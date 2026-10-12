/** Lossless owned carrier recovery; no user files, model, or network. */
import { describe, expect, it } from 'vitest'
import { Session, SessionId, appendProductEvent } from '@codexydsh/runtime/session'
import { chargeableTokens, readGoalFacts, writeGoalState } from '../src/facts.ts'
import type { GoalAccountingState } from '../src/facts.ts'

const state: GoalAccountingState = { goalId: 'owned-goal', stockRevision: 1, status: 'active', tokenBudget: 100,
  tokensObserved: 0, timeUsedMilliseconds: 500, tokenUsageComplete: true, timeUsageComplete: true,
  clockRunning: true, diagnostics: [], continuationRounds: 0, execFailureTurns: 0, emptyAutoTurns: 0, updatedAt: 100 }
const base = { version: 1 as const, goalId: state.goalId, requestId: 'owned-request', sourceSessionId: SessionId('source'), purpose: 'conversation' as const, accountTokens: true }
const fresh = () => Session.create(SessionId('goal-facts-fixture'))

describe('native goal required facts', () => {
  it('the settlement alone commits both original usage and the accounting delta atomically', () => {
    const session = fresh()
    writeGoalState(session, state)
    appendProductEvent(session, 'codexy/goal-request', { ...base, phase: 'start' })
    const original = { inputTokens: 3, outputTokens: 2, cacheReadTokens: 50, reasoningTokens: 1, totalTokens: 55 }
    appendProductEvent(session, 'codexy/goal-request', { ...base, phase: 'end', outcome: 'ended', usage: original,
      state: { ...state, tokensObserved: 5 } })
    original.inputTokens = 900
    expect(readGoalFacts(session)).toMatchObject({ state: { tokensObserved: 5 }, unfinishedRequests: 0 })
    expect(session.snapshotEvents().at(-1)?.data).toMatchObject({ data: { usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 50 } } })
  })

  it('retains unfinished requests of the current goal, without assigning old cleared-goal requests to a successor', () => {
    const session = fresh()
    writeGoalState(session, state)
    appendProductEvent(session, 'codexy/goal-request', { ...base, phase: 'start' })
    expect(readGoalFacts(session).unfinishedRequests).toBe(1)
    writeGoalState(session, null)
    writeGoalState(session, { ...state, goalId: 'actual-successor' })
    expect(readGoalFacts(session).unfinishedRequests).toBe(0)
  })

  it('rejects duplicate starts, unmatched ends and malformed owned state without reading unrelated content', () => {
    const duplicate = fresh()
    appendProductEvent(duplicate, 'codexy/goal-request', { ...base, phase: 'start' })
    appendProductEvent(duplicate, 'codexy/goal-request', { ...base, phase: 'start' })
    expect(() => readGoalFacts(duplicate)).toThrow('duplicate')
    const unmatched = fresh()
    appendProductEvent(unmatched, 'codexy/goal-request', { ...base, phase: 'end', outcome: 'ended', usage: null, state })
    expect(() => readGoalFacts(unmatched)).toThrow('settlement')
    for (const invalid of [{ ...state, tokensObserved: -1 }, { ...state, tokenBudget: 0 }, { ...state, timeUsedMilliseconds: 'unknown' }, { ...state, diagnostics: [0] }]) {
      const session = fresh()
      session.append('codexy/fact', { type: 'codexy/goal-state', data: { version: 1, state: { ...invalid, diagnostics: [...invalid.diagnostics] } } })
      expect(() => readGoalFacts(session)).toThrow('accounting state')
    }
    const invalidEnd = fresh()
    appendProductEvent(invalidEnd, 'codexy/goal-request', { ...base, phase: 'start' })
    invalidEnd.append('codexy/fact', { type: 'codexy/goal-request', data: { ...base, phase: 'end', outcome: 'ended', usage: null, state: { ...state, diagnostics: [...state.diagnostics], clockRunning: 'false' } } })
    expect(() => readGoalFacts(invalidEnd)).toThrow('accounting state')
  })

  it('does not fabricate charges from missing, negative, fractional or unsafe counters', () => {
    expect(chargeableTokens(null)).toBeUndefined()
    expect(chargeableTokens({ inputTokens: -1, outputTokens: 2 })).toBeUndefined()
    expect(chargeableTokens({ inputTokens: 1.2, outputTokens: 2 })).toBeUndefined()
    expect(chargeableTokens({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 })).toBeUndefined()
    expect(chargeableTokens({ inputTokens: 0, outputTokens: 0, reasoningTokens: 999, cacheReadTokens: 999 })).toBe(0)
  })
})
