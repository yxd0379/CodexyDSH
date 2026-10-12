/** Public provider integration preserves captured generations and private request data. */
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, LlmError, ReasoningEffortId, fileHandleText } from '@deepseek-ai/dsh-llm'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment/types'
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import {
  createUserMessage, isAgentLoopRequest, markAgentLoopRequest, textOnlyImageText,
  type GenerateOptions, type PreparedAdapterCall, type StreamChunk, type ToolSchema, type CodexyResponsesConfig,
} from '@codexydsh/runtime/llm'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import RequestProviders from '../src/index.ts'

type Script = (request: GenerateOptions) => AsyncIterable<StreamChunk>
interface Generation { readonly name: string; readonly model: LlmResolvedModelInfo; readonly script: Script }
const route = { provider: 'local', model: 'native' }
const nativeTool: ToolSchema = {
  kind: 'freeform', name: 'apply_patch', description: 'Apply a patch',
  format: { type: 'grammar', syntax: 'lark', definition: 'start: "patch"' },
  namespace: { name: 'workspace', description: 'Workspace changes', toolName: 'apply_patch' },
}
const done: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }
const ordinary: Script = async function* () { yield done }

class FixtureAdapter extends LlmAdapter {
  readonly dispatches: Array<{ generation: string; request: GenerateOptions }> = []
  constructor(public generation: Generation) { super() }
  override async resolveModel(): Promise<LlmResolvedModelInfo> { return this.generation.model }
  override async listModels(): Promise<LlmResolvedModelInfo[]> { return [this.generation.model] }
  override async prepareCall(): Promise<PreparedAdapterCall> {
    const generation = this.generation
    return {
      model: generation.model, developerHistory: 'native',
      listModels: async () => [generation.model],
      resolveModel: async () => generation.model,
      stream: request => this.dispatch(generation, request),
    }
  }
  override stream(request: GenerateOptions): AsyncIterable<StreamChunk> { return this.dispatch(this.generation, request) }
  private async *dispatch(generation: Generation, request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.dispatches.push({ generation: generation.name, request })
    yield* generation.script(request)
  }
}

function generation(name = 'first', model: Partial<LlmResolvedModelInfo> = {}, script: Script = ordinary): Generation {
  return { name, model: { provider: route.provider, id: route.model, name: 'Native fixture', ...model }, script }
}
async function fixture(current = generation(), diagnostics = false) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime).await()
  await ctx.plugin(RequestProviders, { diagnostics }).await()
  const adapter = new FixtureAdapter(current)
  const registration = ctx.codexyRequests.registerAdapter([route.provider], adapter)
  return { ctx, adapter, registration }
}
function request(extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return { ...route, messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'private user text' }] })], ...extra }
}
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('native request provider', () => {
  it('retains one provider generation across registration replacement and freezes its selected epoch controls', async () => {
    const low = ReasoningEffortId('low')
    const first = generation('first', {
      defaultMaxTokens: 111, context: { contextWindow: 65536 }, inputModalities: ['text'],
      reasoning: { efforts: [{ id: low, name: 'Low' }], defaultEffort: low },
      systemPromptUpdate: 'in-history', toolUpdate: 'in-history', toolNamespaces: 'native', codexResponsesLite: true,
    })
    const { ctx, adapter, registration } = await fixture(first)
    const captured = await ctx.codexyRequests.prepareModel(route.provider, route.model)
    registration()
    const replacement = new FixtureAdapter(generation('second', { defaultMaxTokens: 222, inputModalities: ['text', 'image'] }))
    ctx.codexyRequests.registerAdapter([route.provider], replacement)
    first.model.defaultMaxTokens = 999
    const controls: CodexyResponsesConfig = { omitDefaultMaxTokens: false, reasoningSummary: 'none' }
    const proposed = { ...route, stop: ['STOP'], codexfulResponses: controls }
    const call = captured.prepareCall(proposed)
    proposed.stop.push('CHANGED')
    proposed.codexfulResponses.reasoningSummary = 'auto'
    expect(call.config).toMatchObject({ maxTokens: 111, reasoningEffort: low, stop: ['STOP'], codexfulResponses: { reasoningSummary: 'none', lite: true } })
    expect(call.adapterDefaults).toEqual({ maxTokens: true, reasoningEffort: true })
    expect(call.context).toEqual({ contextWindow: 65536 })
    expect(call.inputModalities).toEqual(['text'])
    expect(call.systemPromptUpdate).toBe('in-history')
    expect(call.toolUpdate).toBe('in-history')
    expect(call.developerHistory).toBe('native')
    expect(Object.isFrozen(call.config)).toBe(true)
    expect(Object.isFrozen(call.config.codexfulResponses)).toBe(true)
    expect(Object.isFrozen(call.config.stop)).toBe(true)
    expect((await collect(call.stream(request({ ...call.config, tools: [nativeTool] })))).at(-1)).toEqual(done)
    expect(adapter.dispatches[0]?.generation).toBe('first')
    expect(adapter.dispatches[0]?.request.tools).toEqual([nativeTool])
    expect(replacement.dispatches).toEqual([])
    const current = await ctx.codexyRequests.prepareCall(route)
    expect(current.config.maxTokens).toBe(222)
    expect(current.inputModalities).toEqual(['text', 'image'])
  })

  it('refuses changed controls and repeated dispatch while retaining native schemas and the original AbortSignal', async () => {
    const { ctx, adapter } = await fixture()
    const prepared = await ctx.codexyRequests.prepareCall({ ...route, temperature: 0.1 })
    expect(() => prepared.stream(request({ ...prepared.config, temperature: 0.2 }))).toThrow('controls changed')
    expect(adapter.dispatches).toEqual([])
    await collect(prepared.stream(request({ ...prepared.config, tools: [nativeTool] })))
    expect(() => prepared.stream(request(prepared.config))).toThrow('reused')
    const abort = new AbortController()
    await collect(ctx.codexyRequests.stream(request({ signal: abort.signal, tools: [nativeTool] })))
    expect(adapter.dispatches.at(-1)?.request.signal).toBe(abort.signal)
    expect(adapter.dispatches.at(-1)?.request.tools).toEqual([nativeTool])
  })

  it('projects durable file handles and text-only images without mutating logged messages or losing the loop marker', async () => {
    const { ctx, adapter } = await fixture(generation('text', { inputModalities: ['text'] }))
    const file: FileAttachmentRef = { attachmentId: AttachmentId('sha256:abcdefgh'), name: 'report.txt', bytes: 7 }
    const image: ImageAttachmentRef = { attachmentId: AttachmentId('sha256:01234567'), mediaType: 'image/png', bytes: 12, width: 2, height: 3 }
    ctx.provide('attachments', { fileHostPath: () => '/host/immutable/report.txt' })
    ctx.provide('fs', { processPathFromHostPath: () => '/sandbox/attachments/report.txt' })
    const options = markAgentLoopRequest(deepFreeze(request({ messages: [createUserMessage({ source: { kind: 'user' }, content: [
      { type: 'text', text: 'Read these' }, { type: 'file', attachment: file }, { type: 'image', attachment: image },
    ] })] })))
    const prepared = await ctx.codexyRequests.prepareCall(route)
    await collect(prepared.stream(options))
    const dispatched = adapter.dispatches[0]?.request
    expect(dispatched?.messages[0]?.content).toEqual([
      { type: 'text', text: 'Read these' },
      { type: 'text', text: fileHandleText(file, '/sandbox/attachments/report.txt') },
      { type: 'text', text: textOnlyImageText(image) },
    ])
    expect(dispatched?.messages).not.toBe(options.messages)
    expect(options.messages[0]?.content.map(block => block.type)).toEqual(['text', 'file', 'image'])
    expect(dispatched && isAgentLoopRequest(dispatched)).toBe(true)
    expect(Object.isFrozen(dispatched?.messages[0]?.content)).toBe(true)
    expect(JSON.stringify(dispatched?.messages)).not.toContain('/host/immutable')
  })

  it.each([undefined, ['text', 'image'] as const])('retains image references when image capability is unknown or supported (%s)', async modalities => {
    const { ctx, adapter } = await fixture(generation('images', { inputModalities: modalities }))
    const image: ImageAttachmentRef = { attachmentId: AttachmentId('sha256:01234567'), mediaType: 'image/png', bytes: 12, width: 2, height: 3 }
    const options = request({ messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image', attachment: image }] })] })
    const prepared = await ctx.codexyRequests.prepareCall(route)
    await collect(prepared.stream(options))
    expect(adapter.dispatches[0]?.request).toBe(options)
    expect(adapter.dispatches[0]?.request.messages[0]?.content).toEqual([{ type: 'image', attachment: image }])
  })

  it('normalizes adapter failures and cancellation to one terminal chunk with the same caller signal', async () => {
    const abort = new AbortController()
    const { ctx, adapter } = await fixture(generation('cancellable', {}, async function* (options) {
      expect(options.signal).toBe(abort.signal)
      abort.abort(new Error('cancel exact call'))
      throw options.signal?.reason
    }))
    expect(await collect(ctx.codexyRequests.stream(request({ signal: abort.signal })))).toMatchObject([
      { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED' } } },
    ])
    adapter.generation = generation('failed', {}, async function* () { throw new LlmError('limited', 'RATE_LIMIT', { status: 429 }) })
    expect(await collect(ctx.codexyRequests.stream(request()))).toMatchObject([
      { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', status: 429 } } },
    ])
  })

  it('keeps middleware, consumer and cleanup failures outside adapter error normalization', async () => {
    const middleware = new Error('middleware failed')
    const first = await fixture()
    first.ctx.on('codexy-llm/stream', () => { throw middleware })
    await expect(collect(first.ctx.codexyRequests.stream(request()))).rejects.toBe(middleware)
    expect(first.adapter.dispatches).toEqual([])

    let closed = false
    const second = await fixture(generation('consumer', {}, async function* () {
      try { yield done; yield done } finally { closed = true }
    }))
    const iterator = second.ctx.codexyRequests.stream(request())[Symbol.asyncIterator]()
    await iterator.next()
    const consumer = new Error('consumer failed')
    await expect(iterator.throw?.(consumer)).rejects.toBe(consumer)
    expect(closed).toBe(true)

    const cleanup = new Error('cleanup failed')
    const third = await fixture(generation('cleanup', {}, async function* () {
      try { yield done; yield done } finally { throw cleanup }
    }))
    const ending = third.ctx.codexyRequests.stream(request())[Symbol.asyncIterator]()
    await ending.next()
    await expect(ending.return?.()).rejects.toBe(cleanup)
  })

  it('logs opt-in timing metadata without prompt or output content and preserves the caller timing observer and chunks', async () => {
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'private model output' },
      { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } }, done,
    ]
    const script: Script = async function* (options) {
      options.onRequestTiming?.({ phase: 'http-start', time: Date.now() })
      yield* chunks
    }
    const { ctx } = await fixture(generation('timing', {}, script), true)
    const lines: string[] = []
    vi.spyOn(ctx.logger, 'info').mockImplementation(line => { lines.push(String(line)) })
    const observer = vi.fn()
    const prepared = await ctx.codexyRequests.prepareCall(route)
    const options = markAgentLoopRequest(Object.freeze(request({ onRequestTiming: observer })))
    expect(await collect(prepared.stream(options))).toEqual(chunks)
    expect(observer).toHaveBeenCalledWith(expect.objectContaining({ phase: 'http-start' }))
    const records = lines.map(line => JSON.parse(line.slice('[llm-timing] '.length)))
    expect(records.map(record => record.phase)).toEqual(['request-start', 'adapter-stream-start', 'http-start', 'first-token', 'request-end'])
    expect(records.every(record => record.scope === 'agent' && record.elapsedMs >= 0)).toBe(true)
    expect(records.at(-1)).toMatchObject({ outcome: 'stop', inputTokens: 3, outputTokens: 4 })
    expect(lines.join('\n')).not.toContain('private user text')
    expect(lines.join('\n')).not.toContain('private model output')
    vi.mocked(ctx.logger.info).mockImplementation(() => { throw new Error('diagnostic sink failed') })
    expect(await collect(ctx.codexyRequests.stream(request()))).toEqual(chunks)
    const silent = await fixture(generation('silent', {}, script))
    const log = vi.spyOn(silent.ctx.logger, 'info')
    expect(await collect(silent.ctx.codexyRequests.stream(request()))).toEqual(chunks)
    expect(log).not.toHaveBeenCalled()
  })
})
