/** Original DSH Session mechanics and supplementary Codexy request metadata. */
export * from '@deepseek-ai/dsh-session'
import { canonicalHeader as canonicalPlatformHeader } from '@deepseek-ai/dsh-session'
import type { Session, SessionSeq, SessionEvent as PlatformSessionEvent, EpochHeader as PlatformEpochHeader } from '@deepseek-ai/dsh-session'
import type { SessionEventType as PlatformEventType, SessionEventMap as PlatformEventMap, SurfaceEventType } from '@deepseek-ai/dsh-session/types'
import type { Message } from '@deepseek-ai/dsh-llm'
import { snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'

export type { EpochHeader, SessionEventMap, SessionEvent, SessionEventType, ToolNotificationSource } from './types.ts'
import type { EpochHeader, SessionEventMap, SessionEvent, SessionEventType } from './types.ts'
/** Derive messages with their current surface node, using only public Session reads. */
export function deriveMessageNodes(session: Session): { seq: SessionSeq; message: Message }[] {
  const nodes: { seq: SessionSeq; message: Message }[] = []
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)
    if (event === undefined) throw new Error(`missing session surface event ${seq}`)
    const message = session.deriveEventMessage(event)
    if (message !== null) nodes.push({ seq, message })
  }
  return nodes
}
/** Normalize a private header while retaining the native catalog for the provider. */
export function canonicalHeader(header: EpochHeader): EpochHeader {
  return { config: header.config,
    ...header.adapterDefaults?.reasoningEffort === true || header.adapterDefaults?.maxTokens === true ? { adapterDefaults: header.adapterDefaults } : {},
    ...header.tools !== undefined && header.tools.length > 0 ? { tools: header.tools } : {},
  }
}
/** Compare complete product controls, including Responses and native tool declarations. */
export function headerEquals(a: EpochHeader, b: EpochHeader): boolean { return JSON.stringify(a) === JSON.stringify(b) }
/** Standard v4 headers disclose executable JSON tool names; the product record keeps native wire metadata. */
export function platformHeader(header: EpochHeader): PlatformEpochHeader {
  const { codexfulResponses: _responses, ...config } = header.config
  return canonicalPlatformHeader({ config,
    ...header.adapterDefaults === undefined ? {} : { adapterDefaults: header.adapterDefaults },
    ...header.tools === undefined ? {} : { tools: header.tools.map(tool => tool.kind === 'freeform'
      ? { name: tool.name, description: tool.description, parameters: { type: 'string' } }
      : { name: tool.name, description: tool.description, parameters: tool.parameters, ...tool.deferLoading === undefined ? {} : { deferLoading: tool.deferLoading } }) },
  })
}

/** Native events keep their upstream identity; product-only facts use the legacy carrier until migrated. */
export function appendProductEvent<K extends SessionEventType>(session: Session, type: K, data: NoInfer<SessionEventMap[K]>): SessionEvent<K>
export function appendProductEvent(session: Session, type: SessionEventType, data: SessionEventMap[SessionEventType]): SessionEvent {
  const detached = snapshotJsonValue<unknown>(data)
  if (detached === undefined) throw new TypeError('Codexy fact must contain lossless JSON data')
  if (isNativeLogEvent(type)) {
    return projectProductEvents([session.append(type, detached as PlatformEventMap[typeof type])])[0]!
  }
  const event = session.append('codexy/fact', { type, data: detached as JsonValue })
  return projectProductEvents([event])[0]!
}
export { projectProductEvent, projectProductEvents } from './events.ts'
import { projectProductEvents } from './events.ts'
/** Read the product event vocabulary from an installed upstream Session. */
export function snapshotProductEvents(session: Session): SessionEvent[] { return projectProductEvents(session.snapshotEvents()) }

export { interruptedTurnClosers } from '@deepseek-ai/dsh-session'
export { buildForkSeed } from '@deepseek-ai/dsh-session/fork'

const headerCursors = new WeakMap<Session, { cursor: number; header: EpochHeader | undefined }>()
/** Wire-only controls live with the running request, not in the persisted session format. */
export function rememberRequestHeader(session: Session, header: EpochHeader): void {
  headerCursors.set(session, { cursor: session.seq, header })
}
/** Read the native header incrementally while preserving its product-only controls. */
export function requestHeaderOf(session: Session): EpochHeader | undefined {
  const state = headerCursors.get(session) ?? { cursor: 0, header: undefined }
  for (const event of session.snapshotEvents().slice(state.cursor)) {
    if (event.type === 'request/header') {
      const product = projectProductEvents([event])[0]
      if (product?.type === 'request/header') state.header = product.data.header
    }
    if (event.type === 'codexy/fact' && event.data.type === 'request/header') {
      const product = projectProductEvents([event])[0]
      if (product?.type === 'request/header') state.header = product.data.header
    }
  }
  state.cursor = session.seq
  headerCursors.set(session, state)
  return state.header
}
/** Derive model history using the upstream session interpretation. */
export function deriveProductMessages(session: Session): Message[] { return deriveMessageNodes(session).map(node => node.message) }

import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
const requiredProductTags: ReadonlySet<string> = new Set(['schedule/change'])
type NativeLogEventType = Exclude<PlatformEventType, SurfaceEventType | 'request/header' | 'schedule/change' | 'codexy/fact'>
function isNativeLogEvent(type: string): type is NativeLogEventType {
  return KNOWN_SESSION_EVENT_TYPES.has(type)
    && !['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result', 'request/header', 'schedule/change', 'codexy/fact'].includes(type)
}
/** Encode one product event for the original Session API while retaining its durable identity. */
export function encodeProductEvent(event: SessionEvent): PlatformSessionEvent {
  if (event.type === 'tool/notification') {
    const notification = event.data
    return { type: 'user/message', seq: event.seq, time: event.time,
      data: { id: notification.message.id, role: 'user', content: notification.message.content,
        source: { kind: 'codexy-tool-notification', notification } },
      surfaceOp: 'append', sourceEventSeqs: [notification.callSeq] }
  }
  if (event.type === 'request/header') {
    return { ...event, data: { reason: event.data.reason,
      ...event.data.startsSeries === undefined ? {} : { startsSeries: event.data.startsSeries },
      header: platformHeader(event.data.header) } } as PlatformSessionEvent<'request/header'>
  }
  if (event.type === 'codexy/fact' || (!requiredProductTags.has(event.type) && KNOWN_SESSION_EVENT_TYPES.has(event.type))) return event as PlatformSessionEvent
  const detached = snapshotJsonValue<unknown>(event.data)
  if (detached === undefined) throw new TypeError('Codexy fact must contain lossless JSON data')
  return { type: 'codexy/fact', seq: event.seq, time: event.time, data: { type: event.type, data: detached as JsonValue } }
}
/** Encode an ordered product seed without changing any sequence reference or inherited cut. */
export function encodeProductEvents(events: readonly SessionEvent[]): PlatformSessionEvent[] { return events.map(encodeProductEvent) }
