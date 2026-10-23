/** Fork prefixes with native completed-output recovery over the original Session API. */
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionEvent, SessionSeq as SessionSeqType } from '@deepseek-ai/dsh-session/types'
import { projectProductEvents } from './events.ts'
import { openTurnClosers } from './recovery.ts'
import { encodeProductEvents } from './session.ts'

/** Copy an inclusive source prefix and balance its open native stream outside the inherited cut. */
export function buildForkSeed(events: readonly SessionEvent[], boundary: SessionSeqType): SessionEvent[] {
  const source = events[boundary]
  if (source === undefined) throw new RangeError('fork boundary must name an existing event')
  const prefix = events.slice(0, boundary + 1)
  prefix.push({ type: 'session/end-seed', seq: SessionSeq(boundary + 1), time: source.time, data: { inherited: true } })
  return prefix.concat(encodeProductEvents(openTurnClosers(projectProductEvents(prefix), { kind: 'forked' })))
}
