/** Prepared auxiliary inputs are durable facts, never reconstructed wire packets. */
import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop } from '@codexydsh/runtime'
import { mountAgentLoopTestDependencies } from '@codexydsh/runtime-testkit'
import { BasicCompactionEngine } from '@codexydsh/compaction'
import TokenMeter from '@codexydsh/token-meter'
import { createMessage, createUserMessage, encodeCodexClientMetadata, LlmAdapter, LlmError,
  resolveRetryPolicy, ReasoningEffortId, ToolCallId, type ContentBlock, type CodexCompactionMetadataFacts,
  type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@codexydsh/runtime/llm'
import { summarizeWithLlm } from '../src/summarizer.ts'
import { deriveProductMessages, snapshotProductEvents } from '@codexydsh/runtime/session'
import { Session as StockSession, SessionId, SessionLogOffset, type Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { decodeCodexyArtifact, encodeArtifactEvents, encodeArtifactHeader } from '../../runtime/src/persistence-codec.ts'
import CodexySessionPersistence from '../../runtime/src/persistence.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

class DurableAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  prepareError: Error | undefined
  run: ((options: GenerateOptions, attempt: number) => AsyncIterable<StreamChunk>) | undefined
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (this.prepareError !== undefined) return Promise.reject(this.prepareError)
    return Promise.resolve({ provider, id: model, name: model, defaultMaxTokens: 100, context: { contextWindow: 4_000 } })
  }
  override providerRetryPolicy() {
    return resolveRetryPolicy({ mode: 'normal', maxRetries: 1,
      backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }, 'durable input fixture')
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.run !== undefined) { yield* this.run(options, this.requests.length); return }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'summary' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function harness() {
  const ctx = new Context(); contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  // A participating in-memory JSONL sink, not a fake boolean return. These
  // snapshots exercise the real codec but do not claim filesystem durability.
  const checkpoints: Buffer[] = []
  ctx.on('session/flush', async session => { checkpoints.push(artifactBytes(session)) })
  await ctx.plugin(TokenMeter)
  const adapter = new DurableAdapter()
  ctx.codexyRequests.registerAdapter(['local'], adapter)
  const compact = new BasicCompactionEngine(ctx, { auto: false, checkpointFormat: 'codex',
    codexUserMessageTokens: 0, headroomTokens: 0, retainTokens: 0, maxTokens: 100 })
  const session = ctx.sessions.create(SessionId('durable-compaction'))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'original history '.repeat(100) }],
    source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createMessage({ role: 'assistant',
    content: [{ type: 'text', text: 'original response' }], source: { kind: 'model', provider: 'local', model: 'coding' } }) }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  const clientMetadata = encodeCodexClientMetadata({ installationId: 'fixture', sessionId: session.id, threadId: session.id,
    turnId: 'turn-2', contextWindowId: 'window', windowNumber: 0, requestKind: 'turn' })
  session.append('request/header', { reason: 'initial', header: { config: { provider: 'local', model: 'coding',
    codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none', wireProfile: 'codex-0.162.1', clientMetadata } } } })
  const owner = { session, options: { provider: 'local', model: 'coding' } } as Agent
  const run = (signal = new AbortController().signal, metadata: CodexCompactionMetadataFacts = {
    trigger: 'auto', reason: 'context_limit', implementation: 'responses', phase: 'mid_turn', strategy: 'memento',
  }) => {
    const nodes = session.surface.nodes
    return compact.compactRegion(nodes[0]!, nodes.at(-1)!, owner, signal, 'before-last-user-message',
      metadata)
  }
  return { ctx, adapter, compact, session, owner, run, checkpoints }
}

function requests(session: Session) { return snapshotProductEvents(session).filter(event => event.type === 'compaction/request') }
function results(session: Session) { return snapshotProductEvents(session).filter(event => event.type === 'compaction/request-result') }
function artifactBytes(session: Session): Buffer {
  return Buffer.from(encodeArtifactHeader({ kind: 'codexy-session', version: 1, session: session.header,
    inheritedEventCount: SessionLogOffset(0) }) + encodeArtifactEvents(session.snapshotEvents()))
}
function restore(session: Session): Session {
  return restoreBytes(session.id, artifactBytes(session))
}
function restoreBytes(id: SessionId, bytes: Buffer): Session {
  const decoded = decodeCodexyArtifact(bytes)
  expect(Buffer.from(encodeArtifactHeader(decoded.metadata) + encodeArtifactEvents(decoded.events))).toEqual(bytes)
  return StockSession.fromRestore(id, decoded.events, decoded.metadata.session, decoded.metadata.inheritedEventCount, 'detached')
}

describe('durable prepared compaction inputs', () => {
  it('checkpoints the exact sealed input before dispatch and keeps partial failure output through JSONL restoration', async () => {
    const { ctx, adapter, session, run, checkpoints } = await harness()
    const before = deriveProductMessages(session)
    let checkpointed = false
    ctx.on('session/flush', async () => { checkpointed = requests(session).length > 0 })
    adapter.run = async function* (options) {
      expect(checkpointed).toBe(true)
      expect(requests(session)[0]!.data.preparedInput).toEqual({ ...options, signal: undefined })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial failure' }
      yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } }
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA', message: 'quota exhausted' } } }
    }
    await expect(run()).rejects.toMatchObject({ code: 'QUOTA' })
    expect(requests(session)).toHaveLength(1)
    expect(results(session)[0]!.data).toMatchObject({ outcome: 'error', dispatchInvoked: true,
      failure: { code: 'QUOTA' }, output: [{ type: 'text', text: 'partial failure' }], usage: { inputTokens: 7, outputTokens: 3 } })
    expect(requests(session)[0]!.data.source).toMatchObject({ checkpointFormat: 'codex', headMessageCount: 0,
      compactionMetadata: { trigger: 'auto', phase: 'mid_turn' }, sourceEventSeqs: session.surface.nodes })
    expect(requests(session)[0]!.data.source.compactionId).toBe(snapshotProductEvents(session).find(event => event.type === 'compaction/start')!.data.compactionId)
    expect(deriveProductMessages(session)).toEqual(before)
    const restored = restore(session)
    expect(requests(restored)).toEqual(requests(session)); expect(results(restored)).toEqual(results(session))
    expect(deriveProductMessages(restored)).toEqual(before)
    expect(results(restoreBytes(session.id, checkpoints.at(-1)!))).toEqual(results(session))
  })

  it('retains each overflow-trimmed and transport-retried request independently without changing retry behavior', async () => {
    const { adapter, session, run } = await harness()
    adapter.run = async function* (_options, attempt) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: attempt === 3 ? 'summary' : 'partial' }
      yield { type: 'finish', reason: attempt === 1
        ? { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'overflow' } }
        : attempt === 2 ? { kind: 'error', failure: { code: 'TRANSPORT', message: 'stream failed' } } : { kind: 'stop' } }
    }
    await run()
    expect(adapter.requests).toHaveLength(3)
    expect(requests(session).map(event => event.data.attempt)).toEqual([1, 2, 3])
    expect(requests(session).map(event => event.data.omittedInputMessages)).toEqual([0, 1, 1])
    expect(requests(session).map(event => event.data.preparedInput.messages)).toEqual(adapter.requests.map(options => options.messages))
    expect(results(session).map(event => event.data.outcome)).toEqual(['error', 'error', 'completed'])
    expect(new Set(requests(session).map(event => event.data.requestId)).size).toBe(3)
    expect(requests(session)[1]!.data.preparedInput.codexfulResponses).toEqual(requests(session)[0]!.data.preparedInput.codexfulResponses)
    expect(requests(restore(session))).toEqual(requests(session))
  })

  it('records actual cancellation and available output without another attempt', async () => {
    const { adapter, session, run } = await harness()
    const abort = new AbortController()
    adapter.run = async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'before cancellation' }
      abort.abort(new Error('cancelled'))
      throw new LlmError('cancelled', 'ABORTED')
    }
    await expect(run(abort.signal)).rejects.toMatchObject({ code: 'ABORTED' })
    expect(adapter.requests).toHaveLength(1)
    expect(results(session)[0]!.data).toMatchObject({ outcome: 'aborted', dispatchInvoked: true,
      output: [{ type: 'text', text: 'before cancellation' }] })
    // The owned port normalizes this thrown adapter abort into an actual
    // finish chunk; retain that observed fact, rather than a default stop.
    expect(results(session)[0]!.data.finish).toMatchObject({ kind: 'aborted', failure: { code: 'ABORTED' } })
    expect(results(restore(session))).toEqual(results(session))
  })

  it('persists the legal tool-calls finish and complete original output without changing the summary projection', async () => {
    const { adapter, session, run } = await harness()
    const call = { type: 'tool-call' as const, id: ToolCallId('compaction-observed-tool'), name: 'fixture', arguments: '{}' }
    const replayState = { response: { id: 'tool-call-response' }, blocks: [{ id: 'summary-item' }, { id: 'tool-call-item' }] }
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'visible summary' } },
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      { type: 'block-end', index: 1, block: call },
      { type: 'usage', usage: { inputTokens: 17, outputTokens: 5 } },
      { type: 'finish', reason: { kind: 'tool-calls' }, replayState },
    ]
    adapter.run = async function* () { yield* chunks }
    await run()
    expect(adapter.requests).toHaveLength(1)
    expect(results(session)[0]!.data).toMatchObject({ outcome: 'completed', finish: { kind: 'tool-calls' },
      outputProjection: 'assembled', output: [{ type: 'text', text: 'visible summary' }, call],
      streamChunks: chunks, replayState, completedReplayState: replayState, usage: { inputTokens: 17, outputTokens: 5 } })
    expect(snapshotProductEvents(session).find(event => event.type === 'compaction/summary')!.data)
      .toMatchObject({ summary: [{ type: 'text', text: 'visible summary' }],
        rawOutput: [{ type: 'text', text: 'visible summary' }, call] })
    const restored = restore(session)
    expect(results(restored)).toEqual(results(session))
    expect(deriveProductMessages(restored)).toEqual(deriveProductMessages(session))
  })

  it('does not dispatch when the input checkpoint fails and preserves an unconfirmed prepared fact', async () => {
    const { ctx, adapter, session, run } = await harness()
    vi.spyOn(ctx.sessions, 'flush').mockRejectedValue(new Error('checkpoint unavailable'))
    await expect(run()).rejects.toThrow('checkpoint unavailable')
    expect(adapter.requests).toHaveLength(0)
    expect(requests(session)).toHaveLength(1)
    expect(results(session)).toHaveLength(0)
    expect(requests(session)[0]!.data).not.toHaveProperty('dispatchInvoked')
  })

  it('waits for the checkpoint and does not replay a restored pending input automatically', async () => {
    const { ctx, adapter, session, run } = await harness()
    const checkpoint = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    let first = true
    ctx.on('session/flush', async () => { if (first) { first = false; entered.resolve(); await checkpoint.promise } })
    const pending = run()
    await entered.promise
    expect(adapter.requests).toHaveLength(0)
    const restored = restore(session)
    expect(requests(restored)).toHaveLength(1); expect(results(restored)).toHaveLength(0)
    const fresh = new Context(); contexts.push(fresh)
    await mountAgentLoopTestDependencies(fresh); await fresh.plugin(TokenMeter)
    const freshAdapter = new DurableAdapter(); fresh.codexyRequests.registerAdapter(['local'], freshAdapter)
    new BasicCompactionEngine(fresh, { auto: true, checkpointFormat: 'codex' })
    fresh.sessions.enter(restored)
    fresh.sessions.announce(restored)
    await Promise.resolve()
    expect(freshAdapter.requests).toHaveLength(0)
    expect(requests(restored)).toEqual(requests(session))
    checkpoint.resolve(); await pending
    expect(adapter.requests).toHaveLength(1)
  })

  it('records preparation failure as proposed input, not a dispatched or prepared model request', async () => {
    const { adapter, session, run } = await harness()
    adapter.prepareError = new LlmError('model unavailable', 'NO_ADAPTER')
    await expect(run()).rejects.toMatchObject({ code: 'NO_ADAPTER' })
    expect(adapter.requests).toHaveLength(0); expect(requests(session)).toHaveLength(0); expect(results(session)).toHaveLength(0)
    const failed = snapshotProductEvents(session).filter(event => event.type === 'compaction/preparation-error')
    expect(failed).toHaveLength(1)
    expect(failed[0]!.data).toMatchObject({ dispatchInvoked: false, failure: { code: 'NO_ADAPTER' },
      proposedInput: { provider: 'local', model: 'coding', purpose: 'compaction' } })
    expect(failed[0]!.data.proposedInput.messages.at(-1)?.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('CONTEXT CHECKPOINT COMPACTION') })
    expect(snapshotProductEvents(restore(session)).filter(event => event.type === 'compaction/preparation-error')).toEqual(failed)
  })

  it('records an unsuccessful control sealing as preparation failure before invoking the port', async () => {
    const { adapter, session, run } = await harness()
    session.append('request/header', { reason: 'resume', header: { config: {
      provider: 'local', model: 'coding', reasoningEffort: ReasoningEffortId('unsupported') } } })
    await expect(run()).rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
    expect(adapter.requests).toHaveLength(0); expect(requests(session)).toHaveLength(0)
    const failed = snapshotProductEvents(session).filter(event => event.type === 'compaction/preparation-error')
    expect(failed[0]!.data).toMatchObject({ stage: 'call', dispatchInvoked: false,
      proposedInput: { reasoningEffort: 'unsupported' }, failure: { code: 'UNSUPPORTED_REASONING_EFFORT' } })
    expect(snapshotProductEvents(restore(session)).filter(event => event.type === 'compaction/preparation-error')).toEqual(failed)
  })

  it('does not dispatch or retry when no durability listener participates', async () => {
    const { ctx, adapter, session, run } = await harness()
    vi.spyOn(ctx.sessions, 'flush').mockResolvedValue(false)
    await expect(run()).rejects.toThrow('no persistence listener')
    expect(adapter.requests).toHaveLength(0)
    expect(requests(session)).toHaveLength(1); expect(results(session)).toHaveLength(0)
    expect(requests(restore(session))).toEqual(requests(session))
  })

  it('checks cancellation again after a successful pending checkpoint', async () => {
    const { ctx, adapter, session, run } = await harness()
    const checkpoint = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    ctx.on('session/flush', async () => { entered.resolve(); await checkpoint.promise })
    const abort = new AbortController()
    const pending = run(abort.signal)
    await entered.promise
    abort.abort(new Error('cancelled during checkpoint'))
    checkpoint.resolve()
    await expect(pending).rejects.toThrow('cancelled during checkpoint')
    expect(adapter.requests).toHaveLength(0)
    expect(requests(session)).toHaveLength(1); expect(results(session)).toHaveLength(0)
  })

  it('dispatches the same immutable detached input even when its original sources change during flush', async () => {
    const { ctx, adapter, session, owner } = await harness()
    const block = { type: 'text' as const, text: 'original mutable input' }
    const tools = [{ name: 'fixture', description: 'original tool', parameters: { type: 'object' } }]
    const input = { headMessageCount: 0 as const, messages: [{ ...createUserMessage({
      content: [block], source: { kind: 'user' } }), content: [block] }], tools }
    ctx.on('session/flush', async () => { block.text = 'changed while checkpointing'; tools[0]!.description = 'changed tool' })
    ctx.on('codexy-llm/stream', (options, next) => {
      expect(Object.isFrozen(options)).toBe(true)
      expect(Object.isFrozen(options.messages)).toBe(true)
      expect(Object.isFrozen(options.tools?.[0])).toBe(true)
      expect(Reflect.set(options, 'maxTokens', 999)).toBe(false)
      return next()
    })
    await summarizeWithLlm(ctx, { checkpointFormat: 'dsh', maxTokens: 100,
      summarizationProvider: 'local', summarizationModel: 'coding' }, input, owner)
    expect(adapter.requests[0]!.messages[0]!.content[0]).toEqual({ type: 'text', text: 'original mutable input' })
    expect(adapter.requests[0]!.tools?.[0]?.description).toBe('original tool')
    expect(requests(session)[0]!.data.preparedInput).toEqual(adapter.requests[0])
    expect(requests(session)[0]!.data.source).not.toHaveProperty('compactionId')
    expect(requests(session)[0]!.data.source).not.toHaveProperty('sourceEventSeqs')
    expect(requests(session)[0]!.data.source).not.toHaveProperty('compactionMetadata')
  })

  it('does not treat result persistence failure as a retryable model failure', async () => {
    const { ctx, adapter, session, run } = await harness()
    ctx.on('session/flush', async () => { if (results(session).length > 0) throw new Error('result checkpoint unavailable') })
    adapter.run = async function* () { throw new LlmError('transport failed', 'TRANSPORT') }
    await expect(run()).rejects.toThrow('result checkpoint unavailable')
    expect(adapter.requests).toHaveLength(1); expect(requests(session)).toHaveLength(1)
    expect(results(session)[0]!.data).toMatchObject({ outcome: 'error', failure: { code: 'TRANSPORT' },
      finish: { kind: 'error', failure: { code: 'TRANSPORT' } } })
  })

  it('retains original closed tool, provider and terminal recovery chunks on failure without promoting them into history', async () => {
    const { adapter, session, run } = await harness()
    const before = deriveProductMessages(session)
    const call = { type: 'tool-call' as const, id: ToolCallId('diagnostic-only'), name: 'fixture', arguments: '{}' }
    const hosted = { type: 'provider-output' as const, api: 'openai-responses' as const, outputIndex: 1,
      item: { type: 'web_search_call' as const, id: 'hosted-item', status: 'completed' } }
    const replayState = { response: { id: 'response-id' }, blocks: [{ id: 'tool-native' }, { id: 'hosted-native' }] }
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block: call },
      { type: 'block-start', index: 1, blockType: 'provider-output' },
      { type: 'block-end', index: 1, block: hosted },
      { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA', message: 'out of quota' } }, replayState },
    ]
    adapter.run = async function* () { yield* chunks }
    await expect(run()).rejects.toMatchObject({ code: 'QUOTA' })
    expect(results(session)[0]!.data).toMatchObject({ streamChunks: chunks, replayState, completedReplayState: replayState,
      outputProjection: 'interrupted-text-and-provider', output: [hosted] })
    expect(deriveProductMessages(session)).toEqual(before)
    expect(results(restore(session))).toEqual(results(session))
  })

  it('assembles and stores the same detached chunk even if its provider-owned block changes after yielding', async () => {
    const { adapter, session, run } = await harness()
    const block = { type: 'text' as const, text: 'original provider block' }
    adapter.run = async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block }
      block.text = 'changed after yield'
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA', message: 'quota' } } }
    }
    await expect(run()).rejects.toMatchObject({ code: 'QUOTA' })
    expect(results(session)[0]!.data.output).toEqual([{ type: 'text', text: 'original provider block' }])
    expect(results(session)[0]!.data.streamChunks[1]).toMatchObject({ type: 'block-end',
      block: { type: 'text', text: 'original provider block' } })
    expect(results(restore(session))).toEqual(results(session))
  })

  it('keeps post-turn max-token termination and partial output without retrying or fabricating success', async () => {
    const { adapter, session, run } = await harness()
    adapter.run = async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'truncated summary' }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    }
    await expect(run(undefined, { trigger: 'auto', reason: 'context_limit', implementation: 'responses',
      phase: 'post_turn', strategy: 'memento' })).rejects.toMatchObject({ code: 'MAX_TOKENS' })
    expect(adapter.requests).toHaveLength(1)
    expect(results(session)[0]!.data).toMatchObject({ outcome: 'error', finish: { kind: 'max-tokens' },
      failure: { code: 'MAX_TOKENS' }, output: [{ type: 'text', text: 'truncated summary' }] })
  })

  it('reproduces the native 481-byte checkpoint after a capped reasoning-only mid-turn summary', async () => {
    const { adapter, session, run } = await harness()
    const fixture = JSON.parse(await readFile(new URL('./fixtures/native-capped-checkpoint.json', import.meta.url), 'utf8')) as {
      expectedCheckpointMessage: string; expectedCheckpointBytes: number; expectedCheckpointSha256: string
    }
    const historyText = '\n\nShell quoting mangled that. Let me use `git apply` with a patch file instead:\n\n'
    session.append('step/start', { turn: 2, step: 1 })
    session.append('assistant/message', { turn: 2, step: 1, stream: [], message: createMessage({ role: 'assistant',
      content: [{ type: 'text', text: historyText }], source: { kind: 'model', provider: 'local', model: 'coding' },
    }) }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 2, step: 1 })
    const originalEvents = session.snapshotEvents()
    const reasoning = { type: 'reasoning' as const, text: 'private capped reasoning, never the visible checkpoint' }
    const usage = { inputTokens: 113_749, outputTokens: 17_323, totalTokens: 131_072 }
    adapter.run = async function* () {
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      yield { type: 'block-end', index: 0, block: reasoning }
      yield { type: 'usage', usage }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    }
    await run()
    expect(adapter.requests).toHaveLength(1)
    const checkpoint = deriveProductMessages(session).at(-1)!.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    expect(checkpoint).toBe(fixture.expectedCheckpointMessage)
    expect(Buffer.byteLength(checkpoint)).toBe(fixture.expectedCheckpointBytes)
    expect(createHash('sha256').update(checkpoint).digest('hex')).toBe(fixture.expectedCheckpointSha256)
    expect(results(session)[0]!.data).toMatchObject({ outcome: 'completed', finish: { kind: 'max-tokens' },
      output: [reasoning], usage })
    expect(results(session)[0]!.data).not.toHaveProperty('failure')
    const summaries = snapshotProductEvents(session).filter(event => event.type === 'compaction/summary')
    expect(summaries[0]!.data).toMatchObject({ summary: [{ type: 'text', text: historyText }], rawOutput: [reasoning], usage })
    expect(session.snapshotEvents().slice(0, originalEvents.length)).toEqual(originalEvents)
    const restored = restore(session)
    expect(results(restored)).toEqual(results(session))
    expect(deriveProductMessages(restored)).toEqual(deriveProductMessages(session))
    expect(snapshotProductEvents(restored).filter(event => event.type === 'compaction/summary')).toEqual(summaries)
  })

  it('prefers a capped visible Codex summary over the previous assistant text without another dispatch', async () => {
    const { adapter, session, run } = await harness()
    adapter.run = async function* () {
      yield { type: 'text-delta', index: 0, text: 'current visible summary' }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    }
    await run()
    expect(adapter.requests).toHaveLength(1)
    expect(snapshotProductEvents(session).find(event => event.type === 'compaction/summary')!.data.summary)
      .toEqual([{ type: 'text', text: 'current visible summary' }])
    expect(results(session)[0]!.data).toMatchObject({ outcome: 'completed', finish: { kind: 'max-tokens' } })
  })

  it.each(['pre_turn', 'mid_turn', 'standalone_turn'] as const)(
    'uses only visible history after a completed reasoning-only Codex summary in %s', async phase => {
      const { ctx, adapter, session, owner } = await harness()
      adapter.run = async function* () {
        yield { type: 'reasoning-delta', index: 0, text: 'private current reasoning' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
      const assistant = (content: ContentBlock[]) => createMessage({ role: 'assistant', content,
        source: { kind: 'model', provider: 'local', model: 'coding' } })
      const summary = await summarizeWithLlm(ctx, { checkpointFormat: 'codex', maxTokens: 100,
        summarizationProvider: '', summarizationModel: '' }, {
        headMessageCount: 0, compactionMetadata: { trigger: 'auto', reason: 'context_limit',
          implementation: 'responses', phase, strategy: 'memento' }, messages: [
          assistant([{ type: 'text', text: 'older visible message' }]),
          assistant([{ type: 'text', text: 'latest part one' }, { type: 'text', text: 'latest part two\n' }]),
          assistant([{ type: 'reasoning', text: 'later private history' }]),
          assistant([{ type: 'tool-call', id: ToolCallId('later-tool'), name: 'fixture', arguments: '{}' }]),
        ],
      }, owner)
      expect(summary.summary).toEqual([{ type: 'text', text: 'latest part one\nlatest part two\n' }])
      expect(summary.rawOutput).toEqual([{ type: 'reasoning', text: 'private current reasoning' }])
      expect(adapter.requests).toHaveLength(1)
      expect(results(restore(session))).toEqual(results(session))
    },
  )

  it.each([
    { format: 'dsh', wire: true, phase: 'mid_turn', implementation: 'responses', strategy: 'memento' },
    { format: 'codex', wire: false, phase: 'mid_turn', implementation: 'responses', strategy: 'memento' },
    { format: 'codex', wire: true },
    { format: 'codex', wire: true, phase: 'post_turn', implementation: 'responses', strategy: 'memento' },
    { format: 'codex', wire: true, phase: 'mid_turn', implementation: 'responses_compaction_v2', strategy: 'memento' },
    { format: 'codex', wire: true, phase: 'mid_turn', implementation: 'responses', strategy: 'prefix_compaction' },
  ] as const)('keeps max-token rejection outside pinned local non-post-turn policy %#', async variant => {
    const { ctx, adapter, session, owner } = await harness()
    if (!variant.wire) session.append('request/header', { reason: 'resume', header: { config: {
      provider: 'local', model: 'coding', codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none' },
    } } })
    adapter.run = async function* () {
      yield { type: 'reasoning-delta', index: 0, text: 'capped private reasoning' }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    }
    await expect(summarizeWithLlm(ctx, { checkpointFormat: variant.format, maxTokens: 100,
      summarizationProvider: '', summarizationModel: '' }, {
      headMessageCount: 0, messages: deriveProductMessages(session),
      ...'phase' in variant ? { compactionMetadata: { trigger: 'auto', reason: 'context_limit',
        implementation: variant.implementation, phase: variant.phase, strategy: variant.strategy } as CodexCompactionMetadataFacts } : {},
    }, owner)).rejects.toMatchObject({ code: 'MAX_TOKENS' })
    expect(adapter.requests).toHaveLength(1)
    expect(results(session)[0]!.data).toMatchObject({ outcome: 'error', finish: { kind: 'max-tokens' },
      failure: { code: 'MAX_TOKENS' } })
  })

  it.each(['stop', 'max-tokens'] as const)('rejects reasoning-only output with no visible fallback (%s)', async kind => {
    const { ctx, adapter, session, owner } = await harness()
    adapter.run = async function* () {
      yield { type: 'reasoning-delta', index: 0, text: 'private current reasoning' }
      yield { type: 'finish', reason: { kind } }
    }
    await expect(summarizeWithLlm(ctx, { checkpointFormat: 'codex', maxTokens: 100,
      summarizationProvider: '', summarizationModel: '' }, {
      headMessageCount: 0, messages: [createMessage({ role: 'assistant',
        content: [{ type: 'reasoning', text: 'private historical reasoning' }],
        source: { kind: 'model', provider: 'local', model: 'coding' } })],
      compactionMetadata: { trigger: 'auto', reason: 'context_limit', implementation: 'responses', phase: 'mid_turn', strategy: 'memento' },
    }, owner)).rejects.toThrow(kind === 'stop' ? /no text summary content/ : /token cap/)
    expect(adapter.requests).toHaveLength(1)
    expect(snapshotProductEvents(session).filter(event => event.type === 'compaction/summary')).toHaveLength(0)
  })

  it('captures the fallback before an external source can change during a durability wait', async () => {
    const { ctx, adapter, session, owner } = await harness()
    const text = { type: 'text' as const, text: 'original visible fallback\n' }
    const message = { ...createMessage({ role: 'assistant', content: [text],
      source: { kind: 'model', provider: 'local', model: 'coding' } }), content: [text] }
    const metadata: CodexCompactionMetadataFacts = { trigger: 'auto', reason: 'context_limit',
      implementation: 'responses', phase: 'mid_turn', strategy: 'memento' }
    const mutableMetadata = { ...metadata }
    ctx.on('session/flush', async () => { text.text = 'changed during flush'; mutableMetadata.phase = 'post_turn' })
    adapter.run = async function* () {
      yield { type: 'reasoning-delta', index: 0, text: 'private current reasoning' }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    }
    const result = await summarizeWithLlm(ctx, { checkpointFormat: 'codex', maxTokens: 100,
      summarizationProvider: '', summarizationModel: '' }, {
      headMessageCount: 0, messages: [message], compactionMetadata: mutableMetadata,
    }, owner)
    expect(result.summary).toEqual([{ type: 'text', text: 'original visible fallback\n' }])
    expect(requests(session)[0]!.data.preparedInput.messages[0]!.content[0]).toEqual({ type: 'text', text: 'original visible fallback\n' })
    expect(requests(session)[0]!.data.source.compactionMetadata?.phase).toBe('mid_turn')
    expect(adapter.requests).toHaveLength(1)
  })

  it('does not use old assistant text for a post-turn summary that completed without visible output', async () => {
    const { adapter, session, run } = await harness()
    const before = deriveProductMessages(session)
    adapter.run = async function* () {
      yield { type: 'reasoning-delta', index: 0, text: 'private post-turn reasoning' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    await expect(run(undefined, { trigger: 'auto', reason: 'context_limit', implementation: 'responses',
      phase: 'post_turn', strategy: 'memento' })).rejects.toThrow('no text summary content')
    expect(adapter.requests).toHaveLength(1)
    expect(deriveProductMessages(session)).toEqual(before)
    expect(results(session)[0]!.data).toMatchObject({ outcome: 'completed', finish: { kind: 'stop' } })
  })

  it('does not turn an unterminated reasoning-only stream into a history-backed checkpoint', async () => {
    const { adapter, session, run } = await harness()
    const before = deriveProductMessages(session)
    adapter.run = async function* () { yield { type: 'reasoning-delta', index: 0, text: 'unterminated private reasoning' } }
    await expect(run()).rejects.toThrow('no text summary content')
    expect(adapter.requests).toHaveLength(1)
    expect(deriveProductMessages(session)).toEqual(before)
    expect(results(session)[0]!.data).not.toHaveProperty('finish')
  })

  it.each([{ content: [] }, { content: [{ type: 'text', text: '\n\n' }] }] as Array<{ content: ContentBlock[] }>)(
    'keeps empty or whitespace-only visible history fail-closed %#', async ({ content }) => {
      const { ctx, adapter, session, owner } = await harness()
      adapter.run = async function* () {
        yield { type: 'reasoning-delta', index: 0, text: 'private current reasoning' }
        yield { type: 'finish', reason: { kind: 'max-tokens' } }
      }
      await expect(summarizeWithLlm(ctx, { checkpointFormat: 'codex', maxTokens: 100,
        summarizationProvider: '', summarizationModel: '' }, {
        headMessageCount: 0, messages: [createMessage({ role: 'assistant', content,
          source: { kind: 'model', provider: 'local', model: 'coding' } })],
        compactionMetadata: { trigger: 'auto', reason: 'context_limit', implementation: 'responses', phase: 'mid_turn', strategy: 'memento' },
      }, owner)).rejects.toMatchObject({ code: 'MAX_TOKENS' })
      expect(adapter.requests).toHaveLength(1)
      expect(snapshotProductEvents(session).filter(event => event.type === 'compaction/summary')).toHaveLength(0)
    },
  )

  it('does not invent a terminal finish chunk when the native stream ends without one', async () => {
    const { adapter, session, run } = await harness()
    adapter.run = async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'summary without terminal chunk' }
    }
    await run()
    expect(results(session)[0]!.data.outcome).toBe('completed')
    expect(results(session)[0]!.data).not.toHaveProperty('finish')
    expect(results(session)[0]!.data.streamChunks).toHaveLength(2)
  })

  it('retains the actual terminated stream even when an incomplete block cannot be projected as summary content', async () => {
    const { adapter, session, run } = await harness()
    const chunks: StreamChunk[] = [{ type: 'block-start', index: 0, blockType: 'image' },
      { type: 'finish', reason: { kind: 'stop' } }]
    adapter.run = async function* () { yield* chunks }
    await expect(run()).rejects.toThrow('cannot assemble incomplete block')
    expect(adapter.requests).toHaveLength(1)
    expect(results(session)[0]!.data).toMatchObject({ outcome: 'completed', finish: { kind: 'stop' }, streamChunks: chunks,
      outputProjection: 'unavailable', projectionFailure: { message: expect.stringContaining('cannot assemble incomplete block') } })
    expect(results(restore(session))).toEqual(results(session))
  })

  it('rejects malformed durable facts through the actual codec instead of silently restoring them', async () => {
    const { session, run } = await harness()
    await run()
    const corrupted = session.snapshotEvents().map(event => event.type === 'codexy/fact' && event.data.type === 'compaction/request'
      ? { ...event, data: { ...event.data, data: { ...event.data.data as Record<string, unknown>, dispatchInvoked: true } } } : event)
    const bytes = Buffer.from(encodeArtifactHeader({ kind: 'codexy-session', version: 1, session: session.header,
      inheritedEventCount: SessionLogOffset(0) }) + corrupted.map(event => JSON.stringify(event) + '\n').join(''))
    expect(() => decodeCodexyArtifact(bytes)).toThrow('prepared compaction fact cannot assert dispatch')
  })

  it.each([
    { kind: 'future-finish' }, { kind: ['stop'] }, { kind: ['tool-calls'] }, { kind: null },
  ])('rejects unknown or non-string observed finish kinds through cold decoding %#', async finish => {
    const { session, run } = await harness()
    await run()
    const corrupted = session.snapshotEvents().map(event => event.type === 'codexy/fact' && event.data.type === 'compaction/request-result'
      ? { ...event, data: { ...event.data, data: { ...event.data.data as Record<string, unknown>, finish } } } : event)
    const bytes = Buffer.from(encodeArtifactHeader({ kind: 'codexy-session', version: 1, session: session.header,
      inheritedEventCount: SessionLogOffset(0) }) + corrupted.map(event => JSON.stringify(event) + '\n').join(''))
    expect(() => decodeCodexyArtifact(bytes)).toThrow('invalid compaction observed finish')
  })

  it.each(['error', 'tool-calls'] as const)('flushes the standard product writer before dispatch and restores %s input and result from its retained real file', async kind => {
    const directory = await mkdtemp(join(tmpdir(), 'codexy-compaction-durable-writer-'))
    // Deliberately retained. No test teardown removes artifacts or this directory.
    console.info(`retained compaction writer fixture: ${directory}`)
    const ctx = new Context(); contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(CodexySessionPersistence, { root: directory, leaseStaleMs: 30_000, leaseUpdateMs: 10_000 })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(TokenMeter)
    const adapter = new DurableAdapter(); ctx.codexyRequests.registerAdapter(['local'], adapter)
    const owner = await ctx.agentLoop.create(SessionId('actual-durable-compaction'), { provider: 'local', model: 'coding' })
    const session = owner.session
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'original persisted history '.repeat(100) }] }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    const persistence = ctx.sessionPersistence as CodexySessionPersistence
    const path = persistence.pathFor(session.id)
    adapter.run = async function* (options) {
      const stored = restoreBytes(session.id, await readFile(path))
      const { signal: _signal, onRequestTiming: _timing, ...input } = options
      expect(requests(stored)[0]!.data.preparedInput).toEqual(input)
      expect(results(stored)).toHaveLength(0)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'persisted partial output' }
      if (kind === 'tool-calls') {
        yield { type: 'block-start', index: 1, blockType: 'tool-call' }
        yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: ToolCallId('persisted-compaction-tool'),
          name: 'fixture', arguments: '{}' } }
      }
      yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 4 } }
      yield { type: 'finish', reason: kind === 'tool-calls' ? { kind } : { kind,
        failure: { code: 'QUOTA', message: 'fixture quota' } } }
    }
    const compact = new BasicCompactionEngine(ctx, { auto: false, checkpointFormat: 'codex' })
    const nodes = [...session.surface.nodes]
    const pending = compact.compactRegion(nodes[0]!, nodes.at(-1)!, owner)
    if (kind === 'error') await expect(pending).rejects.toMatchObject({ code: 'QUOTA' })
    else await pending
    expect(adapter.requests).toHaveLength(1)
    await expect(ctx.sessions.flush(session)).resolves.toBe(true)
    const bytes = await readFile(path)
    const restored = restoreBytes(session.id, bytes)
    expect(requests(restored)).toEqual(requests(session)); expect(results(restored)).toEqual(results(session))
    expect(results(restored)[0]!.data).toMatchObject({ outcome: kind === 'error' ? 'error' : 'completed', finish: { kind },
      ...kind === 'error' ? { failure: { code: 'QUOTA' } } : {},
      output: [{ type: 'text', text: 'persisted partial output' },
        ...kind === 'error' ? [] : [{ type: 'tool-call', id: 'persisted-compaction-tool', name: 'fixture', arguments: '{}' }]],
      usage: { inputTokens: 11, outputTokens: 4 } })
    if (kind === 'tool-calls') expect(results(restored)[0]!.data).not.toHaveProperty('failure')
    expect(deriveProductMessages(restored)).toEqual(deriveProductMessages(session))
    await ctx.fiber.dispose()
    const cold = new Context(); contexts.push(cold)
    await cold.plugin(CodexySessionPersistence, { root: directory, leaseStaleMs: 30_000, leaseUpdateMs: 10_000 })
    const reader = await cold.sessionPersistence.open(session.id, 'read')
    try {
      const stored = await reader.read()
      const coldSession = StockSession.fromRestore(session.id, stored.events, reader.header,
        reader.inheritedEventCount, 'detached')
      expect(requests(coldSession)).toEqual(requests(session))
      expect(results(coldSession)).toEqual(results(session))
      expect(deriveProductMessages(coldSession)).toEqual(deriveProductMessages(session))
      expect(await readFile(path)).toEqual(bytes)
    } finally { await reader.close() }
  })
})
