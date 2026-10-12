/** Chat adapter for the automatic-review card and exact-action approval command. */
import type {} from '@codexydsh/ui-approval/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatNodeViewProps } from '../contract/slots.ts'

type ApprovalReviewNodeViewProps = ChatNodeViewProps<'approval-review'> & PropsRenderSlots<'conversation.approval.review'>

/**
 * Hand the public recorded verdict to the approval feature's Session-scoped seat.
 * @param props - review node and child-slot renderer.
 * @returns the feature-owned review notice.
 */
export function ApprovalReviewNodeView({ node, renderSlot }: ApprovalReviewNodeViewProps) {
  return <>{renderSlot('conversation.approval.review', { review: node.data })}</>
}
