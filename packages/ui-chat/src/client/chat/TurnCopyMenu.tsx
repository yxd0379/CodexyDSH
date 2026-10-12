/** Flat question and Turn copy actions with local loading and retry feedback. */
import { useEffect, useRef, useState } from 'react'
import { IconCheckOutlineRegular, IconCopyOutlineRegular, Tooltip, writeClipboard } from '@codexydsh/ui-primitives'
import type { ChatSnapshot } from '../contract/snapshot.ts'
import type { ChatViewSlotProps, TurnCopyInjected } from '../contract/slots.ts'
import { renderedTurnToolSummaries, turnCopyText } from './turn-copy.ts'
import css from './TurnCopyMenu.module.css'
import actionsCss from './MessageIconActions.module.css'

/** Props derived from the user's message, owning Turn, and durable copy callback. */
interface TurnCopyMenuProps {
  readonly turn: number
  readonly question: string
  readonly endSeq?: number | undefined
  readonly snapshot: Pick<ChatSnapshot, 'nodes'>
  readonly readTurnEvents: TurnCopyInjected['readTurnEvents']
  readonly t: ChatViewSlotProps['t']
}

type CopyMode = 'question' | 'brief' | 'full'

/**
 * Copy the question, the Turn's activity summary, or all of its recorded content.
 * @param props - question text, Turn identity, current snapshot, loader, and translator.
 * @returns three persistent actions with local loading and retry feedback.
 */
export function TurnCopyMenu({ turn, question, endSeq, snapshot, readTurnEvents, t }: TurnCopyMenuProps) {
  const [status, setStatus] = useState<'idle' | 'pending' | 'copied' | 'error'>('idle')
  const [activeMode, setActiveMode] = useState<CopyMode | null>(null)
  const root = useRef<HTMLSpanElement>(null)
  const epoch = useRef(0)
  const pending = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => {
    epoch.current += 1
    if (timer.current !== undefined) clearTimeout(timer.current)
  }, [])
  const copy = async (mode: CopyMode): Promise<void> => {
    if (pending.current) return
    const currentEpoch = epoch.current
    pending.current = true
    if (timer.current !== undefined) clearTimeout(timer.current)
    setActiveMode(mode)
    setStatus('pending')
    const transcript = root.current?.closest('[data-codexful-chat]')
    const summaries = transcript == null ? [] : renderedTurnToolSummaries(transcript, snapshot, turn)
    try {
      const events = mode === 'question' ? [] : await readTurnEvents(turn, endSeq)
      if (currentEpoch !== epoch.current) return
      const ok = await writeClipboard(mode === 'question' ? question : turnCopyText(events, mode, summaries, t))
      if (currentEpoch !== epoch.current) return
      if (!ok) { setStatus('error'); return }
      setStatus('copied')
      timer.current = setTimeout(() => { setStatus('idle') }, 1000)
    } catch (_error: unknown) {
      // History or clipboard failure keeps the same action available for retry.
      if (currentEpoch === epoch.current) setStatus('error')
    } finally {
      pending.current = false
    }
  }
  const modes = [
    { mode: 'question', label: t('message.turnCopy.questionOnly'), hint: t('message.turnCopy.questionOnly') },
    { mode: 'brief', label: t('message.turnCopy.brief'), hint: t(endSeq === undefined ? 'message.turnCopy.briefCurrent' : 'message.turnCopy.brief') },
    { mode: 'full', label: t('message.turnCopy.fullLabel'), hint: t(endSeq === undefined ? 'message.turnCopy.fullCurrent' : 'message.turnCopy.full') },
  ] as const
  return <span ref={root} className={css.root} data-turn-copy={turn} role="group" aria-label={t('message.turnCopy.menu')}>
    {modes.map(({ mode, label, hint }) => <Tooltip key={mode} label={hint} side="bottom">
      <button type="button" className={`${actionsCss.action} ${css.button}`} aria-label={label}
        disabled={status === 'pending'} aria-busy={status === 'pending' && activeMode === mode || undefined}
        data-copy-mode={mode} onClick={() => { void copy(mode) }}>
        {status === 'copied' && activeMode === mode ? <IconCheckOutlineRegular /> : <IconCopyOutlineRegular />}
        {label}
      </button>
    </Tooltip>)}
    {(status === 'pending' || status === 'error') && <span className={css.notice} role="status">
      {t(status === 'error' ? 'message.turnCopy.failed' : 'message.turnCopy.preparing')}
    </span>}
  </span>
}
