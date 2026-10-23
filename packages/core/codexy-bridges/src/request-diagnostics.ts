/** Request metadata and monotonic durations for opt-in LLM diagnostics. */

import { isTokenDelta } from '@codexydsh/runtime/llm'
import { isAgentLoopRequest, markAgentLoopRequest } from '@codexydsh/runtime/llm'
import type { GenerateOptions, StreamChunk, TokenUsage } from '@codexydsh/runtime/llm'

/**
 * Observe an adapter call without changing model input or retaining streamed text.
 * Adapter phases carry their original epoch time beside the observation's monotonic duration.
 * @param options - immutable caller request, including any existing timing observer.
 * @param sequence - call number within this LLM service instance.
 * @param started - epoch and monotonic timestamps captured before the request waterfall.
 * @param dispatch - provider stream factory receiving the additional timing observer.
 * @param write - metadata sink; its failures are contained by the caller.
 * @returns the original chunks with diagnostics for first output and every settlement path.
 */
export async function* diagnoseRequest(
  options: GenerateOptions,
  sequence: number,
  started: { readonly wall: number; readonly monotonic: number },
  dispatch: (observed: GenerateOptions) => AsyncIterable<StreamChunk>,
  write: (line: string) => void,
): AsyncGenerator<StreamChunk> {
  let previous = started.monotonic
  const record = (
    phase: string,
    fields: Record<string, string | number | undefined> = {},
    at: typeof started = { wall: Date.now(), monotonic: performance.now() },
  ): void => {
    const time = at.wall
    const now = at.monotonic
    const elapsedMs = now - started.monotonic
    write(`[llm-timing] ${JSON.stringify({
      time, sequence, sessionId: options.sessionId,
      provider: options.provider, model: options.model, purpose: options.purpose,
      scope: isAgentLoopRequest(options) ? 'agent' : 'auxiliary', phase,
      elapsedMs, sincePreviousMs: now - previous, wallDriftMs: time - started.wall - elapsedMs,
      ...fields,
    })}`)
    previous = now
  }
  record('request-start', {
    eventDeliveryDelayMs: Date.now() - started.wall,
    messages: options.messages.length, tools: options.tools?.length,
  }, started)
  record('adapter-stream-start')
  const observed: GenerateOptions = {
    ...options,
    onRequestTiming(timing) {
      record(timing.phase, { eventTime: timing.time, eventDeliveryDelayMs: Date.now() - timing.time })
      options.onRequestTiming?.(timing)
    },
  }
  if (isAgentLoopRequest(options)) markAgentLoopRequest(observed)
  let firstToken = false
  let completed = false
  let outcome: string | undefined
  let code: string | undefined
  let status: number | undefined
  let requestId: string | undefined
  let usage: TokenUsage | undefined
  try {
    for await (const chunk of dispatch(Object.isFrozen(options) ? Object.freeze(observed) : observed)) {
      if (!firstToken && isTokenDelta(chunk)) {
        firstToken = true
        record('first-token')
      }
      if (chunk.type === 'usage') usage = chunk.usage
      if (chunk.type === 'finish') {
        outcome = chunk.reason.kind
        if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
          code = chunk.reason.failure.code
          status = chunk.reason.failure.status
          requestId = chunk.reason.failure.requestId
        }
      }
      yield chunk
    }
    completed = true
  } finally {
    record('request-end', {
      outcome: outcome ?? (completed ? 'eof' : 'consumer-closed'), code, status, requestId,
      inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens,
      cacheReadTokens: usage?.cacheReadTokens,
    })
  }
}
