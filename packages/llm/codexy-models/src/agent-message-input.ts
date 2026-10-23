/** Codexful inter-agent messages in an OpenAI Responses request. */

import { LlmError } from '@codexydsh/runtime/llm'
import type { RequestMessage } from '@codexydsh/runtime/llm'
import { responseItemIdBase } from './response-item-id.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

function isTaskPath(value: string): boolean {
  if (value === '/root') return true
  if (!value.startsWith('/root/')) return false
  return value.slice('/root/'.length).split('/')
    .every(segment => segment !== 'root' && /^[a-z0-9_]+$/.test(segment))
}

function envelope(message: RequestMessage): { author: string; recipient: string; text: string } | undefined {
  if (message.role !== 'user') return
  const kind: string | undefined = message.source?.kind
  if (kind !== 'agent-message' && kind !== 'subagent-settled') return
  const block = message.content[0]
  if (message.content.length !== 1 || block?.type !== 'text') return
  const text = block.text
  const match = /^Message Type: (NEW_TASK|MESSAGE|FINAL_ANSWER)\nTask name: ([^\n]+)\nSender: ([^\n]+)\nPayload:\n[\s\S]*$/.exec(text)
  if (match === null) return
  const [, type, recipient, author] = match
  if (kind === 'subagent-settled' ? type !== 'FINAL_ANSWER' : type === 'FINAL_ANSWER') {
    throw new LlmError('Codexful inter-agent message type does not match its durable source', 'UNSUPPORTED_CONTENT')
  }
  if (author === undefined || recipient === undefined) return
  if (!isTaskPath(author) || !isTaskPath(recipient)) {
    throw new LlmError('Codexful inter-agent message has a noncanonical task path', 'UNSUPPORTED_CONTENT')
  }
  return { author, recipient, text }
}

/**
 * Replace Codexful agent envelopes with the pinned CLI's `agent_message` input items.
 * Ordinary DSH agent notices and providers without Codexful Responses keep their roles.
 * @param payload - detached Responses payload after instruction grouping.
 * @param messages - Session-derived request history with durable message identities.
 * @returns payload whose inter-agent items retain their original order.
 */
export function codexfulAgentMessageInput(
  payload: Record<string, unknown>,
  messages: readonly RequestMessage[],
): Record<string, unknown> {
  if (!isUnknownArray(payload['input'])) {
    throw new LlmError('Codexful Responses request omitted input items', 'UNSUPPORTED_CONTENT')
  }
  const input = [...payload['input']]
  for (const message of messages) {
    const agent = envelope(message)
    if (agent === undefined) continue
    if (message.id === undefined) {
      throw new LlmError('Codexful inter-agent message needs a durable identity', 'UNSUPPORTED_CONTENT')
    }
    const id = `msg_${responseItemIdBase(message.id)}`
    const index = input.findIndex(item => isRecord(item) && item['id'] === id)
    const item = input[index]
    if (!isRecord(item) || item['type'] !== 'message' || item['role'] !== 'user'
      || !isUnknownArray(item['content']) || item['content'].length !== 1) {
      throw new LlmError('Codexful Responses lost an inter-agent user item', 'UNSUPPORTED_CONTENT')
    }
    const block = item['content'][0]
    if (!isRecord(block) || block['type'] !== 'input_text' || block['text'] !== agent.text) {
      throw new LlmError('Codexful Responses changed inter-agent message text', 'UNSUPPORTED_CONTENT')
    }
    input[index] = {
      type: 'agent_message',
      author: agent.author,
      recipient: agent.recipient,
      content: [{ type: 'input_text', text: agent.text }],
    }
  }
  return { ...payload, input }
}
