import type { Context } from '@deepseek-ai/cordis'
import type {
  CompactionSummaryNode, ConversationMatch, ConversationNodeContext, ConversationNodeDefinition,
} from '@codexydsh/ui-conversation/client'
import type {} from '@deepseek-ai/dsh-compaction/types'
import { chatNode } from './common.ts'
import { compactSource, compactSummary, updateCompactionState } from './command.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Automatic compaction checkpoint marker. */
    compaction: CompactionSummaryNode
  }
}

interface CompactionState {
  readonly summary?: ConversationMatch
  readonly checkpoint?: ConversationMatch
}

/** Summary citations identify model-history reconstruction even in a window starting after the summary. */
export const compactionCitationDefinition: ConversationNodeDefinition<number> = {
  kind: 'compaction-citation',
  match: (event) => {
    if (event.type === 'compaction/summary') return { id: String(event.seq), role: 'start' }
    return event.type === 'user/message' && compactSource(event) !== undefined && event.sourceEventSeqs?.length === 1
      ? { id: String(event.sourceEventSeqs[0]), role: 'update' }
      : null
  },
  start: (_context, match) => match.event.seq,
  update: context => context.state,
  publication: () => 'none',
}

function fallbackState(context: ConversationNodeContext<CompactionState>): CompactionState {
  const summary = context.matches.find(match => match.event.type === 'compaction/summary')
  const checkpoint = context.matches.find(match => compactSource(match.event) !== undefined)
  return {
    ...summary === undefined ? {} : { summary },
    ...checkpoint === undefined ? {} : { checkpoint },
  }
}

/** Automatic compaction lifecycle and landed checkpoint Definition. */
export const compactionDefinition: ConversationNodeDefinition<CompactionState> = {
  kind: 'compaction',
  target: 'chat',
  match: (event) => {
    const checkpoint = compactSource(event)
    if (checkpoint !== undefined && checkpoint.sourceCommandId === undefined) {
      return { id: checkpoint.compactionId, role: 'update' }
    }
    if (event.type === 'compaction/start'
      || event.type === 'compaction/summary'
      || event.type === 'compaction/end') {
      if (event.data.sourceCommandId !== undefined) return null
      const compactionId: unknown = event.data.compactionId
      if (typeof compactionId !== 'string' || compactionId === '') return null
      return { id: compactionId, role: event.type === 'compaction/start' ? 'start' : 'update' }
    }
    return null
  },
  start: () => ({}),
  update: (context, match) => updateCompactionState(context.state, match),
  buildViewNode: (context) => {
    const state = context.state ?? fallbackState(context)
    if (state.checkpoint === undefined) return null
    const marker = compactSummary(state.summary, state.checkpoint)
    return chatNode(context, 'compaction', marker.seq, marker)
  },
}

/**
 * Register the automatic-compaction business contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerCompactionConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(compactionCitationDefinition)
  ctx.uiConversation.events.register(compactionDefinition)
}
