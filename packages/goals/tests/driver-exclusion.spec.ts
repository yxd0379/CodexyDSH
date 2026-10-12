/** Real public goal service/driver, synthetic local model; no files or network. */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import GoalService from '@deepseek-ai/dsh-goal'
import * as StockDriver from '@deepseek-ai/dsh-goal-round-driver'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LlmAdapter } from '@codexydsh/runtime/llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@codexydsh/runtime/llm'
import { SessionId } from '@codexydsh/runtime/session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@codexydsh/runtime-testkit'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

class SyntheticModel extends LlmAdapter {
  requests: GenerateOptions[] = []
  onRequest: () => void = () => {}
  override resolveModel(provider: string, id: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id, name: id })
  }
  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    this.onRequest()
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'synthetic complete' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'synthetic complete' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(GoalService)
  await ctx.plugin(StockDriver)
  const model = new SyntheticModel()
  ctx.codexyRequests.registerAdapter(['synthetic'], model)
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId(`goal-exclusion-${contexts.length}`), { provider: 'synthetic', model: 'fixture' })
  return { ctx, agent, model }
}

function ref(ctx: Context, agent: Agent) {
  const current = ctx.goals.get(agent)
  if (current === undefined) throw new Error('Expected real goal')
  return { id: current.id, revision: current.revision }
}

describe('public stock goal-driver exclusion seam', () => {
  it('create then synchronous disarm keeps durable active goal and prevents automatic requests', async () => {
    const { ctx, agent, model } = await setup()
    const created = ctx.goals.create(agent, { objective: 'owned synthetic objective' })
    const disarmed = ctx.goals.disarm(agent)
    expect(disarmed).toMatchObject({ id: created.id, revision: created.revision, phase: 'active', activation: 'disarmed' })
    await tick()
    await tick()
    expect(model.requests).toHaveLength(0)
    expect(agent.inbox.nextTurn).toHaveLength(0)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'goal/change')).toHaveLength(1)
  })

  it('resume then synchronous disarm excludes a stock continuation even across awaited flush', async () => {
    const { ctx, agent, model } = await setup()
    let release: (() => void) | undefined
    let flushes = 0
    ctx.on('session/flush', () => {
      flushes += 1
      return new Promise<void>(resolve => { release = resolve })
    })
    ctx.goals.create(agent, { objective: 'owned synthetic objective' })
    ctx.goals.disarm(agent)
    expect(flushes).toBe(1)
    ctx.goals.pause(agent, ref(ctx, agent))
    ctx.goals.resume(agent, ref(ctx, agent))
    ctx.goals.disarm(agent)
    release?.()
    await tick()
    // Later durable changes may require a second checkpoint, which remains excluded.
    release?.()
    await tick()
    await tick()
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'active', activation: 'disarmed' })
    expect(model.requests).toHaveLength(0)
    expect(agent.inbox.nextTurn).toHaveLength(0)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'goal/change').map(event => event.data.operation)).toEqual(['create', 'pause', 'resume'])
  })

  it('positive control: an armed stock goal really reaches the synthetic model', async () => {
    const { ctx, agent, model } = await setup()
    const reached = new Promise<void>(resolve => {
      model.onRequest = () => {
        ctx.goals.complete(agent, ref(ctx, agent))
        resolve()
      }
    })
    ctx.goals.create(agent, { objective: 'owned synthetic objective' })
    await reached
    await agent.whenIdle()
    await tick()
    expect(model.requests).toHaveLength(1)
    expect(model.requests[0]?.messages.some(message => message.source?.kind === 'goal')).toBe(true)
    expect(ctx.goals.get(agent)).toMatchObject({ phase: 'complete', roundsStarted: 1 })
  })
})
