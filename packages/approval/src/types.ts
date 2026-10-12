/**
 * Wire-safe approval identifiers and outcome vocabulary, free of
 * cordis/service imports so browser type chains can
 * consume them without loading this package's Context augmentation.
 * @module @codexydsh/approval/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { RequestMessage, ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { ContextFormed } from '@deepseek-ai/dsh-llm/message'
import type { ToolSchema } from '@codexydsh/runtime/types'

/**
 * Pairs one `approval/asked` audit event with its `approval/decided`.
 * Service-issued (one fresh id per {@link ApprovalService.request} call).
 */
export type ApprovalRequestId = Branded<'ApprovalRequestId'>

/**
 * Brand a string as an {@link ApprovalRequestId}.
 * @param id - the raw id string to brand.
 * @returns the same string carrying the brand.
 */
export function ApprovalRequestId(id: string): ApprovalRequestId {
  return id as ApprovalRequestId
}

/**
 * Closed approval outcomes: a one-shot grant, explicit rejection, withdrawn
 * request, or unavailable answerer. Callers fail closed on `unavailable`.
 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** Interactive answer before a Session-scoped grant is normalized to one allowed action. */
export type ApprovalAnswer = ApprovalOutcome | 'allow-for-session' | 'allow-prefix-for-session'

/** Independent routing choice for requests that already require approval. */
export type ApprovalReviewer = 'user' | 'auto_review'

/** Structured automatic-review assessment, matching Codex's guardian output. */
export interface ApprovalAssessment {
  /** Intrinsic impact of the exact pending action. */
  risk_level: 'low' | 'medium' | 'high' | 'critical'
  /** Strength of trusted authorization for the action and its effects. */
  user_authorization: 'unknown' | 'low' | 'medium' | 'high'
  /** Policy decision after considering risk and authorization. */
  outcome: 'allow' | 'deny'
  /** Short explanation suitable for the model and user. */
  rationale: string
}

declare module '@codexydsh/runtime/types' {
  interface SessionEventMap {
    /** Durable reviewer selection, independent of sandbox and approval policy. */
    'approval/reviewer': {
      reviewer: ApprovalReviewer
      /** Marks an override seeded into a child at delegation. */
      source?: 'delegation'
    }
    /** Exact reviewer request and terminal assessment, paired by the approval id. */
    'approval/review': {
      id: ApprovalRequestId
      status: 'started' | 'inspecting' | 'approved' | 'denied' | 'failed' | 'cancelled' | 'manual'
      /** Zero-based private model request index, present on started. */
      round?: number
      /** Frozen model input recorded before dispatch; present on started. */
      input?: {
        provider: string
        model: string
        system: string
        user: string
        temperature: number
        maxTokens: number
        messages?: RequestMessage[]
        tools?: ToolSchema[]
      }
      /** Read-only investigation evidence; never enters the main agent history directly. */
      inspection?: { callId: ToolCallId; name: string; arguments: string; response: ContentBlock[]; result: string }
      /** Parsed completed assessment; absent for cancellation and failures. */
      assessment?: ApprovalAssessment
      /** Raw completed reviewer response on assessments and parse failures; private audit only. */
      response?: ContentBlock[]
      /** Failure explanation; never grants permission. */
      error?: string
    }
    /**
     * An approval question was put to the answerer chain — log-only audit
     * (like `hook/*`; NOT a surface event, carries no `surfaceOp`). `id` pairs
     * it with the `approval/decided` that always follows; `toolName` is the
     * tool the question is about, `callId` the exact tool call when the asker
     * had one, `reason` the asker's human-readable explanation (e.g. a hook's
     * permission-decision reason).
     */
    'approval/asked': {
      id: ApprovalRequestId
      toolName: string
      callId?: ToolCallId
      reason?: string
    }
    /**
     * The outcome of a prior `approval/asked` (same `id`) — log-only audit.
     * Exactly one per ask, appended when the outcome is known: a decision, a
     * cancellation, or the fail-closed `'unavailable'`.
     */
    'approval/decided': {
      id: ApprovalRequestId
      outcome: ApprovalOutcome
      /** Digest of the exact action and execution context granted for this Session. */
      sessionGrantKey?: string
      /** Command tokens recorded only when a prefix Session grant was approved. */
      prefixRule?: readonly string[]
    }
  }
}

/** Client-safe payload declared for the approval answerer waterfall. */
export interface ApprovalRequestEvent {
  /** Service-issued audit identity available to reviewer contributions. */
  readonly requestId?: ApprovalRequestId
  /** Agent identity projected to the corresponding Client Context in transit. */
  readonly agent: Agent
  /** Tool whose operation requires a decision. */
  readonly toolName: string
  /** Exact tool call being decided, when available. */
  readonly callId?: ToolCallId
  /** Human-readable reason supplied by the asker. */
  readonly reason?: string
  /** Offer a same-Session grant for an exact action; absent for ordinary asks. */
  readonly allowForSession?: boolean
  /** Tokens whose future matching commands may use the requested permission for this Session. */
  readonly prefixRule?: readonly string[]
  /** Cancellation lifetime of the pending request. */
  readonly signal?: AbortSignal
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Ask composed answerers for one decision. Return an outcome to claim the
     * request or call `next()` to delegate. Scope-filtered dispatch
     * (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @param req - pending approval request.
     * @mode waterfall
     */
    'codexy-approval/request'(
      this: Scoped<Agent>,
      req: ApprovalRequestEvent,
      next: () => Promise<ApprovalAnswer>,
    ): Promise<ApprovalAnswer>
    /**
     * Review a required approval automatically; absent reviewers fail closed.
     * Scope-filtered dispatch: agent-scoped listeners receive only their agent.
     * @param req - service-issued approval request.
     * @mode waterfall
     */
    'codexy-approval/auto-review'(
      this: Scoped<Agent>,
      req: ApprovalRequestEvent,
      next: () => Promise<ApprovalAnswer>,
    ): Promise<ApprovalAnswer>
  }
}

/** The product's richer approval request uses the public Gateway event carrier. */
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteEventSelection { 'codexy-approval/request': true }
}

/**
 * A session's approval policy — what happens to an {@link ApprovalService}
 * ask BEFORE any interactive answerer sees it:
 *
 * - `'ask'` (the default) — delegate to the composed answerers; with none
 *   composed the chain falls through to the fail-closed `'unavailable'`.
 * - `'never'` — never prompt anyone: every ask resolves `'rejected'`
 *   deterministically. The strict headless stance (CI, unattended runs) and
 *   the policy whose outcome is knowable without asking.
 */
export type ApprovalPolicy = 'ask' | 'never'

declare module '@codexydsh/runtime/types' {
  interface SessionEventMap {
    /**
     * The session's approval policy was switched — log-only, durable,
     * replayable, never in the model transcript (the model learns the policy
     * from the runtime-context snapshot and live switch notices). The LAST
     * such event is the session's override.
     * `source: 'delegation'` marks an override seeded into a child; an absent
     * source is a runtime switch.
     */
    'approval/policy': {
      policy: ApprovalPolicy
      /** Marks an override seeded into a child at delegation. */
      source?: 'delegation'
    }
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'codexy-user-approval': {
      kind: 'codexy-user-approval'
      /** Exact denied assessment explicitly acknowledged through a human command. */
      approvedActionId?: ApprovalRequestId
    } & ContextFormed
  }
}
