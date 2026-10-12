import { requestHeaderOf } from '@codexydsh/runtime/session'
import { snapshotProductEvents } from '@codexydsh/runtime/session'
/** Automatic compaction and summary retries retain captured provider generations. */
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, assembleContextFor, type Agent, type AgentOptions } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies } from '@codexydsh/runtime-testkit'
import { BasicCompactionEngine, type BasicCompactionConfig } from '@codexydsh/compaction'
import {
  createMessage, createUserMessage, LlmAdapter, LlmError, ReasoningEffortId, resolveRetryPolicy,
  compactionClientMetadata, encodeCodexClientMetadata,
  type GenerateOptions, type LlmCallConfig, type LlmResolvedModelInfo, type PreparedAdapterCall, type PreparedLlmModel,
  type ResolvedRetryPolicy, type StreamChunk,
} from '@codexydsh/runtime/llm'
import { SessionId, SessionLogOffset, Session as StockSession, type Session } from '@deepseek-ai/dsh-session'
import { decodeCodexyArtifact, encodeArtifactEvents, encodeArtifactHeader } from '../../runtime/src/persistence-codec.ts'
import TokenMeter from '@codexydsh/token-meter'
import type { PromptPreparation } from '@codexydsh/runtime/prompt'
import { afterEach, describe, expect, it } from 'vitest'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

interface Generation {
  readonly name: string
  readonly window: number
  readonly maxTokens: number
  readonly defaultEffort?: string
  readonly lite?: true
}

class MutableAdapter extends LlmAdapter {
  readonly captures: Array<{ generation: string; provider: string; model: string }> = []
  readonly requests: Array<{ generation: string; options: GenerateOptions }> = []
  liveStreams = 0
  onCapture: (() => Promise<void>) | undefined
  onStream: ((attempt: number) => Promise<void>) | undefined

  constructor(public generation: Generation, private readonly maxRetries = 1) {
    super()
  }

  private info(generation: Generation, provider: string, model: string): LlmResolvedModelInfo {
    return {
      provider, id: model, name: model,
      context: { contextWindow: generation.window },
      defaultMaxTokens: generation.maxTokens,
      ...generation.lite === undefined ? {} : { codexResponsesLite: generation.lite },
      reasoning: {
        efforts: ['low', 'medium', 'high'].map(effort => ({ id: ReasoningEffortId(effort), name: effort })),
        ...generation.defaultEffort === undefined ? {} : { defaultEffort: ReasoningEffortId(generation.defaultEffort) },
      },
    }
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve(this.info(this.generation, provider, model))
  }

  override providerRetryPolicy(): ResolvedRetryPolicy {
    return resolveRetryPolicy({ mode: 'normal', maxRetries: this.maxRetries,
      backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
    }, 'prepared compaction fixture')
  }

  override async prepareCall(provider: string, model: string): Promise<PreparedAdapterCall> {
    const generation = this.generation
    this.captures.push({ generation: generation.name, provider, model })
    await this.onCapture?.()
    return {
      model: this.info(generation, provider, model),
      resolveModel: id => Promise.resolve(this.info(generation, provider, id)),
      stream: options => this.streamGeneration(generation, options),
    }
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.liveStreams += 1
    return this.streamGeneration(this.generation, options)
  }

  private async * streamGeneration(generation: Generation, options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    this.requests.push({ generation: generation.name, options })
    await this.onStream?.(this.requests.length)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: `summary ${generation.name}` }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function harness(format: 'codex' | 'dsh' = 'codex', config: BasicCompactionConfig = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  ctx.on('session/flush', async () => {})
  await ctx.plugin(TokenMeter)
  const adapter = new MutableAdapter({ name: 'old', window: 4_000, maxTokens: 100, defaultEffort: 'low' })
  const registration = ctx.codexyRequests.registerAdapter(['local'], adapter)
  const compact = new BasicCompactionEngine(ctx, {
    checkpointFormat: format, codexUserMessageTokens: 0,
    thresholdRatio: 0.8, headroomTokens: 0, retainTokens: 0, maxTokens: 100,
    ...config,
  })
  const session = ctx.sessions.create(SessionId('prepared-compaction'))
  closedStep(session, 1, 1, 'history '.repeat(700))
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  const owner = { session, options: { provider: 'local', model: 'coding' } } as Agent
  return { ctx, adapter, registration, compact, session, owner }
}

function closedStep(session: Session, turn: number, step: number, text: string): void {
  if (step === 1 && turn === 1) session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn, step })
  session.append('assistant/message', { turn, step, stream: [], message: createMessage({
    role: 'assistant', content: [{ type: 'text', text: 'completed' }],
    source: { kind: 'model', provider: 'local', model: 'coding' },
  }) }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step })
}

async function preStep(
  ctx: Context, owner: Agent, turn: number, step: number, preparedModel: PreparedLlmModel,
  variables: Record<string, string | undefined> = {},
) {
  const dispose = ctx.on('codexy-prompt/prepare', async (_current, _context, next) => ({ ...await next(), ...variables }))
  const signal = new AbortController().signal
  const promptPreparation = await ctx.codexyPrompt.prepare(assembleContextFor(owner, signal))
  dispose()
  return agentEvents(ctx, owner).waterfall('codexy-agent/pre-step', {
    messages: [], turn, step, signal, preparedModel, promptPreparation,
  }, () => Promise.resolve({ kind: 'enter', messages: [] }))
}

async function requestEnter(
  ctx: Context, owner: Agent, turn: number, step: number, preparedModel: PreparedLlmModel,
  proposed: LlmCallConfig = { provider: preparedModel.model.provider, model: preparedModel.model.id },
  attempt = 1,
): Promise<PromptPreparation> {
  const signal = new AbortController().signal
  const promptPreparation = await ctx.codexyPrompt.prepare(assembleContextFor(owner, signal))
  const config = preparedModel.prepareCall(proposed).config
  await agentEvents(ctx, owner).serial('agent/request-enter', {
    turn, step, attempt, signal, preparedModel, promptPreparation, config,
  })
  return promptPreparation
}

async function stepCompleted(ctx: Context, owner: Agent, turn: number, step: number, needsFollowUp = true): Promise<void> {
  await agentEvents(ctx, owner).serial('agent/step-completed', {
    turn, step, needsFollowUp, signal: new AbortController().signal,
  })
}

describe('captured automatic compaction', () => {
  it('captures actual pre-turn and mid-turn pressure facts and restores successful summary metadata losslessly', async () => {
    const { ctx, adapter, session, owner } = await harness('codex', { thresholdRatio: 0.1 })
    const workspaces = { '/fixture/workspace': { latest_git_commit_hash: 'a'.repeat(40), has_changes: false } }
    const metadata = encodeCodexClientMetadata({ installationId: 'fixture-installation', sessionId: session.id,
      threadId: session.id, turnId: 'fixture-turn', contextWindowId: 'fixture-window', windowNumber: 0,
      requestKind: 'turn', turnStartedAtUnixMs: 1000, analyticsEnabled: false, workspaces, model: 'coding', reasoningEffort: 'high' })
    workspaces['/fixture/workspace'].latest_git_commit_hash = 'b'.repeat(40)
    workspaces['/fixture/workspace'].has_changes = true
    await requestEnter(ctx, owner, 2, 1, await ctx.codexyRequests.prepareModel('local', 'coding'), {
      provider: 'local', model: 'coding', codexfulResponses: { omitDefaultMaxTokens: true,
        reasoningSummary: 'none', wireProfile: 'codex-0.162.1', clientMetadata: metadata },
    })
    closedStep(session, 2, 1, 'follow-up history '.repeat(700))
    await stepCompleted(ctx, owner, 2, 1)
    expect(adapter.requests).toHaveLength(2)
    for (const [index, phase] of ['pre_turn', 'mid_turn'].entries()) {
      const canonical = JSON.parse(adapter.requests[index]!.options.codexfulResponses!.clientMetadata!['x-codex-turn-metadata']!)
      expect(canonical).toMatchObject({ request_kind: 'compaction', turn_id: 'fixture-turn',
        turn_started_at_unix_ms: 1000, analytics_enabled: false,
        workspaces: { '/fixture/workspace': { latest_git_commit_hash: 'a'.repeat(40), has_changes: false } },
        compaction: { trigger: 'auto', reason: 'context_limit', implementation: 'responses', phase, strategy: 'memento' } })
      expect(canonical).not.toHaveProperty('model')
      expect(canonical).not.toHaveProperty('reasoning_effort')
    }
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    const summaries = snapshotProductEvents(session).filter(event => event.type === 'compaction/summary')
    expect(summaries.map(event => event.data.clientMetadata))
      .toEqual(adapter.requests.map(request => request.options.codexfulResponses?.clientMetadata))
    const artifact = Buffer.from(encodeArtifactHeader({ kind: 'codexy-session', version: 1,
      session: session.header, inheritedEventCount: SessionLogOffset(0) }) + encodeArtifactEvents(session.snapshotEvents()))
    const decoded = decodeCodexyArtifact(artifact)
    const restored = StockSession.fromRestore(session.id, decoded.events, decoded.metadata.session,
      decoded.metadata.inheritedEventCount, 'detached')
    expect(snapshotProductEvents(restored).filter(event => event.type === 'compaction/summary')).toEqual(summaries)
    expect(Buffer.from(encodeArtifactHeader(decoded.metadata) + encodeArtifactEvents(decoded.events))).toEqual(artifact)
    const malformed = decoded.events.map(event => event.type === 'compaction/summary'
      ? { ...event, data: { ...event.data, clientMetadata: { 'x-codex-turn-metadata': false } } } : event)
    expect(() => decodeCodexyArtifact(Buffer.from(encodeArtifactHeader(decoded.metadata) + encodeArtifactEvents(malformed))))
      .toThrow('invalid compaction client metadata')
    expect(JSON.parse(metadata['x-codex-turn-metadata']!)).toMatchObject({ request_kind: 'turn', model: 'coding', reasoning_effort: 'high' })
  })

  it('captures actual context-overflow recovery as an automatic mid-turn context-limit operation', async () => {
    const { ctx, adapter, owner } = await harness()
    const metadata = encodeCodexClientMetadata({ installationId: 'i', sessionId: owner.session.id,
      threadId: owner.session.id, turnId: 't', contextWindowId: 'w', windowNumber: 0, requestKind: 'turn' })
    await requestEnter(ctx, owner, 2, 1, await ctx.codexyRequests.prepareModel('local', 'coding'), {
      provider: 'local', model: 'coding', codexfulResponses: { omitDefaultMaxTokens: true,
        reasoningSummary: 'none', wireProfile: 'codex-0.162.1', clientMetadata: metadata },
    })
    const action = await agentEvents(ctx, owner).waterfall('agent/request-error', {
      turn: 2, step: 1, provider: 'local', failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'synthetic overflow' },
      retryPolicy: undefined, signal: new AbortController().signal,
    }, () => Promise.resolve(undefined))
    expect(action).toEqual({ kind: 'retry' })
    expect(adapter.requests).toHaveLength(1)
    expect(JSON.parse(adapter.requests[0]!.options.codexfulResponses!.clientMetadata!['x-codex-turn-metadata']!).compaction)
      .toEqual({ trigger: 'auto', reason: 'context_limit', implementation: 'responses', phase: 'mid_turn', strategy: 'memento' })
  })

  it('reuses actual automatic operation facts across provider retries without inheriting turn model controls', async () => {
    const { ctx, adapter, owner } = await harness('codex', { thresholdRatio: 0.1 })
    const metadata = encodeCodexClientMetadata({ installationId: 'i', sessionId: owner.session.id,
      threadId: owner.session.id, turnId: 't', contextWindowId: 'w', windowNumber: 0, requestKind: 'turn',
      model: 'coding', reasoningEffort: 'high' })
    adapter.onStream = async attempt => { if (attempt === 1) throw new LlmError('synthetic retry', 'PROVIDER') }
    await requestEnter(ctx, owner, 2, 1, await ctx.codexyRequests.prepareModel('local', 'coding'), {
      provider: 'local', model: 'coding', codexfulResponses: { omitDefaultMaxTokens: true,
        reasoningSummary: 'none', wireProfile: 'codex-0.162.1', clientMetadata: metadata },
    })
    expect(adapter.requests).toHaveLength(2)
    const snapshots = adapter.requests.map(request => request.options.codexfulResponses?.clientMetadata)
    expect(snapshots[1]).toEqual(snapshots[0])
    expect(JSON.parse(snapshots[0]!['x-codex-turn-metadata']!).compaction).toEqual({ trigger: 'auto',
      reason: 'context_limit', implementation: 'responses', phase: 'pre_turn', strategy: 'memento' })
    expect(snapshotProductEvents(owner.session).find(event => event.type === 'compaction/summary')?.data.clientMetadata)
      .toEqual(snapshots[1])
    expect(adapter.captures).toHaveLength(1)
  })

  it('projects a real manual maintenance call while leaving the ordinary durable request header unchanged', async () => {
    const { adapter, compact, session, owner } = await harness('codex', { auto: false })
    const metadata = encodeCodexClientMetadata({ installationId: 'i', sessionId: session.id,
      threadId: session.id, turnId: 'closed-turn', contextWindowId: 'w', windowNumber: 0, requestKind: 'turn',
      model: 'coding', reasoningEffort: 'high' })
    session.append('request/header', { reason: 'initial', header: { config: {
      provider: 'local', model: 'coding', codexfulResponses: { omitDefaultMaxTokens: true,
        reasoningSummary: 'none', wireProfile: 'codex-0.162.1', clientMetadata: metadata },
    } } })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    const header = structuredClone(requestHeaderOf(session))
    const maintenanceOwner = { ...owner, runMaintenance: <T>(task: (signal: AbortSignal) => Promise<T>) =>
      task(new AbortController().signal) } as Agent
    expect(await compact.compactNow(maintenanceOwner, new AbortController().signal)).not.toBeNull()
    expect(adapter.requests).toHaveLength(1)
    const snapshot = adapter.requests[0]!.options.codexfulResponses!.clientMetadata!
    expect(JSON.parse(snapshot['x-codex-turn-metadata']!)).toMatchObject({ request_kind: 'compaction',
      compaction: { trigger: 'manual', reason: 'user_requested', implementation: 'responses',
        phase: 'standalone_turn', strategy: 'memento' } })
    expect(snapshotProductEvents(session).find(event => event.type === 'compaction/summary')?.data.clientMetadata).toEqual(snapshot)
    expect(requestHeaderOf(session)).toEqual(header)
    expect(snapshotProductEvents(session).filter(event => event.type === 'turn/start')).toHaveLength(2)
  })

  it('omits pre-turn context and rebuilds the completed step context only when another request is needed', async () => {
    const { ctx, adapter, session, owner } = await harness('codex', {
      thresholdRatio: 0.1, codexUserMessageTokens: 1_000,
    })
    const captured: PromptPreparation[] = []
    const context = createUserMessage({
      content: [{ type: 'text', text: 'frozen completed-step environment' }],
      source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'environment', text: 'frozen completed-step environment' }] },
    })
    ctx.on('codexy-compaction/initial-context', async ({ promptPreparation }) => {
      if (promptPreparation === undefined) throw new Error('automatic compaction needs its preparation')
      captured.push(promptPreparation)
      return [context]
    })
    const initial = await requestEnter(ctx, owner, 2, 1, await ctx.codexyRequests.prepareModel('local', 'coding'))
    expect(adapter.requests).toHaveLength(1)
    expect(captured).toEqual([])
    expect(session.deriveMessages().some(message => message.source.kind === 'runtime-context')).toBe(false)
    closedStep(session, 2, 1, 'current user '.repeat(700))
    await stepCompleted(ctx, owner, 2, 1, false)
    expect(adapter.requests).toHaveLength(1)
    await stepCompleted(ctx, owner, 2, 1)
    expect(adapter.requests).toHaveLength(2)
    expect(captured).toEqual([initial])
    const messages = session.deriveMessages()
    expect(messages.at(-1)?.source.kind).toBe('compact-checkpoint')
    expect(messages.at(-2)?.source.kind).toBe('user')
    expect(messages.at(-3)?.content).toEqual(context.content)
    const later = await requestEnter(ctx, owner, 2, 2, await ctx.codexyRequests.prepareModel('local', 'coding'))
    expect(later).not.toBe(initial)
    expect(adapter.requests).toHaveLength(2)
  })

  it('retains initial-turn capacity, route and effort across two steps, then captures the next turn', async () => {
    const { ctx, adapter, session, owner } = await harness()
    const entered = Promise.withResolvers<undefined>()
    const resume = Promise.withResolvers<undefined>()
    adapter.onCapture = () => { entered.resolve(undefined); return resume.promise }
    const capture = ctx.codexyRequests.prepareModel('local', 'coding')
    await entered.promise
    adapter.generation = { name: 'new', window: 1_600, maxTokens: 300, defaultEffort: 'high' }
    resume.resolve(undefined)
    const initial = await capture
    adapter.onCapture = undefined
    expect(ctx.codexyTokenMeter.measure(session).totalTokens).toBeGreaterThan(1_280)
    expect(ctx.codexyTokenMeter.measure(session).totalTokens).toBeLessThan(3_200)
    await requestEnter(ctx, owner, 2, 1, initial, {
      provider: 'local', model: 'coding', reasoningEffort: ReasoningEffortId('low'), maxTokens: 100,
      codexfulResponses: { omitDefaultMaxTokens: false, reasoningSummary: 'none' },
    })
    expect(adapter.requests).toHaveLength(0)
    session.append('request/header', { reason: 'initial', header: { config: {
      provider: 'local', model: 'coding', reasoningEffort: ReasoningEffortId('low'), maxTokens: 100,
      codexfulResponses: { omitDefaultMaxTokens: false, reasoningSummary: 'none' },
    } } })
    closedStep(session, 2, 1, 'additional '.repeat(1_000))
    await stepCompleted(ctx, owner, 2, 1)

    const switched = await ctx.codexyRequests.prepareModel('local', 'other')
    await requestEnter(ctx, owner, 2, 2, switched, {
      provider: 'local', model: 'other', reasoningEffort: ReasoningEffortId('high'),
    })
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({ generation: 'old', options: {
      provider: 'local', model: 'coding', reasoningEffort: 'low', purpose: 'compaction',
    } })
    expect(adapter.requests[0]?.options.signal).toBeInstanceOf(AbortSignal)
    expect(adapter.requests[0]?.options).toMatchObject({ maxTokens: 100,
      codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none' },
    })
    closedStep(session, 2, 2, 'short tail')
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 3 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'new turn '.repeat(1_000) }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await requestEnter(ctx, owner, 3, 1, await ctx.codexyRequests.prepareModel('local', 'other'))
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[1]).toMatchObject({ generation: 'new', options: {
      provider: 'local', model: 'other', reasoningEffort: 'high',
    } })
    expect(adapter.liveStreams).toBe(0)
  })

  it('uses the latest captured step for ordinary DSH pressure and its output reservation', async () => {
    const { ctx, adapter, session, owner } = await harness('dsh')
    const initial = await ctx.codexyRequests.prepareModel('local', 'coding')
    adapter.generation = { name: 'new', window: 2_100, maxTokens: 800, defaultEffort: 'high' }
    await preStep(ctx, owner, 2, 1, initial)
    expect(adapter.requests).toHaveLength(0)
    session.append('request/header', { reason: 'initial', header: { config: {
      provider: 'local', model: 'coding', maxTokens: 100,
    }, adapterDefaults: { maxTokens: true } } })
    await preStep(ctx, owner, 2, 2, await ctx.codexyRequests.prepareModel('local', 'coding'))
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({ generation: 'new', options: { provider: 'local', model: 'coding' } })
    expect(snapshotProductEvents(session).some(event => event.type === 'compaction/summary')).toBe(true)
    expect(adapter.liveStreams).toBe(0)
  })

  it('retains the routed explicit output cap over stale AgentOptions in ordinary DSH pressure', async () => {
    const { ctx, adapter, session } = await harness('dsh')
    session.append('request/header', { reason: 'initial', header: { config: {
      provider: 'local', model: 'coding', maxTokens: 1_000,
    } } })
    adapter.generation = { name: 'new', window: 2_100, maxTokens: 100, defaultEffort: 'high' }
    const owner = { session, options: { provider: 'local', model: 'coding', maxTokens: 100 } } as Agent
    expect(ctx.codexyTokenMeter.measure(session).totalTokens).toBeGreaterThan(1_100)
    expect(ctx.codexyTokenMeter.measure(session).totalTokens).toBeLessThan(1_680)
    await preStep(ctx, owner, 2, 2, await ctx.codexyRequests.prepareModel('local', 'coding'))
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.generation).toBe('new')
  })

  it.each([
    { finalEffort: 'medium', modelDefault: 'low', optionsEffort: 'high', headerEffort: 'high', adapterDefault: false, expected: 'medium' },
    { finalEffort: undefined, modelDefault: 'low', optionsEffort: 'high', headerEffort: 'high', adapterDefault: false, expected: 'low' },
    { finalEffort: 'medium', modelDefault: undefined, optionsEffort: 'high', headerEffort: 'high', adapterDefault: false, expected: 'medium' },
    { finalEffort: 'high', modelDefault: 'low', optionsEffort: undefined, headerEffort: 'high', adapterDefault: false, expected: 'high' },
    { finalEffort: undefined, modelDefault: 'low', optionsEffort: undefined, headerEffort: 'high', adapterDefault: true, expected: 'low' },
    { finalEffort: 'high', modelDefault: 'low', optionsEffort: 'high', headerEffort: 'medium', adapterDefault: false, expected: 'high' },
  ])('uses finalized request effort rather than stale header or options: $expected / $finalEffort / $adapterDefault', async (test) => {
    const { ctx, adapter, session } = await harness()
    adapter.generation = { name: 'old', window: 1_600, maxTokens: 100,
      ...test.modelDefault === undefined ? {} : { defaultEffort: test.modelDefault },
    }
    session.append('request/header', { reason: 'initial', header: { config: {
      provider: 'local', model: 'coding', reasoningEffort: ReasoningEffortId(test.headerEffort),
    }, ...test.adapterDefault ? { adapterDefaults: { reasoningEffort: true as const } } : {} } })
    const options: AgentOptions = { provider: 'local', model: 'coding',
      ...test.optionsEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(test.optionsEffort) },
    }
    const owner = { session, options } as Agent
    await requestEnter(ctx, owner, 2, 1, await ctx.codexyRequests.prepareModel('local', 'coding'), {
      provider: 'local', model: 'coding',
      ...test.finalEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(test.finalEffort) },
    })
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.options.reasoningEffort).toBe(test.expected)
  })

  it.each([undefined, 'codex-0.162.1'] as const)('keeps summary retries on the captured generation, retry policy and wire profile=%s after registration replacement', async (wireProfile) => {
    const { ctx, adapter, registration, compact, session, owner } = await harness()
    const initial = await ctx.codexyRequests.prepareModel('local', 'coding')
    const turnMetadata = encodeCodexClientMetadata({ installationId: 'fixture-installation', sessionId: session.id,
      threadId: session.id, turnId: `${session.id}:2`, contextWindowId: `${session.id}:0`, windowNumber: 0,
      requestKind: 'turn', turnStartedAtUnixMs: 1000, analyticsEnabled: false, model: 'coding', reasoningEffort: 'medium' })
    await requestEnter(ctx, owner, 2, 1, initial, {
      provider: 'local', model: 'coding',
      codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none',
        ...wireProfile === undefined ? {} : { wireProfile, clientMetadata: turnMetadata } },
    })
    const entered = Promise.withResolvers<undefined>()
    const resume = Promise.withResolvers<undefined>()
    adapter.onStream = async (attempt) => {
      if (attempt !== 1) return
      entered.resolve(undefined)
      await resume.promise
      throw new LlmError('retryable summary failure', 'PROVIDER')
    }
    const nodes = session.surface.nodes
    const signal = new AbortController().signal
    const summary = compact.compactRegion(nodes[0]!, nodes.at(-1)!, owner, signal)
    await entered.promise
    registration.replace([])
    const replacement = new MutableAdapter({ name: 'new', window: 800, maxTokens: 300, defaultEffort: 'high' }, 0)
    ctx.codexyRequests.registerAdapter(['local'], replacement)
    adapter.generation = { name: 'new', window: 800, maxTokens: 300, defaultEffort: 'high' }
    resume.resolve(undefined)
    await summary
    expect(adapter.requests.map(request => request.generation)).toEqual(['old', 'old'])
    expect(adapter.requests.map(request => request.options.reasoningEffort)).toEqual(['low', 'low'])
    const summaryMetadata = wireProfile === undefined ? undefined
      : compactionClientMetadata(turnMetadata)
    expect(adapter.requests.map(request => request.options.codexfulResponses)).toEqual([
      { omitDefaultMaxTokens: true, reasoningSummary: 'none', ...wireProfile === undefined ? {} : { wireProfile, clientMetadata: summaryMetadata } },
      { omitDefaultMaxTokens: true, reasoningSummary: 'none', ...wireProfile === undefined ? {} : { wireProfile, clientMetadata: summaryMetadata } },
    ])
    if (summaryMetadata !== undefined) {
      expect(JSON.parse(summaryMetadata['x-codex-turn-metadata']!)).toMatchObject({ request_kind: 'compaction',
        turn_id: `${session.id}:2`, turn_started_at_unix_ms: 1000 })
      expect(JSON.parse(summaryMetadata['x-codex-turn-metadata']!)).not.toHaveProperty('compaction')
      expect(JSON.parse(summaryMetadata['x-codex-turn-metadata']!)).not.toHaveProperty('model')
      expect(JSON.parse(summaryMetadata['x-codex-turn-metadata']!)).not.toHaveProperty('reasoning_effort')
      expect(JSON.parse(turnMetadata['x-codex-turn-metadata']!)).toMatchObject({ request_kind: 'turn', reasoning_effort: 'medium' })
    }
    expect(adapter.requests[1]?.options.messages).toEqual(adapter.requests[0]?.options.messages)
    expect(adapter.requests.every(request => request.options.signal === signal)).toBe(true)
    expect(adapter.captures).toHaveLength(1)
    expect(adapter.liveStreams).toBe(0)
    expect(replacement.requests).toHaveLength(0)
  })

  it('uses finalized Codexful request mode and effort on a new route before any header exists', async () => {
    const { ctx, adapter, session, owner } = await harness()
    adapter.generation = { name: 'new', window: 1_600, maxTokens: 300, lite: true }
    expect(requestHeaderOf(session)).toBeUndefined()
    await requestEnter(ctx, owner, 2, 1, await ctx.codexyRequests.prepareModel('local', 'other'), {
      provider: 'local', model: 'other', reasoningEffort: ReasoningEffortId('medium'),
      codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none', strictModelInput: true },
    })
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({ generation: 'new', options: {
      model: 'other', reasoningEffort: 'medium', maxTokens: 300,
      codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none', strictModelInput: true, lite: true },
    } })
  })

  it('re-resolves automatic Lite and defaults after old headers without inheriting them', async () => {
    const { ctx, adapter, session, owner } = await harness()
    session.append('request/header', { reason: 'initial', header: { config: {
      provider: 'local', model: 'coding', reasoningEffort: ReasoningEffortId('low'), maxTokens: 100,
      codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none', lite: true },
    }, adapterDefaults: { maxTokens: true, reasoningEffort: true } } })
    adapter.generation = { name: 'new', window: 1_600, maxTokens: 300, defaultEffort: 'high' }
    await requestEnter(ctx, owner, 2, 1, await ctx.codexyRequests.prepareModel('local', 'coding'), {
      provider: 'local', model: 'coding',
      codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none' },
    })
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({ generation: 'new', options: {
      reasoningEffort: 'high', maxTokens: 300, codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none' },
    } })
    expect(adapter.requests[0]?.options.codexfulResponses).not.toHaveProperty('lite')
  })

  it.each([undefined, 'codex-0.162.1'] as const)('captures the first sealed request and wire profile=%s once, ignoring later attempts, controls and headers', async (wireProfile) => {
    const { ctx, adapter, compact, session, owner } = await harness()
    const prepared = await ctx.codexyRequests.prepareModel('local', 'coding')
    await requestEnter(ctx, owner, 2, 1, prepared, {
      provider: 'local', model: 'coding', reasoningEffort: ReasoningEffortId('medium'),
      codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'auto',
        ...wireProfile === undefined ? {} : { wireProfile } },
    })
    session.append('request/header', { reason: 'initial', header: { config: {
      provider: 'local', model: 'coding', reasoningEffort: ReasoningEffortId('low'),
      codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none' },
    } } })
    await requestEnter(ctx, owner, 2, 1, prepared, {
      provider: 'local', model: 'coding', reasoningEffort: ReasoningEffortId('low'),
    }, 2)
    await requestEnter(ctx, owner, 2, 2, await ctx.codexyRequests.prepareModel('local', 'coding'), {
      provider: 'local', model: 'coding', reasoningEffort: ReasoningEffortId('high'),
    })
    session.append('request/header', { reason: 'change', header: { config: {
      provider: 'local', model: 'coding', reasoningEffort: ReasoningEffortId('high'),
      codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none' },
    } } })
    const nodes = session.surface.nodes
    await compact.compactRegion(nodes[0]!, nodes.at(-1)!, owner)
    expect(adapter.requests[0]?.options).toMatchObject({ reasoningEffort: 'medium',
      codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'auto',
        ...wireProfile === undefined ? {} : { wireProfile } },
    })
  })

  it('captures an overridden summary route once and keeps it for retries', async () => {
    const { ctx, compact, session, owner } = await harness('codex', {
      summarizationProvider: 'summary-provider', summarizationModel: 'summary-model',
    })
    const summaryAdapter = new MutableAdapter({ name: 'summary-old', window: 4_000, maxTokens: 500, defaultEffort: 'medium' })
    ctx.codexyRequests.registerAdapter(['summary-provider'], summaryAdapter)
    await requestEnter(ctx, owner, 2, 1, await ctx.codexyRequests.prepareModel('local', 'coding'), {
      provider: 'local', model: 'coding', codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none',
        wireProfile: 'codex-0.162.1', clientMetadata: encodeCodexClientMetadata({ installationId: 'fixture-installation',
          sessionId: session.id, threadId: session.id, turnId: `${session.id}:2`, contextWindowId: `${session.id}:0`,
          windowNumber: 0, requestKind: 'turn', model: 'coding', reasoningEffort: 'low' }) },
    })
    const entered = Promise.withResolvers<undefined>()
    const resume = Promise.withResolvers<undefined>()
    summaryAdapter.onCapture = () => { entered.resolve(undefined); return resume.promise }
    summaryAdapter.onStream = (attempt) => {
      if (attempt === 1) return Promise.reject(new LlmError('retry summary', 'PROVIDER'))
      return Promise.resolve()
    }
    const nodes = session.surface.nodes
    const summary = compact.compactRegion(nodes[0]!, nodes.at(-1)!, owner)
    await entered.promise
    summaryAdapter.generation = { name: 'summary-new', window: 800, maxTokens: 200, defaultEffort: 'high' }
    resume.resolve(undefined)
    await summary
    expect(summaryAdapter.captures).toEqual([{ generation: 'summary-old', provider: 'summary-provider', model: 'summary-model' }])
    expect(summaryAdapter.requests.map(request => request.generation)).toEqual(['summary-old', 'summary-old'])
    expect(summaryAdapter.requests[1]?.options).toMatchObject({
      provider: 'summary-provider', model: 'summary-model', reasoningEffort: 'medium', maxTokens: 100,
    })
    expect(summaryAdapter.requests[1]?.options).not.toHaveProperty('codexfulResponses')
    expect(summaryAdapter.liveStreams).toBe(0)
  })

  it('releases turn capture at idle and resolves header defaults and Lite with a fresh summary generation', async () => {
    const { ctx, adapter, compact, session, owner } = await harness()
    await requestEnter(ctx, owner, 2, 1, await ctx.codexyRequests.prepareModel('local', 'coding'))
    session.append('request/header', { reason: 'initial', header: { config: {
      provider: 'local', model: 'coding', reasoningEffort: ReasoningEffortId('low'), maxTokens: 100,
      codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none', lite: true },
    }, adapterDefaults: { reasoningEffort: true, maxTokens: true } } })
    agentEvents(ctx, owner).emit('agent/status', { status: 'idle' })
    adapter.generation = { name: 'new', window: 1_600, maxTokens: 300, defaultEffort: 'high' }
    const nodes = session.surface.nodes
    await compact.compactRegion(nodes[0]!, nodes.at(-1)!, owner)
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({ generation: 'new', options: {
      reasoningEffort: 'high', maxTokens: 300, codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none' },
    } })
    expect(adapter.requests[0]?.options.codexfulResponses).not.toHaveProperty('lite')
    expect(adapter.captures).toHaveLength(2)
  })
})
