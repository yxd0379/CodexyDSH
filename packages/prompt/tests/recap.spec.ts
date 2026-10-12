import { installModelSelection } from '@codexydsh/runtime/agent'
import { requestHeaderOf } from '@codexydsh/runtime/session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import Commands from '@deepseek-ai/dsh-commands'
import type { CommandExecution } from '@deepseek-ai/dsh-commands'
import LlmRuntime, { createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage, LlmAdapter, ReasoningEffortId, ToolCallId } from '@codexydsh/runtime/llm'
import type { GenerateOptions, LlmResolvedModelInfo, PreparedAdapterCall, StreamChunk } from '@codexydsh/runtime/llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import type { SessionSearchPage, SessionSearchHit, SessionEventSearchPage } from '@deepseek-ai/dsh-session-query'
import { mountAgentLoopTestDependencies } from '@codexydsh/runtime-testkit'
import { projectProductEvents } from '@codexydsh/runtime/events'
import SystemPrompt from '@codexydsh/runtime/prompt'
import * as Recap from '../src/recap.ts'

class ObservationQuery extends SessionQuery {
  override async searchSessions(): Promise<SessionSearchPage<SessionSearchHit>> { throw new Error('search is outside this fixture') }
  override async searchEvents(): Promise<SessionEventSearchPage> { throw new Error('search is outside this fixture') }
}

const contexts: Context[] = []
const releaseHeld: Array<() => void> = []
afterEach(async () => {
  for (const release of releaseHeld.splice(0)) release()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.useRealTimers()
})

function textStream(text: string, finish = true): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } }, ...finish ? [{ type: 'finish' as const, reason: { kind: 'stop' as const } }] : []]
}

class RecapAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  readonly entered = Promise.withResolvers<GenerateOptions>()
  output = JSON.stringify({ summary: 'Implemented the core request and preserved the main conversation. Validation is still pending.', next_action: 'Run the focused checks.' })
  chunks: StreamChunk[] | undefined
  gate: Promise<void> | undefined
  captured = 0
  dispatched = 0
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, inputModalities: ['text'],
      reasoning: { efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }], defaultEffort: ReasoningEffortId('low') } }
  }
  override async prepareCall(provider: string, model: string): Promise<PreparedAdapterCall> {
    this.captured++
    const info = await this.resolveModel(provider, model)
    return { model: info, stream: options => this.boundStream(options) }
  }
  override stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('The unbound stream must not be used after preparation.')
  }
  private async *boundStream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.dispatched++
    this.calls.push(options)
    this.entered.resolve(options)
    if (this.gate !== undefined) await this.gate
    yield* this.chunks ?? textStream(this.output)
  }
}

function hold(adapter: RecapAdapter): PromiseWithResolvers<undefined> {
  const release = Promise.withResolvers<undefined>()
  adapter.gate = release.promise
  releaseHeld.push(() => { release.resolve(undefined) })
  return release
}

function expectError(execution: CommandExecution | undefined, detail: string): void {
  expect(execution?.result.kind).toBe('error')
  expect(execution?.result.text).toContain(detail)
}

async function harness(config: Recap.Config = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Commands)
  await ctx.plugin(ObservationQuery)
  const adapter = new RecapAdapter()
  ctx.codexyRequests.registerAdapter(['route', 'new-route'], adapter)
  const session = ctx.sessions.create(SessionId('recap-test'))
  const agent = { id: session.id, session, options: { provider: 'route', model: 'original-model' } } as Agent
  const scope = createScope(ctx, agent)
  Object.assign(agent, { ctx: scope.ctx })
  const fiber = await ctx.plugin(Recap, config)
  const events = async () => {
    using observation = await ctx.sessionQuery.observeSession(session.id, { projectionMode: 'none' })
    return projectProductEvents(observation.events)
  }
  const question = (text = 'Implement the feature.') => session.append('user/message',
    createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
  const answer = () => session.append('assistant/message', { turn: 1, step: 1,
    message: createAssistantMessage({ source: { provider: 'route', model: 'original-model' }, content: [{ type: 'text', text: 'Core implementation is done, checks are pending.' }] }), stream: [] }, { surfaceOp: 'append' })
  const run = (signal = new AbortController().signal, line = '/recap') => ctx.commands.execute(agent, line, [], signal)
  return { ctx, adapter, agent, session, fiber, events, question, answer, run, scope }
}

describe('independent task recap command', () => {
  it('logs the exact prepared no-tool request and returns a durable result without changing the main surface', async () => {
    const h = await harness({ maxOutputTokens: 2_048 })
    const user = h.question()
    const answer = h.answer()
    const before = h.session.surface.nodes
    const execution = await h.run()
    expect(execution?.result.kind).toBe('success')
    expect(execution?.result.text).toContain('Validation is still pending.')
    const events = await h.events()
    const request = events.find(event => event.type === 'recap/request')
    expect(request?.data).toMatchObject({ commandId: execution?.commandId,
      config: { provider: 'route', model: 'original-model', temperature: 0, maxTokens: 2_048, reasoningEffort: 'low' },
      tools: [], sourceEventSeqs: [user.seq, answer.seq] })
    expect(h.adapter.calls[0]).toMatchObject({ ...request?.type === 'recap/request' ? request.data.config : {},
      tools: [], messages: request?.type === 'recap/request' ? request.data.messages : undefined })
    expect(h.adapter.calls[0]?.messages.slice(0, -1)).toEqual([user.data, answer.data.message])
    expect(h.adapter.calls[0]?.messages.at(-1)).toMatchObject({ role: 'user' })
    expect(h.adapter.calls[0]?.messages.at(-1)).not.toHaveProperty('source')
    expect(h.adapter.calls[0]?.messages.at(-1)).not.toHaveProperty('id')
    expect(h.adapter.captured).toBe(1)
    expect(h.adapter.dispatched).toBe(1)
    expect(events.filter(event => event.type === 'recap/result')).toHaveLength(1)
    const result = events.find(event => event.type === 'recap/result')
    expect(execution?.result).toMatchObject({ sourceEventSeq: result?.seq })
    expect(h.session.surface.nodes).toEqual(before)
    expect(events.some(event => event.type === 'turn/start' || event.type === 'request/header')).toBe(false)
    expect(events.filter(event => event.type === 'user/message' || event.type === 'assistant/message')).toEqual([user, answer])
  })

  it('keeps all current instructions, earlier goals, reasoning and tool feedback without a recap input cap', async () => {
    const h = await harness()
    h.session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('Follow the current coding instructions.') }, { surfaceOp: 'append' })
    h.question('EARLIER_GOAL: preserve the complete request context.')
    h.answer()
    for (let index = 0; index < 9; index++) { h.question(`Follow-up ${index}`); h.answer() }
    const callId = ToolCallId('recap-existing-call')
    h.session.append('assistant/message', { turn: 2, step: 1, stream: [],
      message: createAssistantMessage({ source: { provider: 'route', model: 'original-model' },
        content: [{ type: 'reasoning', text: 'Retained reasoning for this tool step.' },
          { type: 'tool-call', id: callId, name: 'exec_command', arguments: '{"cmd":"pwd"}' }] }) }, { surfaceOp: 'append' })
    const call = h.session.append('tool/call', { turn: 2, step: 1, callId, name: 'exec_command', arguments: '{"cmd":"pwd"}' })
    h.session.append('tool/result', { turn: 2, step: 1,
      message: createToolResultMessage({ callId, isError: false, content: [{ type: 'text', text: 'FULL_TOOL_FEEDBACK\n' + 'x'.repeat(40_000) }] }) },
    { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    const before = h.session.deriveMessages()
    expect((await h.run())?.result.kind).toBe('success')
    expect(h.adapter.calls[0]?.messages.slice(0, -1)).toEqual(before)
    expect(JSON.stringify(h.adapter.calls[0]?.messages)).toContain('EARLIER_GOAL')
    expect(h.session.deriveMessages()).toEqual(before)
  })

  it('uses the current compaction summary without resurrecting replaced original messages', async () => {
    const h = await harness()
    const user = h.question('REPLACED_ORIGINAL_QUESTION')
    const answer = h.answer()
    const summary = h.session.append('user/message', createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'CURRENT_COMPACTION_SUMMARY: core implementation is done.' }] }),
    { surfaceOp: { op: 'replace', startSeq: user.seq, endSeq: answer.seq }, sourceEventSeqs: [user.seq, answer.seq] })
    h.question('Continue with validation.')
    expect((await h.run())?.result.kind).toBe('success')
    const request = h.adapter.calls[0]
    expect(JSON.stringify(request?.messages)).toContain('CURRENT_COMPACTION_SUMMARY')
    expect(JSON.stringify(request?.messages)).not.toContain('REPLACED_ORIGINAL_QUESTION')
    expect((await h.events()).find(event => event.type === 'recap/request')?.data).toMatchObject({ sourceEventSeqs: [summary.seq, summary.seq + 1] })
  })

  it('uses a newly selected provider/model before a normal turn updates request/header', async () => {
    const h = await harness()
    h.question()
    h.session.append('request/header', { reason: 'initial',
      header: { config: { provider: 'route', model: 'previous-model', reasoningEffort: ReasoningEffortId('low') } } })
    const selection: ModelSelectionRef = { current: { provider: 'new-route', model: 'selected-model' }, assembled: undefined }
    installModelSelection(h.scope.ctx, selection)
    await h.run()
    expect(h.adapter.calls[0]).toMatchObject({ provider: 'new-route', model: 'selected-model' })
    expect(requestHeaderOf(h.session)?.config.model).toBe('previous-model')
  })

  it('does not carry an unrelated startup model effort into a scoped route override', async () => {
    const h = await harness()
    h.question()
    h.agent.options.reasoningEffort = ReasoningEffortId('high')
    await h.scope.ctx.plugin(Object.assign((ctx: Context) => {
      ctx.effect(() => ctx.codexyPrompt.variable('provider', () => 'new-route'))
      ctx.effect(() => ctx.codexyPrompt.variable('model', () => 'another-model'))
    }, { inject: ['codexyPrompt'] }))
    expect((await h.run())?.result.kind).toBe('success')
    expect(h.adapter.calls[0]).toMatchObject({ provider: 'new-route', model: 'another-model', reasoningEffort: 'low' })
  })

  it('rejects empty history, arguments, and a second concurrent recap before extra model requests', async () => {
    const h = await harness()
    expectError(await h.run(), 'no conversation')
    h.question()
    expectError(await h.run(undefined, '/recap extra'), 'arguments')
    const release = hold(h.adapter)
    const first = h.run()
    await h.adapter.entered.promise
    expectError(await h.run(), 'already')
    release.resolve(undefined)
    await first
    expect(h.adapter.dispatched).toBe(1)
  })

  it.each([
    '{"summary":"","next_action":null}',
    '{"summary":"ok","next_action":null,"extra":"unsupported"}',
    '{"summary":"ok"}',
    '{"summary":4,"next_action":null}',
    'not JSON',
    JSON.stringify({ summary: '😀'.repeat(701), next_action: null }),
    JSON.stringify({ summary: 'ok', next_action: '中'.repeat(201) }),
  ])('records a failed terminal result for invalid response %s', async (output) => {
    const h = await harness()
    h.question()
    h.adapter.output = output
    const execution = await h.run()
    expect(execution?.result.kind).toBe('error')
    const results = (await h.events()).filter(event => event.type === 'recap/result')
    expect(results).toHaveLength(1)
    expect(results[0]?.data).toMatchObject({ commandId: execution?.commandId, outcome: 'failed' })
    const result = results[0]?.data
    expect(typeof (result?.outcome === 'completed' ? undefined : result?.error)).toBe('string')
  })

  it('accepts Unicode character limits and normalizes an empty next action', async () => {
    const h = await harness()
    h.question('用中文回顾任务。')
    h.adapter.output = JSON.stringify({ summary: '  ' + '😀'.repeat(700) + '  ', next_action: '  ' })
    const result = await h.run()
    expect(result?.result).toMatchObject({ kind: 'success', text: '😀'.repeat(700) })
    expect((await h.events()).find(event => event.type === 'recap/result')?.data).toMatchObject({ outcome: 'completed', nextAction: null })
  })

  it('rejects an unexpected tool call without dispatching it', async () => {
    const h = await harness()
    h.question()
    h.adapter.chunks = [{ type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('forbidden'), name: 'exec_command', arguments: '{"cmd":"pwd"}' } },
      { type: 'finish', reason: { kind: 'stop' } }]
    expectError(await h.run(), 'without tools')
    expect((await h.events()).some(event => event.type === 'tool/call')).toBe(false)
  })

  it('rejects output without a successful terminal finish', async () => {
    const h = await harness()
    h.question()
    h.adapter.chunks = textStream(h.adapter.output, false)
    expect((await h.run())?.result.kind).toBe('error')
    expect((await h.events()).find(event => event.type === 'recap/result')?.data).toMatchObject({ outcome: 'failed' })
  })

  it.each(['question', 'answer', 'turn-start', 'turn-end', 'inbox'] as const)('discards a response after %s advances the conversation', async (advance) => {
    const h = await harness()
    h.question()
    const release = hold(h.adapter)
    const pending = h.run()
    await h.adapter.entered.promise
    if (advance === 'question') h.question('New scope.')
    else if (advance === 'answer') h.answer()
    else if (advance === 'turn-start') h.session.append('turn/start', { turn: 1 })
    else if (advance === 'turn-end') h.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    else h.session.append('agent/inbox/spliced', { target: 'next-step', start: 0,
      inserted: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'New queued correction.' }] })] })
    release.resolve(undefined)
    expect((await pending)?.result.kind).toBe('error')
    expect((await h.events()).find(event => event.type === 'recap/result')?.data).toMatchObject({ outcome: 'stale' })
  })

  it('does not invalidate its own log events or a metadata-only rename', async () => {
    const h = await harness()
    h.question()
    const release = hold(h.adapter)
    const pending = h.run()
    await h.adapter.entered.promise
    h.session.append('session/title', { title: 'A new human title', source: { kind: 'user' }, messageSeqs: [] })
    release.resolve(undefined)
    expect((await pending)?.result.kind).toBe('success')
  })

  it('records cancellation and contains a late model result after the user stops the agent', async () => {
    const h = await harness()
    h.question()
    const release = hold(h.adapter)
    const pending = h.run()
    await h.adapter.entered.promise
    agentEvents(h.ctx, h.agent).emit('agent/cancelled', { cause: { kind: 'user' } })
    release.resolve(undefined)
    expect((await pending)?.result.kind).toBe('error')
    expect((await h.events()).find(event => event.type === 'recap/result')?.data).toMatchObject({ outcome: 'cancelled' })
  })

  it('settles the auxiliary log after the invoking UI request is cancelled', async () => {
    const h = await harness()
    h.question()
    const release = hold(h.adapter)
    const controller = new AbortController()
    const pending = h.run(controller.signal)
    await h.adapter.entered.promise
    const rejected = expect(pending).rejects.toThrow('UI request cancelled')
    controller.abort(new Error('UI request cancelled'))
    release.resolve(undefined)
    await rejected
    await h.fiber.dispose()
    const results = (await h.events()).filter(event => event.type === 'recap/result')
    expect(results).toHaveLength(1)
    expect(results[0]?.data).toMatchObject({ outcome: 'cancelled', error: 'UI request cancelled' })
  })

  it('records a failed deadline rather than publishing a late summary', async () => {
    vi.useFakeTimers()
    const h = await harness({ timeoutMs: 10 })
    h.question()
    const release = hold(h.adapter)
    const pending = h.run()
    await h.adapter.entered.promise
    await vi.advanceTimersByTimeAsync(10)
    release.resolve(undefined)
    expect((await pending)?.result.kind).toBe('error')
    const result = (await h.events()).find(event => event.type === 'recap/result')
    expect(result?.data).toMatchObject({ outcome: 'failed' })
    expect(result?.data.outcome === 'completed' ? undefined : result?.data.error).toContain('RECAP_TIMEOUT')
  })

  it('withdraws discovery and waits for an owned auxiliary request on plugin disposal', async () => {
    const h = await harness()
    h.question()
    const release = hold(h.adapter)
    const pending = h.run()
    const request = await h.adapter.entered.promise
    const dispose = h.fiber.dispose()
    await Promise.resolve()
    expect(request.signal?.aborted).toBe(true)
    expect(h.ctx.commands.find(h.agent, 'recap')).toBeUndefined()
    release.resolve(undefined)
    await dispose
    expect((await pending)?.result.kind).toBe('error')
    expect((await h.events()).find(event => event.type === 'recap/result')?.data).toMatchObject({ outcome: 'cancelled' })
  })
})
