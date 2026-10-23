/** Product event reads retain the sequence identities of the original Session. */
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import { projectProductEvents, projectProductEvent, type SessionEvent } from '@codexydsh/runtime/session'

/** Read a projected suffix or interval using the original Session's bounds.
 * @param session - Loaded owner.
 * @param bounds - Public log offsets.
 * @returns Projected durable events.
 */
export function productSnapshot(session: Session, ...bounds: Parameters<Session['snapshotEvents']>): SessionEvent[] {
  return projectProductEvents(session.snapshotEvents(...bounds))
}
/** Read one projected event without changing its surface position.
 * @param session - Loaded owner.
 * @param seq - Durable sequence.
 * @returns Projected event, or undefined when absent.
 */
export function productEventAt(session: Session, seq: SessionSeq): SessionEvent | undefined {
  const event = session.eventAt(seq)
  return event === undefined ? undefined : projectProductEvent(event)
}
