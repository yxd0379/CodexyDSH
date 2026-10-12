/** Public review verdicts; private reviewer requests never reach this component. */
import { useState } from 'react'
import { Button, IconChevronRightOutlineRegular, StateDot, TextShimmer } from '@codexydsh/ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionEventMap } from '@codexydsh/runtime/types'
import type { ApprovalRequestId } from '@codexydsh/approval/types'
import css from './ApprovalReviewCard.module.css'

/** Recorded review status and public explanation, without internal model context. */
export interface ApprovalReviewPresentation {
  readonly id: ApprovalRequestId
  readonly status: SessionEventMap['approval/review']['status']
  readonly toolName?: string
  readonly reason?: string
  readonly rationale?: string
  readonly error?: string
}

/** Public review values and a Session-bound callback supplied by the approval registration. */
export interface ApprovalReviewCardProps extends PropsLocale<'approval'> {
  readonly review: ApprovalReviewPresentation
  /** Submit explicit authorization for this exact action; the Host performs another review. */
  readonly approve?: (reviewId: ApprovalRequestId) => Promise<void>
}

const STATUS_KEYS = {
  started: 'review.pending', inspecting: 'review.inspecting', approved: 'review.approved',
  denied: 'review.denied', failed: 'review.failed', cancelled: 'review.cancelled', manual: 'review.manual',
} as const

/**
 * Reviewer input-budget fallbacks, recorded verbatim by the Codexful reviewer as
 * `review.error`. They describe a handover to the human, not a denial, so the
 * card shows product copy instead of the raw diagnostics text.
 */
const BUDGET_FALLBACK_ERRORS = new Set([
  'the complete private review request exceeds the reviewer input budget',
  'the action and trusted instructions exceed the reviewer input budget',
])

/**
 * Render compact successful reviews and actionable failures with their full rationale.
 * @param props - public recorded verdict and Session-bound command callback.
 * @returns an accessible review notice whose action always invokes another review.
 */
export function ApprovalReviewCard({ review, approve, t }: ApprovalReviewCardProps) {
  const [request, setRequest] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle')
  const [failure, setFailure] = useState('')
  const pending = review.status === 'started' || review.status === 'inspecting'
  const denied = review.status === 'denied' || review.status === 'failed'
  const retryable = denied && approve !== undefined
  const budgetFallback = review.error !== undefined && BUDGET_FALLBACK_ERRORS.has(review.error)
  const explanation = review.rationale ?? (budgetFallback ? t('review.budget') : review.error) ?? review.reason
  const submit = (): void => {
    if (approve === undefined || request === 'sending' || request === 'sent') return
    setRequest('sending')
    setFailure('')
    void approve(review.id).then(() => { setRequest('sent') }, (error: unknown) => {
      setRequest('failed')
      setFailure(error instanceof Error ? error.message : String(error))
    })
  }
  const verdict = <span className={css.verdict} role="status" aria-live="polite">
    {(review.status !== 'approved' || explanation === undefined) && <StateDot state={pending ? 'ongoing' : review.status === 'approved' ? 'done' : denied ? 'error' : 'warning'} />}
    <TextShimmer active={pending}>{t(STATUS_KEYS[review.status])}</TextShimmer>
  </span>
  const tool = review.toolName !== undefined && <span className={css.tool}>{t(
    review.toolName === 'exec_command' || review.toolName === 'bash' ? 'review.action.command'
      : review.toolName === 'write_stdin' ? 'review.action.process'
        : review.toolName === 'apply_patch' ? 'review.action.edit' : 'review.action.tool',
  )}</span>
  if (review.status === 'approved' && explanation !== undefined) {
    return <details className={css.root} data-approval-review={review.id} data-review-status={review.status} aria-busy={false}>
      <summary className={css.header}>
        <IconChevronRightOutlineRegular className={css.chevron} size={14} aria-hidden />
        {verdict}
        {tool}
        <span className={css.inlineExplanation}>{explanation}</span>
      </summary>
      <p className={css.explanation}>{explanation}</p>
    </details>
  }
  return <div className={css.root} data-approval-review={review.id} data-review-status={review.status}
    aria-busy={pending || request === 'sending'}>
    <div className={css.header}>{verdict}{tool}</div>
    {explanation !== undefined && <p className={css.explanation}>{explanation}</p>}
    {retryable && <div className={css.actions}>
      <p className={css.hint}>{t(request === 'sent' ? 'review.sent' : 'review.retryHelp')}</p>
      <Button variant="outline" disabled={request === 'sending' || request === 'sent'} onClick={submit}>
        {t(request === 'sending' ? 'review.sending' : 'review.approve')}
      </Button>
    </div>}
    {request === 'failed' && <div className={css.failure} role="alert">{t('review.sendFailed', { reason: failure })}</div>}
  </div>
}
