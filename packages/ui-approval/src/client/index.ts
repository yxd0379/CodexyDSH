/** Browser approval consumer over the existing scoped Remote Event waterfall. */
import type {} from '@codexydsh/approval/types'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ApprovalRequestId } from '@codexydsh/approval/types'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { ComposerChainProps } from '@codexydsh/ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PendingInteractionPublisher } from '@deepseek-ai/dsh-client-ui-session/client'
import type { TypertClientEventListener } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { ApprovalPanel } from './ApprovalPanel.tsx'
import { ApprovalReviewCard } from './ApprovalReviewCard.tsx'
import { PendingApproval } from './contract/slots.ts'
import { en, zh } from './locales.ts'

export type { ApprovalReviewCardProps, ApprovalReviewPresentation } from './ApprovalReviewCard.tsx'

export type {
  ApprovalComposerProps,
  ApprovalDecision,
  ApprovalDetailOwnerProps,
  ApprovalPresentationRequest,
  ApprovalReviewOwnerProps,
  PendingApproval,
} from './contract/slots.ts'
export type { ApprovalKey } from './locales.ts'

/** Required services: Agent scopes, Remote Events, Session UI, Slot registry, and copy. */
export const inject = ['sessions', 'remote', 'uiSession', 'slots', 'locale']

const NS = 'approval'

type ApprovalListener = TypertClientEventListener<'codexy-approval/request'>
type ClientApprovalRequest = Parameters<ApprovalListener>[0]
type ClientApprovalNext = Parameters<ApprovalListener>[1]
type ClientApprovalOutcome = Awaited<ReturnType<ApprovalListener>>

/* jscpd:ignore-start -- Approval and Question intentionally mirror one Remote waterfall lifecycle. */
/** Present one request until the user answers or its lifetime ends. */
async function answerApproval(
  ctx: ClientContext,
  owner: ClientContext,
  request: ClientApprovalRequest,
  next: ClientApprovalNext,
  registerPendingInteraction: PendingInteractionPublisher<PendingApproval>,
): Promise<ClientApprovalOutcome> {
  const sessionId = ctx.sessions.scopeOf(owner)
  if (sessionId === undefined) return next()
  const pending = new PendingApproval(sessionId, {
    toolName: request.toolName,
    ...(request.callId === undefined
      ? {}
      : { callId: request.callId }),
    ...(request.reason === undefined ? {} : { reason: request.reason }),
    ...(request.allowForSession === undefined ? {} : { allowForSession: request.allowForSession }),
    ...(request.prefixRule === undefined ? {} : { prefixRule: request.prefixRule }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  })
  const completed = Promise.withResolvers<void>()
  const remove = registerPendingInteraction(pending, async () => {
    pending.delegate()
    await completed.promise
  })
  try {
    try {
      return await pending.result
    } catch (error) {
      if (pending.isDelegation(error)) return await next()
      throw error
    }
  } finally {
    remove()
    completed.resolve()
  }
}
/* jscpd:ignore-end */

/**
 * Install approval copy and the scoped waterfall consumer.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-approval: dictionaries')
  const registerPendingInteraction = ctx.uiSession.registerPendingInteraction<PendingApproval>(
    () => 0,
  )
  ctx.slots.inject('conversation.composer', () => ctx.slots.register({
    name: 'conversation.composer',
    priority: 1,
    select: ({ pendingInteraction }: ComposerChainProps): PendingApproval | null =>
      pendingInteraction instanceof PendingApproval ? pendingInteraction : null,
    locale: NS,
    children: {
      'conversation.approval.detail': { kind: 'single', scope: 'session' },
    },
  }, ApprovalPanel))
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('conversation.approval.review', () => ctx.slots.register({
    name: 'conversation.approval.review', locale: NS,
    inject: sessionId => ({ approve: async (id: ApprovalRequestId) => {
      const session = ctx.sessions.binding(sessionId)?.session
      if (session === undefined) throw new Error(t('review.sessionUnavailable'))
      const result = await session.command(`/approve ${id}`)
      if (!result.ok) throw new Error(result.error.message)
      if (!result.value.matched) throw new Error(t('review.unavailable'))
    } }),
  }, ApprovalReviewCard))
  ctx.remote.$on('codexy-approval/request', function (request, next) {
    return answerApproval(ctx, this, request, next, registerPendingInteraction)
  })
}
