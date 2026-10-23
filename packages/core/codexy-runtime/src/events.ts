/** Browser-safe projection of durable Codexy fact envelopes. */
import type { SessionEvent as PlatformSessionEvent } from '@deepseek-ai/dsh-session/types'
import type { SessionEvent } from './types.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
/** Expand one product fact while retaining the original durable sequence and time. */
export function projectProductEvent(event: PlatformSessionEvent): SessionEvent {
  if (event.type === 'request/header' && 'codexyHeader' in event.data) {
    return { ...event, data: { ...event.data, header: event.data.codexyHeader } } as SessionEvent
  }
  if (event.type === 'user/message' && event.data.source.kind === 'codexy-tool-notification') {
    if (event.surfaceOp !== 'append') throw new TypeError(`Codexy tool notification must append at session seq ${event.seq}`)
    return { ...event, type: 'tool/notification', surfaceOp: 'append', data: event.data.source.notification }
  }
  const name: string = event.type
  if (name !== 'codexy/fact' && name !== 'plugin:codexy/runtime') return event as SessionEvent
  const wrapper: unknown = event.data
  if (!isRecord(wrapper) || typeof wrapper['type'] !== 'string' || !Object.hasOwn(wrapper, 'data')) {
    throw new TypeError(`invalid Codexy fact at session seq ${event.seq}`)
  }
  return { ...event, type: wrapper['type'], data: wrapper['data'] } as SessionEvent
}
/** Expand an ordered read without changing durable sequence identities. */
export function projectProductEvents(events: readonly PlatformSessionEvent[]): SessionEvent[] { return events.map(projectProductEvent) }
