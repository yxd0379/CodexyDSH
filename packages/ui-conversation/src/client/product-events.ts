/** Browser event projection keeps product records on the upstream Session carrier. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { AssistantLiveChunkEvent, SessionEventSource as PlatformSource, SessionEventWindow as PlatformWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import { projectProductEvent } from '@codexydsh/runtime/events'
import type { SessionEvent } from '@codexydsh/runtime/types'
import { isSurfaceEligibleType } from '@deepseek-ai/dsh-session/surface'
import type { SurfaceOp } from '@deepseek-ai/dsh-session/types'

export type SessionEventLike = SessionEvent | AssistantLiveChunkEvent
export type SessionEventLikeEntry =
  | { readonly type: 'event'; readonly event: SessionEvent }
  | { readonly type: 'transient'; readonly event: AssistantLiveChunkEvent }
export type SessionTransientEventEntry = Extract<SessionEventLikeEntry, { readonly type: 'transient' }>
export interface SessionAssistantSettlementEntry {
  readonly type: 'event'
  readonly event: SessionEvent<'assistant/message'> | SessionEvent<'assistant/attempt'>
}
export type SessionEventChange =
  | { readonly kind: 'replace' | 'prepend' | 'append'; readonly entries: readonly SessionEventLikeEntry[] }
  | { readonly kind: 'settle-assistant'; readonly attemptId: import('@deepseek-ai/dsh-llm').LlmAttemptId; readonly entry?: SessionAssistantSettlementEntry }
export interface SessionEventWindow extends Omit<PlatformWindow, 'entries' | 'change'> {
  readonly entries: readonly SessionEventLikeEntry[]
  readonly change: SessionEventChange
}
export type SessionEventSource = ObservableSnapshot<SessionEventWindow>

const sources = new WeakMap<PlatformSource, SessionEventSource>()

/**
 * Project entries and their matching delta without changing seqs or Session ownership.
 * @param source - Upstream contiguous history and live feed.
 * @returns Identity-stable product view with the same subscription lifetime.
 */
export function productEventSource(source: PlatformSource): SessionEventSource {
  const existing = sources.get(source)
  if (existing !== undefined) return existing
  let previous: PlatformWindow | undefined
  let value: SessionEventWindow | undefined
  const result: SessionEventSource = {
    subscribe: listener => source.subscribe(listener),
    getSnapshot: () => {
      const snapshot = source.getSnapshot()
      if (snapshot === previous && value !== undefined) return value
      const entries = (items: PlatformWindow['entries']): SessionEventLikeEntry[] => items.map(item => item.type === 'transient'
        ? item : { type: 'event', event: projectProductEvent(item.event) })
      const change = snapshot.change
      let projected: SessionEventChange
      if (change.kind === 'settle-assistant') {
        projected = { ...change, ...change.entry === undefined ? {} : {
          entry: { type: 'event', event: projectProductEvent(change.entry.event) } as SessionAssistantSettlementEntry,
        } }
      } else projected = { ...change, entries: entries(change.entries) }
      previous = snapshot
      value = { ...snapshot, entries: entries(snapshot.entries), change: projected }
      return value
    },
  }
  sources.set(source, result)
  return result
}

/** A known upstream message event carrying its surface marker. */
export type ProductSurfaceEvent = Extract<SessionEvent, { readonly surfaceOp: SurfaceOp }>

/**
 * Classify the projected message events eligible for the upstream surface.
 * @param event - Durable product event.
 * @returns Whether the event has a standard message type and surface marker.
 */
export function isProductSurfaceEvent(event: SessionEvent): event is ProductSurfaceEvent {
  return isSurfaceEligibleType(event.type) && event.surfaceOp !== undefined
}

/**
 * Classify append-origin messages for the human transcript.
 * @param event - Durable product event.
 * @returns Whether the event appended to the model surface.
 */
export function isAppendProductSurfaceEvent(event: SessionEvent): event is ProductSurfaceEvent & { readonly surfaceOp: 'append' } {
  return isProductSurfaceEvent(event) && event.surfaceOp === 'append'
}
