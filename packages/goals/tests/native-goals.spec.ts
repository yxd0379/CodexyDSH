/** Real public goals/driver/tools + owned loop; all model streams are synthetic in-memory fixtures. */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import GoalService from '@deepseek-ai/dsh-goal'
import * as StockDriver from '@deepseek-ai/dsh-goal-round-driver'
import type { Agent } from '@codexydsh/runtime/agent'
import { LlmAdapter, LlmError, ToolCallId, createUserMessage } from '@codexydsh/runtime/llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk, TokenUsage } from '@codexydsh/runtime/llm'
import { Session, SessionId, SessionLogOffset, appendProductEvent, snapshotProductEvents } from '@codexydsh/runtime/session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@codexydsh/runtime-testkit'
import NativeGoals, { chargeableTokens, readGoalFacts } from '../src/index.ts'
import type { Config, GoalClock, NativeGoalResult } from '../src/index.ts'
import { goalSteering } from '../src/continuation.ts'
import { defineTool } from '@codexydsh/tool-schema'
import { encodeArtifactHeader, encodeArtifactEvents, decodeCodexyArtifact } from '../../runtime/src/persistence-codec.ts'
import { CREATE_GOAL_DESCRIPTION, GET_GOAL_DESCRIPTION, UPDATE_GOAL_DESCRIPTION } from '../src/spec.ts'

const contexts: Context[] = []
const barriers: (() => void)[] = []
afterEach(async () => {
  for (const release of barriers.splice(0)) release()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
class Clock implements GoalClock {
  now = 0
  wall = 1_790_000_000_000
  monotonic() { return this.now }
  epoch() { return this.wall }
  advance(ms: number) { this.now += ms; this.wall += ms }
}
const DEFAULT_USAGE = { inputTokens: 8, outputTokens: 2, cacheReadTokens: 90, cacheWriteTokens: 5, reasoningTokens: 1, totalTokens: 105 }
class SyntheticModel extends LlmAdapter {
  requests: GenerateOptions[] = []
  handler: (request: GenerateOptions, index: number) => AsyncIterable<StreamChunk> = () => text(DEFAULT_USAGE)
  override resolveModel(provider: string, id: string): Promise<LlmResolvedModelInfo> { return Promise.resolve({ provider, id, name: id }) }
  override stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    return this.handler(request, this.requests.length)
  }
}
async function* text(usage: TokenUsage | null, value = 'synthetic progress'): AsyncIterable<StreamChunk> {
  if (value !== '') {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: value }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: value } }
  }
  if (usage !== null) yield { type: 'usage', usage }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
async function setup(config: Config = { enabled: true }) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(GoalService)
  await ctx.plugin(StockDriver)
  const model = new SyntheticModel()
  ctx.codexyRequests.registerAdapter(['synthetic'], model)
  const clock = new Clock()
  class FixtureGoals extends NativeGoals { constructor(context: Context) { super(context, config, clock) } }
  const fiber = await ctx.plugin(FixtureGoals)
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId(`native-goal-${contexts.length}`), { provider: 'synthetic', model: 'fixture' })
  return { ctx, agent, model, clock, fiber }
}
async function tool(ctx: Context, agent: Agent | undefined, name: string, args: Record<string, unknown> = {}): Promise<NativeGoalResult> {
  const result = await ctx.codexyTools.execute({ name, arguments: args, agent, signal: new AbortController().signal, callId: ToolCallId(`fixture-${name}`) })
  if (result.isError) throw new Error(result.error.message)
  return result.value as unknown as NativeGoalResult
}
/** A public checkpoint barrier lets tests independently exercise request accounting without racing auto continuation. */
function park(ctx: Context) {
  let release: () => void = () => {}
  const pending = new Promise<void>(resolve => { release = resolve })
  barriers.push(release)
  ctx.on('session/flush', () => pending)
  return release
}
async function request(ctx: Context, agent: Agent, extra: Partial<GenerateOptions> = {}) {
  const chunks: StreamChunk[] = []
  for await (const chunk of ctx.codexyRequests.stream({ provider: 'synthetic', model: 'fixture', messages: [], sessionId: agent.id, ...extra })) chunks.push(chunk)
  return chunks
}

describe('native goal tools', () => {
  it('default is opt-out; explicit enable registers exactly the pinned native schemas', async () => {
    const disabled = await setup({})
    expect(disabled.ctx.codexyTools.get('get_goal')).toBeUndefined()
    const { ctx } = await setup()
    const schemas = ctx.codexyTools.schemas().filter(schema => ['get_goal', 'create_goal', 'update_goal'].includes(schema.name))
    expect(schemas.map(schema => schema.name)).toEqual(['get_goal', 'create_goal', 'update_goal'])
    expect(schemas.map(schema => schema.description)).toEqual([GET_GOAL_DESCRIPTION, CREATE_GOAL_DESCRIPTION, UPDATE_GOAL_DESCRIPTION])
    expect(schemas[0]?.parameters).toEqual({ type: 'object', properties: {}, required: [], additionalProperties: false })
    expect(schemas[1]?.parameters).toMatchObject({ additionalProperties: false, required: ['objective'], properties: { objective: { type: 'string' }, token_budget: { type: 'integer' } } })
    expect(schemas[2]?.parameters).toMatchObject({ additionalProperties: false, required: ['status'], properties: { status: { type: 'string', enum: ['complete', 'blocked', 'paused'] } } })
    await expect(tool(ctx, undefined, 'get_goal')).rejects.toThrow('persistent thread')
  })

  it('a mounted default-off plugin leaves the real stock driver and lifecycle unchanged', async () => {
    const { ctx, agent, model } = await setup({})
    model.handler = () => (async function* () {
      const goal = ctx.goals.get(agent)!
      ctx.goals.complete(agent, { id: goal.id, revision: goal.revision })
      yield* text(DEFAULT_USAGE)
    })()
    ctx.goals.create(agent, { objective: 'stock goal remains real' })
    await tick(); await agent.whenIdle()
    expect(model.requests).toHaveLength(1)
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'complete', roundsStarted: 1 })
    expect(snapshotProductEvents(agent.session).some(event => event.type === 'codexy/goal-state')).toBe(false)
    expect(() => ctx.codexyGoals.create(agent, 'disabled')).toThrow('not enabled')
  })

  it('the public production Config/plugin mounts enabled without a made-up token ceiling', async () => {
    expect(NativeGoals.Config({ enabled: true })).toEqual({ enabled: true })
    const { ctx, fiber } = await setup({})
    await fiber.dispose()
    const enabled = await ctx.plugin(NativeGoals, { enabled: true })
    expect(ctx.codexyTools.get('create_goal')).toBeDefined()
    await enabled.dispose()
  })

  it('real create/get/update retain stock durable UI state, replace only complete goals and report omitted unlimited budget', async () => {
    const { ctx, agent, model } = await setup()
    const release = park(ctx)
    expect(await tool(ctx, agent, 'get_goal')).toEqual({ goal: null, remainingTokens: null, completionBudgetReport: null })
    const created = await tool(ctx, agent, 'create_goal', { objective: '  preserved objective  ' })
    expect(created.goal).toMatchObject({ threadId: agent.id, objective: 'preserved objective', status: 'active', tokensUsed: 0, timeUsedSeconds: 0 })
    expect(created.goal).not.toHaveProperty('tokenBudget')
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'active', activation: 'disarmed', roundsStarted: 0 })
    await expect(tool(ctx, agent, 'create_goal', { objective: 'must not replace' })).rejects.toThrow()
    await expect(tool(ctx, agent, 'update_goal', { status: 'active' })).rejects.toThrow()
    expect((await tool(ctx, agent, 'update_goal', { status: 'paused' })).goal?.status).toBe('paused')
    expect(ctx.goals.get(agent)?.phase).toBe('paused')
    const done = await tool(ctx, agent, 'update_goal', { status: 'complete' })
    expect(done.goal?.status).toBe('complete')
    expect(done.completionBudgetReport).toBeNull()
    await tool(ctx, agent, 'create_goal', { objective: 'actual successor' })
    await tool(ctx, agent, 'update_goal', { status: 'blocked' })
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'blocked', blockedReason: { code: 'model-reported-blocked' } })
    release()
    await tick()
    expect(model.requests).toHaveLength(0)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'goal/change')).toHaveLength(5)
  })

  it('validates a real token budget separately from stock rounds and supports human-only budget replacement/resume', async () => {
    const { ctx, agent } = await setup({ enabled: true, maxGoalTokenBudget: 20 })
    const release = park(ctx)
    await expect(tool(ctx, agent, 'create_goal', { objective: 'x', token_budget: 0 })).rejects.toThrow()
    await expect(tool(ctx, agent, 'create_goal', { objective: 'x', token_budget: 21 })).rejects.toThrow()
    await expect(tool(ctx, agent, 'create_goal', { objective: ' '.repeat(2) })).rejects.toThrow()
    await expect(tool(ctx, agent, 'create_goal', { objective: 'x'.repeat(4001) })).rejects.toThrow()
    expect((await tool(ctx, agent, 'create_goal', { objective: 'real budget' })).goal?.tokenBudget).toBe(20)
    await request(ctx, agent)
    await request(ctx, agent)
    expect(ctx.codexyGoals.get(agent)).toMatchObject({ goal: { status: 'budgetLimited', tokensUsed: 20 }, remainingTokens: 0 })
    expect((await tool(ctx, agent, 'update_goal', { status: 'paused' })).goal?.status).toBe('budgetLimited')
    expect(ctx.codexyGoals.resume(agent).goal?.status).toBe('budgetLimited')
    expect(ctx.codexyGoals.resume(agent, null).goal).toMatchObject({ status: 'active', tokensUsed: 20 })
    ctx.codexyGoals.update(agent, 'complete')
    release()
  })

  it('bridges stopped phase changes using public same-stack transitions, without a stock continuation', async () => {
    const { ctx, agent, model } = await setup()
    const release = park(ctx)
    ctx.codexyGoals.create(agent, 'same native goal')
    const id = ctx.goals.get(agent)!.id
    ctx.codexyGoals.update(agent, 'paused')
    expect(ctx.codexyGoals.update(agent, 'blocked').goal?.status).toBe('blocked')
    expect(ctx.codexyGoals.update(agent, 'paused').goal?.status).toBe('paused')
    expect(ctx.goals.get(agent)).toMatchObject({ id, phase: 'paused', activation: 'disarmed' })
    ctx.codexyGoals.update(agent, 'complete')
    expect(ctx.codexyGoals.update(agent, 'complete').goal?.status).toBe('complete')
    expect(() => ctx.codexyGoals.update(agent, 'paused')).toThrow('cannot reopen')
    release(); await tick()
    expect(model.requests).toHaveLength(0)
  })
})

describe('durable native accounting', () => {
  it('counts uncached input + output once, preserves raw cache/reasoning/total and atomically restores the settlement', async () => {
    const { ctx, agent, clock } = await setup()
    const release = park(ctx)
    ctx.codexyGoals.create(agent, 'real accounting', 100)
    clock.advance(1499)
    await request(ctx, agent)
    clock.advance(502)
    const result = ctx.codexyGoals.get(agent)
    expect(result).toMatchObject({ goal: { tokensUsed: 10, timeUsedSeconds: 2 }, remainingTokens: 90 })
    expect(chargeableTokens(DEFAULT_USAGE)).toBe(10)
    const facts = snapshotProductEvents(agent.session).filter(event => event.type === 'codexy/goal-request')
    expect(facts).toHaveLength(2)
    expect(facts[1]?.data).toMatchObject({ phase: 'end', outcome: 'ended', usage: DEFAULT_USAGE, state: { tokensObserved: 10 } })
    const restored = Session.fromRestore(agent.id, agent.session.snapshotEvents(), agent.session.header, SessionLogOffset(0), 'detached')
    expect(readGoalFacts(restored)).toMatchObject({ state: { tokensObserved: 10, timeUsedMilliseconds: 2001 }, unfinishedRequests: 0 })
    ctx.codexyGoals.update(agent, 'paused')
    clock.advance(9999)
    expect(ctx.codexyGoals.get(agent).goal?.timeUsedSeconds).toBe(2)
    ctx.codexyGoals.resume(agent)
    clock.advance(999)
    const done = ctx.codexyGoals.update(agent, 'complete')
    expect(done.goal?.timeUsedSeconds).toBe(3)
    expect(done.completionBudgetReport).toContain('structured goal fields')
    release()
  })

  it('counts actual failure/retry and compaction streams without double-counting committed assistant events', async () => {
    const { ctx, agent, model } = await setup()
    const release = park(ctx)
    ctx.codexyGoals.create(agent, 'all requests', 100)
    model.handler = (_request, index) => index === 1 ? (async function* () {
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 1 } } as const
      throw new Error('synthetic transport failure')
    })() : text(DEFAULT_USAGE)
    expect((await request(ctx, agent)).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
    await request(ctx, agent)
    await request(ctx, agent, { purpose: 'compaction' })
    expect(ctx.codexyGoals.get(agent).goal?.tokensUsed).toBe(24)
    const settlements = snapshotProductEvents(agent.session).filter(event => event.type === 'codexy/goal-request' && event.data.phase === 'end')
    expect(settlements.map(event => event.data)).toMatchObject([{ outcome: 'error' }, { outcome: 'ended' }, { purpose: 'compaction' }])
    ctx.codexyGoals.update(agent, 'complete')
    release()
  })

  it('makes unknown usage visible instead of reporting invented zero or fabricated remaining tokens', async () => {
    const { ctx, agent, model } = await setup()
    const release = park(ctx)
    ctx.codexyGoals.create(agent, 'unknown usage', 100)
    model.handler = () => text(null)
    await request(ctx, agent)
    expect(ctx.codexyGoals.get(agent)).toMatchObject({ goal: { status: 'active', tokensUsed: null }, remainingTokens: null,
      accountingDiagnostics: ['request-token-usage-unavailable'] })
    expect(readGoalFacts(agent.session).state?.tokensObserved).toBe(0)
    ctx.codexyGoals.update(agent, 'complete')
    release()
  })

  it('Plan mode does not spend tokens and descendant actual requests join the loaded ancestor goal', async () => {
    const { ctx, agent, model, clock } = await setup()
    const release = park(ctx)
    ctx.codexyGoals.create(agent, 'root goal', 100)
    agent.session.append('codexy/fact', { type: 'plan/mode', data: { active: true } })
    model.handler = () => { clock.advance(5000); return text(DEFAULT_USAGE) }
    await request(ctx, agent)
    expect(ctx.codexyGoals.get(agent).goal?.tokensUsed).toBe(0)
    expect(ctx.codexyGoals.get(agent).goal?.timeUsedSeconds).toBe(0)
    agent.session.append('codexy/fact', { type: 'plan/mode', data: { active: false } })
    model.handler = () => text(DEFAULT_USAGE)
    const child = await ctx.agents.create({ sessionId: SessionId('actual-goal-child'), parentAgent: agent,
      meta: { parentSession: agent.id, origin: 'subagent' }, agentOptions: { provider: 'synthetic', model: 'fixture' } })
    await request(ctx, child.agent)
    expect(ctx.codexyGoals.get(agent).goal?.tokensUsed).toBe(10)
    child.agent.session.append('codexy/fact', { type: 'plan/mode', data: { active: true } })
    await request(ctx, child.agent)
    expect(ctx.codexyGoals.get(agent).goal?.tokensUsed).toBe(20)
    const last = snapshotProductEvents(agent.session).filter(event => event.type === 'codexy/goal-request').at(-1)
    expect(last?.data).toMatchObject({ sourceSessionId: child.agent.id, accountTokens: true })
    ctx.codexyGoals.update(agent, 'complete')
    release()
    await child.dispose()
  })

  it('clean effect unload + full artifact/factory restore retain counters and exclude offline time', async () => {
    const initial = await setup()
    const release = park(initial.ctx)
    initial.ctx.codexyGoals.create(initial.agent, 'same durable goal', 100)
    initial.clock.advance(1500)
    await request(initial.ctx, initial.agent)
    const stopping = initial.fiber.dispose()
    release()
    await stopping
    const originalEvents = initial.agent.session.snapshotEvents()
    const bytes = encodeArtifactHeader({ kind: 'codexy-session', version: 1, session: initial.agent.session.header, inheritedEventCount: SessionLogOffset(0) }) + encodeArtifactEvents(originalEvents)
    const decoded = decodeCodexyArtifact(Buffer.from(bytes))
    const resumed = await setup()
    const releaseResumed = park(resumed.ctx)
    resumed.clock.advance(900_000)
    const handle = await resumed.ctx.agents.create({ sessionId: initial.agent.id, seed: decoded.events,
      agentOptions: { provider: 'synthetic', model: 'fixture' } })
    expect(resumed.ctx.codexyGoals.get(handle.agent)).toMatchObject({ goal: { status: 'active', tokensUsed: 10, timeUsedSeconds: 1 }, remainingTokens: 90 })
    resumed.clock.advance(500)
    expect(resumed.ctx.codexyGoals.get(handle.agent).goal?.timeUsedSeconds).toBe(2)
    await request(resumed.ctx, handle.agent)
    expect(resumed.ctx.codexyGoals.get(handle.agent).goal?.tokensUsed).toBe(20)
    resumed.ctx.codexyGoals.update(handle.agent, 'complete')
    releaseResumed()
    await handle.dispose()
    // Neither codec nor reconstruction changes the source's existing prefix.
    expect(initial.agent.session.snapshotEvents().slice(0, originalEvents.length)).toEqual(originalEvents)
  })

  it('unclean active-state restore reports unknown elapsed time and an unfinished request without losing observed counters', async () => {
    const initial = await setup()
    const release = park(initial.ctx)
    initial.ctx.codexyGoals.create(initial.agent, 'interrupted real accounting', 100)
    await request(initial.ctx, initial.agent)
    const goalId = readGoalFacts(initial.agent.session).state!.goalId
    appendProductEvent(initial.agent.session, 'codexy/goal-request', { version: 1, phase: 'start', goalId,
      requestId: 'unfinished-synthetic-request', sourceSessionId: initial.agent.id, purpose: 'conversation', accountTokens: true })
    const seeded = initial.agent.session.snapshotEvents()
    const resumed = await setup()
    const releaseResumed = park(resumed.ctx)
    const handle = await resumed.ctx.agents.create({ sessionId: initial.agent.id, seed: seeded, agentOptions: { provider: 'synthetic', model: 'fixture' } })
    expect(resumed.ctx.codexyGoals.get(handle.agent)).toMatchObject({ goal: { tokensUsed: null, timeUsedSeconds: null }, remainingTokens: null,
      accountingDiagnostics: ['interrupted-request-usage-unavailable', 'unclean-restart-elapsed-time-unavailable'] })
    expect(readGoalFacts(handle.agent.session)).toMatchObject({ state: { tokensObserved: 10 }, unfinishedRequests: 1 })
    resumed.ctx.codexyGoals.update(handle.agent, 'complete')
    initial.ctx.codexyGoals.update(initial.agent, 'complete')
    releaseResumed(); release()
    await handle.dispose()
  })

  it('consumer abort closes the exact request, keeps reported usage, and does not count a future request', async () => {
    const { ctx, agent, model } = await setup()
    const release = park(ctx)
    ctx.codexyGoals.create(agent, 'aborted accounting', 100)
    model.handler = () => (async function* () {
      yield { type: 'usage', usage: DEFAULT_USAGE } as const
      yield* text(null)
    })()
    for await (const _chunk of ctx.codexyRequests.stream({ provider: 'synthetic', model: 'fixture', messages: [], sessionId: agent.id })) break
    expect(ctx.codexyGoals.get(agent).goal?.tokensUsed).toBe(10)
    expect(snapshotProductEvents(agent.session).filter(event => event.type === 'codexy/goal-request').at(-1)?.data).toMatchObject({ outcome: 'aborted', usage: DEFAULT_USAGE })
    expect(readGoalFacts(agent.session).unfinishedRequests).toBe(0)
    ctx.codexyGoals.update(agent, 'complete')
    release()
  })
})

describe('native continuation owner', () => {
  it('creation-request usage is excluded using the actual model/tool loop, not a fabricated accounting baseline', async () => {
    const { ctx, agent, model } = await setup()
    model.handler = (_request, index) => (async function* () {
      if (index === 1) {
        const call = { type: 'tool-call' as const, id: ToolCallId('create-actual-goal'), name: 'create_goal', arguments: JSON.stringify({ objective: 'actual model-created goal', token_budget: 100 }) }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments }
        yield { type: 'block-end', index: 0, block: call }
        yield { type: 'usage', usage: { inputTokens: 500, outputTokens: 100 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } else {
        yield* text(DEFAULT_USAGE)
        ctx.codexyGoals.update(agent, 'complete')
      }
    })()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Synthetic explicit goal request' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await tick()
    expect(model.requests).toHaveLength(2)
    expect(ctx.codexyGoals.get(agent).goal).toMatchObject({ objective: 'actual model-created goal', status: 'complete', tokensUsed: 10, tokenBudget: 100 })
    expect(snapshotProductEvents(agent.session).filter(event => event.type === 'codexy/goal-request')).toHaveLength(2)
  })

  it('continues through the owned loop only, exact pinned objective escaping, with real accounting and no stock rounds', async () => {
    const { ctx, agent, model } = await setup()
    model.handler = (_request, index) => (async function* () {
      yield* text(DEFAULT_USAGE)
      if (index === 2) ctx.codexyGoals.update(agent, 'complete')
    })()
    ctx.codexyGoals.create(agent, '<objective>& full scope', 100)
    for (let i = 0; i < 12 && ctx.codexyGoals.get(agent).goal?.status === 'active'; i++) { await tick(); await agent.whenIdle() }
    expect(model.requests).toHaveLength(2)
    expect(ctx.codexyGoals.get(agent)).toMatchObject({ goal: { status: 'complete', tokensUsed: 20 }, remainingTokens: 80 })
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'complete', roundsStarted: 0, activation: 'disarmed' })
    const content = model.requests[0]?.messages.flatMap(message => message.content).find(block => block.type === 'text' && block.text.includes('<codex_internal_context'))
    expect(content?.type === 'text' && content.text).toContain('&lt;objective&gt;&amp; full scope')
    expect(content?.type === 'text' && content.text).not.toContain('Progress visibility:')
    const state = readGoalFacts(agent.session).state!
    expect(goalSteering('<objective>& full scope', state, 'continuation', true)).toContain('Progress visibility:')
  })

  it('budget stop allows one wrap-up step, never hard-cancels the turn, and requires real resume to continue', async () => {
    const { ctx, agent, model } = await setup()
    let cancellations = 0
    ctx.on('agent/cancelled', () => { cancellations++ })
    ctx.codexyTools.register(defineTool({ name: 'goal_fixture_step', description: 'Actual synthetic step', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, async execute() { return 'verified step' } }))
    model.handler = (_request, index) => index === 1 ? (async function* () {
      const call = { type: 'tool-call' as const, id: ToolCallId('budget-step'), name: 'goal_fixture_step', arguments: '{}' }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments }
      yield { type: 'block-end', index: 0, block: call }
      yield { type: 'usage', usage: DEFAULT_USAGE }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })() : text(DEFAULT_USAGE)
    ctx.codexyGoals.create(agent, 'budget wrap-up', 10)
    for (let i = 0; i < 8; i++) { await tick(); await agent.whenIdle() }
    expect(model.requests).toHaveLength(2)
    expect(cancellations).toBe(0)
    expect(ctx.codexyGoals.get(agent)).toMatchObject({ goal: { status: 'budgetLimited', tokensUsed: 20 }, remainingTokens: 0 })
    expect(model.requests[1]?.messages.flatMap(message => message.content).some(block => block.type === 'text' && block.text.includes('do not start new substantive work'))).toBe(true)
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'paused', activation: 'disarmed', roundsStarted: 0 })
  })

  it('a budget-limited text-only turn closes without inventing an extra wrap-up request', async () => {
    const { ctx, agent, model } = await setup()
    ctx.codexyGoals.create(agent, 'text only budget', 10)
    await tick(); await agent.whenIdle(); await tick()
    expect(model.requests).toHaveLength(1)
    expect(ctx.codexyGoals.get(agent)).toMatchObject({ goal: { status: 'budgetLimited', tokensUsed: 10 } })
  })

  it('does not fabricate progress: three empty automatic turns stop blocked with a durable diagnostic', async () => {
    const { ctx, agent, model } = await setup()
    model.handler = () => text(DEFAULT_USAGE, '')
    ctx.codexyGoals.create(agent, 'requires actual progress')
    for (let i = 0; i < 12 && ctx.codexyGoals.get(agent).goal?.status === 'active'; i++) { await tick(); await agent.whenIdle() }
    expect(model.requests).toHaveLength(3)
    expect(ctx.codexyGoals.get(agent)).toMatchObject({ goal: { status: 'blocked', tokensUsed: 30 }, accountingDiagnostics: ['repeated-empty-auto-turn'] })
  })

  it('three actual exec failures without success block; denied calls are not fabricated dispatch failures', async () => {
    const { ctx, agent, model } = await setup()
    let executions = 0
    ctx.codexyTools.register(defineTool({ name: 'exec_command', description: 'Synthetic executable backend', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { executions++; throw new Error('actual synthetic body failure') } }))
    model.handler = (_request, index) => (async function* () {
      await ctx.codexyTools.execute({ name: 'exec_command', arguments: {}, agent, signal: new AbortController().signal, callId: ToolCallId(`exec-${index}`) })
      yield* text(DEFAULT_USAGE)
    })()
    ctx.codexyGoals.create(agent, 'verified execution failure')
    for (let i = 0; i < 12 && ctx.codexyGoals.get(agent).goal?.status === 'active'; i++) { await tick(); await agent.whenIdle() }
    expect(executions).toBe(3)
    expect(ctx.codexyGoals.get(agent)).toMatchObject({ goal: { status: 'blocked' }, accountingDiagnostics: ['repeated-exec-failure'] })
  })

  it('pre-dispatch denials do not increment executed-failure counters', async () => {
    const { ctx, agent, model } = await setup()
    let executions = 0
    ctx.codexyTools.register(defineTool({ name: 'exec_command', description: 'Synthetic body must not run', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { executions++; throw new Error('must not dispatch') } }))
    ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'deny', reason: 'synthetic denied' }))
    model.handler = (_request, index) => (async function* () {
      await ctx.codexyTools.execute({ name: 'exec_command', arguments: {}, agent, signal: new AbortController().signal, callId: ToolCallId(`denied-${index}`) })
      yield* text(DEFAULT_USAGE)
      if (index === 3) ctx.codexyGoals.update(agent, 'complete')
    })()
    ctx.codexyGoals.create(agent, 'denied is not executed')
    for (let i = 0; i < 12 && ctx.codexyGoals.get(agent).goal?.status === 'active'; i++) { await tick(); await agent.whenIdle() }
    expect(executions).toBe(0)
    expect(readGoalFacts(agent.session).state?.execFailureTurns).toBe(0)
    expect(ctx.codexyGoals.get(agent).goal?.status).toBe('complete')
  })

  it('terminal quota stops usageLimited; transient retry streams alone do not change goal status', async () => {
    const { ctx, agent, model } = await setup()
    model.handler = () => (async function* () { throw new LlmError('synthetic quota', 'QUOTA') })()
    ctx.codexyGoals.create(agent, 'real terminal quota')
    await tick()
    await agent.whenIdle()
    expect(model.requests).toHaveLength(1)
    expect(ctx.codexyGoals.get(agent).goal?.status).toBe('usageLimited')
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'paused', activation: 'disarmed' })
  })

  it('effect unload removes tools and pending native continuation without starting a stock request', async () => {
    const { ctx, agent, model, fiber } = await setup()
    const release = park(ctx)
    ctx.codexyGoals.create(agent, 'owned goal pending checkpoint')
    const disposed = fiber.dispose()
    release()
    await disposed
    await tick()
    expect(ctx.codexyTools.get('get_goal')).toBeUndefined()
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'active', activation: 'disarmed' })
    expect(model.requests).toHaveLength(0)
    expect(readGoalFacts(agent.session).state?.clockRunning).toBe(false)
  })
})
