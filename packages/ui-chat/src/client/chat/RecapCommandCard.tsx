/** Completed task recaps stay readable in the transcript without another disclosure or scrollport. */
import { memo } from 'react'
import {
  IconCheckOutlineRegular, IconCopyOutlineRegular, Tooltip, useCopyFeedback,
} from '@codexydsh/ui-primitives'
import type { ChatViewSlotProps, CommandRowOwnerProps } from '../contract/slots.ts'
import { GenericCommandCard } from './GenericCommandCard.tsx'
import css from './RecapCommandCard.module.css'

interface RecapCommandCardProps extends CommandRowOwnerProps {
  t: ChatViewSlotProps['t']
}

/**
 * Show the separately generated task summary while leaving the conversation intact.
 * @param props - recorded command settlement and localized labels.
 * @returns readable summary, or the command's pending/error feedback.
 */
export const RecapCommandCard = memo(function RecapCommandCard({ node, t }: RecapCommandCardProps) {
  const text = node.outcome?.text ?? ''
  const { copied, onCopy } = useCopyFeedback(text)
  if (node.outcome === null || node.outcome.kind === 'error' || text === '') {
    return <GenericCommandCard node={node} t={t} runningSummary={t('message.recap.running')} />
  }
  return <section className={css.root} data-task-recap aria-label={t('message.recap.title')}>
    <div className={css.header}>
      <span>{t('message.recap.title')}</span>
      <Tooltip label={copied ? t('copied') : t('message.recap.copy')}><button type="button" className={css.copy} onClick={onCopy}
        aria-label={copied ? t('copied') : t('message.recap.copy')}>
        {copied ? <IconCheckOutlineRegular size={14} /> : <IconCopyOutlineRegular size={14} />}
      </button></Tooltip>
    </div>
    <p className={css.body}>{text}</p>
  </section>
})
