/** Composer takeover for one pending approval waterfall. */
import { useState, type ReactNode } from 'react'
import { Button, StateDot } from '@codexydsh/ui-primitives'
import type { ApprovalComposerProps, PendingApproval } from './contract/slots.ts'
import css from './ApprovalPanel.module.css'

/**
 * Render one pending approval and its optional Tool-owned detail.
 * @param props - selector-matched request and standard Slot props.
 * @returns The approval composer takeover.
 */
export function ApprovalPanel(props: ApprovalComposerProps) {
  const approval = props.matched
  const detail = approval.callId === undefined
    ? null
    : props.renderSlot('conversation.approval.detail', { callId: approval.callId })
  return <ApprovalFlow key={approval.key} pending={approval} detail={detail} t={props.t} />
}

function ApprovalFlow({ pending, detail, t }: {
  pending: PendingApproval
  detail: ReactNode
  t: ApprovalComposerProps['t']
}) {
  const [answered, setAnswered] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const answer = (outcome: 'allowed-once' | 'allow-for-session' | 'allow-prefix-for-session' | 'rejected'): void => {
    setAnswered(true)
    setFailure(null)
    void pending.answer(outcome).catch((error: unknown) => {
      setFailure(error instanceof Error ? error.message : String(error))
      setAnswered(false)
    })
  }
  return (
    <div className={css.root} data-approval-key={pending.key} aria-busy={answered}>
      <div className={css.card}>
        <div className={css.strip}><StateDot state={answered ? 'ongoing' : 'warning'} />{t('waiting')}</div>
        <div
          className={css.body}
          data-approval-scroll=""
          tabIndex={0}
          role="group"
          aria-label={t('detail.aria')}
        >
          <div className={css.headline}>{pending.reason ?? t('escalation', { toolName: pending.toolName })}</div>
          {pending.prefixRule !== undefined && <div className={css.command}>
            {t('prefixScope', { prefix: JSON.stringify(pending.prefixRule) })}
          </div>}
          {detail !== null && <div className={css.command}>{detail}</div>}
        </div>
        {failure !== null && <div className={css.failure} role="alert">{t('answerFailed', { reason: failure })}</div>}
        <div className={css.actionRow}>
          <Button variant="outline" className={css.reject} disabled={answered} onClick={() => { answer('rejected') }}>
            {t('reject')}
          </Button>
          <Button variant="primary" disabled={answered} onClick={() => { answer('allowed-once') }}>
            {t('allowOnce')}
          </Button>
          {pending.allowForSession && <Button variant="primary" disabled={answered} onClick={() => { answer('allow-for-session') }}>
            {t('allowForSession')}
          </Button>}
          {pending.prefixRule !== undefined && <Button variant="primary" disabled={answered} onClick={() => { answer('allow-prefix-for-session') }}>
            {t('allowPrefixForSession')}
          </Button>}
        </div>
      </div>
    </div>
  )
}
