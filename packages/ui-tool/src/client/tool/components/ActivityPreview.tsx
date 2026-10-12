/** Bounded text excerpts for command output and agent receipts in the transcript. */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ActivityPreview.module.css'

/**
 * Show the beginning and end of a result; opening the row restores its complete content.
 * @param props - Recorded text, localized labels, and the row disclosure callback.
 * @returns A compact excerpt with a keyboard-accessible disclosure action.
 */
export function ActivityPreview({ text, t, onOpen }: {
  text: string
  t: TranslateNS<'conversation'>
  onOpen: () => void
}) {
  if (text.trim() === '') return null
  const lines = text.trimEnd().split(/\r?\n/u).filter(line => line.trim() !== '')
  const hidden = Math.max(0, lines.length - 2)
  const excerpt = hidden > 0
    ? [...lines.slice(0, 1), t('activity.hiddenLines', { count: hidden }), ...lines.slice(-1)]
    : lines
  return <div className={css.root} data-activity-preview>
    <button type="button" className={css.content} onClick={onOpen} aria-label={t('activity.viewDetails')}>
      {excerpt.map((line, index) => <span key={index} className={css.line}>
        {line.length > 240 ? `${line.slice(0, 240)}…` : line || '\u00a0'}
      </span>)}
    </button>
  </div>
}
