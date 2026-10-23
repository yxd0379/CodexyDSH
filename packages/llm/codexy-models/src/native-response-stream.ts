/** Native Codex stops reading after a parsed Completed event, without waiting for EOF. */
import type { FetchFunction } from '@earendil-works/pi-ai'

type RecordValue = Record<string, unknown>
const record = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Match the fixed Rust ResponseCompleted deserializer; status and output are not its fields. */
function completed(payload: string): boolean {
  const numbers = new WeakMap<object, Map<string, string>>()
  let value: unknown
  try {
    value = JSON.parse(payload, function (this: unknown, key: string, item: unknown, context?: { source?: string }): unknown {
      if (record(this) && typeof item === 'number' && context?.source !== undefined) {
        let fields = numbers.get(this)
        if (fields === undefined) { fields = new Map(); numbers.set(this, fields) }
        fields.set(key, context.source)
      }
      return item
    }) as unknown
  } catch { return false }
  if (!record(value) || !record(value['response'])) return false
  const response = value['response']
  if (value['type'] !== 'response.completed' && !(value['type'] === 'response.incomplete'
    && record(response['incomplete_details']) && response['incomplete_details']['reason'] === 'interrupted')) return false
  if (typeof response['id'] !== 'string' || response['end_turn'] != null && typeof response['end_turn'] !== 'boolean') return false
  const metadata = response['usage_metadata']
  if (metadata != null && (!record(metadata) || metadata['amount'] != null && typeof metadata['amount'] !== 'string')) return false
  const i64 = (object: RecordValue, key: string): boolean => {
    const item = object[key], source = numbers.get(object)?.get(key)
    if (typeof item !== 'number' || !Number.isFinite(item)) return false
    if (source === undefined) return Number.isSafeInteger(item)
    if (!/^-?(?:0|[1-9][0-9]*)$/.test(source)) return false
    const integer = BigInt(source)
    return integer >= -(1n << 63n) && integer < 1n << 63n
  }
  const usage = response['usage']
  if (usage != null) {
    if (!record(usage) || !['input_tokens', 'output_tokens', 'total_tokens'].every(key => i64(usage, key))) return false
    const input = usage['input_tokens_details'], output = usage['output_tokens_details']
    if (input != null && (!record(input) || !i64(input, 'cached_tokens')
      || input['cache_write_tokens'] !== undefined && !i64(input, 'cache_write_tokens'))) return false
    if (output != null && (!record(output) || !i64(output, 'reasoning_tokens'))) return false
    if (usage['codex_rollout_budget_units'] != null && (typeof usage['codex_rollout_budget_units'] !== 'number'
      || !Number.isFinite(usage['codex_rollout_budget_units']))) return false
  }
  return true
}

/** Incremental SSE framing over original bytes; no JSON or UTF-8 re-serialization. */
class CompletionFrame {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  private line: number[] = []
  private data: string[] = []
  private cr = false
  private terminal = false
  private firstLine = true

  private newline(): void {
    let text = this.decoder.decode(Uint8Array.from(this.line))
    if (this.firstLine) { text = text.replace(/^\uFEFF/, ''); this.firstLine = false }
    this.line = []
    if (text === '') {
      if (this.data.length > 0) this.terminal = completed(this.data.join('\n'))
      this.data = []
    } else if (text.startsWith('data:')) this.data.push(text.slice(5).replace(/^ /, ''))
  }

  consume(bytes: Uint8Array): number | undefined {
    for (let index = 0; index < bytes.length; index++) {
      const byte = bytes[index]!
      if (this.cr) {
        this.cr = false
        this.newline()
        if (byte === 10) {
          if (this.terminal) return index + 1
          continue
        }
        if (this.terminal) return index
      }
      if (byte === 13) {
        // The pinned eventsource-stream parser gives CRLF priority and waits
        // for the byte following a trailing CR before deciding the line end.
        this.cr = true
      } else if (byte === 10) {
        this.newline()
        if (this.terminal) return index + 1
      } else this.line.push(byte)
    }
    return undefined
  }

  get complete(): boolean { return this.terminal }
}

/** Close only the SDK-facing stream and cancel its owned reader, never the caller's signal. */
export function nativeResponseFetch(upstream: FetchFunction = globalThis.fetch): FetchFunction {
  return async (input, init) => {
    const response = await upstream(input, init)
    if (!response.ok || response.body === null || !response.headers.get('content-type')?.includes('text/event-stream')) return response
    const reader = response.body.getReader(), frame = new CompletionFrame()
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    let closed = false
    const release = (): void => { if (!closed) { closed = true; reader.releaseLock() } }
    const cancel = async (reason: unknown): Promise<void> => {
      try { await reader.cancel(reason) } finally { release() }
    }
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          signal?.throwIfAborted()
          const chunk = await reader.read()
          signal?.throwIfAborted()
          if (chunk.done) {
            if (!frame.complete) throw new Error('Native Responses stream closed before a valid completion event')
            controller.close(); release(); return
          }
          const end = frame.consume(chunk.value)
          if (end === undefined) controller.enqueue(chunk.value)
          else {
            if (end > 0) controller.enqueue(chunk.value.subarray(0, end))
            controller.close()
            // Cancellation follows a complete legal frame; its teardown cannot add a new outcome.
            await cancel('native response completed').catch(() => undefined)
          }
        } catch (error) {
          controller.error(error)
          await cancel(error).catch(() => undefined)
        }
      },
      async cancel(reason) { await cancel(reason) },
    })
    const forwarded = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
    Object.defineProperties(forwarded, { url: { value: response.url }, redirected: { value: response.redirected }, type: { value: response.type } })
    return forwarded
  }
}
