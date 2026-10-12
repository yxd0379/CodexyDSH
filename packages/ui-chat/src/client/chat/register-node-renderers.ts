import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { PerformanceUsageMode } from '../../chat-settings.ts'
import type { ChatPresentationPolicy } from '../presentation-policy.ts'
import { NS } from '../locale.ts'
import { AssistantNodeView } from './AssistantNodeView.tsx'
import { CommandNodeView, ManualCompactionNodeView } from './CommandNodeView.tsx'
import {
  CompactionNodeView, ContextMessageNodeView, RetryNodeView, TurnErrorNodeView,
  TurnMaxTokensNodeView, UnknownNodeView, SteeringMessageNodeView, UserMessageNodeView,
} from './MessageItem.tsx'
import { SystemPromptNodeView } from './SystemPromptRow.tsx'
import { TurnProcessNodeView } from './TurnProcessNodeView.tsx'
import { TurnTailNodeView } from './TurnTailNodeView.tsx'
import { TurnTriggerNodeView } from './TurnTriggerNodeView.tsx'
import { ShellCommandCard } from './ShellCommandCard.tsx'
import { RecapCommandCard } from './RecapCommandCard.tsx'
import { RenameCommandCard } from './RenameCommandCard.tsx'
import { ApprovalReviewNodeView } from './ApprovalReviewNodeView.tsx'
import { readCompleteTurn } from './turn-copy.ts'

/**
 * Register this package's business renderers behind the keyed Chat Node seat.
 * Renderers whose output depends on the work-details mode receive the policy
 * through their own registration; the seat and the other renderers do not.
 * @param ctx - owning UI Conversation context.
 * @param performanceUsage - live statistics detail preference.
 * @param presentation - live presentation policy.
 */
export function registerChatNodeRenderers(
  ctx: Context,
  performanceUsage: ObservableSnapshot<PerformanceUsageMode>,
  presentation: ObservableSnapshot<ChatPresentationPolicy>,
): void {
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: 'approval-review', locale: NS,
    children: { 'conversation.approval.review': { kind: 'single', scope: 'session' } },
  }, ApprovalReviewNodeView))
  const userInjection = (sessionId: SessionId) => ({
    hooks: { presentation, performanceUsage },
    readTurnEvents: (turn: number, endSeq?: number) => {
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) return Promise.reject(new Error('Session is unavailable'))
      return readCompleteTurn(binding, turn, endSeq)
    },
  })
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: 'user', locale: NS,
    inject: userInjection,
    children: { 'conversation.chat.turn-actions': { kind: 'list', scope: 'session' } },
  }, UserMessageNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: 'steering', locale: NS,
    inject: userInjection,
  }, SteeringMessageNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'context', locale: NS }, ContextMessageNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'developer', locale: NS }, ContextMessageNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'turn-trigger', locale: NS }, TurnTriggerNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'system-prompt', locale: NS }, SystemPromptNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'assistant-step',
    locale: NS,
    inject: () => ({ hooks: { presentation } }),
  }, AssistantNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'command',
    locale: NS,
    children: { 'conversation.chat.commandview': { kind: 'keyed', scope: 'session' } },
  }, CommandNodeView))
  ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
    name: 'conversation.chat.commandview', key: 'shell', locale: NS,
  }, ShellCommandCard))
  ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
    name: 'conversation.chat.commandview', key: 'recap', locale: NS,
  }, RecapCommandCard))
  ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
    name: 'conversation.chat.commandview', key: 'rename', locale: NS,
  }, RenameCommandCard))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'manual-compaction', locale: NS }, ManualCompactionNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'compaction', locale: NS }, CompactionNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'model-retry', locale: NS }, RetryNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'turn-error', locale: NS }, TurnErrorNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'turn-max-tokens', locale: NS }, TurnMaxTokensNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'turn-process', locale: NS, inject: () => ({ hooks: { presentation } }) }, TurnProcessNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'turn-tail',
    locale: NS,
    inject: () => ({ hooks: { performanceUsage, presentation } }),
    children: {
      'conversation.chat.turnTail': { kind: 'list', scope: 'session' },
      'conversation.chat.assistant-actions': { kind: 'list', scope: 'session' },
    },
  }, TurnTailNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'unknown', locale: NS }, UnknownNodeView))
}
