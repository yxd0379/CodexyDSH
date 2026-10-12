/** Public automatic review lifecycle paired by the durable approval request id. */
import type {} from '@codexydsh/approval/types'
import type { Context } from '@deepseek-ai/cordis'
import type { ApprovalReviewPresentation } from '@codexydsh/ui-approval/client'
import type { ConversationMatch, ConversationNodeDefinition } from '@codexydsh/ui-conversation/client'
import { chatNode } from './common.ts'

interface ReviewState {
  readonly anchorSeq: number
  readonly request?: { readonly toolName: string; readonly reason?: string }
  readonly review?: ApprovalReviewPresentation
}

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Public reviewer progress or terminal verdict, without private model input. */
    'approval-review': ApprovalReviewPresentation
  }
}

function reduce(previous: ReviewState | undefined, match: ConversationMatch): ReviewState {
  const { event } = match
  const anchorSeq = previous?.anchorSeq ?? event.seq
  if (event.type === 'approval/asked') {
    return { ...previous, anchorSeq, request: { toolName: event.data.toolName,
      ...event.data.reason === undefined ? {} : { reason: event.data.reason } } }
  }
  if (event.type !== 'approval/review') throw new Error('approval review requires a matching approval event')
  const { id, status, assessment, error } = event.data
  return { ...previous, anchorSeq, review: {
    id, status,
    ...previous?.request,
    ...assessment === undefined ? {} : { rationale: assessment.rationale },
    ...error === undefined ? {} : { error },
  } }
}

/** Fold retained approval records into one public row, including history windows without the original request. */
export const approvalReviewDefinition: ConversationNodeDefinition<ReviewState> = {
  kind: 'approval-review', target: 'chat',
  match: event => event.type === 'approval/asked' || event.type === 'approval/review'
    ? { id: String(event.data.id), role: 'start' } : null,
  start: (_context, match) => reduce(undefined, match),
  update: (context, match) => reduce(context.state, match),
  buildViewNode: (context) => {
    const state = context.state
    return state?.review === undefined ? null : chatNode(context, 'approval-review', state.anchorSeq, state.review)
  },
}

/**
 * Register the public approval review event contribution.
 * @param ctx - owning conversation registry.
 */
export function registerApprovalReviewConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(approvalReviewDefinition)
}
