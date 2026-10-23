/**
 * Service Definition for the approval capability seam, covering requests, cancellation, audit, and per-session policy. Missing
 * answerers fail closed; grants apply only to the requested action.
 * @module @codexydsh/approval
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { approvalDomain, type StoredReview } from './domain.ts'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ToolCallId } from '@deepseek-ai/dsh-llm'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { Session } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { appendProductEvent, projectProductEvent, type SessionEvent } from '@codexydsh/runtime/session'
import type { ApprovalService as PlatformApprovalService } from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Read product audit facts without changing the upstream Session implementation. */
function auditEventAt(session: Session, seq: import('@deepseek-ai/dsh-session').SessionSeq): SessionEvent | undefined {
  const event = session.eventAt(seq)
  return event === undefined ? undefined : projectProductEvent(event)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    codexyApproval: ApprovalService
  }
}

import { ApprovalRequestId, toNativeApprovalRequest } from './types.ts'
import type { ApprovalAnswer, ApprovalOutcome, ApprovalRequestEvent, ApprovalReviewer, ApprovalPolicy } from './types.ts'

export { ApprovalRequestId } from './types.ts'
export type { ApprovalAnswer, ApprovalOutcome, ApprovalReviewer, ApprovalAssessment, ApprovalPolicy } from './types.ts'

/** Every supported approval reviewer. */
export const APPROVAL_REVIEWERS: readonly ApprovalReviewer[] = ['user', 'auto_review']

/** Every {@link ApprovalOutcome}, for runtime normalization of answerer returns. */
const OUTCOMES: readonly ApprovalOutcome[] = ['allowed-once', 'rejected', 'cancelled', 'unavailable']

/** A prior exact-action grant is valid only since the last permission-policy switch. */
function hasSessionGrant(session: Session, toolName: string, key: string): boolean {
  const granted = new Set<ApprovalRequestId>()
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const event = auditEventAt(session, SessionSeq(seq))
    if (event === undefined) continue
    const eventType: string = event.type
    if (eventType === 'approval/policy' || eventType === 'sandbox/mode' || eventType === 'approval/reviewer') return false
    if (event.type === 'approval/decided' && event.data.outcome === 'allowed-once' && event.data.sessionGrantKey === key) {
      granted.add(event.data.id)
    }
    if (event.type === 'approval/asked' && granted.delete(event.data.id) && event.data.toolName === toolName) return true
  }
  return false
}

/** Policy changes while a human answered cannot install a reusable grant. */
function policyChangedSince(session: Session, firstSeq: number): boolean {
  for (let seq = firstSeq; seq < session.seq; seq += 1) {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const type: string | undefined = auditEventAt(session, SessionSeq(seq))?.type
    if (type === 'approval/policy' || type === 'sandbox/mode' || type === 'approval/reviewer') return true
  }
  return false
}

/** Every {@link ApprovalPolicy}, for option advertisement and runtime validation of untrusted policy strings. */
export const APPROVAL_POLICIES: readonly ApprovalPolicy[] = ['ask', 'never']

/** Model-facing statement for the deterministic `'never'` policy. */
const NEVER_SENTENCE = 'Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set `sandbox_permissions`).'
/** Model-facing statement for an interactive policy that may still fail closed. */
const ASK_SENTENCE = 'Approval policy: ask. Operations that require approval may ask through the configured answerers; without an available answerer, the request fails closed.'

/**
 * Whether the log currently sits inside an open turn (a `turn/start` not yet
 * closed by a `turn/end`) — the {@link ApprovalService.request} precondition.
 * The audit pair must be turn-enclosed: the turn is the durable log's
 * commit/replay boundary, so a bare event appended between turns is
 * indistinguishable from a crash tail and silently dropped on reload.
 */
function hasOpenTurn(session: Session): boolean {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const type = auditEventAt(session, SessionSeq(seq))?.type
    if (type === 'turn/start') return true
    if (type === 'turn/end') return false
  }
  return false
}

/**
 * Append the sole durable representation of a session policy override. Invalid
 * values throw before the log changes; consumers fold the new value on each read.
 * @param session - the session the override belongs to.
 * @param policy - the policy in effect until the next switch.
 */
export function setApprovalPolicy(session: Session, policy: ApprovalPolicy): void {
  if (!APPROVAL_POLICIES.includes(policy)) {
    throw new TypeError('approval policy must be one of "ask" or "never"')
  }
  appendProductEvent(session, 'approval/policy', { policy })
}

/**
 * Record the reviewer for new requests and withdraw pending reviewer dispatches.
 * @param session - Session whose reviewer changes.
 * @param reviewer - human or automatic reviewer.
 */

/**
 * Readonly same-process permission question. `callId` links to an already
 * presented tool call, so arguments are not duplicated here.
 */
export interface ApprovalRequest extends ApprovalRequestEvent {
  /**
   * The agent on whose behalf the question is asked. Routes the question (a
   * UI answerer only answers for agents it owns) and receives the audit
   * events on its session log.
   */
  readonly agent: Agent
  /** The tool the question is about (presentation and audit). */
  readonly toolName: string
  /**
   * The exact tool call being decided, when the asker has one — lets a UI
   * attach the prompt to the tool call it already streamed.
   */
  readonly callId?: ToolCallId
  /** The asker's human-readable explanation of WHY it is asking. */
  readonly reason?: string
  /** Hashed exact action/context tuple; enables the optional Session decision. */
  readonly sessionGrantKey?: string
  /** Hashed prefix/context tuple; enables a separate, explicitly scoped Session decision. */
  readonly prefixGrantKey?: string
  /**
   * Aborting withdraws a manual question immediately. Automatic review waits
   * for its audit to settle; both routes return `'cancelled'` after abortion
   * and discard late approval answers.
   */
  readonly signal?: AbortSignal
}

/** Plugin config. All optional — `static Config` supplies the defaults. */
export interface Config {
  /**
   * The deployment's default {@link ApprovalPolicy} for sessions without an
   * `approval/policy` override — `'ask'` delegates to the composed answerers
   * (fail-closed with none); `'never'` auto-rejects every ask without
   * prompting (the deterministic CI/unattended stance).
   */
  readonly policy?: ApprovalPolicy
  /** Default answerer routing; automatic review requires a mounted reviewer. */
  readonly reviewer?: ApprovalReviewer
}

/**
 * Approval service that applies session policy before answerers and logs every
 * ask/outcome pair to the requesting session. It exposes deterministic policy
 * changes to the model through the runtime-context snapshot and switch notices.
 */
export class ApprovalService extends Service {
  static inject = ['storageDomain']
  private reviews!: KvTable<string, StoredReview>
  private settings!: KvTable<string, { reviewer: ApprovalReviewer }>

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(approvalDomain)
    this.ctx.effect(() => () => domain.close(), 'approval.domainClose')
    this.reviews = domain.table('reviews')
    this.settings = domain.table('settings')
  }

  async setSessionReviewer(session: Session, reviewer: ApprovalReviewer): Promise<void> {
    if (!APPROVAL_REVIEWERS.includes(reviewer)) throw new TypeError('approval reviewer must be "user" or "auto_review"')
    if (this.settings.get(session.id)?.reviewer === reviewer) return
    await this.settings.put(session.id, { reviewer })
    // A policy refresh withdraws pending approvals and invalidates old grants
    // using the existing native approval lifecycle, without a private event.
    setApprovalPolicy(session, this.effectivePolicy(session))
  }

  /** Lookup is session-scoped, so an id from another conversation grants nothing. */
  reviewOf(session: Session, id: string): StoredReview | undefined {
    const review = this.reviews.get(`${session.id}:${id}`)
    return review?.sessionId === session.id ? review : undefined
  }

  /** Retain the latest assessment as plugin state; request traces are diagnostics only. */
  async recordReview(session: Session, review: SessionEvent<'approval/review'>['data']): Promise<void> {
    this.ctx.logger.debug('approval/review %o', { sessionId: session.id, ...review })
    if (review.status === 'started' || review.status === 'inspecting') return
    await this.reviews.put(`${session.id}:${review.id}`, {
      sessionId: session.id, id: review.id, status: review.status,
      ...review.assessment === undefined ? {} : { assessment: review.assessment },
      ...review.error === undefined ? {} : { error: review.error },
    })
  }
  static Config: z<Config> = z.object({
    policy: z.union(['ask', 'never'] as const).default('ask'),
    reviewer: z.union(['user', 'auto_review'] as const).default('user'),
  })

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'codexyApproval')

    // Existing DSH tools consume the public approval service; this adapter keeps
    // their requests on the same product audit and reviewer path.
    const platform: Pick<PlatformApprovalService, 'config' | 'request' | 'setPolicy' | 'overrideOf'> = {
      config, request: request => this.request(request),
      setPolicy: (agent, policy) => this.setPolicy(agent, policy),
      overrideOf: session => this.overrideOf(session),
    }
    ctx.provide('approval', platform)

    const effective = (agent: Agent): ApprovalPolicy => this.effectivePolicy(agent.session)

    // The complete current value travels after retained history, so switching
    // policy does not rewrite the stable system-prompt cache prefix.
    ctx.inject(['systemPrompt'], (scope: Context) => {
      scope.systemPrompt.context({
        name: 'approval:policy',
        order: scope.systemPrompt.getContextOrder('APPROVAL_POLICY'),
        text: (context) => {
          const agent = context.agent
          // A bare assemble() (tests, diagnostics) has no session to state.
          if (agent === undefined) return ''
          const policy = effective(agent)
          return policy === 'never' ? NEVER_SENTENCE : this.reviewerOf(agent.session) === 'auto_review'
            ? 'Approval policy: ask. Requests requiring approval are reviewed automatically; a rejection or review failure grants no wider access.'
            : ASK_SENTENCE
        },
      })
    })
  }

  /**
   * Switch one live agent's policy and queue the transition for its next model
   * step. Session initialization uses {@link setApprovalPolicy} directly
   * because there is no previously visible policy to change.
   * @param agent - the live agent whose policy is changing.
   * @param policy - the new effective policy.
   */
  setPolicy(agent: Agent, policy: ApprovalPolicy): void {
    const previous = this.effectivePolicy(agent.session)
    if (previous === policy) return
    setApprovalPolicy(agent.session, policy)
    agent.inject(createUserMessage({
      content: [{
        type: 'text',
        text: `The approval policy changed from "${previous}" to "${policy}" (changed by the user).`,
      }],
      source: { kind: 'codexy-user-approval' },
    }))
  }

  /**
   * Change the reviewer and append the transition after the stable model prefix.
   * @param agent - owner of the changed reviewer setting.
   * @param reviewer - answerer used for subsequent requests.
   */
  async setReviewer(agent: Agent, reviewer: ApprovalReviewer): Promise<void> {
    const previous = this.reviewerOf(agent.session)
    if (previous === reviewer) return
    await this.setSessionReviewer(agent.session, reviewer)
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: `The approval reviewer changed from "${previous}" to "${reviewer}" (changed by the user).` }],
      source: { kind: 'codexy-user-approval' },
    }))
  }

  /**
   * Read the effective independent reviewer selection.
   * @param session - Session whose last reviewer override is read.
   * @returns the override or composition default.
   */
  reviewerOf(session: Pick<Session, 'id'>): ApprovalReviewer {
    return this.settings.get(session.id)?.reviewer ?? this.config.reviewer ?? 'user'
  }

  /**
   * Read the latest terminal reviewer explanation for a tool call.
   * @param session - Session containing the request and its review.
   * @param callId - exact call, or the most recent request when omitted.
   * @returns the refusal or failure explanation when one was recorded.
   */
  reviewReasonOf(session: Session, callId?: ToolCallId): string | undefined {
    let requestId: ApprovalRequestId | undefined
    for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
      // oxlint-disable-next-line typescript/no-deprecated -- Review details are paired through the audit id.
      const event = auditEventAt(session, SessionSeq(seq))
      if (event?.type === 'approval/asked' && (callId === undefined || event.data.callId === callId)) {
        requestId = event.data.id
        break
      }
    }
    if (requestId === undefined) return undefined
    const review = this.reviewOf(session, requestId)
    if (review?.status === 'manual') return undefined
    return review?.assessment?.outcome === 'deny' ? review.assessment.rationale : review?.error
  }

  /**
   * Ask the composed answerers to decide one readonly same-process request.
   * The service borrows the agent and action fields, and supplies an audit id
   * and cancellable reviewer signal. Permission changes withdraw the current
   * dispatch and send the action to the newly selected reviewer.
   * The request requires an open turn because the audit pair must be enclosed
   * by the durable log's commit/replay boundary; an idle ask rejects before
   * appending anything. The answerer phase always produces an outcome: an
   * aborted signal yields `'cancelled'`, a missing or throwing answerer yields
   * `'unavailable'` (fail closed), and a rogue non-vocabulary return value is
   * normalized to `'unavailable'`. A failure that prevents either audit append
   * from committing still rejects because returning an unlogged decision would
   * violate the pair. Session contains post-commit observer failures, so an
   * authoritative append cannot reject the request or suppress its matching
   * audit event.
   * @param req - the pending decision (agent, tool identity, reason, signal).
   * @returns the closed outcome; a Session grant still returns `'allowed-once'` for this action.
   * @throws when the Session key is empty, no turn is open, or either audit
   *   event fails before the session append commit point.
   */
  async request(req: ApprovalRequest): Promise<ApprovalOutcome> {
    const session = req.agent.session
    if (req.sessionGrantKey !== undefined && req.sessionGrantKey.length === 0) {
      throw new TypeError('sessionGrantKey must be a non-empty fingerprint')
    }
    if (req.prefixGrantKey !== undefined
      && (req.prefixGrantKey.length === 0 || req.prefixRule?.length === 0 || req.prefixRule === undefined
        || req.prefixRule.some(token => token.length === 0))) {
      throw new TypeError('prefixGrantKey requires a non-empty fingerprint and prefixRule')
    }
    const offeredPrefix = req.prefixGrantKey === undefined || req.prefixRule === undefined
      ? undefined : Object.freeze([...req.prefixRule])
    if (!hasOpenTurn(session)) {
      throw new Error(
        'approval.request() outside an open turn: the approval/asked + approval/decided audit pair '
        + 'must be turn-enclosed (a bare event between turns is crash-tail garbage on reload). '
        + 'Ask from inside the turn that needs the decision.',
      )
    }
    const id = ApprovalRequestId(randomUUID())
    appendProductEvent(session, 'approval/asked', {
      id,
      toolName: req.toolName,
      ...req.callId !== undefined ? { callId: req.callId } : {},
      ...req.reason !== undefined ? { reason: req.reason } : {},
    })
    const afterAsk = session.seq
    const { prefixRule: _prefixRule, ...withoutPrefix } = req
    const dispatched = req.prefixGrantKey !== undefined
      ? { ...req, ...offeredPrefix === undefined ? {} : { prefixRule: offeredPrefix }, allowForSession: req.sessionGrantKey !== undefined }
      : req.sessionGrantKey !== undefined || req.allowForSession === true || req.prefixRule !== undefined
        ? { ...withoutPrefix, allowForSession: req.sessionGrantKey !== undefined }
        : req
    let decisionStartedAt = afterAsk
    const decided = await this.decide({ ...dispatched, requestId: id }, session, () => { decisionStartedAt = session.seq })
    const answer = req.signal?.aborted === true ? 'cancelled' : decided
    const permissionChanged = policyChangedSince(session, decisionStartedAt)
    const stillAsk = this.effectivePolicy(session) === 'ask'
    const selectedKey = answer === 'allow-for-session' ? req.sessionGrantKey
      : answer === 'allow-prefix-for-session' ? req.prefixGrantKey : undefined
    const sessionGrantKey = selectedKey !== undefined
      && !permissionChanged && stillAsk
      ? selectedKey : undefined
    const allowed = answer === 'allowed-once' || answer === 'allow-for-session' || answer === 'allow-prefix-for-session'
    const outcome: ApprovalOutcome = allowed && (permissionChanged || !stillAsk)
      ? 'rejected'
      : answer === 'allow-for-session' || answer === 'allow-prefix-for-session' ? 'allowed-once' : answer
    const prefixRule = answer === 'allow-prefix-for-session' && sessionGrantKey !== undefined
      ? offeredPrefix : undefined
    appendProductEvent(session, 'approval/decided', {
      id, outcome,
      ...sessionGrantKey === undefined ? {} : { sessionGrantKey },
      ...prefixRule === undefined ? {} : { prefixRule },
    })
    return outcome
  }

  /**
   * The session's effective policy: its own `approval/policy` fold, else the
   * configured default (the schema already defaulted an omitted policy to
   * `'ask'`; the `??` only narrows the optional-input TYPE).
   * @param session - the exact accepted session whose policy applies.
   * @returns the policy every ask for this session resolves under right now.
   */
  private effectivePolicy(session: Session): ApprovalPolicy {
    return this.overrideOf(session) ?? this.config.policy ?? 'ask'
  }

  /**
   * Whether a previously approved fingerprint remains usable by this tool and Session.
   * @param agent - the owner of the durable approval record.
   * @param toolName - the tool whose command would reuse the grant.
   * @param key - a fingerprint derived from the current execution context.
   * @returns true only while interactive approval is still permitted.
   */
  hasGrant(agent: Agent, toolName: string, key: string): boolean {
    return this.effectivePolicy(agent.session) === 'ask' && hasSessionGrant(agent.session, toolName, key)
  }

  /**
   * Read the session override without applying the configured default.
   * @param session - session whose log supplies the override.
   * @returns the last logged policy, or `undefined` without one.
   */
  overrideOf(session: Session): ApprovalPolicy | undefined {
    for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const event = auditEventAt(session, SessionSeq(seq))
      if (event?.type === 'approval/policy') return event.data.policy
    }
    return undefined
  }

  /**
   * Redispatch a pending action when its Session permissions change.
   * @param req - the borrowed public request.
   * @param session - the request agent's session used for policy lookup.
   * @param onDispatch - capture the permission interval for the current reviewer.
   * @returns the normalized closed outcome.
   */
  private async decide(req: ApprovalRequest, session: Session, onDispatch: () => void): Promise<ApprovalAnswer> {
    while (true) {
      if (req.signal?.aborted) return 'cancelled'
      const route = new AbortController()
      const unsubscribe = this.ctx.on('session/event', (owner, event) => {
        const type: string = projectProductEvent(event).type
        if (owner !== session || type !== 'approval/reviewer' && type !== 'approval/policy'
          && type !== 'sandbox/mode') return
        route.abort(new Error('approval permissions changed'))
      })
      try {
        onDispatch()
        const signal = req.signal === undefined ? route.signal : AbortSignal.any([req.signal, route.signal])
        const answer = await this.decideOnce({ ...req, signal }, session)
        if (!route.signal.aborted) return answer
      } finally {
        unsubscribe()
      }
    }
  }

  /** Dispatch one reviewer selection; the caller withdraws it when permissions change. */
  private async decideOnce(req: ApprovalRequest, session: Session): Promise<ApprovalAnswer> {
    const signal = req.signal
    if (signal?.aborted) return 'cancelled'
    // The 'never' policy is decided HERE, before any dispatch: a listener
    // registered with `prepend: true` after this service mounts would sit
    // ahead of any gate LISTENER, so a listener-shaped gate cannot keep the
    // documented promise that 'never' rejects deterministically regardless
    // of registration order — only the service's own request path can.
    if (this.effectivePolicy(session) === 'never') return 'rejected'
    if (req.prefixGrantKey !== undefined && hasSessionGrant(session, req.toolName, req.prefixGrantKey)) return 'allowed-once'
    if (req.prefixGrantKey === undefined && req.sessionGrantKey !== undefined
      && hasSessionGrant(session, req.toolName, req.sessionGrantKey)) return 'allowed-once'
    // Enter the promise chain BEFORE dispatching: a listener that throws
    // SYNCHRONOUSLY (before its first await) must land in the same rejection
    // path as an async one — `Promise.resolve(call())` would let it escape
    // the containment into the caller.
    const reviewer = this.reviewerOf(session)
    const answer: Promise<ApprovalAnswer> = Promise.resolve().then(
      () => reviewer === 'auto_review'
        ? this.ctx.waterfall(scopeTarget(req.agent, req.agent), 'codexy-approval/auto-review', req,
          () => Promise.resolve<ApprovalOutcome>('unavailable'))
        : this.ctx.waterfall(scopeTarget(req.agent, req.agent), 'approval/request', toNativeApprovalRequest(req),
          () => Promise.resolve<ApprovalOutcome>('unavailable')),
    ).then(
      // Normalize a rogue (non-vocabulary) answerer return to the fail-closed
      // outcome instead of leaking it into callers' closed-union switches.
      outcome => outcome === 'allow-for-session'
        ? req.sessionGrantKey === undefined ? 'unavailable' : outcome
        : outcome === 'allow-prefix-for-session'
          ? req.prefixGrantKey === undefined ? 'unavailable' : outcome
          : OUTCOMES.includes(outcome) ? outcome : 'unavailable',
      // A throwing answerer must fail the QUESTION closed, not the caller's
      // tool call open — the seam contains its callbacks.
      () => 'unavailable',
    )
    // Automatic reviewers own cancellable model work and settle its audit before the turn closes.
    if (signal === undefined || reviewer === 'auto_review') return answer
    return await new Promise<ApprovalAnswer>((resolve) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort)
        resolve('cancelled')
      }
      signal.addEventListener('abort', onAbort, { once: true })
      void answer.then((outcome) => {
        signal.removeEventListener('abort', onAbort)
        // After an abort won the race this resolve is a settled-promise no-op:
        // the late answer is discarded by construction.
        resolve(outcome)
      })
    })
  }
}

export default ApprovalService
