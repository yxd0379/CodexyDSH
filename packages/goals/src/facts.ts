/** Durable native-goal facts. Stock goal/change remains the lifecycle/UI source. */
import { appendProductEvent, snapshotProductEvents } from '@codexydsh/runtime/session'
import type { Session, SessionId } from '@codexydsh/runtime/session'
import type { TokenUsage } from '@codexydsh/runtime/llm'

export type NativeGoalStatus = 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete'
export interface GoalAccountingState {
  readonly goalId: string
  readonly stockRevision: number
  readonly status: NativeGoalStatus
  readonly tokenBudget?: number
  /** Authoritative observed lower bounds; incomplete totals are not advertised as exact. */
  readonly tokensObserved: number
  readonly timeUsedMilliseconds: number
  readonly tokenUsageComplete: boolean
  readonly timeUsageComplete: boolean
  readonly clockRunning: boolean
  readonly diagnostics: readonly string[]
  readonly continuationRounds: number
  readonly execFailureTurns: number
  readonly emptyAutoTurns: number
  readonly updatedAt: number
}
export interface GoalStateFact { readonly version: 1; readonly state: GoalAccountingState | null }
export type GoalRequestFact = {
  readonly version: 1
  readonly goalId: string
  readonly requestId: string
  readonly sourceSessionId: SessionId
  readonly purpose: 'conversation' | 'compaction' | 'session-title'
  readonly accountTokens: boolean
} & ({ readonly phase: 'start' } | {
  readonly phase: 'end'
  readonly outcome: 'ended' | 'error' | 'aborted'
  /** Preserve the provider-normalized raw counters, including cache/reasoning/total. */
  readonly usage: TokenUsage | null
  /** Charge and original usage commit together; a crash cannot lose the accounting delta. */
  readonly state: GoalAccountingState | null
})

declare module '@codexydsh/runtime/types' {
  interface SessionEventMap {
    'codexy/goal-state': GoalStateFact
    'codexy/goal-request': GoalRequestFact
  }
}

const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const statuses: readonly string[] = ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']

function stateOf(value: unknown): GoalAccountingState | null {
  if (value === null) return null
  if (!record(value) || typeof value['goalId'] !== 'string' || value['goalId'].length === 0
    || !count(value['stockRevision']) || value['stockRevision'] === 0 || !statuses.includes(String(value['status']))
    || !count(value['tokensObserved']) || typeof value['timeUsedMilliseconds'] !== 'number'
    || !Number.isFinite(value['timeUsedMilliseconds']) || value['timeUsedMilliseconds'] < 0
    || !count(value['continuationRounds']) || !count(value['execFailureTurns']) || !count(value['emptyAutoTurns'])
    || !count(value['updatedAt']) || typeof value['tokenUsageComplete'] !== 'boolean'
    || typeof value['timeUsageComplete'] !== 'boolean' || typeof value['clockRunning'] !== 'boolean'
    || !Array.isArray(value['diagnostics']) || value['diagnostics'].some(item => typeof item !== 'string')
    || value['tokenBudget'] !== undefined && (!count(value['tokenBudget']) || value['tokenBudget'] === 0)) {
    throw new TypeError('invalid native goal accounting state')
  }
  return value as unknown as GoalAccountingState
}

/** Validate the plugin's own facts on recovery, without examining arbitrary session content. */
export function readGoalFacts(session: Session): { state: GoalAccountingState | null; unfinishedRequests: number } {
  let state: GoalAccountingState | null = null
  const open = new Map<string, string>()
  for (const event of snapshotProductEvents(session)) {
    if (event.type === 'codexy/goal-state') {
      const fact: unknown = event.data
      if (!record(fact) || fact['version'] !== 1) throw new TypeError('invalid native goal state fact')
      state = stateOf(fact['state'])
    } else if (event.type === 'codexy/goal-request') {
      const fact: unknown = event.data
      if (!record(fact) || fact['version'] !== 1 || typeof fact['requestId'] !== 'string'
        || typeof fact['goalId'] !== 'string' || typeof fact['sourceSessionId'] !== 'string'
        || typeof fact['accountTokens'] !== 'boolean'
        || !['conversation', 'compaction', 'session-title'].includes(String(fact['purpose']))) throw new TypeError('invalid native goal request fact')
      if (fact['phase'] === 'start') {
        if (open.has(fact['requestId'])) throw new TypeError('duplicate native goal request start')
        open.set(fact['requestId'], fact['goalId'])
      } else if (fact['phase'] === 'end') {
        if (open.get(fact['requestId']) !== fact['goalId'] || !['ended', 'error', 'aborted'].includes(String(fact['outcome']))
          || fact['usage'] !== null && !record(fact['usage'])) throw new TypeError('invalid native goal request settlement')
        open.delete(fact['requestId'])
        state = stateOf(fact['state'])
      } else throw new TypeError('invalid native goal request phase')
    }
  }
  return { state, unfinishedRequests: [...open.values()].filter(id => id === state?.goalId).length }
}

export function writeGoalState(session: Session, state: GoalAccountingState | null): void {
  appendProductEvent(session, 'codexy/goal-state', { version: 1, state })
}

/** DSH inputTokens is already uncached; reasoning is part of output, not another charge. */
export function chargeableTokens(usage: TokenUsage | null): number | undefined {
  if (usage === null || !count(usage.inputTokens) || !count(usage.outputTokens)) return undefined
  const sum = usage.inputTokens + usage.outputTokens
  return Number.isSafeInteger(sum) ? sum : undefined
}

export function diagnostic(state: GoalAccountingState, code: string): readonly string[] {
  return state.diagnostics.includes(code) ? state.diagnostics : [...state.diagnostics, code]
}
