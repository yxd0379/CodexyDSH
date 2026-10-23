/** Explicit Responses backend-hosted output over the public SDK fetch/payload hooks.
 * This does not execute search locally and does not qualify a server capability.
 */
import { EMPTY_RESPONSE_CODE, LlmError } from '@codexydsh/runtime/llm'
import type { ProviderOutputBlock, ReplayEnvelope, StreamChunk } from '@codexydsh/runtime/llm'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { Api, Context, Model } from '@earendil-works/pi-ai'
import { convertResponsesMessages } from '@earendil-works/pi-ai/api/openai-responses-shared'
import { transformMessages } from '@earendil-works/pi-ai/api/transform-messages'

type JsonObject = { [key: string]: JsonValue }
/** Ordered provider-native items and actual hosted progress, retained in opaque replay state. */
export interface HostedResponsesReplay {
  output: JsonObject[]
  events: JsonObject[]
  terminal?: JsonObject
  /** Actual added items not yet closed by the backend; never replayed as successful output. */
  pendingOutput: { outputIndex: number; item: JsonObject }[]
}
/** Adapter-private pi-ai history tag. The SDK ignores it; onPayload restores the native items. */
export const HOSTED_REPLAY = '__codexyHostedResponses' as const

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function jsonObject(value: unknown): JsonObject {
  const snapshot = snapshotJsonValue<unknown>(value)
  if (!record(snapshot)) throw new LlmError('Responses native output requires lossless JSON', 'INVALID_RESPONSE')
  return snapshot as JsonObject
}
function indexOf(value: unknown): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0) {
    throw new LlmError('Responses output requires a nonnegative output_index', 'INVALID_RESPONSE')
  }
  return value
}

/** One stream's observer. Bytes are forwarded unchanged, not decoded and re-encoded. */
export class HostedResponsesCapture {
  private queue: StreamChunk[] = []
  private wake = Promise.withResolvers<void>()
  private readonly supportedIndexes: number[] = []
  private readonly started = new Set<number>()
  private readonly closed = new Map<number, JsonObject>()
  private readonly events: JsonObject[] = []
  private readonly added = new Map<number, JsonObject>()
  private readonly metadata: { api: 'openai-responses'; provider: string; model: string }
  private terminal: JsonObject | undefined
  private failure: unknown

  constructor(provider: string, model: string) { this.metadata = { api: 'openai-responses', provider, model } }

  private push(chunk: StreamChunk): void {
    this.queue.push(chunk)
    this.wake.resolve()
  }
  /** Wake the merger without polling while the SDK waits for its own next event. */
  waiting(): Promise<void> { return this.queue.length > 0 ? Promise.resolve() : this.wake.promise }
  drain(): StreamChunk[] {
    const chunks = this.queue.splice(0)
    this.wake = Promise.withResolvers<void>()
    if (this.failure !== undefined) throw this.failure
    return chunks
  }
  outputIndex(piIndex: number): number {
    const index = this.supportedIndexes[piIndex]
    if (index === undefined) throw new LlmError('SDK content has no observed Responses output item', 'INVALID_RESPONSE')
    return index
  }
  replay(): HostedResponsesReplay {
    return {
      output: [...this.closed].toSorted(([left], [right]) => left - right).map(([, item]) => structuredClone(item)),
      events: structuredClone(this.events),
      ...this.terminal === undefined ? {} : { terminal: structuredClone(this.terminal) },
      pendingOutput: [...this.added].filter(([index]) => !this.closed.has(index))
        .map(([outputIndex, item]) => ({ outputIndex, item: structuredClone(item) })),
    }
  }
  hasHostedOutput(): boolean { return [...this.closed.values()].some(item => item['type'] === 'web_search_call') }
  private hasHostedFacts(): boolean { return this.events.length > 0 || this.hasHostedOutput() }

  /** Attach original items to the opaque response half, keeping block alignment explicit. */
  withReplay(state: ReplayEnvelope, blocks = state.blocks): ReplayEnvelope {
    if (!record(state.response)) throw new LlmError('Expected pi-ai response metadata', 'INVALID_RESPONSE')
    return { response: { ...state.response, hostedResponses: this.replay() }, ...blocks === undefined ? {} : { blocks } }
  }
  private nativeReplay(index: number, block: ProviderOutputBlock): ReplayEnvelope {
    return this.withReplay({ response: { kind: 'pi-ai', version: 2, ...this.metadata, stopReason: 'stop' },
      blocks: [{ type: 'provider-output', outputIndex: index, nativeContent: block }] })
  }
  private progressReplay(): ReplayEnvelope {
    return this.withReplay({ response: { kind: 'pi-ai', version: 2, ...this.metadata, stopReason: 'pending' }, blocks: [] })
  }

  private open(index: number, item: JsonObject): void {
    if (this.started.has(index)) return
    this.started.add(index)
    if (item['type'] === 'web_search_call') this.push({ type: 'block-start', index, blockType: 'provider-output', replayState: this.progressReplay() })
    else {
      const blockType = item['type'] === 'reasoning' ? 'reasoning'
        : item['type'] === 'message' ? 'text'
        : item['type'] === 'function_call' || item['type'] === 'custom_tool_call' ? 'tool-call' : undefined
      if (blockType !== undefined) {
        this.supportedIndexes.push(index)
        this.push({ type: 'block-start', index, blockType })
      }
    }
  }
  private closeHosted(index: number, item: JsonObject): void {
    if (typeof item['id'] !== 'string' || item['id'].length === 0) throw new LlmError('Hosted web output requires its native id', 'INVALID_RESPONSE')
    const block: ProviderOutputBlock = { type: 'provider-output', api: 'openai-responses', outputIndex: index,
      item: item as ProviderOutputBlock['item'] }
    this.push({ type: 'block-end', index, block, replayState: this.nativeReplay(index, block) })
  }

  observe(value: unknown): void {
    if (!record(value) || typeof value['type'] !== 'string') return
    const type = value['type']
    if (type.startsWith('response.web_search_call.')) {
      this.events.push(jsonObject(value))
      // Repeated start checkpoints update only opaque progress; they do not
      // complete an item or cause local dispatch.
      this.push({ type: 'block-start', index: indexOf(value['output_index']), blockType: 'provider-output', replayState: this.progressReplay() })
    }
    if (type === 'response.output_item.added') {
      const index = indexOf(value['output_index'])
      const item = jsonObject(value['item'])
      if (item['type'] === 'web_search_call') {
        this.added.set(index, item)
        this.events.push(jsonObject(value))
      }
      this.open(index, item)
    } else if (type === 'response.output_item.done') {
      const index = indexOf(value['output_index'])
      const item = jsonObject(value['item'])
      this.open(index, item)
      this.closed.set(index, item)
      this.events.push(jsonObject(value))
      if (item['type'] === 'web_search_call') {
        this.closeHosted(index, item)
      }
    } else if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
      this.terminal = jsonObject(value['response'])
      this.events.push(jsonObject(value))
      // The SDK/native client consumed output_item.done. A later terminal can
      // use different identities/arguments; retain it as separate raw evidence,
      // never rewrite already-consumed history from that later snapshot.
      const output = this.terminal['output']
      if (Array.isArray(output)) for (const [index, item] of output.entries()) {
        // Only the explicit opaque hosted seam can represent a genuinely
        // completed hosted item which the backend supplied at terminal only.
        if (!this.closed.has(index) && record(item) && item['type'] === 'web_search_call' && item['status'] === 'completed') {
          this.closed.set(index, jsonObject(item))
          this.open(index, jsonObject(item))
          this.closeHosted(index, jsonObject(item))
        }
      }
    }
  }

  /** Wrap a real fetch without changing status, headers, body bytes, or HTTP/SSE errors. */
  fetch(upstream: typeof globalThis.fetch): typeof globalThis.fetch {
    return async (input, init) => {
      const response = await upstream(input, init)
      if (response.body === null || !response.headers.get('content-type')?.includes('text/event-stream')) return response
      const decoder = new TextDecoder()
      let pending = ''
      let data: string[] = []
      const line = (value: string): void => {
        if (value === '') {
          if (data.length > 0) {
            const payload = data.join('\n')
            data = []
            if (payload !== '[DONE]') this.observe(JSON.parse(payload) as unknown)
          }
        } else if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''))
      }
      const parse = (final = false): void => {
        let match: RegExpExecArray | null
        while ((match = /\r\n|\n|\r/.exec(pending)) !== null) {
          // A CR at the end of a chunk may be the first half of CRLF.
          if (!final && match[0] === '\r' && match.index === pending.length - 1) break
          line(pending.slice(0, match.index))
          pending = pending.slice(match.index + match[0].length)
        }
        if (final && pending.length > 0) { line(pending); pending = '' }
      }
      const observed = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform: (bytes, controller) => {
          try { pending += decoder.decode(bytes, { stream: true }); parse() }
          catch (error: unknown) { this.failure = error; this.wake.resolve() }
          controller.enqueue(bytes)
        },
        flush: () => {
          try { pending += decoder.decode(); parse(true) }
          catch (error: unknown) { this.failure = error; this.wake.resolve() }
        },
      }))
      const forwarded = new Response(observed, { status: response.status, statusText: response.statusText, headers: response.headers })
      Object.defineProperties(forwarded, {
        url: { value: response.url }, redirected: { value: response.redirected }, type: { value: response.type },
      })
      return forwarded
    }
  }

  /** Merge actual native checkpoints while the SDK continues parsing ordinary content. */
  async * merge(chunks: AsyncIterable<StreamChunk>, onStop: () => void): AsyncGenerator<StreamChunk> {
    const iterator = chunks[Symbol.asyncIterator]()
    let next = iterator.next()
    const blockMetadata = new Map<number, unknown>()
    try {
      while (true) {
        const ready = await Promise.race([
          next.then(result => ({ kind: 'sdk' as const, result })),
          this.waiting().then(() => ({ kind: 'native' as const })),
        ])
        for (const chunk of this.drain()) {
          if (chunk.type === 'block-end') blockMetadata.set(chunk.index, chunk.replayState?.blocks?.[0])
          yield chunk
        }
        if (ready.kind !== 'sdk') continue
        if (ready.result.done) return
        const chunk = ready.result.value
        next = iterator.next()
        if ('index' in chunk) {
          const index = this.outputIndex(chunk.index)
          // Observed native added frames already emitted starts in provider order.
          if (chunk.type === 'block-start') continue
          if (chunk.type === 'block-end' && chunk.replayState !== undefined) {
            const block = { ...record(chunk.replayState.blocks?.[0]) ? chunk.replayState.blocks[0] : {}, nativeContent: chunk.block }
            blockMetadata.set(index, block)
            yield { ...chunk, index, replayState: this.withReplay(chunk.replayState, [block]) }
          } else yield { ...chunk, index }
        } else if (chunk.type === 'finish' && (chunk.replayState !== undefined || this.hasHostedFacts())) {
          const blocks = [...blockMetadata].toSorted(([left], [right]) => left - right).map(([, value]) => value)
          const reason = this.hasHostedOutput() && this.terminal?.['status'] === 'completed'
            && chunk.reason.kind === 'error' && chunk.reason.failure.code === EMPTY_RESPONSE_CODE
            ? { kind: 'stop' as const } : chunk.reason
          const state = chunk.replayState ?? { response: { kind: 'pi-ai', version: 2, ...this.metadata,
            // This envelope represents only actually closed output items, not a completed request.
            // The real failure remains the finish reason and native terminal (if any).
            stopReason: blocks.length === 0 ? 'pending'
              : blocks.some(block => record(block) && block['type'] === 'tool-call') ? 'toolUse' : 'stop' }, blocks }
          yield { ...chunk, reason, replayState: this.withReplay(state, blocks) }
        } else yield chunk
      }
    } finally { onStop(); await iterator.return?.() }
  }
}

/** Restore same-route native historical output using the public SDK message conversion boundary. */
export function hostedResponsesPayload(
  payload: unknown, context: Context, model: Model<Api>, advertiseWebSearch = true,
): { payload: Record<string, unknown>; originals: ReadonlyMap<string, JsonObject> } {
  if (!record(payload) || !Array.isArray(payload['input'])) throw new LlmError('Responses payload requires input items', 'INVALID_REQUEST')
  const input = [...payload['input']]
  const originals = new Map<string, JsonObject>()
  const sameRoute = (message: Record<string, unknown>) => message['api'] === model.api
    && message['provider'] === model.provider && message['model'] === model.id
  // Count exact public conversions, including synthetic missing local-tool outputs.
  // Identity normalization changes bytes, not these item counts; actual input bytes are not reserialized.
  const messages = transformMessages(context.messages, model, id => id)
  let offset = context.systemPrompt ? 1 : 0
  const replacements: { offset: number; length: number; output: JsonObject[] }[] = []
  for (const message of messages) {
    const projected = convertResponsesMessages(model, { messages: [message] }, new Set([model.provider]), { includeSystemPrompt: false })
    const length = message.role === 'assistant'
      ? projected.filter(item => !('type' in item) || item.type !== 'function_call_output' && item.type !== 'custom_tool_call_output').length
      : projected.length
    const tagged = message as unknown as Record<string, unknown>
    const replay = tagged[HOSTED_REPLAY]
    if (message.role === 'assistant' && sameRoute(tagged) && record(replay) && Array.isArray(replay['output'])) {
      const output = replay['output'].map(jsonObject)
      replacements.push({ offset, length, output })
      for (const item of output) if (typeof item['id'] === 'string') originals.set(item['id'], item)
    }
    offset += length
  }
  if (offset !== input.length) throw new LlmError('Native Responses history did not align with public SDK conversion', 'INVALID_REPLAY_STATE')
  for (const replacement of replacements.toReversed()) input.splice(replacement.offset, replacement.length, ...replacement.output)
  const tools = Array.isArray(payload['tools']) ? [...payload['tools']] : []
  if (advertiseWebSearch && !tools.some(tool => record(tool) && tool['type'] === 'web_search')) tools.push({ type: 'web_search' })
  return { payload: { ...payload, input, tools }, originals }
}

/** Retain original server text annotations and unknown fields across product input grouping. */
export function restoreHostedOriginals(payload: Record<string, unknown>, originals: ReadonlyMap<string, JsonObject>): Record<string, unknown> {
  if (!Array.isArray(payload['input']) || originals.size === 0) return payload
  return { ...payload, input: payload['input'].map((item: unknown) => {
    if (!record(item) || typeof item['id'] !== 'string') return item
    const original = originals.get(item['id'])
    return original === undefined || original['type'] !== item['type'] ? item : structuredClone(original)
  }) }
}
