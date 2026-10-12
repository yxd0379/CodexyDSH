/** Native invocation declarations and notification messages admitted before tail recovery. */

import { SessionFormatError, isSessionFormatJsonObject, sessionFormatCount } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatJsonObject, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'

/**
 * Require an object at a decoded JSON field.
 * @param value - decoded field.
 * @param subject - diagnostic subject.
 * @returns the admitted object.
 */
export function record(value: SessionFormatJsonValue | undefined, subject: string): SessionFormatJsonObject
/**
 * Require an object in an untrusted physical row; JSON decoding owns its members.
 * @param value - untrusted field.
 * @param subject - diagnostic subject.
 * @returns the object record.
 */
export function record(value: unknown, subject: string): Record<string, unknown>
export function record(value: unknown, subject: string): Record<string, unknown> {
  if (!isSessionFormatJsonObject(value)) throw new SessionFormatError(`${subject} requires an object`)
  return value
}

/**
 * Require a nonempty decoded string.
 * @param value - decoded field.
 * @param subject - diagnostic subject.
 * @returns the admitted string.
 */
export function text(value: unknown, subject: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new SessionFormatError(`${subject} requires a nonempty string`)
  return value
}

function isJsonArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value)
}

/** Admit durable auxiliary facts without treating them as model history or replay instructions. */
function assertCompactionRequestFact(type: string, value: unknown): void {
  const data = record(value, `${type} data`)
  if (data['version'] !== 1) throw new SessionFormatError('unsupported compaction request version')
  for (const key of ['invocationId', 'requestId']) text(data[key], `compaction ${key}`)
  if (sessionFormatCount(data['attempt'], 'compaction attempt') === 0) throw new SessionFormatError('compaction attempt must be positive')
  sessionFormatCount(data['omittedInputMessages'], 'compaction omittedInputMessages')
  const source = record(data['source'], 'compaction source')
  if (source['checkpointFormat'] !== 'codex' && source['checkpointFormat'] !== 'dsh'
    || source['headMessageCount'] !== 0 && source['headMessageCount'] !== 1) throw new SessionFormatError('invalid compaction input source')
  for (const key of ['compactionId', 'sourceCommandId']) if (source[key] !== undefined) text(source[key], `compaction ${key}`)
  if (source['sourceEventSeqs'] !== undefined) {
    if (!isJsonArray(source['sourceEventSeqs'])) throw new SessionFormatError('compaction sourceEventSeqs must be an array')
    source['sourceEventSeqs'].forEach(seq => sessionFormatCount(seq, 'compaction source seq'))
  }
  if (source['shadowedRange'] !== undefined) {
    const range = record(source['shadowedRange'], 'compaction shadowedRange')
    if (sessionFormatCount(range['end'], 'compaction range end') < sessionFormatCount(range['start'], 'compaction range start')) throw new SessionFormatError('invalid compaction shadowedRange')
  }
  if (source['compactionMetadata'] !== undefined) {
    const facts = record(source['compactionMetadata'], 'compaction metadata facts')
    for (const key of ['trigger', 'reason', 'implementation', 'phase', 'strategy']) if (facts[key] !== undefined) text(facts[key], `compaction ${key}`)
  }
  if (type === 'compaction/request' || type === 'compaction/preparation-error') {
    const prepared = type === 'compaction/request'
    const input = record(data[prepared ? 'preparedInput' : 'proposedInput'], 'compaction native input')
    text(input['provider'], 'compaction input provider'); text(input['model'], 'compaction input model')
    if (input['purpose'] !== 'compaction' || !isJsonArray(input['messages'])
      || Object.hasOwn(input, 'signal') || Object.hasOwn(input, 'onRequestTiming')) throw new SessionFormatError('invalid durable compaction native input')
    for (const item of input['messages']) {
      const message = record(item, 'compaction request message')
      if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(String(message['role'])) || !isJsonArray(message['content'])) throw new SessionFormatError('invalid compaction request message')
    }
    if (input['tools'] !== undefined) {
      if (!isJsonArray(input['tools'])) throw new SessionFormatError('compaction request tools must be an array')
      input['tools'].forEach(assertToolSchema)
    }
    if (input['codexfulResponses'] !== undefined) {
      const controls = record(input['codexfulResponses'], 'compaction controls')
      if (controls['clientMetadata'] !== undefined && Object.values(record(controls['clientMetadata'], 'compaction client metadata')).some(item => typeof item !== 'string')) throw new SessionFormatError('invalid compaction client metadata')
    }
    if (prepared) {
      if (Object.hasOwn(data, 'dispatchInvoked')) throw new SessionFormatError('prepared compaction fact cannot assert dispatch')
      return
    }
    if (data['dispatchInvoked'] !== false || data['stage'] !== 'model' && data['stage'] !== 'call') throw new SessionFormatError('invalid compaction preparation failure')
  } else {
    if (data['dispatchInvoked'] !== true || !['completed', 'error', 'aborted'].includes(String(data['outcome']))
      || !isJsonArray(data['output']) || !isJsonArray(data['streamChunks'])
      || !['assembled', 'interrupted-text-and-provider', 'unavailable'].includes(String(data['outputProjection']))) throw new SessionFormatError('invalid compaction request result')
    if (data['projectionFailure'] !== undefined && typeof record(data['projectionFailure'], 'compaction projection failure')['message'] !== 'string') throw new SessionFormatError('compaction projection failure message must be a string')
    if (data['finish'] !== undefined) {
      const finish = record(data['finish'], 'compaction observed finish')
      if (!['stop', 'error', 'aborted', 'max-tokens'].includes(String(finish['kind']))) throw new SessionFormatError('invalid compaction observed finish')
    }
    if (data['outcome'] === 'completed' && data['failure'] !== undefined) throw new SessionFormatError('completed compaction stream cannot have failure')
    if (data['outcome'] === 'completed') return
  }
  const failure = record(data['failure'], 'compaction request failure')
  if (typeof failure['message'] !== 'string') throw new SessionFormatError('compaction failure message must be a string')
  if (failure['code'] !== undefined) text(failure['code'], 'compaction failure code')
}

/**
 * Admit the explicit invocation discriminator, defaulting only the released function form.
 * @param value - decoded discriminator.
 * @returns the invocation form.
 */
export function toolKind(value: unknown): 'function' | 'freeform' {
  if (value === undefined || value === 'function') return 'function'
  if (value === 'freeform') return value
  throw new SessionFormatError('tool kind must be function or freeform')
}

function assertToolSchema(value: unknown): void {
  const tool = record(value, 'request tool')
  text(tool['name'], 'request tool name')
  if (typeof tool['description'] !== 'string') throw new SessionFormatError('request tool description must be a string')
  if (toolKind(tool['kind']) === 'freeform') {
    if (Object.hasOwn(tool, 'parameters')) throw new SessionFormatError('freeform tool must omit JSON parameters')
    const format = record(tool['format'], 'freeform tool format')
    if (format['type'] !== 'grammar' || (format['syntax'] !== 'lark' && format['syntax'] !== 'regex')
      || typeof format['definition'] !== 'string' || format['definition'].length === 0) throw new SessionFormatError('freeform tool requires a nonempty Lark or regex grammar definition')
  } else {
    record(tool['parameters'], 'function tool parameters')
    if (Object.hasOwn(tool, 'format')) throw new SessionFormatError('function tool must omit a freeform format')
  }
  if (tool['deferLoading'] !== undefined && tool['deferLoading'] !== true) throw new SessionFormatError('tool deferLoading must be true when present')
  if (tool['namespace'] !== undefined) {
    const namespace = record(tool['namespace'], 'tool namespace')
    text(namespace['name'], 'tool namespace name')
    text(namespace['toolName'], 'namespaced tool name')
    if (typeof namespace['description'] !== 'string') throw new SessionFormatError('tool namespace description must be a string')
  }
  if (tool['inputSchemaMaxBytes'] !== undefined) sessionFormatCount(tool['inputSchemaMaxBytes'], 'tool inputSchemaMaxBytes')
  if (tool['outputSchema'] !== undefined) record(tool['outputSchema'], 'tool outputSchema')
}

/**
 * Validate a first-class additional tool output without treating it as settlement.
 * @param data - decoded notification payload.
 * @returns the admitted tool message.
 */
export function notificationMessage(data: SessionFormatJsonObject): SessionFormatJsonObject
/**
 * Admit notification message fields before physical JSON decoding.
 * @param data - untrusted notification payload.
 * @returns the tool message record.
 */
export function notificationMessage(data: Record<string, unknown>): Record<string, unknown>
export function notificationMessage(data: Record<string, unknown>): Record<string, unknown> {
  const message = record(data['message'], 'notification message')
  text(message['id'], 'notification message id')
  if (message['role'] !== 'tool') throw new SessionFormatError('notification requires a tool-role message')
  const source = record(message['source'], 'notification message source')
  if (source['kind'] !== 'tool') throw new SessionFormatError('notification requires a tool source')
  const id = text(message['toolCallId'], 'notification toolCallId')
  if (source['callId'] !== id) throw new SessionFormatError('notification requires matching tool call ids')
  if (!isJsonArray(message['content'])) throw new SessionFormatError('notification requires array content')
  if (message['content'].some(block => isSessionFormatJsonObject(block) && block['type'] === 'tool-result')) {
    throw new SessionFormatError('notification content must not contain a released tool-result wrapper')
  }
  if (typeof message['isError'] !== 'boolean') {
    throw new SessionFormatError('notification isError must be boolean')
  }
  if (data['historyTruncationTokenLimit'] !== undefined) sessionFormatCount(data['historyTruncationTokenLimit'], 'notification historyTruncationTokenLimit')
  if (data['originalText'] !== undefined && typeof data['originalText'] !== 'string') throw new SessionFormatError('notification originalText must be a string')
  if (toolKind(source['toolKind']) === 'freeform') text(source['name'], 'freeform notification tool name')
  return message
}

/**
 * Read advertised tool-call blocks without interpreting ordinary content or tool argument strings.
 * @param row - decoded row.
 * @returns advertised calls from one completed item or assistant message.
 */
export function advertisedCalls(row: SessionFormatJsonObject): readonly SessionFormatJsonObject[]
/**
 * Read tool-call records from an untrusted assistant row without parsing arguments.
 * @param row - untrusted row.
 * @returns its advertised invocation records.
 */
export function advertisedCalls(row: Record<string, unknown>): readonly Record<string, unknown>[]
export function advertisedCalls(row: Record<string, unknown>): readonly Record<string, unknown>[] {
  const data = row['data']
  if (!isSessionFormatJsonObject(data)) return []
  if (row['type'] === 'assistant/output-item') {
    const block = data['block']
    return isSessionFormatJsonObject(block) && block['type'] === 'tool-call' ? [block] : []
  }
  if (row['type'] !== 'assistant/message') return []
  const message = data['message']
  const content = isSessionFormatJsonObject(message) ? message['content'] : undefined
  if (!isJsonArray(content)) return []
  return content.filter((block): block is Record<string, unknown> => isSessionFormatJsonObject(block) && block['type'] === 'tool-call')
}

function streamCalls(row: Record<string, unknown>): readonly Record<string, unknown>[] {
  if (row['type'] !== 'assistant/message' && row['type'] !== 'assistant/attempt') return []
  const data = row['data']
  if (!isSessionFormatJsonObject(data) || !isJsonArray(data['stream'])) return []
  return data['stream'].flatMap((item) => {
    if (!isSessionFormatJsonObject(item) || item['type'] !== 'chunk') return []
    const chunk = item['chunk']
    if (!isSessionFormatJsonObject(chunk)) return []
    if (chunk['type'] === 'tool-call-delta') return [chunk]
    const block = chunk['block']
    return chunk['type'] === 'block-end' && isSessionFormatJsonObject(block) && block['type'] === 'tool-call' ? [block] : []
  })
}

/**
 * Validate V5-specific grammar, discriminator, and notification fields before physical tail recovery.
 * Relationship validation requires the complete artifact and remains in the restorer.
 * @param row - untrusted physical or logical row.
 */
export function assertV5RowContent(row: unknown): void {
  if (!isSessionFormatJsonObject(row)) return
  const data = row['data']
  if (row['type'] === 'compaction/request' || row['type'] === 'compaction/request-result' || row['type'] === 'compaction/preparation-error') {
    if (row['surfaceOp'] !== undefined) throw new SessionFormatError('compaction request facts cannot enter the model surface')
    assertCompactionRequestFact(row['type'], data)
    return
  }
  if (row['type'] === 'tool/notification') {
    const payload = record(data, 'tool/notification data')
    sessionFormatCount(payload['turn'], 'notification turn')
    sessionFormatCount(payload['callSeq'], 'notification callSeq')
    if (row['surfaceOp'] !== 'append') throw new SessionFormatError('tool/notification must append an additional output')
    notificationMessage(payload)
    return
  }
  if (row['type'] === 'runtime/feature' || row['type'] === 'request/feature') {
    const feature = record(data, `${row['type']} data`)
    const known = row['type'] === 'request/feature'
      ? feature['name'] === 'codexful-responses'
      : feature['name'] === 'tool-notification' || feature['name'] === 'native-request-header'
    if (!known || feature['version'] !== 1) throw new SessionFormatError(`unsupported ${row['type']}`)
    return
  }
  if (!isSessionFormatJsonObject(data)) return
  if (row['type'] === 'compaction/summary' && data['clientMetadata'] !== undefined) {
    const metadata = record(data['clientMetadata'], 'compaction client metadata')
    if (Object.values(metadata).some(value => typeof value !== 'string')) throw new SessionFormatError('invalid compaction client metadata')
  }
  if (row['type'] === 'request/header') {
    const header = record(data['header'], 'request header')
    const config = record(header['config'], 'request config')
    if (config['codexfulResponses'] !== undefined) {
      const controls = record(config['codexfulResponses'], 'Codexy request controls')
      if (typeof controls['omitDefaultMaxTokens'] !== 'boolean'
        || controls['reasoningSummary'] !== 'auto' && controls['reasoningSummary'] !== 'none'
        || controls['wireProfile'] !== undefined && controls['wireProfile'] !== 'codex-0.162.1'
        || controls['lite'] !== undefined && controls['lite'] !== true
        || controls['strictModelInput'] !== undefined && controls['strictModelInput'] !== true) throw new SessionFormatError('invalid Codexy request controls')
      if (controls['clientMetadata'] !== undefined) {
        const metadata = record(controls['clientMetadata'], 'Codexy client metadata')
        if (Object.values(metadata).some(value => typeof value !== 'string')) throw new SessionFormatError('invalid Codexy client metadata')
      }
    }
    if (header['tools'] !== undefined) {
      if (!isJsonArray(header['tools'])) throw new SessionFormatError('request tools must be an array')
      header['tools'].forEach(assertToolSchema)
    }
  } else if (row['type'] === 'assistant/output-item') {
    for (const field of ['turn', 'step', 'index']) {
      const coordinate = sessionFormatCount(data[field], `assistant/output-item ${field}`)
      if (field !== 'index' && coordinate === 0) throw new SessionFormatError(`assistant/output-item ${field} must be positive`)
    }
    text(data['provider'], 'completed item provider')
    text(data['model'], 'completed item model')
    const block = record(data['block'], 'completed output block')
    if (block['type'] === 'tool-call') {
      text(block['id'], 'completed call id'); text(block['name'], 'completed tool name')
      if (typeof block['arguments'] !== 'string') throw new SessionFormatError('completed call arguments must be a string')
    } else if (block['type'] === 'provider-output') {
      if (block['api'] !== 'openai-responses') throw new SessionFormatError('unsupported provider output API')
      if (sessionFormatCount(block['outputIndex'], 'provider output index') !== data['index']) throw new SessionFormatError('provider output index must match its checkpoint')
      const item = record(block['item'], 'provider output item')
      if (item['type'] !== 'web_search_call') throw new SessionFormatError('unsupported provider output item')
      text(item['id'], 'provider output item id')
    } else if ((block['type'] !== 'text' && block['type'] !== 'reasoning') || typeof block['text'] !== 'string') {
      throw new SessionFormatError('completed output must be a text, reasoning, or tool call block')
    }
    if (data['replayState'] !== undefined) {
      const state = record(data['replayState'], 'completed item replay state')
      if (state['blocks'] !== undefined && !Array.isArray(state['blocks'])) throw new SessionFormatError('completed replay blocks must be an array')
    }
  } else if (row['type'] === 'tool/call') {
    toolKind(data['kind'])
  } else if (row['type'] === 'tool/result') {
    const message = record(data['message'], 'tool result message')
    const source = record(message['source'], 'tool result source')
    if (toolKind(source['toolKind']) === 'freeform') text(source['name'], 'freeform result tool name')
  }
  for (const call of advertisedCalls(row)) toolKind(call['kind'])
  for (const call of streamCalls(row)) toolKind(call['kind'])
}

