import { requestHeaderOf } from '@codexydsh/runtime/session'
import { snapshotProductEvents } from '@codexydsh/runtime/session'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import { createUserMessage, createSystemMessage, CONTEXT_WINDOW_EXCEEDED_CODE, LlmError, resolveRetryPolicy , createMessage } from '@codexydsh/runtime/llm'
import type { ContentBlock, GenerateOptions, LlmResolvedModelInfo, PreparedAdapterCall, ResolvedRetryPolicy, StreamChunk } from '@codexydsh/runtime/llm'
import { ToolCallId, LlmAdapter } from '@codexydsh/runtime/llm'
import { defineContentToolFixture } from '@codexydsh/runtime/tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@codexydsh/runtime'
import { mountAgentLoopTestDependencies } from '@codexydsh/runtime-testkit'
import { BasicCompactionEngine } from '@codexydsh/compaction'
import TokenMeter from '@codexydsh/token-meter'
import * as LlmRetry from '@codexydsh/retry'
import { Session, SessionId, type SessionEvent, type SurfaceEvent } from '@deepseek-ai/dsh-session'

/**
 * CBR-001 regression through the real loop. A replacement checkpoint has a high
 * log seq at the surface head and carries no tool pair, so both adjacent cuts
 * must be safe and re-compacting that checkpoint alone must succeed. This pins
 * surface-position semantics rather than raw-log scanning.
 */

class ReproCompactionEngine extends BasicCompactionEngine {
  override async summarize(): Promise<{ summary: ContentBlock[]; provider: string; model: string }> {
    return {
      summary: [{ type: 'text', text: 'CHECKPOINT SUMMARY' }],
      provider: 'mock',
      model: 'stub',
    }
  }
}

/** Each call emits one tool-call until exhausted, then a final text answer. */
class StepwiseToolAdapter extends LlmAdapter {
  calls = 0
  readonly requests: GenerateOptions[] = []
  constructor(private toolSteps: number, private readonly nativeDeveloperHistory = false) {
    super()
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const prepared = await super.prepareCall(provider, model, signal)
    return this.nativeDeveloperHistory ? { ...prepared, developerHistory: 'native' } : prepared
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 400 },
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const n = this.calls
    this.calls += 1
    if (n < this.toolSteps) {
      const id = ToolCallId(`c${n}`)
      const args = `{"i":${n}}`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `step ${n}` } }
      yield { type: 'block-start', index: 1, blockType: 'tool-call' }
      yield { type: 'block-end', index: 1, block: { type: 'tool-call', id, name: 'work', arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'all done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** First conversation request overflows, then the rebuilt retry succeeds. */
class OverflowRecoveryAdapter extends LlmAdapter {
  readonly conversationRequests: GenerateOptions[] = []
  readonly summaryRequests: GenerateOptions[] = []
  private readonly retryPolicy = resolveRetryPolicy({
    mode: 'normal',
    maxRetries: 1,
    backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
  }, 'compaction test provider retryPolicy')

  constructor(
    private readonly delivery: 'thrown' | 'in-band',
    private readonly transientAfterOverflow = false,
  ) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 128 },
    })
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.retryPolicy
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // The cache-reusing summarizer replays the conversation prefix and marks
    // its call only by the compaction instruction in the trailing user message.
    const trailing = options.messages.at(-1)?.content
      .map(block => (block.type === 'text' ? block.text : ''))
      .join('') ?? ''
    if (trailing.includes('acting as a compaction engine')) {
      this.summaryRequests.push(options)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'RECOVERY CHECKPOINT' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    this.conversationRequests.push(options)
    if (this.conversationRequests.length === 1) {
      if (this.delivery === 'thrown') {
        throw new LlmError('request too large for model context', CONTEXT_WINDOW_EXCEEDED_CODE)
      }
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: 'request too large for model context',
            code: CONTEXT_WINDOW_EXCEEDED_CODE,
          },
        },
      }
      return
    }
    if (this.transientAfterOverflow && this.conversationRequests.length === 2) {
      throw new LlmError('temporary provider outage', 'SERVER')
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'recovered' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}


async function harness(
  toolSteps: number,
  checkpointFormat: 'dsh' | 'codex' = 'dsh',
  nativeDeveloperHistory = false,
  thresholdRatio = 0.5,
): Promise<{ ctx: Context; compact: ReproCompactionEngine; adapter: StepwiseToolAdapter }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  ctx.on('session/flush', async () => {})
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  const adapter = new StepwiseToolAdapter(toolSteps, nativeDeveloperHistory)
  ctx.codexyRequests.registerAdapter(['mock'], adapter)
  ctx.codexyTools.register(defineContentToolFixture({
    name: 'work',
    description: 'does work',
    parameters: { i: { type: 'number' } },
    async execute() {
      return [{ type: 'text', text: 'work result' }]
    },
  }))
  // Small window so several tool steps cross the threshold and compaction
  // fires within the runaway turn after enough history can shrink.
  const compact = new ReproCompactionEngine(ctx, {
    auto: true,
    headroomTokens: 0,
    thresholdRatio,
    retainTokens: 50,
    maxTokens: 8192,
    compactionRetries: 1,
    checkpointFormat,
  })
  return { ctx, compact, adapter }
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function overflowHistorySeed(): readonly SessionEvent[] {
  const session = Session.create(SessionId('overflow-history-seed'))
  for (let turn = 1; turn <= 2; turn += 1) {
    const sentinel = turn === 1 ? 'OLD HISTORY SENTINEL' : 'RECENT HISTORY'
    session.append('turn/start', {
      turn,
    })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${sentinel} ${'old context '.repeat(200)}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `historical response ${turn} ${'detail '.repeat(200)}` }],
        source: {
          kind: 'model',
          ...{ provider: 'mock', model: 'mock' },
        },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return session.snapshotEvents()
}

describe('CBR-001: a real-loop checkpoint is a valid boundary on both sides', () => {
  it.each([true, false])('reinserts current environment and permissions after an idle Codex checkpoint (native: %s)', async (native) => {
    const { ctx, compact, adapter } = await harness(0, 'codex', native)
    let mode = 'read-only'
    ctx.codexyPrompt.context({ name: 'environment', order: 0, text: () => `<environment_context>${mode}</environment_context>` })
    ctx.codexyPrompt.context({ name: 'permissions', order: 0, role: 'developer', text: () => `Permissions: ${mode}.` })
    ctx.on('codexy-prompt/assemble', async (_assembly, _context, next) => ({
      ...await next(), contextSnapshotIntro: 'none',
    }))
    try {
      const agent = await ctx.agentLoop.create(SessionId(`codex-idle-context-${native}`), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: `first task ${'long history '.repeat(100)}` }], source: { kind: 'user' },
      }))
      await waitForIdle(ctx, agent)
      expect(await compact.compactNow(agent, new AbortController().signal)).not.toBeNull()
      expect(agent.session.deriveMessages().some(message => message.source.kind === 'runtime-context')).toBe(false)

      mode = 'workspace-write'
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' },
      }))
      await waitForIdle(ctx, agent)

      const resumed = adapter.requests[1]?.messages ?? []
      const permissions = resumed.filter(message => message.source?.kind === 'runtime-context'
        && (native ? message.role === 'developer' : message.source.form === 'instructions'))
      const environments = resumed.filter(message => message.source?.kind === 'runtime-context'
        && message.role === 'user' && message.source.form !== 'instructions')
      expect(permissions).toHaveLength(1)
      expect(environments).toHaveLength(1)
      expect(permissions[0]?.role).toBe(native ? 'developer' : 'user')
      expect(permissions[0]?.content).toEqual([{ type: 'text', text: 'Permissions: workspace-write.' }])
      expect(environments[0]?.content).toEqual([{ type: 'text', text: '<environment_context>workspace-write</environment_context>' }])
      const permissionIndex = resumed.indexOf(permissions[0]!)
      const environmentIndex = resumed.indexOf(environments[0]!)
      const summaryIndex = resumed.findIndex(message => message.source?.kind === 'compact-checkpoint')
      const continueIndex = resumed.findIndex(message => message.content.some(block =>
        block.type === 'text' && block.text === 'continue'))
      expect(summaryIndex).toBeLessThan(permissionIndex)
      expect(summaryIndex).toBeLessThan(environmentIndex)
      expect(native ? permissionIndex : environmentIndex).toBeLessThan(native ? environmentIndex : permissionIndex)
      expect(permissionIndex).toBeLessThan(continueIndex)
      expect(environmentIndex).toBeLessThan(continueIndex)
      const replay = Session.create(SessionId(`codex-idle-context-replay-${native}`), agent.session.snapshotEvents())
      expect(replay.deriveMessages()).toEqual(agent.session.deriveMessages())
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each([true, false])('restores the latest environment and permissions before a Codex checkpoint (native: %s)', async (native) => {
    const { ctx, adapter } = await harness(16, 'codex', native, 0.7)
    const skills = '<skills_instructions>\n## Skills\n- sample (file: /work/.agents/skills/sample/SKILL.md)\n</skills_instructions>'
    ctx.codexyPrompt.context({ name: 'environment', order: 0, text: '<environment_context>\n  <cwd>/work</cwd>\n</environment_context>' })
    ctx.codexyPrompt.context({ name: 'codexful:skills', order: -100, role: 'developer', text: skills })
    ctx.codexyPrompt.context({ name: 'permissions', order: 0, role: 'developer', text: 'Read-only permissions.' })
    ctx.on('codexy-prompt/assemble', async (_assembly, _context, next) => ({
      ...await next(), contextSnapshotIntro: 'none',
    }))
    try {
      const agent = await ctx.agentLoop.create(SessionId(`codex-context-continuation-${native}`), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'finish the tool task' }], source: { kind: 'user' },
      }))
      await waitForIdle(ctx, agent)

      const resumed = adapter.requests.find(request => request.messages.some(message =>
        message.source?.kind === 'compact-checkpoint'))
      expect(resumed).toBeDefined()
      const messages = resumed!.messages
      const permissionIndexes = messages.flatMap((message, index) =>
        message.source?.kind === 'runtime-context' && message.source.form === 'instructions' ? [index] : [])
      const environmentIndexes = messages.flatMap((message, index) =>
        message.source?.kind === 'runtime-context' && message.source.form !== 'instructions' ? [index] : [])
      const userIndex = messages.findIndex(message => message.role === 'user'
        && message.content.some(block => block.type === 'text' && block.text === 'finish the tool task'))
      const summaryIndex = messages.findIndex(message => message.source?.kind === 'compact-checkpoint')
      expect(permissionIndexes).toHaveLength(1)
      expect(environmentIndexes).toHaveLength(1)
      expect(messages[permissionIndexes[0]!]?.role).toBe(native ? 'developer' : 'user')
      expect(messages[permissionIndexes[0]!]?.content).toEqual([{
        type: 'text', text: `${skills}\n\nRead-only permissions.`,
      }])
      expect(messages[environmentIndexes[0]!]?.content).toEqual([{
        type: 'text', text: '<environment_context>\n  <cwd>/work</cwd>\n</environment_context>',
      }])
      expect(permissionIndexes[0]).toBeLessThan(environmentIndexes[0]!)
      expect(environmentIndexes[0]).toBeLessThan(userIndex)
      expect(userIndex).toBeLessThan(summaryIndex)
      const replay = Session.create(SessionId(`codex-context-replay-${native}`), agent.session.snapshotEvents())
      expect(replay.deriveMessages()).toEqual(agent.session.deriveMessages())
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('sends retained user messages separately before the Codex summary on the next request', async () => {
    const { ctx, adapter } = await harness(8, 'codex')
    try {
      const agent = await ctx.agentLoop.create(SessionId('codex-continuation'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'finish the tool task' }], source: { kind: 'user' },
      }))
      await waitForIdle(ctx, agent)

      const nextRequest = adapter.requests.find(request => request.messages.some(message =>
        message.source?.kind === 'compact-checkpoint'))
      expect(nextRequest).toBeDefined()
      const summaryIndex = nextRequest!.messages.findIndex(message => message.source?.kind === 'compact-checkpoint')
      expect(summaryIndex).toBeGreaterThan(0)
      expect(nextRequest!.messages[summaryIndex - 1]).toMatchObject({
        role: 'user', content: [{ type: 'text', text: 'finish the tool task' }],
      })
      const summaryText = nextRequest!.messages[summaryIndex]?.content
        .map(block => block.type === 'text' ? block.text : '').join('')
      expect(summaryText).toContain('Another language model started')
      const replay = Session.create(SessionId('codex-continuation-replay'), agent.session.snapshotEvents())
      expect(replay.deriveMessages()).toEqual(agent.session.deriveMessages())
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('uses the route selected before tools and agent/request for post-step pressure', async () => {
    const { ctx } = await harness(8)
    ctx.on('codexy-prompt/prepare', async (_variables, _context, next) => ({
      ...await next(), provider: 'mock', model: 'mock',
    }))
    ctx.on('codexy-agent/request', async (_payload, next) => ({
      ...await next(), provider: 'mock', model: 'mock',
    }))
    try {
      const agent = await ctx.agentLoop.create(SessionId('routed-pressure'), {
        provider: 'unconfigured-agent-fallback',
        model: 'unconfigured-agent-fallback',
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'do a routed multi-step task' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)

      expect(requestHeaderOf(agent.session)?.config.model).toBe('mock')
      expect(snapshotProductEvents(agent.session).some(event => event.type === 'compaction/summary')).toBe(true)
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'completed' } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('runs automatic pressure between the completed tool step and the next step', async () => {
    const { ctx } = await harness(8)
    try {
      const agent = await ctx.agentLoop.create(SessionId('post-step-order'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'do tool work' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)

      const events = agent.session.snapshotEvents()
      const compactStart = events.find(event => event.type === 'compaction/start')
      expect(compactStart).toBeDefined()
      const precedingResult = events.findLast(event =>
        event.type === 'tool/result' && event.seq < compactStart!.seq,
      )
      if (precedingResult?.type !== 'tool/result') throw new Error('expected a durable tool result before compaction')
      const precedingStepEnd = events.find(event =>
        event.type === 'step/end'
        && event.data.step === precedingResult.data.step
        && event.seq > precedingResult.seq,
      )
      const nextStepStart = events.find(event =>
        event.type === 'step/start'
        && event.data.step === precedingResult.data.step + 1
        && event.seq > compactStart!.seq,
      )
      expect(precedingResult.seq).toBeLessThan(compactStart!.seq)
      expect(precedingStepEnd!.seq).toBeLessThan(compactStart!.seq)
      expect(compactStart!.seq).toBeLessThan(nextStepStart!.seq)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('the head checkpoint the loop lands is a balanced cut on both sides', async () => {
    const { ctx } = await harness(8)
    try {
      const agent = await ctx.agentLoop.create(SessionId('repro'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'do a long multi-step task' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)

      const events = agent.session.snapshotEvents()
      // A compaction ran: at least one checkpoint landed on the surface.
      const checkpoints = events.filter(
        (e): e is SurfaceEvent =>
          e.type === 'user/message'
          && typeof (e as SurfaceEvent).surfaceOp === 'object',
      )
      expect(checkpoints.length).toBeGreaterThan(0)

      // High log position does not make a text-only checkpoint mid-step; both
      // its start and end cuts are balanced in surface order.
      const nodes = agent.session.surface.nodes
      for (const cp of checkpoints) {
        const index = nodes.indexOf(cp.seq)
        if (index === -1) continue // shadowed by a later checkpoint — no longer an edge.
        expect(toolPairingBalancedBefore(agent.session, cp.seq),
          `checkpoint seq ${cp.seq} must be a balanced region START`).toBe(true)
        expect(toolPairingBalancedAfter(agent.session, cp.seq),
          `checkpoint seq ${cp.seq} must be a balanced region END`).toBe(true)
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('token pressure after loop-admitted system prompts', () => {
  it.each([false, true])('counts initial and replaced prompts once with retry=%s', async (retry) => {
    const ctx = new Context()
    const requests: GenerateOptions[] = []
    const usage = { inputTokens: 1000, cacheReadTokens: 100, outputTokens: 10 }
    const adapter = new class extends StepwiseToolAdapter {
      override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        requests.push(options)
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'answer' } }
        yield { type: 'usage', usage }
        yield retry && requests.length === 1
          ? { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'retry me' } } }
          : { type: 'finish', reason: { kind: 'stop' } }
      }
    }(0)
    try {
      await mountAgentLoopTestDependencies(ctx)
      ctx.on('session/flush', async () => {})
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(TokenMeter)
      ctx.codexyRequests.registerAdapter(['mock'], adapter)
      let prompt = 'initial guidance '.repeat(8)
      ctx.codexyPrompt.section({ name: 'meter-test', order: 0, complete: true, text: () => prompt })
      ctx.on('codexy-agent/request', async (_payload, next) => ({ ...await next(), temperature: 0.5 }))
      ctx.on('agent/request-error', async ({ agent, turn, step }, next) => {
        const action = await next()
        if (action !== undefined) return action
        const node = agent.session.surface.nodes[0]!
        agent.session.append('system/message', {
          turn,
          step,
          message: createSystemMessage('retry guidance'),
        }, { surfaceOp: { op: 'replace', startSeq: node, endSeq: node }, sourceEventSeqs: [node] })
        return { kind: 'retry' }
      })
      const agent = await ctx.agentLoop.create(SessionId('prompt-pressure'), { provider: 'mock', model: 'mock' })
      // Eager replay must observe the same anchor as a fresh reader of the finished log.
      ctx.codexyTokenMeter.measure(agent.session)
      for (const nextPrompt of [prompt, 'expanded guidance '.repeat(20), 'short', '']) {
        prompt = nextPrompt
        agent.followup(createUserMessage({ content: [{ type: 'text', text: 'question' }], source: { kind: 'user' } }))
        await agent.whenIdle()
        expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
          type: 'turn/end', data: { reason: { kind: 'completed' } },
        })
        const measured = ctx.codexyTokenMeter.measure(agent.session)
        expect(measured.baseline).toEqual({ kind: 'usage', tokens: 1110, usage })
        expect(measured.surfaceDeltaTokens).toBe(0)
        expect(measured.totalTokens).toBe(1110)
        const replay = Session.create(SessionId('prompt-pressure-replay'), agent.session.snapshotEvents())
        expect(ctx.codexyTokenMeter.measure(replay)).toMatchObject({
          baseline: measured.baseline, surfaceDeltaTokens: 0, totalTokens: 1110, nodes: measured.nodes,
        })
      }
      const events = agent.session.snapshotEvents()
      const prompts = events.filter(event => event.type === 'system/message')
      expect(prompts[0]?.surfaceOp).toBe('append')
      expect(prompts.slice(1).every(event => typeof event.surfaceOp === 'object')).toBe(true)
      for (const event of prompts) {
        expect(events.find(start => start.type === 'step/start'
          && start.data.turn === event.data.turn && start.data.step === event.data.step)?.seq)
          .toBeLessThan(event.seq)
      }
      expect(requests).toHaveLength(retry ? 5 : 4)
      expect(requests.every(request => request.temperature === 0.5)).toBe(true)
      expect(events.filter(event => event.type === 'assistant/attempt')).toHaveLength(retry ? 1 : 0)
      expect(events.filter(event => event.type === 'step/start')).toHaveLength(4)
      expect(requests[0]?.messages[0]?.content).toEqual([{ type: 'text', text: 'initial guidance '.repeat(8) }])
      if (retry) expect(requests[1]?.messages[0]?.content).toEqual(requests[0]?.messages[0]?.content)
      expect(requests.at(-1)?.messages.some(message => message.role === 'system')).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('context-overflow recovery across the real loop and compaction-basic', () => {
  it.each(['thrown', 'in-band'] as const)(
    'force-compacts a %s overflow within the retried step',
    async (delivery) => {
      const ctx = new Context()
      const adapter = new OverflowRecoveryAdapter(delivery)
      await mountAgentLoopTestDependencies(ctx)
      ctx.on('session/flush', async () => {})
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(TokenMeter)
      ctx.codexyRequests.registerAdapter(['mock'], adapter)
      ctx.on('codexy-prompt/prepare', async (_variables, _context, next) => ({
        ...await next(), provider: 'mock', model: 'mock',
      }))
      ctx.on('codexy-agent/request', async (_payload, next) => ({
        ...await next(), provider: 'mock', model: 'mock',
      }))
      await ctx.plugin(BasicCompactionEngine, {
        headroomTokens: 0,
        thresholdRatio: 1,
        retainTokens: 100,
        maxTokens: 64,
        compactionRetries: 0,
        maxOverflowRetries: 1,
      })

      try {
        const { agent } = await ctx.agentLoop.createAgent(ctx, {
          sessionId: SessionId(`overflow-${delivery}`),
          seed: overflowHistorySeed(),
          agentOptions: {
            provider: 'unconfigured-agent-fallback',
            model: 'unconfigured-agent-fallback',
          },
        })

        agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue from history' }], source: { kind: 'user' } }))
        await agent.whenIdle()

        expect(adapter.conversationRequests).toHaveLength(2)
        expect(adapter.summaryRequests).toHaveLength(1)
        const instruction = adapter.summaryRequests[0]!.messages.at(-1)?.content
          .map(block => (block.type === 'text' ? block.text : ''))
          .join('') ?? ''
        expect(instruction).toContain('Write concise English engineering prose.')
        expect(instruction).toContain('numeric values, function signatures, and syntax fragments.')
        expect(JSON.stringify(adapter.conversationRequests[0]!.messages)).toContain('OLD HISTORY SENTINEL')
        const retry = JSON.stringify(adapter.conversationRequests[1]!.messages)
        expect(retry).toContain('RECOVERY CHECKPOINT')
        expect(retry).not.toContain('OLD HISTORY SENTINEL')

        const events = agent.session.snapshotEvents()
        const stepStart = events.find(event =>
          event.type === 'step/start' && event.data.turn === 3 && event.data.step === 1,
        )!
        const stepEnd = events.find(event =>
          event.type === 'step/end' && event.data.turn === 3 && event.data.step === 1,
        )!
        const compaction = events.filter(event =>
          event.type === 'compaction/start'
          || event.type === 'compaction/summary'
          || event.type === 'compaction/end',
        )
        expect(compaction.map(event => event.type)).toEqual([
          'compaction/start',
          'compaction/summary',
          'compaction/end',
        ])
        expect(compaction.every(event =>
          event.seq > stepStart.seq && event.seq < stepEnd.seq,
        )).toBe(true)
        expect(events.filter(event => event.type === 'turn/start').slice(-1).map(event => event.data.turn))
          .toEqual([3])
        expect(events.filter(event => event.type === 'step/start' && event.data.turn === 3))
          .toHaveLength(1)
        expect(events.at(-1)).toMatchObject({
          type: 'turn/end',
          data: { reason: { kind: 'completed' } },
        })
      } finally {
        await ctx.fiber.dispose()
      }
    },
  )

  it('keeps context-overflow and transient retry budgets independent in one sequence', async () => {
    const ctx = new Context()
    const adapter = new OverflowRecoveryAdapter('thrown', true)
    await mountAgentLoopTestDependencies(ctx)
    ctx.on('session/flush', async () => {})
    await ctx.plugin(LlmRetry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(TokenMeter)
    ctx.codexyRequests.registerAdapter(['mock'], adapter)
    await ctx.plugin(BasicCompactionEngine, {
      headroomTokens: 0,
      thresholdRatio: 1,
      retainTokens: 100,
      maxTokens: 64,
      compactionRetries: 0,
      maxOverflowRetries: 1,
    })

    try {
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('alternating-recovery'),
        seed: overflowHistorySeed(),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue from history' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      expect(adapter.conversationRequests).toHaveLength(3)
      expect(adapter.summaryRequests).toHaveLength(1)
      expect(snapshotProductEvents(agent.session).filter(event => event.type === 'llm/retry').map(event => event.data))
        .toEqual([expect.objectContaining({ turn: 3, step: 1, retry: 1, failure: { message: 'temporary provider outage', code: 'SERVER' } })])
      expect(snapshotProductEvents(agent.session).filter(event => event.type === 'turn/start').slice(-1).map(event => event.data.turn))
        .toEqual([3])
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'completed' } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
