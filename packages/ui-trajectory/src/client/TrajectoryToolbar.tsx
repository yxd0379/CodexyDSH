/**
 * Trajectory toolbar. Each control states one axis and its pressed state is
 * that axis alone: actual duration, collapsed turns, collapsed calls.
 */

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { IconSearchOutlineRegular } from '@codexydsh/ui-primitives'
import type { NS } from './locales.ts'
import css from './TrajectoryToolbar.module.css'

export interface TrajectoryToolbarProps {
  /** Whether timeline blocks use recorded durations. */
  actualDuration: boolean
  /** Select recorded-duration or equal-width blocks. */
  onActualDurationChange: (actualDuration: boolean) => void
  /** Whether recorded timing retains idle gaps between operations. */
  actualTime: boolean
  /** Select complete wall-clock timing or idle-compressed timing. */
  onActualTimeChange: (actualTime: boolean) => void
  /** Whether collapsible turns are folded. */
  allTurnsCollapsed: boolean
  /** Whether any turn is currently expanded, so its inner calls can be folded. */
  turnsExpanded: boolean
  /** Fold or expand collapsible turns. */
  onTurnsCollapsedChange: (collapsed: boolean) => void
  /** Whether every collapsible assistant's tool calls are currently folded. */
  allAssistantsCollapsed: boolean
  /** Fold or expand tool calls under collapsible assistants. */
  onAssistantsCollapsedChange: (collapsed: boolean) => void
  /** Current live ledger search query. */
  searchQuery: string
  /** Update the live ledger search query. */
  onSearchQueryChange: (query: string) => void
  /** Translate a toolbar dictionary key. */
  t: TranslateNS<typeof NS>
}

/**
 * Render the sticky trajectory toolbar.
 * @param props - rendered counts and whole-list fold state.
 * @returns the toolbar element.
 */
export function TrajectoryToolbar({
  actualDuration,
  onActualDurationChange,
  actualTime,
  onActualTimeChange,
  allTurnsCollapsed,
  turnsExpanded,
  onTurnsCollapsedChange,
  allAssistantsCollapsed,
  onAssistantsCollapsedChange,
  searchQuery,
  onSearchQueryChange,
  t,
}: TrajectoryToolbarProps) {
  return (
    <div className={css.root} role="toolbar" aria-label={t('toolbar.aria')}>
      <div className={css.inner}>
        <div className={css.actions}>
          <button
            type="button"
            className={css.control}
            role="switch"
            aria-label={t('toolbar.actualDuration')}
            aria-checked={actualDuration}
            aria-pressed={actualDuration}
            onClick={() => { onActualDurationChange(!actualDuration) }}
          >
            {t('toolbar.duration')}
            <span className={css.controlTrack} data-on={actualDuration || undefined} aria-hidden="true">
              <span className={css.controlThumb} />
            </span>
          </button>
          <button
            type="button"
            className={css.control}
            role="switch"
            aria-checked={actualTime}
            hidden
            onClick={() => { onActualTimeChange(!actualTime) }}
          >
            <span>{t('toolbar.actualTime')}</span>
            <span className={css.controlTrack} data-on={actualTime || undefined} aria-hidden="true">
              <span className={css.controlThumb} />
            </span>
          </button>
          <button
            type="button"
            className={css.control}
            role="switch"
            aria-label={t('toolbar.collapseTurns')}
            aria-checked={allTurnsCollapsed}
            aria-pressed={allTurnsCollapsed}
            onClick={() => { onTurnsCollapsedChange(!allTurnsCollapsed) }}
          >
            {t('toolbar.turns')}
            <span className={css.controlTrack} data-on={allTurnsCollapsed || undefined} aria-hidden="true">
              <span className={css.controlThumb} />
            </span>
          </button>
          {turnsExpanded && (
            <button
              type="button"
              className={css.control}
              role="switch"
              aria-label={t('toolbar.collapseCalls')}
              aria-checked={allAssistantsCollapsed}
              aria-pressed={allAssistantsCollapsed}
              onClick={() => { onAssistantsCollapsedChange(!allAssistantsCollapsed) }}
            >
              {t('toolbar.calls')}
              <span className={css.controlTrack} data-on={allAssistantsCollapsed || undefined} aria-hidden="true">
                <span className={css.controlThumb} />
              </span>
            </button>
          )}
        </div>
        <div className={css.search}>
          <IconSearchOutlineRegular size={11} className={css.searchIcon} />
          <input
            type="search"
            className={css.searchInput}
            aria-label={t('toolbar.search')}
            placeholder={t('toolbar.searchPlaceholder')}
            value={searchQuery}
            onChange={(event) => { onSearchQueryChange(event.currentTarget.value) }}
          />
        </div>
      </div>
    </div>
  )
}
