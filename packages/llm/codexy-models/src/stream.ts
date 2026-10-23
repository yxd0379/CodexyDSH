/**
 * pi-ai assistant event translation into the Harness streaming protocol.
 *
 * The Harness preserves function JSON and native custom source strings while
 * pi-ai represents both as parsed argument objects. Failures are terminal stream
 * events, which this module maps into Harness finish chunks.
 *
 * @module dsh-llm-pi-ai/stream
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import { CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, isContextWindowExceededError, isQuotaExceededError, LlmError, QUOTA_EXCEEDED_CODE } from '@codexydsh/runtime/llm'
import type { FinishReason, StreamChunk, TokenUsage, ToolCallId } from '@codexydsh/runtime/llm'
import { isContextOverflow } from '@earendil-works/pi-ai/utils/overflow'
import type { AssistantMessage, AssistantMessageEvent, Usage as PiUsage } from '@earendil-works/pi-ai'
import { toPiItemReplayState, toPiReplayState } from './replay.ts'

/**
 * Map pi-ai usage (reasoning folded into output by pi-ai).
 * @param usage - cumulative usage from the terminal pi-ai event.
 * @returns harness counts with pi-ai's exact total; cache fields appear only
 *   when non-zero (pi-ai reports zeros, not absence).
 */
export function mapUsage(usage: PiUsage): TokenUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: usage.totalTokens,
    ...usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {},
    ...usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {},
  }
}

// XXX(pi-ai upstream): pi-ai flattens the caught error to `error.message`
// (api/anthropic-messages.js: `errorMessage = error instanceof Error ?
// error.message : JSON.stringify(error)`), discarding the original Error and its
// `cause` chain before it reaches us. undici carries the actionable transport
// detail on `cause` (e.g. `SocketError: other side closed`) but hands the fetch
// wrapper a bare `terminated`, so we are left pattern-matching terse words here.
// If pi-ai ever forwards the original Error (or a fetch/dispatcher hook that lets
// us capture the cause ourselves), classify on `code`/`cause` instead of text.
function classifyPiAiError(message: string): string {
  if (/\b(?:401|403)\b/.test(message)) return 'AUTH'
  if (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE
  if (/\b429\b|rate.?limit/i.test(message)) return 'RATE_LIMIT'
  // A rejected request body (gateway or provider size cap): resending the
  // same request cannot succeed, so it is invalid, not transient.
  if (/\b413\b|failed to buffer the request body:\s*length limit exceeded|payload too large|request body too large/i.test(message)) return 'INVALID_REQUEST'
  if (/\b400\b|invalid.?request/i.test(message)) return 'INVALID_REQUEST'
  if (/\b5\d\d\b/.test(message)) return 'SERVER'
  if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) return 'TIMEOUT'
  // A stream truncated before the provider's terminal event: each pi-ai provider
  // throws its own wording when the wire closes mid-response without a terminal
  // event (`… stream ended before message_stop`, `… before a terminal response
  // event`, `… ended without a terminal event`, `Stream ended without
  // finish_reason`). The connection dropped mid-response, so this is a transport
  // truncation, not a model-level error.
  if (/stream ended (?:before|without)\b/i.test(message)) return 'TRANSPORT'
  if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(message)
    || /\b(?:other side closed|HTTP2 request did not get a response|WebSocket closed unexpectedly)\b/i.test(message)
    // undici renders a mid-stream socket drop as a bare `terminated` (its
    // `cause` — the real SocketError — was flattened away upstream); Node's
    // stream layer says `Premature close`.
    || /\bterminated\b|premature close/i.test(message)) {
    return 'TRANSPORT'
  }
  return 'PI_AI_ERROR'
}

/**
 * Map a terminal pi-ai event to the harness finish reason.
 * @param message - the assistant message carried by the `done` or `error` event.
 * @param contextWindow - resolved catalog capacity for usage-based overflow detection.
 * @returns the mapped harness reason. Recognized error text, `stop` usage above
 *   `contextWindow`, and zero-output `length` usage that fills the window map
 *   to `CONTEXT_WINDOW_EXCEEDED`; a terminal `stop` with no content blocks maps
 *   to `EMPTY_RESPONSE`, while Responses `end_turn: false` stays a same-turn
 *   continuation. Terminal `pending` and `deferred` states map to non-retryable
 *   `PI_AI_ERROR` failures.
 */
export function mapStopReason(message: AssistantMessage, contextWindow?: number): FinishReason {
  const piAiOverflow = isContextOverflow(message, contextWindow)
  const harnessOverflow = message.stopReason === 'error'
    && message.errorMessage !== undefined
    && isContextWindowExceededError(message.errorMessage)
  if (piAiOverflow || harnessOverflow) {
    return {
      kind: 'error',
      failure: {
        message: message.errorMessage ?? `pi-ai detected context overflow for model "${message.model}"`,
        code: CONTEXT_WINDOW_EXCEEDED_CODE,
      },
    }
  }

  switch (message.stopReason) {
    case 'stop':
      if ('__dshEndTurn' in message && message.__dshEndTurn === false) {
        return { kind: 'stop', endTurn: false }
      }
      // A terminal stop that produced no content blocks is a degenerate
      // provider completion, not a successful (empty) assistant message.
      if (message.content.length === 0) {
        return {
          kind: 'error',
          failure: {
            message: `model "${message.model}" returned a completed response with no content`,
            code: EMPTY_RESPONSE_CODE,
          },
        }
      }
      return { kind: 'stop' }
    case 'length': return { kind: 'max-tokens' }
    case 'toolUse': return { kind: 'tool-calls' }
    case 'pending': return {
      kind: 'error',
      failure: { message: `pi-ai stream for model "${message.model}" ended pending`, code: 'PI_AI_ERROR' },
    }
    case 'deferred': return {
      kind: 'error',
      failure: { message: `pi-ai deferred response for model "${message.model}" is not supported`, code: 'PI_AI_ERROR' },
    }
    case 'aborted': return {
      kind: 'aborted',
      failure: { message: message.errorMessage ?? 'pi-ai stream aborted', code: 'ABORTED' },
    }
    case 'error': {
      const text = message.errorMessage ?? 'pi-ai stream error'
      return { kind: 'error', failure: { message: text, code: classifyPiAiError(text) } }
    }
  }
}

/**
 * Translate the pi-ai event stream into StreamChunks. pi-ai never throws
 * mid-stream — failures arrive as `error` events, which become error/aborted
 * `finish` chunks (the harness protocol's other error-delivery style).
 * @param events - one assistant turn's pi-ai event stream.
 * @param contextWindow - resolved catalog capacity for usage-based overflow detection.
 * @param callerSignal - caller cancellation state; an aborted caller makes any
 *   in-band terminal error an aborted finish.
 * @param requestedModel - request model identity recorded for durable replay.
 * @returns the harness chunks, ending with `usage` then `finish`; throws
 *   `LlmError` (`STREAM_CLOSED`) if the source ends without a terminal event.
 */
export async function* toStreamChunks(
  events: AsyncIterable<AssistantMessageEvent>,
  contextWindow?: number,
  callerSignal?: AbortSignal,
  requestedModel?: string,
): AsyncGenerator<StreamChunk> {
  // pi-ai contentIndex ↔ our block index map 1:1 (both count blocks from 0
  // in stream order), but we track ids per index for tool calls.
  const toolIds = new Map<number, { id: string; name: string; kind?: 'freeform' }>()

  for await (const event of events) {
    switch (event.type) {
      case 'start':
        break
      case 'text_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'text' }
        break
      case 'text_delta':
        yield { type: 'text-delta', index: event.contentIndex, text: event.delta }
        break
      case 'text_end': {
        const partialBlock = event.partial.content[event.contentIndex]
        yield {
          type: 'block-end',
          index: event.contentIndex,
          block: { type: 'text', text: event.content },
          replayState: toPiItemReplayState(event.partial, {
            type: 'text',
            text: event.content,
            ...partialBlock?.type === 'text' && partialBlock.textSignature !== undefined
              ? { textSignature: partialBlock.textSignature } : {},
          }, requestedModel),
        }
        break
      }
      case 'thinking_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'reasoning' }
        break
      case 'thinking_delta':
        yield { type: 'reasoning-delta', index: event.contentIndex, text: event.delta }
        break
      case 'thinking_end': {
        const partialBlock = event.partial.content[event.contentIndex]
        yield {
          type: 'block-end',
          index: event.contentIndex,
          block: { type: 'reasoning', text: event.content },
          replayState: toPiItemReplayState(event.partial, {
            type: 'thinking',
            thinking: event.content,
            ...partialBlock?.type === 'thinking' && partialBlock.thinkingSignature !== undefined
              ? { thinkingSignature: partialBlock.thinkingSignature } : {},
            ...partialBlock?.type === 'thinking' && partialBlock.redacted !== undefined
              ? { redacted: partialBlock.redacted } : {},
          }, requestedModel),
        }
        break
      }
      case 'toolcall_start': {
        // The id/name live on the partial's content at this index.
        const partial = event.partial.content[event.contentIndex]
        const id = partial?.type === 'toolCall' ? partial.id : ''
        const name = partial?.type === 'toolCall' ? partial.name : ''
        const initialInput = '__dshFreeformInitialInput' in event && typeof event.__dshFreeformInitialInput === 'string'
          ? event.__dshFreeformInitialInput : undefined
        toolIds.set(event.contentIndex, { id, name, ...initialInput === undefined ? {} : { kind: 'freeform' } })
        yield { type: 'block-start', index: event.contentIndex, blockType: 'tool-call' }
        if (initialInput !== undefined && initialInput.length > 0) {
          yield {
            type: 'tool-call-delta', index: event.contentIndex, id: brandString<ToolCallId>(id),
            name, kind: 'freeform', argumentsDelta: initialInput,
          }
        }
        break
      }
      case 'toolcall_delta': {
        const known = toolIds.get(event.contentIndex)
        const rawDelta = '__dshFreeformInputDelta' in event && typeof event.__dshFreeformInputDelta === 'string'
          ? event.__dshFreeformInputDelta : undefined
        if (known?.kind === 'freeform' && rawDelta === undefined) {
          throw new LlmError('pi-ai omitted the native freeform input delta', 'INVALID_RESPONSE')
        }
        yield {
          type: 'tool-call-delta',
          index: event.contentIndex,
          id: brandString<ToolCallId>(known?.id ?? ''),
          ...known?.name !== undefined && known.name.length > 0 ? { name: known.name } : {},
          ...known?.kind === undefined ? {} : { kind: known.kind },
          argumentsDelta: rawDelta ?? event.delta,
        }
        break
      }
      case 'toolcall_end': {
        // Responses retains function JSON and custom source independently of
        // pi-ai's parsed object for tool feedback and subsequent history.
        const rawArguments = '__dshRawArguments' in event.toolCall
          ? event.toolCall.__dshRawArguments : undefined
        const freeformInput = '__dshFreeformInput' in event.toolCall && typeof event.toolCall.__dshFreeformInput === 'string'
          ? event.toolCall.__dshFreeformInput : undefined
        yield {
          type: 'block-end',
          index: event.contentIndex,
          block: {
            type: 'tool-call',
            id: brandString<ToolCallId>(event.toolCall.id),
            name: event.toolCall.name,
            // Responses declares namespace as nullable. Null denotes the
            // ordinary unnamespaced tool, not a literal dispatch namespace.
            ...event.toolCall.namespace === undefined || event.toolCall.namespace === null
              ? {} : { namespace: event.toolCall.namespace },
            ...freeformInput === undefined ? {} : { kind: 'freeform' },
            arguments: freeformInput ?? (typeof rawArguments === 'string'
              ? rawArguments : JSON.stringify(event.toolCall.arguments)),
          },
          replayState: toPiItemReplayState(event.partial, event.toolCall, requestedModel),
        }
        break
      }
      case 'done':
        yield { type: 'usage', usage: mapUsage(event.message.usage) }
        yield {
          type: 'finish',
          reason: mapStopReason(event.message, contextWindow),
          replayState: toPiReplayState(event.message, requestedModel),
        }
        return
      case 'error':
        // In-stream error delivery (pi-ai's style) → error finish chunk
        // (the harness's other sanctioned error path besides throwing).
        yield { type: 'usage', usage: mapUsage(event.error.usage) }
        yield {
          type: 'finish',
          reason: mapStopReason(
            callerSignal?.aborted ? { ...event.error, stopReason: 'aborted' } : event.error,
            contextWindow,
          ),
        }
        return
      // no default: AssistantMessageEvent is pi-ai's closed union; a new
      // event type should fail compilation here via tsc's exhaustiveness
      // when one is added (switch covers all current variants).
    }
  }
  throw new LlmError('pi-ai event stream ended without done/error', 'STREAM_CLOSED')
}
