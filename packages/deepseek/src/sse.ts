/** SSE framing delegated to eventsource-parser; JSON errors remain provider failures. */

import { EventSourceParserStream } from 'eventsource-parser/stream'
import { LlmError } from '@codexydsh/runtime/llm'
import { object } from './replay.ts'
import { providerError } from './transport.ts'

/** Decode complete SSE frames without treating an unterminated tail as an event.
 * @param body - provider response bytes.
 * @param activity - pulse the idle watchdog for events and heartbeat comments.
 * @param firstByte - optional observer invoked once for the first nonempty response bytes.
 * @returns JSON events, including message_stop; the translator owns completion.
 */
export async function* parseSse(
  body: ReadableStream<BufferSource>, activity: () => void, firstByte?: () => void,
): AsyncGenerator<Record<string, unknown>> {
  let observed = false
  const measured = firstByte === undefined ? body : body.pipeThrough(new TransformStream<BufferSource, BufferSource>({
    transform(bytes, controller) {
      if (!observed && bytes.byteLength > 0) {
        observed = true
        firstByte()
      }
      controller.enqueue(bytes)
    },
  }))
  const events = measured.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream({ onComment: activity }))
  for await (const frame of events) {
    activity()
    let raw: unknown
    try { raw = JSON.parse(frame.data) } catch (_invalidSseJson) {
      throw new LlmError('DeepSeek Messages SSE contains invalid JSON', 'MALFORMED_RESPONSE')
    }
    const event = object(raw)
    if (typeof event.type !== 'string' || (frame.event !== undefined && frame.event !== event.type)) {
      throw new LlmError('DeepSeek Messages SSE event type mismatch', 'MALFORMED_RESPONSE')
    }
    if (event.type === 'error') throw providerError(event, undefined)
    yield event
  }
}
