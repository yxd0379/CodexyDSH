/** Native invocation admission for imported v5 and independent product artifacts. */

import { SessionFormatError, isSessionFormatJsonObject, sessionFormatCount } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact, SessionFormatEvent, SessionFormatJsonObject, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'
import { assertReleasedV4Header } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { assertCodexyLifecycleRelationships } from './product-relationships.ts'
import { advertisedCalls, assertV5RowContent, notificationMessage, record, text, toolKind } from './v5-content.ts'

/**
 * Validate V5 metadata using the unchanged V4 metadata fields.
 * @param header - untrusted decoded V5 header.
 */
export function assertReleasedV5Header(header: unknown): void {
  if (!isSessionFormatJsonObject(header) || header['version'] !== 5) throw new SessionFormatError('expected format v5 header')
  assertReleasedV4Header({ ...header, version: 4 })
}

function jsonArray(value: SessionFormatJsonValue | undefined): value is readonly SessionFormatJsonValue[] {
  return Array.isArray(value)
}

function structuralEvent(
  event: SessionFormatEvent, artifact: SessionFormatArtifact,
  activeTurn: number | undefined, knownEventTypes: ReadonlySet<string>,
): SessionFormatEvent {
  if (event.type === 'request/header') {
    const data = record(event.data, 'request/header data')
    const header = record(data['header'], 'request header')
    if (!jsonArray(header['tools'])) return event
    const tools = header['tools'].map(tool => isSessionFormatJsonObject(tool) && tool['kind'] === 'freeform'
      ? { ...tool, parameters: {} } : tool)
    return { ...event, data: { ...data, header: { ...header, tools } } }
  }
  if (event.type === 'session-log-deepseek/delivery-accepted') {
    const data = record(event.data, 'delivery-accepted data')
    // Only native V5 watermarks enter the frozen validator's active generation.
    if (data['sessionFormatVersion'] === 5) return { ...event, data: { ...data, sessionFormatVersion: 4 } }
    if (data['sessionFormatVersion'] === 4) return { ...event, data: { ...data, sessionFormatVersion: 3 } }
    return event
  }
  if (event.type !== 'tool/notification') return event
  const data = record(event.data, 'tool/notification data')
  if (activeTurn === undefined || data['turn'] !== activeTurn) throw new SessionFormatError('tool/notification requires its active turn')
  if (event['surfaceOp'] !== 'append') throw new SessionFormatError('tool/notification must append an additional output')
  const callSeq = sessionFormatCount(data['callSeq'], 'tool/notification callSeq')
  const cited = event['sourceEventSeqs']
  if (!jsonArray(cited) || cited.length !== 1 || cited[0] !== callSeq) throw new SessionFormatError('tool/notification must cite exactly its originating call')
  const call = artifact.events[callSeq]
  if (callSeq >= event.seq || call?.type !== 'tool/call' || !knownEventTypes.has(call.type)) throw new SessionFormatError('tool/notification callSeq must reference an earlier known tool/call')
  const callData = record(call.data, 'notification originating call')
  const message = notificationMessage(data)
  const source = record(message['source'], 'notification message source')
  if (message['role'] !== 'tool' || source['kind'] !== 'tool'
    || message['toolCallId'] !== callData['callId'] || source['callId'] !== callData['callId']) {
    throw new SessionFormatError('tool/notification must retain its originating tool call')
  }
  if (toolKind(source['toolKind']) !== toolKind(callData['kind'])) throw new SessionFormatError('tool/notification tool kind differs from its call')
  if (source['toolKind'] === 'freeform' && source['name'] !== callData['name']) {
    throw new SessionFormatError('tool/notification tool name differs from its call')
  }
  // An ordinary-message view retains the surface position without settling the call.
  return { ...event, type: 'user/message', data: { ...message, role: 'user', source: { kind: 'tool-notification' } } }
}

interface Invocation {
  readonly kind: 'function' | 'freeform'
  readonly name: string
}

function invocation(value: SessionFormatJsonObject): Invocation {
  return { kind: toolKind(value['kind']), name: text(value['name'], 'tool call name') }
}

function assertOutputInvocation(message: SessionFormatJsonObject, origin: Invocation | undefined): void {
  const source = record(message['source'], 'tool result source')
  if (origin === undefined) return
  if (toolKind(source['toolKind']) !== origin.kind) throw new SessionFormatError('tool/result tool kind differs from its invocation')
  if (source['toolKind'] === 'freeform' && source['name'] !== origin.name) throw new SessionFormatError('tool/result tool name differs from its invocation')
}

/**
 * Validate native notifications, early dispatch, surface ranges, and tool settlement.
 * The returned artifact retains native tool messages and every original event.
 * Original Session restoration separately validates envelopes, messages, and seed cuts.
 * @param artifact - detached V5 artifact.
 * @param knownEventTypes - required vocabulary understood by the reader.
 * @returns the original validated artifact.
 */
export function restoreReleasedV5Artifact(artifact: SessionFormatArtifact, knownEventTypes: ReadonlySet<string>): SessionFormatArtifact {
  assertReleasedV5Header(artifact.header)
  let activeTurn: number | undefined
  const advertised = new Map<string, Invocation>()
  const called = new Map<string, Invocation>()
  const events = artifact.events.map((event) => {
    if (!knownEventTypes.has(event.type)) return event
    assertV5RowContent(event)
    if (event.type === 'turn/start' && isSessionFormatJsonObject(event.data)) {
      activeTurn = sessionFormatCount(event.data['turn'], 'turn/start turn')
      advertised.clear()
    }
    for (const call of advertisedCalls(event)) {
      const id = text(call['id'], 'advertised tool call id')
      const item = invocation(call)
      const previous = advertised.get(id)
      if (previous !== undefined && previous.kind !== item.kind) throw new SessionFormatError('assistant tool call kind changes between output item and message')
      advertised.set(id, item)
    }
    if (event.type === 'tool/call') {
      const data = record(event.data, 'tool/call data')
      const id = text(data['callId'], 'tool/call id')
      const item = invocation(data)
      if (advertised.get(id)?.kind !== item.kind) throw new SessionFormatError('tool/call tool kind differs from its advertised invocation')
      called.set(id, item)
    } else if (event.type === 'tool/result') {
      const data = record(event.data, 'tool/result data')
      const message = record(data['message'], 'tool result message')
      const id = text(message['toolCallId'], 'tool result call id')
      assertOutputInvocation(message, called.get(id) ?? advertised.get(id))
    }
    const view = structuralEvent(event, artifact, activeTurn, knownEventTypes)
    if (event.type === 'turn/end') activeTurn = undefined
    return view
  })
  assertCodexyLifecycleRelationships({ ...artifact, header: { ...artifact.header, version: 4 }, events }, knownEventTypes)
  return artifact
}
