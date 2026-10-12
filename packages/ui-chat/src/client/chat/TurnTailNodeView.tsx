import { memo } from 'react'
import type { InjectFace, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ChatNodeViewProps, ChatViewSlotProps, PerformanceUsageInjected, PresentationInjected, TurnTailOwnerProps,
} from '../contract/slots.ts'
import { MessageIconActions } from './MessageIconActions.tsx'
import { TurnUsagePanel } from './TurnUsagePanel.tsx'
import { assistantText } from './turn-assistant.ts'
import { hasAssistantReplyContent } from '../contract/assistant-content.ts'
import type { ChatNode, TurnTailChatData, TurnTokenUsage } from '../contract/chat-nodes.ts'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { ChatSnapshot } from '../contract/snapshot.ts'
import css from './TurnTailNodeView.module.css'

type TurnTailNodeViewProps = ChatNodeViewProps<'turn-tail'>
  & PropsRenderSlots<'conversation.chat.turnTail' | 'conversation.chat.assistant-actions'>
  & InjectFace<PerformanceUsageInjected>
  & InjectFace<PresentationInjected>

function lastContent(snapshot: ChatSnapshot, turn: number, skipWarning: boolean): ChatNode | undefined {
  const keys = snapshot.locations.getTurn(turn)
  for (let index = keys.length - 1; index >= 0; index--) {
    const node = snapshot.nodes.get(keys[index] as string) as ChatNode | undefined
    if (node === undefined || node.kind === 'turn-tail' || node.kind === 'turn-process'
      || (skipWarning && node.kind === 'turn-max-tokens')) continue
    return node
  }
  return undefined
}

/** Turn footer actions resolved for either the tail row or the Codexful turn-actions seat. */
export interface TurnTailActions {
  /** Boundary seq the branch action forks at, absent before the Turn has a tail. */
  readonly seq: number | undefined
  /** Finalized assistant message addressed by per-message actions. */
  readonly messageId: MessageId | undefined
  /** Whether the branch point is no longer a transcript tail. */
  readonly branchUnavailable: boolean
  /** Exact per-Turn accounting when the loaded evidence is complete. */
  readonly tokenUsage: TurnTokenUsage | undefined
}

/**
 * Resolve the Turn footer's branch point, per-message identity, and usage.
 * @param tail - the enclosing Turn's tail data, absent before one exists.
 * @param useChat - the owning view's Chat store seat (reads later-node evidence).
 * @returns footer action inputs, shared by every surface that shows them.
 */
export function useTurnTailActions(
  tail: TurnTailChatData | undefined,
  useChat: ChatViewSlotProps['useChat'],
): TurnTailActions {
  const hasLaterChatNode = useChat(snapshot => tail === undefined ? false
    : (lastContent(snapshot, tail.turn, true)?.anchorSeq ?? -1) > (tail.closing?.finalNode.seq ?? tail.seq))
  return {
    seq: tail?.seq,
    messageId: tail?.closing?.finalNode.messageId,
    branchUnavailable: tail === undefined || tail.branchUnavailable || hasLaterChatNode,
    tokenUsage: tail?.tokenUsage,
  }
}

/** Turn-local actions and feature tail over the Location index, independent of Assistant placement. */
export const TurnTailNodeView = memo(function TurnTailNodeView({
  node, openFile, forkAt, renderSlot, t, useChat, usePerformanceUsage, usePresentation,
}: TurnTailNodeViewProps) {
  const detailed = usePerformanceUsage(mode => mode) === 'detailed'
  const codexful = usePresentation(policy => policy.codexful === true)
  const data = node.data
  const actions = useTurnTailActions(data, useChat)
  const endsWithResponse = useChat((snapshot) => {
    if (snapshot.timeline.turnOrder.at(-1) !== data.turn) return false
    const last = lastContent(snapshot, data.turn, false)
    const block = last?.kind === 'assistant-step' ? last.data.blocks.findLast(candidate =>
      (candidate.kind !== 'text' && candidate.kind !== 'reasoning') || candidate.text.trim() !== '') : undefined
    return block !== undefined && hasAssistantReplyContent([block])
  })
  const turn = node.location.kind === 'turn' || node.location.kind === 'step'
    ? node.location.turn
    : undefined
  if (turn === undefined) return null
  const closing = data.closing
  const owner: TurnTailOwnerProps = { turn, seq: closing?.finalNode.seq ?? data.seq, openFile }
  const tail = renderSlot('conversation.chat.turnTail', owner)
  if (closing === null) return tail === null ? null : <div className={css.root} data-turn-tail={data.turn}>{tail}</div>
  // Codexful shows every Turn action on the opening user row, so the tail keeps
  // its feature slot and anchor without a second action row under the answer.
  if (codexful) {
    return <div className={css.root} data-turn-tail={data.turn}>{tail}</div>
  }
  // Interruption-frozen partials carry no messageId, so they address no
  // durable message and contribute no per-message actions.
  const messageId = closing.finalNode.messageId
  const assistantActions = messageId === undefined
    ? null
    : renderSlot('conversation.chat.assistant-actions', { messageId })
  return (
    <div
      className={css.root}
      data-turn-tail={data.turn}
      data-actions-reveal={endsWithResponse ? 'always' : 'hover'}
    >
      {tail}
      <MessageIconActions
        text={assistantText(closing.blocks)}
        time={closing.time}
        clock="end"
        // The branch action owns boundary resolution: it sends the real
        // turn/end seq it already has, and the Host cuts exactly there.
        onBranch={() => { forkAt(actions.seq ?? data.seq) }}
        branchUnavailable={actions.branchUnavailable}
        className={css.actions}
        extraActions={assistantActions}
        usageAction={detailed && actions.tokenUsage !== undefined
          ? <TurnUsagePanel usage={actions.tokenUsage} t={t} />
          : null}
        t={t}
      />
    </div>
  )
})
