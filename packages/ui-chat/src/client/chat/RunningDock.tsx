/** Current run status anchored to the resident composer instead of historical messages. */
import { useEffect, useState } from 'react'
import { formatLiveRunDuration, LIVE_RUN_CLOCK_INTERVAL_MS } from './message-chrome.ts'
import { TextShimmer } from '@codexydsh/ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ChatPresentationPolicy } from '../presentation-policy.ts'
import type { ChatSnapshot } from '../contract/snapshot.ts'
import type { AssistantChatData } from '../contract/chat-nodes.ts'
import { NS } from '../locale.ts'
import css from './TurnProcessNodeView.module.css'

type RunningDockProps = PropsRuntime<'conversation.input.dock'> & PropsLocale<typeof NS>
  & InjectFace<{ hooks: {
    presentation: ObservableSnapshot<ChatPresentationPolicy>
    runningChat: ObservableSnapshot<ChatSnapshot | undefined>
  } }>

/** Render one live status above the input while a Codexful run is active.
 * @param props - Session state and application presentation policy.
 * @returns Live status, absent for idle sessions or another application.
 */
export function RunningDock({ useSession, useRunningChat, usePresentation, t }: RunningDockProps) {
  const running = useSession(state => state.running)
  const codexful = usePresentation(state => state.codexful === true)
  const startedAt = useRunningChat((state) => {
    const timeline = state?.timeline
    const last = timeline?.turnOrder.at(-1)
    const turn = last === undefined ? undefined : timeline?.turns.get(last)
    return turn?.status === 'open' ? turn.start?.time : undefined
  })
  // The first streamed token of the open Turn separates "waiting for the model"
  // from "the answer is arriving": reasoning or text with content proves output
  // started, while a pending or tool-only step keeps the waiting phase.
  const composing = useRunningChat((state) => {
    const timeline = state?.timeline
    const last = timeline?.turnOrder.at(-1)
    const turn = last === undefined ? undefined : timeline?.turns.get(last)
    if (state === undefined || turn === undefined || turn.status !== 'open') return false
    return state.nodes.values().some((node) => {
      if (node.kind !== 'assistant-step') return false
      const location = node.location
      if ((location.kind !== 'turn' && location.kind !== 'step') || location.turn.turn !== turn.turn) return false
      const data = node.data as AssistantChatData
      return data.status === 'running' && data.blocks.some(block =>
        (block.kind === 'text' || block.kind === 'reasoning') && block.text.trim() !== '')
    })
  })
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!running || !codexful) return
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, LIVE_RUN_CLOCK_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [running, codexful, startedAt])
  return running && codexful ? <div className={css.dock} data-running-dock role="status" aria-live="polite">
    {composing
      ? <span className={css.composing} data-running-phase="composing">{t('chat.composing')}</span>
      : <TextShimmer active>{t('chat.deepDiving')}</TextShimmer>}
    {startedAt !== undefined && <span data-running-duration>{formatLiveRunDuration(Math.max(1000, now - startedAt), t)}</span>}
    <span className={css.stopHint}>{t('chat.escapeStop')}</span>
  </div> : null
}
