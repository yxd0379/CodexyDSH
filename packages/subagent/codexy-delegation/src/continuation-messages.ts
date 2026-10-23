/**
 * Model-visible messages owned by continuable-subagent orchestration.
 *
 * @module @codexydsh/delegation/continuation-messages
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@codexydsh/runtime/llm'
import type { ContentBlock } from '@codexydsh/runtime/llm'
import type { SessionEvent, SessionId, TurnEndReason } from '@codexydsh/runtime/session'
import type { CodexV1Identity } from './projection-types.ts'
import type { ActivationTerminal } from './lifecycle.ts'
import type { SubagentResult } from './types.ts'

/** Durable attribution for one model-authored message between adjacent Agents. */
export interface AgentMessageSource {
  readonly kind: 'agent-message'
  /** A message another agent addressed to this one (`relay` context form). */
  readonly form: 'relay'
  /** Session id of the Agent whose tool call produced the message. */
  readonly senderSessionId: SessionId
  /** This message was accepted without waking the recipient's current turn. */
  readonly queueOnly?: true
}

/**
 * Durable attribution for the runtime's own account of a continuable child
 * settling. Deliberately a different kind from
 * {@link AgentMessageSource}: an Agent message is content the sender chose,
 * while this message is the manager stating what became of the child, and a
 * transcript that merged them would credit the child with words it never wrote.
 */
export interface SubagentSettledMessageSource {
  readonly kind: 'subagent-settled'
  /** A runtime account shown without expanding the row (`notice` context form). */
  readonly form: 'notice'
  /** One-line account of how the child ended. */
  readonly summary: string
  /** Session id of the child that settled. */
  readonly senderSessionId: SessionId
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'agent-message': AgentMessageSource
    'subagent-settled': SubagentSettledMessageSource
  }
}

/**
 * Build durable attribution for one adjacent-Agent message.
 * @param sender - exact live Agent that authored the message.
 * @returns the source preserved in the recipient Session.
 */
export function agentMessageSource(sender: Agent): AgentMessageSource {
  return {
    kind: 'agent-message',
    form: 'relay',
    senderSessionId: sender.id,
  }
}

/**
 * Render Codex v2's inter-agent text inside DSH's durable user-message carrier.
 * @param type - Codex inter-agent message type.
 * @param taskName - canonical recipient path.
 * @param sender - canonical sender path.
 * @param payload - unmodified message body.
 * @returns the pinned Codex message text.
 */
export function codexfulAgentText(
  type: 'NEW_TASK' | 'MESSAGE' | 'FINAL_ANSWER',
  taskName: string,
  sender: string,
  payload: string,
): string {
  return `Message Type: ${type}\nTask name: ${taskName}\nSender: ${sender}\nPayload:\n${payload}`
}

/**
 * Render one Codexful task-tree message while preserving its original Agent source.
 * @param author - exact live Agent whose tool call produced the message.
 * @param taskName - canonical recipient path.
 * @param senderPath - canonical sender path.
 * @param payload - plain-text tool message.
 * @returns the durable recipient message.
 */
export function createCodexfulAgentMessage(
  author: Agent,
  taskName: string,
  senderPath: string,
  payload: string,
): ReturnType<typeof createUserMessage> {
  return createUserMessage({
    content: [{ type: 'text', text: codexfulAgentText('MESSAGE', taskName, senderPath, payload) }],
    source: agentMessageSource(author),
  })
}

/**
 * Recover Codexful v2 identity from child-owned events after a cold resume.
 * @param events - only the child-owned suffix after its inherited fork prefix.
 * @param parentId - recorded direct parent's Session id.
 * @returns canonical child path when its initial task has the recorded Agent source.
 */
export function codexfulTaskPath(events: readonly SessionEvent[], parentId: SessionId): string | undefined {
  const descriptor = events.findLast(event => event.type === 'subagent/descriptor')
  if (descriptor?.type !== 'subagent/descriptor' || descriptor.data.mode !== 'continuable') return undefined
  const path = descriptor.data.label
  if (!/^\/root(?:\/[a-z0-9_]+)+$/.test(path)) return undefined
  const senderPath = path.slice(0, path.lastIndexOf('/'))
  const prefix = codexfulAgentText('NEW_TASK', path, senderPath, '')
  const messages = events.flatMap(event => event.type === 'user/message'
    ? [event.data]
    : event.type === 'agent/inbox/spliced' ? event.data.inserted : [])
  return messages.some(message => message.source.kind === 'agent-message'
    && message.source.senderSessionId === parentId
    && message.content[0]?.type === 'text'
    && message.content[0].text.startsWith(prefix)) ? path : undefined
}

/** Match Codex's 900-token middle truncation for an inter-agent error payload. */
function truncateCodexfulError(error: string): string {
  const maxBytes = 900 * 4
  const originalBytes = Buffer.byteLength(error)
  if (originalBytes <= maxBytes) return error
  const chars = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(error), ({ segment }) => segment)
  let prefix = ''
  let prefixBytes = 0
  for (const char of chars) {
    const size = Buffer.byteLength(char)
    if (prefixBytes + size > maxBytes / 2) break
    prefix += char
    prefixBytes += size
  }
  let suffix = ''
  let suffixBytes = 0
  for (const char of chars.toReversed()) {
    const size = Buffer.byteLength(char)
    if (suffixBytes + size > maxBytes / 2) break
    suffix = char + suffix
    suffixBytes += size
  }
  return `${prefix}…${Math.ceil((originalBytes - maxBytes) / 4)} tokens truncated…${suffix}`
}

/** Codex v2 terminal statuses accepted by its completion formatter. */
export type CodexfulCompletionStatus =
  | { readonly kind: 'completed'; readonly message?: string }
  | { readonly kind: 'errored'; readonly error: string }
  | { readonly kind: 'shutdown' | 'not-found' | 'pending-init' | 'running' | 'interrupted' }

/**
 * Render the pinned Codex completion report for every terminal status.
 * @param parentPath - canonical recipient path.
 * @param childPath - canonical sender path.
 * @param status - Codex status or a nonterminal state that produces no report.
 * @returns the exact text body, or no body for nonterminal statuses.
 */
export function codexfulCompletionText(
  parentPath: string,
  childPath: string,
  status: CodexfulCompletionStatus,
): string | undefined {
  let payload: string
  switch (status.kind) {
    case 'completed':
      payload = status.message ?? ''
      break
    case 'errored':
      payload = `Agent errored: ${truncateCodexfulError(status.error)}\n\nThis agent's turn failed. If you still need this agent, use the available collaboration tools to give it another task.`
      break
    case 'shutdown':
      payload = 'Agent shut down.'
      break
    case 'not-found':
      payload = 'Agent was not found.'
      break
    case 'pending-init':
    case 'running':
    case 'interrupted':
      return undefined
  }
  return codexfulAgentText('FINAL_ANSWER', parentPath, childPath, payload)
}

/**
 * Deliver Codex v2's terminal report for a DSH continuable Activation.
 * @param childId - durable child Session id.
 * @param childPath - canonical child task path.
 * @param terminal - captured Activation outcome.
 * @param events - child-owned Session events carrying any error detail.
 * @returns a durable report, or nothing for an interrupted child.
 */
export function createCodexfulSettlementMessage(
  childId: SessionId,
  childPath: string,
  terminal: ActivationTerminal,
  events: readonly SessionEvent[],
): ReturnType<typeof createUserMessage> | undefined {
  const parentPath = childPath.slice(0, childPath.lastIndexOf('/'))
  const end = events.findLast(event => event.type === 'turn/end')
  const detail = end?.type === 'turn/end' && end.data.reason.kind === 'error'
    ? end.data.reason.error.message
    : terminal.stopReason === 'max-tokens' ? 'maximum output tokens reached'
      : terminal.stopReason === 'refusal' ? 'task was declined'
        : 'subagent activation failed'
  const status: CodexfulCompletionStatus = terminal.stopReason === 'completed'
    ? { kind: 'completed', message: (terminal.output ?? []).flatMap(block =>
      block.type === 'text' ? [block.text] : []).join('') }
    : terminal.stopReason === 'aborted'
      ? { kind: 'interrupted' }
      : { kind: 'errored', error: detail }
  const body = codexfulCompletionText(parentPath, childPath, status)
  if (body === undefined) return undefined
  return createUserMessage({
    content: [{ type: 'text', text: body }],
    source: {
      kind: 'subagent-settled',
      form: 'notice',
      summary: boundContextSummary(body),
      senderSessionId: childId,
    },
  })
}

/**
 * Build the model-visible and durable representation of one adjacent-Agent message.
 * @param sender - exact live Agent that authored the message.
 * @param content - model-visible message blocks supplied by the sender.
 * @returns the durable user-message representation delivered to the recipient.
 */
export function createAgentMessage(
  sender: Agent,
  content: ContentBlock[],
): ReturnType<typeof createUserMessage> {
  return createUserMessage({
    content: [
      { type: 'text' as const, text: `Agent ${sender.id} sent a message: ` },
      ...content,
    ],
    source: agentMessageSource(sender),
  })
}

/**
 * Append adjacent-Agent return guidance to a continuable child's initial task.
 * @param parentId - durable parent session id named in the guidance.
 * @param prompt - initial model-visible task blocks.
 * @returns task blocks followed by the continuable return guidance.
 */
export function withContinuableReturnGuidance(
  parentId: SessionId,
  prompt: ContentBlock[],
): ContentBlock[] {
  const encodedParentId = JSON.stringify(parentId)
  return [
    ...prompt,
    {
      type: 'text',
      text: `Your parent agent id is ${encodedParentId}. Before you finish, send your result to that agent with `
        + `send_message({ agent_id: ${encodedParentId}, message: "<self-contained result>" }). The parent shares `
        + 'your workspace but does not automatically receive your transcript, tool output, or reasoning. Send '
        + 'earlier messages as well when a finding changes what the parent should do next; sending a message '
        + 'does not end your turn.',
    },
  ]
}

/**
 * One line telling a parent that a background child is finished and why, in
 * the parent's own task vocabulary.
 * @param childId - the durable child the parent knows by id.
 * @param stopReason - how the child's last ordinary turn ended.
 * @returns the model-facing opening line of the settlement notice.
 */
function settlementSummary(childId: SessionId, stopReason: SubagentResult['stopReason']): string {
  const subject = `Background subagent ${childId}`
  switch (stopReason) {
    case 'completed':
      return `${subject} finished and will do no further work unless you send it more.`
    case 'aborted':
      return `${subject} was stopped before it finished.`
    case 'max-tokens':
      return `${subject} ran out of room before it finished.`
    // A pre-step rejection — a hook deny, a policy plugin — discarded input
    // the child had claimed, so the parent must not treat the task as done.
    case 'refusal':
      return `${subject} declined the task.`
    case 'error':
      return `${subject} failed before it finished.`
    /* v8 ignore next 4 -- `SubagentResult['stopReason']` is merge-extensible, so this arm
     * needs a backend that adds a variant; an unnameable ending is reported as unfinished
     * rather than silently as success. */
    default:
      return `${subject} ended abnormally (${String(stopReason)}) before it finished.`
  }
}

/**
 * Build the runtime-owned settlement notice from the child's nonempty closing text.
 * @param childId - durable child session id named in the notice.
 * @param terminal - recorded terminal state for the settled Activation.
 * @returns the durable user-message representation delivered to the parent.
 */
export function createSettlementMessage(
  childId: SessionId,
  terminal: ActivationTerminal,
): ReturnType<typeof createUserMessage> {
  const summary = settlementSummary(childId, terminal.stopReason)
  // Parent providers receive this notice as a user message and may reject
  // nontext assistant blocks. Keep this conversion local so SDK/UI consumers
  // retain the complete child output.
  const closingText = (terminal.output ?? []).flatMap(block =>
    block.type === 'text' && block.text.length > 0 ? [block] : [],
  )
  return createUserMessage({
    content: [
      { type: 'text' as const, text: summary },
      ...closingText.length === 0
        ? [{ type: 'text' as const, text: 'It left no closing message.' }]
        : [{ type: 'text' as const, text: 'Its closing message:' }, ...closingText],
    ],
    source: {
      kind: 'subagent-settled' as const,
      form: 'notice' as const,
      summary: boundContextSummary(summary),
      senderSessionId: childId,
    },
  })
}

/**
 * Render Codex v1's terminal notification without starting a parent turn.
 * @param childId - child Session id used when no canonical path is recorded.
 * @param identity - child-owned Codex v1 nickname and optional path.
 * @param reason - actual child turn ending; interruption is not a final status.
 * @param output - final assistant content selected from the child's current turn.
 * @returns the durable notification, or undefined for an interrupted turn.
 */
export function createCodexV1SettlementMessage(
  childId: SessionId,
  identity: CodexV1Identity,
  reason: TurnEndReason,
  output: readonly ContentBlock[] | undefined,
): ReturnType<typeof createUserMessage> | undefined {
  if (reason.kind === 'aborted' || reason.kind === 'interrupted' || reason.kind === 'forked') return undefined
  const text = output?.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
  const status = reason.kind === 'completed'
    ? { completed: text === undefined || text.length === 0 ? null : text }
    : { errored: reason.kind === 'error' ? reason.error.message : `Agent turn ended: ${reason.kind}` }
  return createCodexV1Notification(childId, identity, status)
}

/**
 * Render the first final status of a v1 child closed before completion.
 * @param childId - child Session id used when no canonical path is recorded.
 * @param identity - child-owned Codex v1 name and optional path.
 * @returns the durable shutdown notification for non-waking parent delivery.
 */
export function createCodexV1ShutdownMessage(
  childId: SessionId,
  identity: CodexV1Identity,
): ReturnType<typeof createUserMessage> {
  return createCodexV1Notification(childId, identity, 'shutdown')
}

/** Render one terminal v1 status using Codex's contextual user-fragment format. */
function createCodexV1Notification(
  childId: SessionId,
  identity: CodexV1Identity,
  status: { completed: string | null } | { errored: string } | 'shutdown',
): ReturnType<typeof createUserMessage> {
  const action = status === 'shutdown' ? 'shut down' : 'completed' in status ? 'finished' : 'failed'
  const summary = `Background subagent ${childId} ${action}.`
  return createUserMessage({
    content: [{ type: 'text', text: `<subagent_notification>\n${JSON.stringify({
      agent_path: identity.agentPath ?? childId,
      status,
    })}\n</subagent_notification>` }],
    source: { kind: 'subagent-settled', form: 'notice', summary, senderSessionId: childId },
  })
}
