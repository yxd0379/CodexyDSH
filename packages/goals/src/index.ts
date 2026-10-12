/** Explicit native goal tools/accounting, composed over the unmodified public DSH goal service. */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
import type { Agent } from '@codexydsh/runtime/agent'
import type {} from '@deepseek-ai/dsh-goal'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import { createUserMessage } from '@codexydsh/runtime/llm'
import type { GenerateOptions, StreamChunk, TokenUsage } from '@codexydsh/runtime/llm'
import { appendProductEvent, snapshotProductEvents } from '@codexydsh/runtime/session'
import type { SessionId } from '@codexydsh/runtime/session'
import { defineTool } from '@codexydsh/tool-schema'
import { chargeableTokens, diagnostic, readGoalFacts, writeGoalState } from './facts.ts'
import type { GoalAccountingState, NativeGoalStatus } from './facts.ts'
import { goalSteering } from './continuation.ts'
import { COMPLETION_REPORT, CREATE_GOAL_DESCRIPTION, GET_GOAL_DESCRIPTION, OBJECTIVE_DESCRIPTION,
  STATUS_DESCRIPTION, TOKEN_BUDGET_DESCRIPTION, UPDATE_GOAL_DESCRIPTION } from './spec.ts'

export type { GoalAccountingState, GoalRequestFact, NativeGoalStatus } from './facts.ts'
export { chargeableTokens, readGoalFacts } from './facts.ts'

export interface Config {
  /** Native ownership is opt-in. Ordinary DSH goals and their driver remain unchanged by default. */
  enabled?: boolean
  /** Optional deployment ceiling/default, independent of DSH's round cap. */
  maxGoalTokenBudget?: number
}
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  maxGoalTokenBudget: z.number(),
})
export interface GoalClock { monotonic(): number; epoch(): number }
export type NativeGoalResult = {
  goal: null | {
    threadId: string; objective: string; status: NativeGoalStatus; tokenBudget?: number
    tokensUsed: number | null; timeUsedSeconds: number | null; createdAt: number; updatedAt: number
  }
  remainingTokens: number | null
  completionBudgetReport: string | null
  /** Present only when authoritative usage/time is unavailable; no fabricated numeric total. */
  accountingDiagnostics?: string[]
}
interface TurnProgress { number: number; automatic: boolean; execSuccess: boolean; execFailure: boolean; content: boolean }
interface OwnedGoal {
  agent: Agent
  state: GoalAccountingState | null
  clockMark: number | null
  suspended: boolean
  drive?: Promise<void>
  budgetSteeredTurn?: number
  /** A budget edge is a soft stop: the already-running turn may finish and is still charged. */
  limitedTurn?: number
  turn: TurnProgress
}
declare module '@deepseek-ai/cordis' { interface Context { codexyGoals: NativeGoals } }
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'codexy-goal': { kind: 'codexy-goal'; goalId: string; round: number; purpose: 'continuation' | 'budget' }
  }
}
const systemClock: GoalClock = { monotonic: () => performance.now(), epoch: () => Date.now() }
const emptyTurn = (): TurnProgress => ({ number: 0, automatic: false, execSuccess: false, execFailure: false, content: false })
const positive = (value: number) => Number.isSafeInteger(value) && value > 0
const ref = (goal: GoalView) => ({ id: goal.id, revision: goal.revision })
function committedPlan(agent: Agent): boolean {
  let active = false
  for (const event of snapshotProductEvents(agent.session)) {
    if (String(event.type) !== 'plan/mode') continue
    const data: unknown = event.data
    if (typeof data === 'object' && data !== null && 'active' in data && typeof data.active === 'boolean') active = data.active
  }
  return active
}

/** Owns only explicitly enabled native goals; all registrations unwind with the Cordis effect. */
export class NativeGoals extends Service {
  static inject = ['goals', 'agents', 'sessions', 'codexyRequests', 'codexyTools']
  static Config = Config
  private readonly owned = new Map<Agent, OwnedGoal>()
  private readonly streams = new Set<Promise<void>>()
  private stopping = false
  private readonly clock: GoalClock
  private readonly ceiling: number | undefined
  private readonly enabled: boolean

  constructor(ctx: Context, config: Config = {}, clock: GoalClock = systemClock) {
    super(ctx, 'codexyGoals')
    this.clock = clock
    this.ceiling = config.maxGoalTokenBudget
    this.enabled = config.enabled === true
    if (this.ceiling !== undefined && !positive(this.ceiling)) throw new Error('maxGoalTokenBudget must be a positive safe integer')
    if (!this.enabled) return
    ctx.effect(function* (this: NativeGoals) {
      ctx.on('agent/created', ({ agent }) => { this.queueDrive(this.attach(agent)) })
      ctx.on('agent/disposed', ({ agent }) => { this.detach(agent) })
      ctx.on('goal/changed', ({ agent, change }) => { this.changed(agent, change.operation) })
      ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') queueMicrotask(() => { if (!this.stopping) this.queueDrive(this.attach(agent)) }) })
      ctx.on('agent/cancelled', ({ agent }) => { const own = this.owned.get(agent); if (own !== undefined) own.suspended = true })
      ctx.on('agent/error', ({ agent, error }) => {
        const own = this.owned.get(agent)
        if (own?.state?.status !== 'active') return
        const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
        this.stop(own, code === 'QUOTA' || code === 'ACCOUNT_QUOTA' ? 'usageLimited' : 'blocked', 'terminal-request-error')
      })
      ctx.on('agent/pre-step', async ({ agent, messages, turn }, next) => {
        const own = this.attach(agent)
        if (own.turn.number !== turn) {
          own.turn = { ...emptyTurn(), number: turn }
          if (own.state?.status === 'budgetLimited') own.limitedTurn = turn
        }
        if (messages.some(message => message.source.kind === 'codexy-goal' && message.source.purpose === 'continuation')) own.turn.automatic = true
        return next()
      })
      ctx.on('codexy-llm/stream', (options, next) => this.accountRequest(options, next))
      ctx.on('tools/execute', async (exec, next) => {
        const result = await next()
        const own = exec.agent === undefined ? undefined : this.owned.get(exec.agent)
        // Actual dispatched exec bodies only: denials, blocked/pre-dispatch and aborts do not count.
        if (own !== undefined && !exec.signal.aborted) {
          if (!result.isError) own.turn.execSuccess = true
          else if (exec.name === 'exec_command' || exec.name === 'write_stdin') own.turn.execFailure = true
        }
        return result
      })
      ctx.on('tools/post-execute', async (exec, _result, next) => {
        if (exec.agent !== undefined && exec.name !== 'update_goal') this.budgetSteering(this.attach(exec.agent))
        return next()
      })
      ctx.on('agent/turn-stopping', ({ agent }) => {
        const own = this.attach(agent)
        this.settleClock(own)
      })
      ctx.on('session/event', (session, event) => {
        const agent = ctx.agents.get(session.id)
        const own = agent === undefined ? undefined : this.owned.get(agent)
        if (own === undefined) return
        if (event.type === 'assistant/message') own.turn.content ||= event.data.message.content.some(block => block.type === 'tool-call' || block.type === 'text' && block.text.trim().length > 0)
        if (event.type === 'turn/end') {
          const progress = { ...own.turn }
          const goalId = own.state?.goalId
          const aborted = event.data.reason.kind === 'aborted'
          // Session append notifications cannot append recursively. Settle after the
          // committed boundary, before the separately queued idle continuation.
          queueMicrotask(() => {
            if (this.owned.get(own.agent) !== own || own.state?.goalId !== goalId) return
            this.finishTurn(own, aborted, progress)
          })
        }
      })
      this.registerTools()
      for (const agent of ctx.agents.list()) this.queueDrive(this.attach(agent))
      yield async () => {
        this.stopping = true
        for (const own of this.owned.values()) {
          own.suspended = true
          this.removeQueued(own)
          ctx.goals.disarm(own.agent)
          if (own.turn.automatic && own.agent.status === 'running') own.agent.cancel({ kind: 'user' }, { keepInbox: true })
        }
        await Promise.all([...this.streams, ...[...this.owned.values()].flatMap(own => own.drive === undefined ? [] : [own.drive])])
        for (const own of this.owned.values()) this.detach(own.agent)
      }
    }.bind(this))
  }

  private attach(agent: Agent): OwnedGoal {
    const prior = this.owned.get(agent)
    if (prior !== undefined) return prior
    const recovered = readGoalFacts(agent.session)
    const own: OwnedGoal = { agent, state: recovered.state, clockMark: null, suspended: false, turn: emptyTurn() }
    this.owned.set(agent, own)
    const goal = this.ctx.goals.get(agent)
    if (goal !== undefined) {
      this.ctx.goals.disarm(agent)
      if (own.state?.goalId !== goal.id) {
        this.newState(own, goal, false)
      } else {
        let state = own.state
        if (recovered.unfinishedRequests > 0) state = { ...state, tokenUsageComplete: false, diagnostics: diagnostic(state, 'interrupted-request-usage-unavailable') }
        if (state.clockRunning) state = { ...state, timeUsageComplete: false, diagnostics: diagnostic(state, 'unclean-restart-elapsed-time-unavailable') }
        own.state = { ...state, status: state.status === 'budgetLimited' || state.status === 'usageLimited' ? state.status : goal.phase,
          stockRevision: goal.revision, clockRunning: goal.phase === 'active' && state.status === 'active' }
        if (own.state.clockRunning) own.clockMark = this.clock.monotonic()
        this.commit(own)
      }
    } else own.state = null
    return own
  }

  private newState(own: OwnedGoal, goal: GoalView, complete: boolean): void {
    own.state = { goalId: goal.id, stockRevision: goal.revision, status: goal.phase, tokensObserved: 0,
      timeUsedMilliseconds: 0, tokenUsageComplete: complete, timeUsageComplete: complete,
      clockRunning: goal.phase === 'active', diagnostics: complete ? [] : ['preexisting-goal-accounting-unavailable'],
      continuationRounds: 0, execFailureTurns: 0, emptyAutoTurns: 0, updatedAt: Math.floor(goal.updatedAt / 1000) }
    own.clockMark = own.state.clockRunning ? this.clock.monotonic() : null
    own.suspended = false
    this.commit(own)
  }

  private changed(agent: Agent, operation: string): void {
    const own = this.attach(agent)
    this.settleClock(own)
    const goal = this.ctx.goals.get(agent)
    this.ctx.goals.disarm(agent)
    if (goal === undefined) { own.state = null; own.clockMark = null; this.commit(own); this.removeQueued(own); return }
    if (operation === 'create' || own.state?.goalId !== goal.id) this.newState(own, goal, operation === 'create')
    else {
      const state = own.state
      const exhausted = state.tokenBudget !== undefined && state.tokensObserved >= state.tokenBudget
      const status = goal.phase === 'complete' ? 'complete'
        : exhausted ? 'budgetLimited' : operation === 'resume' ? 'active'
          : state.status === 'budgetLimited' || state.status === 'usageLimited' ? state.status : goal.phase
      const clockRunning = status === 'active' || status === 'budgetLimited' && own.limitedTurn === own.turn.number && agent.status === 'running'
      own.state = { ...state, status, stockRevision: goal.revision, clockRunning }
      own.clockMark = clockRunning ? this.clock.monotonic() : null
      if (operation === 'resume') {
        own.suspended = false
        own.state = { ...own.state, execFailureTurns: 0, emptyAutoTurns: 0 }
      }
      this.commit(own)
      if (status !== 'active') this.removeQueued(own)
      if (status === 'budgetLimited' && goal.phase === 'active') this.pauseStock(own)
    }
    this.queueDrive(own)
  }

  private commit(own: OwnedGoal): void {
    if (own.state !== null) own.state = { ...own.state, updatedAt: Math.max(own.state.updatedAt, Math.floor(this.clock.epoch() / 1000)) }
    writeGoalState(own.agent.session, own.state)
  }

  private settleClock(own: OwnedGoal): void {
    const state = own.state
    if (state === null || own.clockMark === null) return
    const now = this.clock.monotonic()
    const delta = now - own.clockMark
    own.clockMark = now
    own.state = Number.isFinite(delta) && delta >= 0
      ? { ...state, timeUsedMilliseconds: state.timeUsedMilliseconds + delta }
      : { ...state, timeUsageComplete: false, diagnostics: diagnostic(state, 'monotonic-clock-unavailable') }
    this.commit(own)
  }

  private detach(agent: Agent): void {
    const own = this.owned.get(agent)
    if (own === undefined) return
    this.settleClock(own)
    if (own.state !== null) { own.state = { ...own.state, clockRunning: false }; this.commit(own) }
    own.clockMark = null
    this.owned.delete(agent)
  }

  /** Descendant usage joins the nearest actual loaded ancestor goal, never guessed thread IDs. */
  private requestOwner(sessionId: SessionId | undefined): OwnedGoal | undefined {
    let agent = sessionId === undefined ? undefined : this.ctx.agents.get(sessionId)
    const visited = new Set<SessionId>()
    while (agent !== undefined && !visited.has(agent.id)) {
      visited.add(agent.id)
      const own = this.attach(agent)
      if (!own.suspended && (own.state?.status === 'active'
        || own.state?.status === 'budgetLimited' && agent.status === 'running' && own.limitedTurn === own.turn.number)) return own
      const parent: SessionId | undefined = agent.session.header.parentSession
      agent = parent === undefined ? undefined : this.ctx.agents.get(parent)
    }
    return undefined
  }

  private async *accountRequest(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    const own = this.requestOwner(options.sessionId)
    if (own?.state === null || own === undefined || options.sessionId === undefined || this.stopping) { yield* next(); return }
    // Native root accounting charges descendant usage even if the child is in
    // Plan; only the actual goal owner's committed Plan mode suspends its budget.
    const plan = committedPlan(own.agent)
    if (plan && own.clockMark !== null) {
      this.settleClock(own)
      own.clockMark = null
      own.state = { ...own.state, clockRunning: false }
      this.commit(own)
    } else if (!plan && own.clockMark === null) {
      own.clockMark = this.clock.monotonic()
      own.state = { ...own.state, clockRunning: true }
      this.commit(own)
    }
    const base = { version: 1 as const, goalId: own.state.goalId, requestId: randomUUID(), sourceSessionId: options.sessionId,
      purpose: options.purpose ?? 'conversation' as const, accountTokens: !plan }
    appendProductEvent(own.agent.session, 'codexy/goal-request', { ...base, phase: 'start' })
    let settle: () => void = () => {}
    const pending = new Promise<void>(resolve => { settle = resolve })
    this.streams.add(pending)
    let usage: TokenUsage | null = null
    let outcome: 'ended' | 'error' | 'aborted' = 'aborted'
    let finished = false
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'usage') usage = structuredClone(chunk.usage)
        if (chunk.type === 'finish') { outcome = chunk.reason.kind === 'error' ? 'error' : 'ended'; finished = true }
        yield chunk
      }
      if (!finished) outcome = options.signal?.aborted === true ? 'aborted' : 'ended'
    } catch (error) { outcome = options.signal?.aborted === true ? 'aborted' : 'error'; throw error }
    finally {
      try {
        this.settleClock(own)
        if (own.state?.goalId === base.goalId) {
          const charge = chargeableTokens(usage)
          const state = own.state
          const total = charge === undefined ? undefined : state.tokensObserved + charge
          if (base.accountTokens) own.state = total === undefined || !Number.isSafeInteger(total)
            ? { ...state, tokenUsageComplete: false, diagnostics: diagnostic(state, 'request-token-usage-unavailable') }
            : { ...state, tokensObserved: total }
          // Preserve original normalized usage and its accounting snapshot atomically.
          appendProductEvent(own.agent.session, 'codexy/goal-request', { ...base, phase: 'end', outcome, usage, state: own.state })
          if (own.state.tokenBudget !== undefined && own.state.tokensObserved >= own.state.tokenBudget && own.state.status !== 'complete') this.stop(own, 'budgetLimited')
        } else appendProductEvent(own.agent.session, 'codexy/goal-request', { ...base, phase: 'end', outcome, usage, state: own.state })
      } finally { this.streams.delete(pending); settle() }
    }
  }

  private pauseStock(own: OwnedGoal): void {
    const goal = this.ctx.goals.get(own.agent)
    if (goal?.phase === 'active') this.ctx.agents.withInitiator(own.agent, () => this.ctx.goals.pause(own.agent, ref(goal)))
    this.ctx.goals.disarm(own.agent)
  }

  private stop(own: OwnedGoal, status: Exclude<NativeGoalStatus, 'active'>, reason?: string): void {
    this.settleClock(own)
    if (own.state === null) return
    if (status === 'budgetLimited' && own.agent.status === 'running') own.limitedTurn = own.turn.number
    const clockRunning = status === 'budgetLimited' && own.limitedTurn === own.turn.number && own.agent.status === 'running'
    own.state = { ...own.state, status, clockRunning,
      diagnostics: reason === undefined ? own.state.diagnostics : diagnostic(own.state, reason) }
    if (!clockRunning) own.clockMark = null
    this.commit(own)
    this.removeQueued(own)
    const goal = this.ctx.goals.get(own.agent)
    if (goal !== undefined && status === 'blocked' && goal.phase === 'active') {
      this.ctx.goals.block(own.agent, ref(goal), { code: 'native-goal-blocked', message: 'Goal continuation stopped after a terminal error or repeated verified no-progress turns.' })
    } else this.pauseStock(own)
  }

  private budgetSteering(own: OwnedGoal): void {
    if (own.state?.status !== 'budgetLimited' || own.agent.status !== 'running' || own.limitedTurn !== own.turn.number || own.budgetSteeredTurn === own.turn.number) return
    const goal = this.ctx.goals.get(own.agent)
    if (goal === undefined) return
    own.budgetSteeredTurn = own.turn.number
    own.agent.steer(this.steeringMessage(own, goal, 'budget'))
  }

  private steeringMessage(own: OwnedGoal, goal: GoalView, purpose: 'continuation' | 'budget') {
    if (own.state === null) throw new Error('No active native goal')
    return createUserMessage({ content: [{ type: 'text', text: goalSteering(goal.objective, own.state, purpose,
      this.ctx.codexyTools.get('update_plan', own.agent) !== undefined) }],
      source: { kind: 'codexy-goal', goalId: goal.id, round: own.state.continuationRounds, purpose } })
  }

  private removeQueued(own: OwnedGoal): void {
    for (const message of [...own.agent.inbox.nextTurn, ...own.agent.inbox.nextStep]) {
      if (message.source.kind === 'codexy-goal') own.agent.inbox.remove(message.id)
    }
  }

  private queueDrive(own: OwnedGoal): void {
    if (this.stopping || own.suspended || own.drive !== undefined || own.state?.status !== 'active' || own.agent.status !== 'idle') return
    const drive = async () => {
      await this.ctx.sessions.flush(own.agent.session)
      if (this.stopping || own.suspended || own.state?.status !== 'active' || committedPlan(own.agent) || own.agent.status !== 'idle'
        || own.agent.inbox.nextTurn.length > 0 || own.agent.inbox.nextStep.length > 0) return
      const goal = this.ctx.goals.get(own.agent)
      if (goal === undefined || goal.id !== own.state.goalId || goal.phase !== 'active') return
      own.state = { ...own.state, continuationRounds: own.state.continuationRounds + 1 }
      this.commit(own)
      own.agent.followup(this.steeringMessage(own, goal, 'continuation'))
    }
    own.drive = drive().catch(() => {
      own.suspended = true
      if (own.state !== null) { own.state = { ...own.state, diagnostics: diagnostic(own.state, 'goal-continuation-checkpoint-failed') }; this.commit(own) }
    }).finally(() => { delete own.drive })
  }

  private finishTurn(own: OwnedGoal, aborted: boolean, progress: TurnProgress): void {
    this.settleClock(own)
    const state = own.state
    if (state === null) return
    if (aborted) { own.suspended = true; return }
    const execFailureTurns = progress.execSuccess ? 0 : progress.execFailure ? state.execFailureTurns + 1 : state.execFailureTurns
    const emptyAutoTurns = progress.automatic && !progress.content ? state.emptyAutoTurns + 1 : 0
    own.state = { ...state, execFailureTurns, emptyAutoTurns,
      ...state.status === 'active' ? {} : { clockRunning: false } }
    if (state.status !== 'active') { own.clockMark = null; delete own.limitedTurn }
    this.commit(own)
    if (state.status === 'active' && (execFailureTurns >= 3 || emptyAutoTurns >= 3)) this.stop(own, 'blocked', execFailureTurns >= 3 ? 'repeated-exec-failure' : 'repeated-empty-auto-turn')
  }

  /** Read actual durable native counters. Incomplete totals are visible, not guessed. */
  get(agent: Agent): NativeGoalResult {
    if (!this.enabled) throw new Error('Native goals are not enabled')
    const own = this.attach(agent)
    this.settleClock(own)
    const goal = this.ctx.goals.get(agent)
    const state = own.state
    if (goal === undefined || state === null) return { goal: null, remainingTokens: null, completionBudgetReport: null }
    return { goal: { threadId: agent.id, objective: goal.objective, status: state.status,
      ...state.tokenBudget === undefined ? {} : { tokenBudget: state.tokenBudget },
      tokensUsed: state.tokenUsageComplete ? state.tokensObserved : null,
      timeUsedSeconds: state.timeUsageComplete ? Math.floor(state.timeUsedMilliseconds / 1000) : null,
      createdAt: Math.floor(goal.createdAt / 1000), updatedAt: state.updatedAt },
      remainingTokens: state.tokenBudget === undefined || !state.tokenUsageComplete ? null : Math.max(0, state.tokenBudget - state.tokensObserved),
      completionBudgetReport: null, ...state.diagnostics.length === 0 ? {} : { accountingDiagnostics: [...state.diagnostics] } }
  }

  create(agent: Agent, objective: string, tokenBudget?: number): NativeGoalResult {
    if (!this.enabled) throw new Error('Native goals are not enabled')
    const trimmed = objective.trim()
    if (trimmed.length === 0 || [...trimmed].length > 4000) throw new Error('Goal objective must contain 1–4000 characters')
    const budget = tokenBudget ?? this.ceiling
    if (budget !== undefined && (!positive(budget) || this.ceiling !== undefined && budget > this.ceiling)) throw new Error('Goal token budget must be positive and not exceed the deployment ceiling')
    this.ctx.goals.create(agent, { objective: trimmed })
    this.ctx.goals.disarm(agent)
    const own = this.attach(agent)
    if (own.state !== null && budget !== undefined) { own.state = { ...own.state, tokenBudget: budget }; this.commit(own) }
    this.queueDrive(own)
    return this.get(agent)
  }

  update(agent: Agent, status: 'complete' | 'blocked' | 'paused'): NativeGoalResult {
    if (!this.enabled) throw new Error('Native goals are not enabled')
    const own = this.attach(agent)
    this.settleClock(own)
    const goal = this.ctx.goals.get(agent)
    if (goal === undefined || own.state === null) throw new Error('No current goal')
    if (goal.phase === 'complete' && status !== 'complete') throw new Error('The public DSH goal service cannot reopen a completed goal; create a new goal for new work')
    if (status === 'complete') {
      if (goal.phase !== 'complete') this.ctx.goals.complete(agent, ref(goal))
      else this.commit(own)
    } else if (own.state.status === 'budgetLimited') this.pauseStock(own)
    else {
      let current = goal
      // The public service exposes stopped->active and active->stopped edges;
      // compose those synchronously, disarming before the stock checkpoint settles.
      if (current.phase !== status && current.phase !== 'active') {
        current = this.ctx.goals.resume(agent, ref(current))
        this.ctx.goals.disarm(agent)
      }
      if (current.phase !== status) {
        if (status === 'paused') this.pauseStock(own)
        else this.ctx.goals.block(agent, ref(current), { code: 'model-reported-blocked', message: 'The agent set update_goal status to blocked.' })
      }
      own.state = { ...own.state!, status, clockRunning: false }
      this.commit(own)
    }
    own.clockMark = null
    delete own.limitedTurn
    if (own.state !== null) { own.state = { ...own.state, clockRunning: false }; this.commit(own) }
    const result = this.get(agent)
    return { ...result, completionBudgetReport: status === 'complete' && (result.goal?.tokenBudget !== undefined || (result.goal?.timeUsedSeconds ?? 0) > 0) ? COMPLETION_REPORT : null }
  }

  /** Public human/system resume seam; the model's update_goal cannot change a budget or resume. */
  resume(agent: Agent, tokenBudget?: number | null): NativeGoalResult {
    if (!this.enabled) throw new Error('Native goals are not enabled')
    const own = this.attach(agent)
    if (own.state === null) throw new Error('No current goal')
    if (tokenBudget !== undefined) {
      if (tokenBudget !== null && (!positive(tokenBudget) || this.ceiling !== undefined && tokenBudget > this.ceiling)) throw new Error('Invalid replacement goal token budget')
      const { tokenBudget: _prior, ...state } = own.state
      own.state = { ...state, ...tokenBudget === null ? {} : { tokenBudget } }
      this.commit(own)
    }
    const goal = this.ctx.goals.get(agent)
    if (goal === undefined) throw new Error('No current goal')
    this.ctx.goals.resume(agent, ref(goal))
    this.ctx.goals.disarm(agent)
    return this.get(agent)
  }

  private registerTools(): void {
    const output = { schema: { type: 'json' as const }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
    const owner = (agent: Agent | undefined) => { if (agent === undefined) throw new Error('Goal tools require a persistent thread.'); return agent }
    const getTool = defineTool({ name: 'get_goal', description: GET_GOAL_DESCRIPTION, closedParameters: true,
      parameters: {}, output, execute: async (_args, exec) => this.get(owner(exec.agent)) })
    getTool.parameters['required'] = []
    this.ctx.codexyTools.register(getTool)
    this.ctx.codexyTools.register(defineTool({ name: 'create_goal', description: CREATE_GOAL_DESCRIPTION, closedParameters: true,
      parameters: { objective: { type: 'string', required: true, description: OBJECTIVE_DESCRIPTION },
        token_budget: { type: 'integer', description: TOKEN_BUDGET_DESCRIPTION } }, output,
      execute: async (args, exec) => this.create(owner(exec.agent), args.objective, args.token_budget) }))
    this.ctx.codexyTools.register(defineTool({ name: 'update_goal', description: UPDATE_GOAL_DESCRIPTION, closedParameters: true,
      parameters: { status: { type: 'string', required: true, enum: ['complete', 'blocked', 'paused'], description: STATUS_DESCRIPTION } },
      output, execute: async (args, exec) => this.update(owner(exec.agent), args.status) }))
  }
}
export default NativeGoals
