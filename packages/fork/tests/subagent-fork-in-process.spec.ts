import { snapshotProductEvents } from '@codexydsh/runtime/session'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { AgentLoop } from '@codexydsh/runtime'
import { mountAgentLoopTestDependencies } from '@codexydsh/runtime-testkit'
import SubagentRuntime, { type SubagentStartRequest } from '@codexydsh/delegation'
import { MockAdapter, textResponse, toolCallResponse } from '@codexydsh/runtime-testkit/mock-adapter'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import * as fork from '../src/index.ts'
import { scrubCodexfulForkHistory } from '../src/codexful-context.ts'
import { STRUCTURED_OUTPUT_TOOL } from '@codexydsh/delegation-driver'

type Script = ConstructorParameters<typeof MockAdapter>[0]


function start(ctx: Context, provider: string, request: Omit<SubagentStartRequest, 'signal'> & { signal?: AbortSignal }) {
  return ctx.codexySubagents.start(provider, { signal: request.signal ?? new AbortController().signal, ...request })
}

/** A bare `stop` finish that streams no content → the turn ends `completed`
 * with NO `assistant/message` of its own. */
const emptyStop: StreamChunk[] = [{ type: 'finish', reason: { kind: 'stop' } }]

/**
 * Drives the REAL fork backend with a real loop + scripted mock MODEL + the
 * real invariant service and package companions. The session contribution replays a seeded child log on
 * `session/created`, so a malformed (unbalanced) fork seed makes these tests
 * THROW — that is the regression guard for the completed-turn-prefix boundary.
 */
async function setup(script: Script, options: { codexfulHistory?: true } = {}) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(fork, { providerName: 'fork', ...options })
  const adapter = new MockAdapter(script)
  ctx.codexyRequests.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, parent, adapter }
}

function text(blocks: readonly { type: string; text?: string }[]): string {
  return blocks.filter(b => b.type === 'text').map(b => b.text).join('')
}

describe('dsh-subagent-fork-in-process', () => {
  it('Codexful fork includes the first in-flight user turn and balances its open step', async () => {
    const { ctx, parent, adapter } = await setup(['hang', textResponse('child')], { codexfulHistory: true })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'current task' }], source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    parent.session.append('assistant/output-item', {
      turn: 1, step: 1, index: 0,
      block: { type: 'tool-call', id: ToolCallId('pending-fork'), name: 'spawn_agent', arguments: '{}' },
      provider: 'mock', model: 'mock',
    })
    parent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'inherited agent message' }],
      source: { kind: 'agent-message', form: 'relay', senderSessionId: SessionId('other-agent') },
    }), { surfaceOp: 'append' })
    const inheritedCount = parent.session.snapshotEvents().length
    let run: Awaited<ReturnType<typeof start>> | undefined
    try {
      run = await start(ctx, 'fork', { prompt: [{ type: 'text', text: 'child task' }], parent, forkTurns: 1 })
      await run.result
      const child = ctx.agents.get(run.id)!
      expect(child.session.inheritedEventCount).toBe(inheritedCount)
      expect(child.session.snapshotEvents()[inheritedCount]).toMatchObject({
        type: 'session/end-seed', data: { inherited: true },
      })
      expect(snapshotProductEvents(child.session).some(event => event.type === 'turn/end'
        && event.data.reason.kind === 'forked')).toBe(true)
      expect(child.session.snapshotEvents().slice(inheritedCount).some(event => event.type === 'assistant/message'
        && event.data.interrupted === true)).toBe(true)
      const messages = adapter.requests[1]!.messages
      expect(messages[0]?.role).toBe('system')
      expect(messages.some(message => text(message.content) === 'current task')).toBe(true)
      expect(messages.some(message => text(message.content) === 'child task')).toBe(true)
      expect(messages.some(message => text(message.content) === 'inherited agent message')).toBe(false)
      expect(messages.some(message => message.role === 'system' && text(message.content) === '')).toBe(false)
      expect(messages.every(message => message.role !== 'tool'
        && message.content.every(block => block.type !== 'tool-call'))).toBe(true)
      const childEvents = snapshotProductEvents(child.session)
      const descriptorSeq = childEvents.find(event => event.type === 'subagent/descriptor')?.seq
      expect(descriptorSeq).toBeDefined()
      const retained = child.session.deriveMessages()
      scrubCodexfulForkHistory(child.session, 2, 1, SessionSeq(descriptorSeq!))
      expect(child.session.deriveMessages()).toEqual(retained)
      const invalid = childEvents.map(event => event.type === 'subagent/fork-window'
        ? { ...event, data: { ...event.data, lastNTurns: 0 } }
        : event)
      const restored = Session.create(child.id, invalid, child.session.header, child.session.inheritedEventCount)
      expect(() => { scrubCodexfulForkHistory(restored, 2, 1, SessionSeq(descriptorSeq!)) })
        .toThrow('fork history selection event is invalid')
    } finally {
      parent.cancel({ kind: 'user' })
      await parent.whenIdle()
      if (run !== undefined) await run.dispose()
    }
  })

  it('Codexful fork removes tool and reasoning history while retaining final text and the new task on restore', async () => {
    const finalWithReasoning: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'private reasoning' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'parent final' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const { ctx, parent, adapter } = await setup([
      toolCallResponse('call-parent', 'missing-tool', {}), finalWithReasoning, textResponse('child final'),
    ], { codexfulHistory: true })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'parent task' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    expect(parent.session.deriveMessages().some(message => message.role === 'tool')).toBe(true)
    expect(parent.session.deriveMessages().some(message => message.role === 'assistant'
      && message.content.some(block => block.type === 'reasoning'))).toBe(true)

    const run = await start(ctx, 'fork', { prompt: [{ type: 'text', text: 'child task' }], parent })
    try {
      await run.result
      const child = ctx.agents.get(run.id)!
      const messages = adapter.requests[2]!.messages
      expect(messages.slice(0, 4).map(message => message.role)).toEqual(['system', 'user', 'assistant', 'user'])
      expect(messages[2]?.content).toEqual([{ type: 'text', text: 'parent final' }])
      expect(messages.some(message => text(message.content) === 'child task')).toBe(true)
      const inheritedFinal = child.session.snapshotEvents().slice(0, child.session.inheritedEventCount)
        .find(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'text'
          && block.text === 'parent final'))
      expect(inheritedFinal?.type).toBe('assistant/message')
      if (inheritedFinal?.type !== 'assistant/message') throw new Error('missing inherited final answer')
      expect(JSON.stringify(inheritedFinal.data.stream)).not.toContain('private reasoning')
      const restored = Session.create(child.id, child.session.snapshotEvents(), child.session.header,
        child.session.inheritedEventCount)
      expect(restored.deriveMessages()).toEqual(child.session.deriveMessages())
      expect(restored.surface.nodes[0]).toBe(child.session.surface.nodes[0])
      expect(restored.deriveMessages().some(message => message.role === 'tool'
        || message.role === 'assistant' && message.content.some(block => block.type === 'tool-call' || block.type === 'reasoning'))).toBe(false)
    } finally {
      await run.dispose()
    }
  })

  it('emits subagent/start only after the seeded child is published', async () => {
    const { ctx, parent } = await setup([textResponse('child answer')])
    let childAtStart: ReturnType<typeof ctx.agents.get>
    ctx.on('subagent/start', (info) => {
      if (info.provider === 'fork') childAtStart = ctx.agents.get(info.id)
    })

    const starting = start(ctx, 'fork', { prompt: [{ type: 'text', text: 'child q' }], parent })
    expect(childAtStart).toBeUndefined()
    const run = await starting
    expect(childAtStart).toBe(ctx.agents.get(run.id))
    expect(childAtStart?.id).toBe(run.id)

    await run.result
    await run.dispose()
  })

  it('forks an UNSEEDED (fresh) child when the parent has no completed turn', async () => {
    // The parent has never completed a turn → empty prefix → the provider omits
    // the seed → the child runs fresh. Exercises the `seed.length > 0` false arm.
    const { ctx, parent } = await setup([textResponse('fresh child')])
    const run = await start(ctx, 'fork', { prompt: [{ type: 'text', text: 'child q' }], parent })
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(text(result.output)).toBe('fresh child')
    const child = ctx.agents.get(run.id)!
    // Only the child's own turn — no seeded parent turns.
    expect(snapshotProductEvents(child.session).filter(e => e.type === 'turn/end')).toHaveLength(1)
    expect(child.session.header.isSeeded).toBe(false)
    expect(child.session.inheritedEventCount).toBe(0)
    await run.dispose()
  })

  it('seeds every completed parent turn through the last turn/end', async () => {
    const { ctx, parent } = await setup([textResponse('first'), textResponse('second'), textResponse('child')])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'q1' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'q2' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    const parentPrefixLen = parent.session.snapshotEvents().length

    const run = await start(ctx, 'fork', { prompt: [{ type: 'text', text: 'child q' }], parent })
    await run.result
    const child = ctx.agents.get(run.id)!
    expect(child.session.header.isSeeded).toBe(true)
    expect(child.session.inheritedEventCount).toBe(parentPrefixLen)
    expect(child.session.snapshotEvents().slice(0, parentPrefixLen).at(-1)?.type).toBe('turn/end')
    expect(child.session.snapshotEvents().slice(0, parentPrefixLen).filter(e => e.type === 'turn/end')).toHaveLength(2)
    await run.dispose()
  })

  it('seeds the child with the parent\'s completed-turn prefix (child inherits context)', async () => {
    const { ctx, parent } = await setup([textResponse('parent answer'), textResponse('child answer')])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'parent question' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    const parentPrefixLen = parent.session.snapshotEvents().length

    const run = await start(ctx, 'fork', { prompt: [{ type: 'text', text: 'child question' }], parent })
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(text(result.output)).toBe('child answer')

    const child = ctx.agents.get(run.id)!
    // The child's log STARTS with the parent's prefix (seeded), then its own turn.
    expect(child.session.snapshotEvents().length).toBeGreaterThan(parentPrefixLen)
    // The seeded prefix carried the parent's user message.
    const seededUser = child.session.snapshotEvents().slice(0, parentPrefixLen).find(e => e.type === 'user/message')
    expect(seededUser).toBeDefined()
    // Lineage stamped.
    expect(child.session.header.parentSession).toBe(parent.session.header.id)
    // Logical metadata records lineage while Session state retains the exact
    // inherited cut for reload and replay.
    expect(child.session.header.isSeeded).toBe(true)
    expect(child.session.inheritedEventCount).toBe(parentPrefixLen)
    await run.dispose()
  })

  it('produces an invariant-CLEAN seed: forking mid-turn excludes the open turn', async () => {
    // Drive the parent so it has one completed turn, then start a SECOND turn that is still
    // open (a hanging model call), and fork while it's in flight. The seed must stop after the
    // balanced first turn; including the open turn would fail invariant replay during start.
    const { ctx, parent } = await setup([textResponse('done'), 'hang', textResponse('child')])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'q1' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    // Start a second turn that hangs (open turn/start + open step, never ends).
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'q2' }], source: { kind: 'user' } }))
    await new Promise(r => setTimeout(r, 20)) // let the hanging turn open

    // Forking now must NOT throw (the open second turn is excluded from the seed).
    const run = await start(ctx, 'fork', { prompt: [{ type: 'text', text: 'child q' }], parent })
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(text(result.output)).toBe('child')

    const child = ctx.agents.get(run.id)!
    // The child's seed has exactly the ONE completed parent turn (the open one excluded).
    const seedTurnEnds = snapshotProductEvents(child.session).filter(e => e.type === 'turn/end')
    // 1 from the seeded parent turn + 1 from the child's own completed turn.
    expect(seedTurnEnds.length).toBe(2)

    parent.cancel({ kind: 'user' })
    await run.dispose()
  })

  it('captures structured output through the shipped plugin (seeded child, driver runtime)', async () => {
    const { ctx, parent } = await setup([
      textResponse('parent turn'),
      toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { answer: 9 }),
    ])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'warm up' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    const run = await start(ctx, 'fork', {
      prompt: [{ type: 'text', text: 'report structured' }],
      parent,
      outputSchema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] },
    })
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(result.structured).toEqual({ answer: 9 })
    expect(ctx.tools.get(STRUCTURED_OUTPUT_TOOL)).toBeUndefined()
    await run.dispose()
  })

  it('does NOT return the seeded parent output when the child produces no message of its own', async () => {
    // `readResult` must scan only child-owned events after the seed. The child emits no assistant
    // message, so scanning the whole log would incorrectly return the parent's distinctive text.
    const { ctx, parent } = await setup([textResponse('parent stale'), emptyStop])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'parent question' }], source: { kind: 'user' } }))
    await parent.whenIdle()

    const run = await start(ctx, 'fork', { prompt: [{ type: 'text', text: 'child question' }], parent })
    const result = await run.result
    // The child completed its own (empty) turn — completed, but with NO output
    // borrowed from the seeded parent prefix.
    expect(result.stopReason).toBe('completed')
    expect(result.output).toEqual([])
    await run.dispose()
  })

  it('advertises every start-time capability', async () => {
    const { ctx } = await setup([])
    expect(ctx.codexySubagents.getProvider('fork')!.capabilities).toEqual({
      agentOptions: true,
      outputSchema: true,
      depthLimit: true,
      toolFilter: true,
      persona: true,
    })
  })

  it('unregisters the provider when its fiber is disposed (HMR safety)', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    const fiber = await ctx.plugin(fork, { providerName: 'fork' })
    expect(ctx.codexySubagents.list()).toEqual(['fork'])
    await fiber.dispose()
    expect(ctx.codexySubagents.list()).toEqual([])
  })

  it('contributes the completed-turn prefix as a continuable child\'s seed', async () => {
    const { ctx, parent } = await setup([textResponse('parent turn'), textResponse('child answer')])
    const provider = ctx.codexySubagents.getProvider('fork')!
    const signal = new AbortController().signal

    // Before any completed parent turn there is nothing to inherit, so the
    // child starts fresh rather than carrying an empty seed.
    const fresh = await provider.prepareContinuable!({
      sessionId: SessionId('continuable-fresh'),
      parent,
      signal,
    })
    expect(fresh.seed).toBeUndefined()

    // Complete one parent turn, then the prefix is captured once at creation.
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    const seeded = await provider.prepareContinuable!({
      sessionId: SessionId('continuable-seeded'),
      parent,
      signal,
    })
    expect(seeded.seed).toBeDefined()
    const lastSeeded = seeded.seed!.at(-1)
    // The seed ends at a completed turn, so it replays as a valid child log.
    expect(lastSeeded?.type).toBe('turn/end')
    expect(seeded.seed!.map(event => event.seq)).toEqual(seeded.seed!.map((_event, index) => index))
  })

  it('has the namespace-plugin export shape (no stray default)', () => {
    expect('default' in fork).toBe(false)
    expect(fork.name).toBe('subagent-fork-in-process')
    expect(fork.inject).toEqual(['agentLoop', 'codexySubagents'])
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(fork) as Record<string, unknown>
    expect(unwrapped).toBe(fork)
    expect(unwrapped.name).toBe('subagent-fork-in-process')
    expect(unwrapped.inject).toEqual(['agentLoop', 'codexySubagents'])
    expect(typeof unwrapped.apply).toBe('function')
  })
})
