/** Goal accounting carriers survive product recovery even when the goal plugin is absent. */
import { describe, expect, it } from 'vitest'
import { SessionId, SessionLogOffset, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { snapshotProductEvents, Session } from '../src/session.ts'
import { decodeCodexyArtifact, encodeArtifactEvents, encodeArtifactHeader } from '../src/persistence-codec.ts'

const id = SessionId('native-goal-carrier')
const header = { version: 4 as const, id, createdAt: 1000, isSeeded: false }
const container = encodeArtifactHeader({ kind: 'codexy-session', version: 1,
  session: header, inheritedEventCount: SessionLogOffset(0) })
const carrier = (type: string, data: SessionEvent<'codexy/fact'>['data']['data'], seq: number): SessionEvent<'codexy/fact'> => ({
  type: 'codexy/fact', seq: SessionSeq(seq), time: 1000 + seq, data: { type, data },
})

describe('durable native goal carriers', () => {
  it('roundtrips exact state and unsettled request facts without mounting a goal plugin', () => {
    const state = { version: 1, state: { goalId: 'g1', stockRevision: 1, status: 'active', tokenBudget: 4096,
      tokensObserved: 150, timeUsedMilliseconds: 1234.5, tokenUsageComplete: true, timeUsageComplete: true,
      clockRunning: true, diagnostics: [], continuationRounds: 2, execFailureTurns: 0, emptyAutoTurns: 0, updatedAt: 1000 } }
    const request = { version: 1, phase: 'start', goalId: 'g1', requestId: 'req1', sourceSessionId: id,
      purpose: 'compaction', accountTokens: true }
    const rows = [carrier('codexy/goal-state', state, 0), carrier('codexy/goal-request', request, 1)]
    const bytes = Buffer.from(container + encodeArtifactEvents(rows))
    const decoded = decodeCodexyArtifact(bytes)
    expect(decoded.events).toEqual(rows)
    expect(decoded.tornBytes).toBe(0)
    const restored = Session.fromRestore(id, decoded.events, decoded.metadata.session,
      decoded.metadata.inheritedEventCount, 'detached')
    expect(snapshotProductEvents(restored).map(event => ({ type: event.type, data: event.data })))
      .toEqual([{ type: 'codexy/goal-state', data: state }, { type: 'codexy/goal-request', data: request },
        { type: 'session/end-seed', data: {} }])
    expect(Buffer.from(encodeArtifactHeader(decoded.metadata) + encodeArtifactEvents(decoded.events))).toEqual(bytes)
  })

  it('preserves provider counters and diagnostics without inventing missing usage', () => {
    const facts = [
      { version: 1, phase: 'start', goalId: 'g1', requestId: 'req1', sourceSessionId: id, purpose: 'conversation', accountTokens: true },
      { version: 1, phase: 'end', goalId: 'g1', requestId: 'req1', sourceSessionId: id, purpose: 'conversation', accountTokens: true,
        outcome: 'error', usage: { inputTokens: 100, outputTokens: 30, cachedInputTokens: 20, reasoningTokens: 15, totalTokens: 150 } },
      { version: 1, phase: 'start', goalId: 'g1', requestId: 'req2', sourceSessionId: id, purpose: 'compaction', accountTokens: true },
      { version: 1, phase: 'end', goalId: 'g1', requestId: 'req2', sourceSessionId: id, purpose: 'compaction', accountTokens: true,
        outcome: 'aborted', usage: null },
      { version: 1, state: null },
    ]
    const rows = facts.map((data, seq) => carrier(seq === 4 ? 'codexy/goal-state' : 'codexy/goal-request', data, seq))
    expect(decodeCodexyArtifact(Buffer.from(container + encodeArtifactEvents(rows))).events).toEqual(rows)
  })

  it('still rejects unrelated required facts without modifying the supplied bytes', () => {
    const bytes = Buffer.from(container + encodeArtifactEvents([carrier('codexy/future-goal-fact', { version: 1 }, 0)]))
    const before = Buffer.from(bytes)
    expect(() => decodeCodexyArtifact(bytes)).toThrow('unknown required Codexy fact codexy/future-goal-fact')
    expect(bytes).toEqual(before)
  })
})
