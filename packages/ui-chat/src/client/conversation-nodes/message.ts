import type { Context } from '@deepseek-ai/cordis'
import type {
  ContextMessageNode, ConversationContextReader, ConversationNodeDefinition, SteeringMessageNode, UserMessageNode,
} from '@codexydsh/ui-conversation/client'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type { InboxState } from './inbox.ts'
import { chatNode } from './common.ts'
import { contextForm, contextProducer } from './event-projection.ts'

interface ReferencedUserMessageNode extends UserMessageNode {
  /** User-cancelled Turn cited by a generated interruption notice. */
  readonly interruptedTurn?: number
  /** Labels cited by the immediately following session-reference context. */
  readonly referenceLabels?: readonly string[]
  /** Skill names the same step's `skill-invocation` injections loaded. */
  readonly skillNames?: readonly string[]
}

interface ReferencedSteeringMessageNode extends SteeringMessageNode {
  /** User-cancelled Turn cited by a generated interruption notice. */
  readonly interruptedTurn?: number
  /** Labels cited by the immediately following session-reference context. */
  readonly referenceLabels?: readonly string[]
  /** Skill names the same step's `skill-invocation` injections loaded. */
  readonly skillNames?: readonly string[]
}

interface DeveloperContextMessageNode extends ContextMessageNode {
  /** The message's model-facing role, separate from its producer source. */
  readonly messageRole: 'developer'
}

type MessageNode = ReferencedUserMessageNode | ReferencedSteeringMessageNode
  | (ContextMessageNode & { readonly waking?: boolean; readonly messageRole?: never })
  | DeveloperContextMessageNode
  | { readonly kind: 'model-history-copy'; readonly node: ContextMessageNode }

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Ordinary turn-opening user message. */
    user: ReferencedUserMessageNode
    /** User message admitted into an active turn. */
    steering: ReferencedSteeringMessageNode
    /** Non-user context injected into model history. */
    context: ContextMessageNode
    /** Developer-role instructions appended to model history. */
    developer: DeveloperContextMessageNode
    /** Non-human input that starts a Turn. */
    'turn-trigger': ContextMessageNode
  }
}

function isCompactionCheckpoint(event: Parameters<ConversationNodeDefinition['match']>[0]): boolean {
  if (event.type !== 'user/message') return false
  const source = event.data.source as { kind?: unknown }
  return source.kind === 'compact-checkpoint'
}

function userInterruptedTurn(
  event: Extract<Parameters<ConversationNodeDefinition['match']>[0], { type: 'user/message' }>,
  reader: ConversationContextReader,
): number | undefined {
  const content = event.data.content
  const block = content[0]
  if (event.sourceEventSeqs === undefined || content.length !== 1 || block?.type !== 'text'
    || !block.text.startsWith('<turn_aborted>\n') || !block.text.endsWith('\n</turn_aborted>')) return undefined
  const end = reader.previous('turn-process')?.matches.findLast(({ event: source }) =>
    source.type === 'turn/end' && event.sourceEventSeqs?.includes(source.seq) === true
    && source.data.reason.kind === 'aborted' && source.data.reason.reason.kind === 'user')?.event
  return end?.type === 'turn/end' ? end.data.turn : undefined
}

/** User, steering, developer, and injected-context message classification Definition. */
export const messageDefinition: ConversationNodeDefinition<MessageNode> = {
  kind: 'input-message',
  target: 'chat',
  match: (event) => {
    if (event.type === 'user/message') {
      return isAppendSurfaceEvent(event) && !isCompactionCheckpoint(event)
        ? { id: event.sourceEventSeqs === undefined ? String(event.data.id) : `derived:${event.seq}`, role: 'start' }
        : null
    }
    if (event.type === 'developer/message') {
      return isAppendSurfaceEvent(event)
        ? { id: String(event.data.message.id), role: 'start' }
        : null
    }
    return null
  },
  start: (_context, match, reader) => {
    if (match.event.type === 'developer/message') {
      const { message } = match.event.data
      return {
        kind: 'context',
        messageRole: 'developer',
        seq: match.event.seq,
        time: match.event.time,
        content: message.content,
        source: message.source,
        producer: contextProducer(message.source),
        form: contextForm(message.source),
      }
    }
    if (match.event.type !== 'user/message') throw new Error('input-message start requires user/message')
    const event = match.event
    if (event.sourceEventSeqs?.some(seq => reader.matches('compaction-citation', String(seq)).length > 0)) {
      return { kind: 'model-history-copy', node: {
        kind: 'context', seq: event.seq, time: event.time, content: event.data.content, source: event.data.source,
        producer: contextProducer(event.data.source), form: contextForm(event.data.source),
      } }
    }
    if (event.data.source.kind !== 'user') {
      const nextTurn = reader.previous<InboxState>('inbox-next-turn')?.state
      const nextStep = reader.previous<InboxState>('inbox-next-step')?.state
      const location = match.location
      const turnStart = location.kind === 'step' ? location.turn.start?.seq : undefined
      // An idle steer opens Step 1 without a next-turn claim in this Turn.
      // A human in that same next-step claim owns the opening instead of its notices.
      const idleSteer = location.kind === 'step' && location.step.step === 1
        && turnStart !== undefined && (nextStep?.claimSeq ?? -1) > turnStart
        && (nextTurn?.claimSeq ?? -1) < turnStart && nextStep?.claimedHuman === false
        && nextStep.currentClaimed.has(String(event.data.id))

      return {
        kind: 'context',
        waking: nextTurn?.currentClaimed.has(String(event.data.id)) === true || idleSteer,
        seq: event.seq,
        time: event.time,
        content: event.data.content,
        source: event.data.source,
        producer: contextProducer(event.data.source),
        form: contextForm(event.data.source),
      }
    }
    const claimed = reader.previous<InboxState>('inbox-next-step')
      ?.state.currentClaimed.has(String(event.data.id)) === true
    const interruptedTurn = userInterruptedTurn(event, reader)
    const interruption = interruptedTurn === undefined ? {} : { interruptedTurn }
    return claimed
      ? {
        kind: 'steering',
        messageId: event.data.id,
        seq: event.seq,
        time: event.time,
        content: event.data.content,
        source: event.data.source,
        ...interruption,
      }
      : {
        kind: 'user',
        seq: event.seq,
        time: event.time,
        content: event.data.content,
        source: event.data.source,
        ...interruption,
      }
  },
  update: context => context.state,
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    if (context.state.kind === 'model-history-copy') {
      return chatNode(context, 'context', context.state.node.seq, context.state.node, { visibility: 'hidden' })
    }
    if (context.state.kind === 'context' && context.state.messageRole === 'developer') {
      return chatNode(context, 'developer', context.state.seq, context.state)
    }
    const waking = context.state.kind === 'context'
      && context.start?.event.type === 'user/message'
      && context.state.waking === true
    return chatNode(context, waking ? 'turn-trigger' : context.state.kind, context.state.seq, context.state)
  },
}

/**
 * Register the user, steering, developer, and injected-context message contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerMessageConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(messageDefinition)
}
