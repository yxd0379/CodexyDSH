/**
 * Durable pi-ai replay metadata and assistant-history reconstruction.
 *
 * Harness content remains the durable source for text and tool calls. This
 * module stores only the provider-native metadata needed to reconstruct a
 * pi-ai assistant message on a later request.
 *
 * @module dsh-llm-pi-ai/replay
 */

import { LlmError } from '@codexydsh/runtime/llm'
import type { AssistantMessage as HarnessAssistantMessage, ModelMessageSource, ReplayEnvelope } from '@codexydsh/runtime/llm'
import type { Api, AssistantMessage, Usage as PiUsage } from '@earendil-works/pi-ai'
import { HOSTED_REPLAY, type HostedResponsesReplay } from './hosted-responses.ts'
import { deepEqualJson, snapshotJsonValue } from '@deepseek-ai/dsh-util-values'

/** Per-block half of the pi-ai replay envelope, one entry per content block. */
export type PiAiReplayBlock = (
  | { type: 'text'; textSignature?: string }
  | { type: 'reasoning'; thinkingSignature?: string; redacted?: boolean }
  | { type: 'tool-call'; thoughtSignature?: string; namespace?: string }
  | { type: 'provider-output'; outputIndex: number }
) & { nativeContent?: unknown }

/** Versioned response-level half of the pi-ai replay envelope. */
export interface PiAiReplayResponse {
  kind: 'pi-ai'
  version: 2
  api: Api
  provider: string
  /** Requested model identity, matching the durable assistant source. */
  model: string
  /** Provider-reported model; only Anthropic replays it as the native model (reported in `message.model`, not `message.responseModel`). */
  responseModel?: string
  responseId?: string
  /** Provider-native effort for historical replay; absence is preserved. */
  providerThinkingLevel?: string
  stopReason: AssistantMessage['stopReason']
  /** Explicit hosted-route native items, including their original order and progress. */
  hostedResponses?: HostedResponsesReplay
}

/** The validated halves of one pi-ai replay envelope. */
interface PiAiReplayState {
  response: PiAiReplayResponse
  blocks: PiAiReplayBlock[]
}

/** Supply pi-ai's parsed argument object while the raw string travels separately. */
function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // fall through
  }
  return {}
}

type PiToolCall = Extract<AssistantMessage['content'][number], { type: 'toolCall' }>

function withRawArguments<T extends PiToolCall>(
  call: T, raw: string, kind: 'function' | 'freeform' = 'function',
): T & { __dshRawArguments: string; __dshFreeformInput?: string } {
  return {
    ...call, __dshRawArguments: raw,
    ...kind === 'freeform' ? { __dshFreeformInput: raw } : {},
  }
}

/** Construct the zero usage value required by historical pi-ai messages. */
function emptyPiUsage(): PiUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

/**
 * Project a successful pi-ai response into the minimal durable replay state.
 * The per-block half is index-aligned with the streamed blocks (pi-ai content
 * order), so `BlockAssembler` prunes an entry with its block whenever assembly
 * removes one.
 * @param message - completed native pi-ai assistant response.
 * @param requestedModel - request identity stored in the assistant source; defaults to the native model.
 * @returns the versioned lossless-JSON replay projection.
 */
export function toPiReplayState(message: AssistantMessage, requestedModel = message.model): ReplayEnvelope {
  const responseModel = message.api === 'anthropic-messages' && message.model !== requestedModel
    ? message.model : message.responseModel
  const response: PiAiReplayResponse = {
    kind: 'pi-ai',
    version: 2,
    api: message.api,
    provider: message.provider,
    model: requestedModel,
    ...responseModel === undefined ? {} : { responseModel },
    ...message.responseId === undefined ? {} : { responseId: message.responseId },
    ...message.providerThinkingLevel === undefined ? {} : { providerThinkingLevel: message.providerThinkingLevel },
    stopReason: message.stopReason,
  }
  return {
    response,
    blocks: message.content.map((block): PiAiReplayBlock => {
      switch (block.type) {
        case 'text': return {
          type: 'text',
          ...block.textSignature === undefined ? {} : { textSignature: block.textSignature },
        }
        case 'thinking': return {
          type: 'reasoning',
          ...block.thinkingSignature === undefined ? {} : { thinkingSignature: block.thinkingSignature },
          ...block.redacted === undefined ? {} : { redacted: block.redacted },
        }
        case 'toolCall': return {
          type: 'tool-call',
          ...block.thoughtSignature === undefined ? {} : { thoughtSignature: block.thoughtSignature },
          ...block.namespace === undefined || block.namespace === null ? {} : { namespace: block.namespace },
        }
      }
    }),
  }
}

/**
 * Project one completed stream item before the provider sends its terminal
 * response. The partial response is still pending at this point, so its
 * replay stop reason reflects the completed item instead. Response IDs may
 * arrive later and belong only to the terminal projection.
 * @param partial - provider response metadata available when the item closed.
 * @param block - the completed native item with any available signature.
 * @param requestedModel - request identity stored in the assistant source.
 * @returns a one-block replay envelope for an interrupted response.
 */
export function toPiItemReplayState(
  partial: AssistantMessage,
  block: AssistantMessage['content'][number],
  requestedModel = partial.model,
): ReplayEnvelope {
  const replayPartial: AssistantMessage = {
    ...partial,
    content: [block],
    stopReason: block.type === 'toolCall' ? 'toolUse' : 'stop',
  }
  delete replayPartial.responseId
  return toPiReplayState(replayPartial, requestedModel)
}

function invalidReplay(message: string): never {
  throw new LlmError(`invalid pi-ai replay state: ${message}`, 'INVALID_REPLAY_STATE')
}

/** Validate the durable adapter-private envelope before it reaches pi-ai. */
function readReplayState(value: unknown): PiAiReplayState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalidReplay('expected a replay envelope')
  const envelope = value as Record<string, unknown>
  const rawResponse = envelope['response']
  if (typeof rawResponse !== 'object' || rawResponse === null || Array.isArray(rawResponse)) return invalidReplay('expected a response object')
  const response = rawResponse as Record<string, unknown>
  if (response['kind'] !== 'pi-ai') return invalidReplay('unknown state kind')
  if (response['version'] !== 2) return invalidReplay(`unsupported version ${String(response['version'])}`)
  for (const key of ['api', 'provider', 'model'] as const) {
    if (typeof response[key] !== 'string' || response[key].length === 0) return invalidReplay(`${key} must be a non-empty string`)
  }
  if (!['stop', 'length', 'toolUse', 'error', 'aborted'].includes(String(response['stopReason']))) {
    return invalidReplay('unknown stopReason')
  }
  if (response['responseModel'] !== undefined && typeof response['responseModel'] !== 'string') return invalidReplay('responseModel must be a string')
  if (response['responseId'] !== undefined && typeof response['responseId'] !== 'string') return invalidReplay('responseId must be a string')
  if (response['providerThinkingLevel'] !== undefined && typeof response['providerThinkingLevel'] !== 'string') return invalidReplay('providerThinkingLevel must be a string')
  if (response['hostedResponses'] !== undefined) {
    const native = response['hostedResponses']
    if (response['api'] !== 'openai-responses' || typeof native !== 'object' || native === null || Array.isArray(native)
      || snapshotJsonValue<unknown>(native) === undefined) return invalidReplay('invalid hosted Responses state')
    const fields = native as Record<string, unknown>
    for (const key of ['output', 'events']) {
      if (!Array.isArray(fields[key]) || fields[key].some((item: unknown) => typeof item !== 'object' || item === null || Array.isArray(item))) {
        return invalidReplay(`hosted Responses ${key} must contain JSON objects`)
      }
    }
  }
  const blocks = envelope['blocks']
  if (!Array.isArray(blocks)) return invalidReplay('blocks must be an array')
  for (const [index, value] of blocks.entries()) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalidReplay(`block ${index} must be an object`)
    const block = value as Record<string, unknown>
    if (!['text', 'reasoning', 'tool-call', 'provider-output'].includes(String(block['type']))) return invalidReplay(`block ${index} has an unknown type`)
    if (block['type'] === 'provider-output' && (!Number.isSafeInteger(block['outputIndex']) || Number(block['outputIndex']) < 0)) return invalidReplay(`block ${index} has an invalid native index`)
    for (const signature of ['textSignature', 'thinkingSignature', 'thoughtSignature'] as const) {
      if (block[signature] !== undefined && typeof block[signature] !== 'string') return invalidReplay(`block ${index} ${signature} must be a string`)
    }
    if (block['namespace'] !== undefined && (block['type'] !== 'tool-call'
      || typeof block['namespace'] !== 'string' || block['namespace'].length === 0)) {
      return invalidReplay(`block ${index} namespace must be a non-empty tool-call string`)
    }
    if (block['redacted'] !== undefined && typeof block['redacted'] !== 'boolean') return invalidReplay(`block ${index} redacted must be boolean`)
  }
  return {
    response: response as unknown as PiAiReplayResponse,
    blocks: blocks as PiAiReplayBlock[],
  }
}

/** Convert provider-neutral blocks without trusting them as same-model replay. */
function foreignAssistant(message: HarnessAssistantMessage): AssistantMessage {
  const source = message.source
  const content: AssistantMessage['content'] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text': content.push({ type: 'text', text: block.text }); break
      case 'reasoning': content.push({ type: 'thinking', thinking: block.text }); break
      case 'tool-call': content.push(withRawArguments({
        type: 'toolCall',
        id: block.id,
        name: block.name,
        ...block.namespace === undefined ? {} : { namespace: block.namespace },
        arguments: block.kind === 'freeform' ? { input: block.arguments } : parseArguments(block.arguments),
      }, block.arguments, block.kind)); break
      case 'image':
        throw new LlmError('pi-ai chat history cannot represent structured assistant image output', 'UNSUPPORTED_CONTENT')
      default:
        // plugin-added block types are not representable in pi-ai.
        break
    }
  }
  return {
    role: 'assistant',
    content,
    // Deliberately never equals a catalog API: absent replay state is foreign
    // even if source names the same provider/model as this request.
    api: 'dsh-foreign',
    provider: source.provider,
    model: source.model,
    usage: emptyPiUsage(),
    stopReason: content.some(piece => piece.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp: 0,
  }
}

/** Recombine durable Harness content with validated pi-ai replay metadata. */
function replayedAssistant(message: HarnessAssistantMessage, source: ModelMessageSource, rawState: unknown): AssistantMessage {
  const state = readReplayState(rawState)
  if (state.response.provider !== source.provider) return invalidReplay('provider does not match assistant source')
  if (state.response.model !== source.model) return invalidReplay('model does not match assistant source')
  if (state.blocks.length !== message.content.length) return invalidReplay('block count does not match assistant content')
  const content: AssistantMessage['content'] = message.content.flatMap((block, index): AssistantMessage['content'] => {
    const replay = state.blocks[index]
    if (replay === undefined || replay.type !== block.type) return invalidReplay(`block ${index} does not match assistant content`)
    if (replay.nativeContent !== undefined && !deepEqualJson(replay.nativeContent, block)) return invalidReplay(`block ${index} changed its original native content`)
    switch (block.type) {
      case 'text': return [{
        type: 'text',
        text: block.text,
        ...replay.type === 'text' && replay.textSignature !== undefined ? { textSignature: replay.textSignature } : {},
      }]
      case 'reasoning': return [{
        type: 'thinking',
        thinking: block.text,
        ...replay.type === 'reasoning' && replay.thinkingSignature !== undefined ? { thinkingSignature: replay.thinkingSignature } : {},
        ...replay.type === 'reasoning' && replay.redacted !== undefined ? { redacted: replay.redacted } : {},
      }]
      case 'tool-call': {
        if (replay.type !== 'tool-call' || replay.namespace !== block.namespace) {
          return invalidReplay(`block ${index} namespace does not match assistant content`)
        }
        return [withRawArguments({
          type: 'toolCall',
          id: block.id,
          name: block.name,
          ...block.namespace === undefined ? {} : { namespace: block.namespace },
          arguments: block.kind === 'freeform' ? { input: block.arguments } : parseArguments(block.arguments),
          ...replay.thoughtSignature === undefined ? {} : { thoughtSignature: replay.thoughtSignature },
        }, block.arguments, block.kind)]
      }
      case 'provider-output': {
        if (replay.type !== 'provider-output' || replay.outputIndex !== block.outputIndex
          || !(state.response.hostedResponses?.output.some(item => deepEqualJson(item, block.item))
            || state.response.hostedResponses?.events.some(event => event['type'] === 'response.output_item.done' && deepEqualJson(event['item'], block.item)))) {
          return invalidReplay(`block ${index} does not match its original hosted output`)
        }
        return []
      }
      /* v8 ignore next -- readReplayState rejects unknown replay tags, so an equal plugin-added Harness tag cannot reach this switch */
      default: return invalidReplay(`block ${index} has an unsupported Harness type`)
    }
  })
  const result: AssistantMessage & { [HOSTED_REPLAY]?: HostedResponsesReplay } = {
    role: 'assistant',
    content,
    api: state.response.api,
    provider: state.response.provider,
    // Anthropic reports aliases and fallbacks as model, unlike Completions' informational responseModel.
    model: state.response.api === 'anthropic-messages'
      ? state.response.responseModel ?? state.response.model : state.response.model,
    ...state.response.responseModel === undefined ? {} : { responseModel: state.response.responseModel },
    ...state.response.responseId === undefined ? {} : { responseId: state.response.responseId },
    ...state.response.providerThinkingLevel === undefined ? {} : { providerThinkingLevel: state.response.providerThinkingLevel },
    usage: emptyPiUsage(),
    stopReason: state.response.stopReason,
    timestamp: 0,
  }
  if (state.response.hostedResponses !== undefined) result[HOSTED_REPLAY] = state.response.hostedResponses
  return result
}

/**
 * Convert one durable Harness assistant message into pi-ai history.
 *
 * Durable content is the authoritative record; replay metadata only restores
 * native fidelity (ids, signatures). A replay state this build cannot use —
 * another adapter's kind, another version, a malformed value, or metadata that
 * no longer matches the content — therefore degrades the one message to
 * provider-neutral history instead of failing the request.
 * @param message - model-produced assistant content with provider, model, and optional adapter-owned replay metadata.
 * @param onDegrade - called with the diagnostic reason when an unusable replay
 *   state falls back to provider-neutral conversion.
 * @returns a native pi-ai assistant message reconstructed from durable content.
 */
export function toPiAssistant(message: HarnessAssistantMessage, onDegrade?: (reason: string) => void): AssistantMessage {
  const source = message.source
  if (source.replayState === undefined) return foreignAssistant(message)
  try {
    return replayedAssistant(message, source, source.replayState)
  } catch (error: unknown) {
    /* v8 ignore next -- replayedAssistant throws only INVALID_REPLAY_STATE LlmErrors; the
       guard keeps a future non-replay failure loud instead of silently degrading it */
    if (!(error instanceof LlmError) || error.code !== 'INVALID_REPLAY_STATE') throw error
    onDegrade?.(error.message)
    return foreignAssistant(message)
  }
}
