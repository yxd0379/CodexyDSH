import { memo, useEffect, useState } from 'react'
import { IconChevronDownOutlineRegular } from '@codexydsh/ui-primitives'
import type { TurnLocation } from '@codexydsh/ui-conversation/client'
import type { UsePresentation, ChatNodeViewProps, TurnProcessOwnerProps, ChatViewSlotProps } from '../contract/slots.ts'
import { turnProcessAlwaysOpen } from '../contract/turn-process.ts'
import { formatLiveRunDuration, formatMessageClock, formatRunDuration, LIVE_RUN_CLOCK_INTERVAL_MS } from './message-chrome.ts'
import { useCalendarDay } from './use-calendar-day.ts'
import a11yCss from './accessibility.module.css'
import css from './TurnProcessNodeView.module.css'

/**
 * Render the Codexful process toggle beside the user's copy controls.
 * @param props - owning Turn, local process disclosure, and translator.
 * @returns compact controls for recorded or running work.
 */
export function CodexfulTurnControls({ turn, process, t }: {
  readonly turn: TurnLocation
  readonly process: TurnProcessOwnerProps
  readonly t: ChatViewSlotProps['t']
}) {
  return <span className={css.controls} data-codexful-turn-controls={turn.turn}
    data-turn-process={turn.turn}
    data-turn-process-messages={process.spec.messageCount}
    data-turn-process-tool-calls={process.spec.toolCallCount}
    data-turn-process-subagents={process.spec.subagentCount}>
    {process.foldable && process.hasContent && <button type="button" className={css.toggle}
      aria-expanded={process.open}
      onClick={(event) => { event.currentTarget.focus(); process.setOpen(!process.open) }}>
      <IconChevronDownOutlineRegular className={css.chevron} data-expanded={process.open || undefined} />
      {t(process.open ? 'message.turnProcess.collapseAll' : 'message.turnProcess.expandAll')}
    </button>}
  </span>
}

/**
 * Show the owning Turn's start and end together at its opening human message.
 * @param props - Turn events, original human fallback time, and translator.
 * @returns date-aware source-event times, or null when no start time is loaded.
 */
export function CodexfulTurnTime({ turn, fallbackStart, t }: {
  readonly turn: TurnLocation
  readonly fallbackStart: number | undefined
  readonly t: ChatViewSlotProps['t']
}) {
  const day = useCalendarDay()
  const start = turn.start?.time ?? fallbackStart
  if (start === undefined) return null
  const clock = (time: number, relativeDay: number): string =>
    `${formatMessageClock(time, t, relativeDay)}:${String(new Date(time).getSeconds()).padStart(2, '0')}`
  const startText = clock(start, day)
  const end = turn.end?.time
  const endText = end === undefined ? undefined : clock(end, start)
  return <span className={css.timeRange} data-turn-time-range={turn.turn} role="group" aria-label={t('message.turnTiming.range')}>
    <time dateTime={new Date(start).toISOString()} title={t('message.turnTiming.start', { time: startText })} data-turn-time-start>{startText}</time>
    {(end !== undefined || turn.status === 'open') && <>
      <span aria-hidden="true">→</span>
      {end === undefined ? <span data-turn-time-live>{t('message.turnTiming.ongoing')}</span>
        : <time dateTime={new Date(end).toISOString()} title={t('message.turnTiming.end', { time: endText })} data-turn-time-end>{endText}</time>}
    </>}
  </span>
}

/** Turn-level process disclosure controller. */
export const TurnProcessNodeView = memo(function TurnProcessNodeView({
  node, turnProcess, t, usePresentation,
}: ChatNodeViewProps<'turn-process'> & { usePresentation: UsePresentation }) {
  const codexful = usePresentation(policy => policy.codexful === true)
  if (turnProcess === undefined) throw new Error('turn-process node requires Turn process owner state')
  const open = !turnProcess.foldable || turnProcess.open
  const turn = node.location.kind === 'turn' || node.location.kind === 'step'
    ? node.location.turn
    : undefined
  const [now, setNow] = useState(Date.now)
  const ticking = !codexful && turn?.status === 'open' && turn.start !== undefined
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, LIVE_RUN_CLOCK_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [ticking])
  if (codexful || (turn?.start === undefined && turn?.status !== 'closed')) return null
  const canCollapse = turnProcess.foldable && turnProcess.hasContent && !turnProcessAlwaysOpen(node)
  const running = turn.status === 'open'
  const reason = turn.end?.data.reason.kind
  const elapsedMs = turn.start === undefined ? undefined
    : Math.max(1000, (turn.end?.time ?? now) - turn.start.time)
  const duration = elapsedMs === undefined ? undefined
    : running ? formatLiveRunDuration(elapsedMs, t) : formatRunDuration(elapsedMs, t)
  const label = running
    ? duration === undefined ? t('chat.deepDiving') : t('message.turnProcess.deepDivingFor', { duration })
    : reason === 'aborted' ? t('message.stopped')
      : reason === 'error' ? t('message.turnProcess.failed')
        : duration === undefined ? t('message.turnProcess.worked')
          : t('message.turnProcess.took', { duration })
  const announcement = running ? t('chat.deepDiving')
    : reason === 'aborted' ? t('message.stopped')
      : reason === 'error' ? t('message.turnProcess.failed')
        : t('message.turnProcess.worked')
  return (
    <>
      <span className={a11yCss.visuallyHidden} role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
      <button
        type="button"
        className={css.root}
        data-open={open || undefined}
        data-turn-process={node.data.turn}
        data-turn-process-messages={node.data.messageCount}
        data-turn-process-tool-calls={node.data.toolCallCount}
        data-turn-process-subagents={node.data.subagentCount}
        disabled={!canCollapse}
        aria-expanded={turnProcess.hasContent ? open : undefined}
        onClick={(event) => {
          event.currentTarget.focus()
          turnProcess.setOpen(!open)
        }}
      >
        <span className={css.label}>{label}</span>
        {canCollapse && <IconChevronDownOutlineRegular className={css.chevron} />}
      </button>
    </>
  )
})
