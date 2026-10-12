/** Compact reminder for the original question above the current reading position. */
import { IconChevronUpOutlineRegular } from '@codexydsh/ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import type { TurnNavigationItem } from '../contract/snapshot.ts'
import type { TurnRailItem } from './turn-rail-items.ts'
import css from './ChatView.module.css'

/**
 * Render a single-line question reminder with an explicit return action.
 * @param props - question anchor, shared Turn navigation and translator.
 * @returns the compact reminder row.
 */
export function CurrentQuestionBar({ item, onNavigate, t }: {
  readonly item: TurnNavigationItem
  readonly onNavigate: (item: TurnRailItem) => void
  readonly t: ChatViewSlotProps['t']
}) {
  return <div className={css.questionSlot}>
    <div className={css.questionBar} data-current-question-bar={item.turn}>
      <span className={css.questionLabel}>{t('chat.currentQuestion.label')}</span>
      <span className={css.questionPreview}>{item.prompt}</span>
      <button type="button" className={css.questionReturn} aria-label={t('chat.currentQuestion.back')}
        onClick={() => { onNavigate({
          turn: item.turn, prompt: item.prompt, response: item.response,
          anchor: { kind: 'loaded', key: item.anchorKey },
        }) }}>
        <IconChevronUpOutlineRegular size={14} />
        <span>{t('chat.currentQuestion.back')}</span>
      </button>
    </div>
  </div>
}
