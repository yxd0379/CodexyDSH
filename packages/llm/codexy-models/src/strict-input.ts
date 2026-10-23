/** Pinned Codex Responses input grouping and assistant text serialization. */

import { LlmError, type RequestMessage } from '@codexydsh/runtime/llm'
import { responseItemIdBase } from './response-item-id.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

type ContextGroup = 'mergeable' | 'standalone'

interface GroupedContextItem {
  readonly start: number
  length: number
  readonly role: RequestMessage['role']
  readonly item: Record<string, unknown>
  readonly blocks: Record<string, unknown>[]
}

function contextGroup(message: RequestMessage): ContextGroup | undefined {
  if (message.role !== 'user' && message.role !== 'developer') return
  const source: unknown = message.source
  if (!isRecord(source)) return
  if (source['kind'] === 'agent-instructions') return message.role === 'user' ? 'mergeable' : undefined
  if (source['kind'] !== 'runtime-context') return
  const worldState = source['codexMultiAgentWorldState'] ?? source['codexWorldState']
  if (isRecord(worldState)) {
    switch (worldState['section']) {
      case 'multi-agent-role': return 'standalone'
      case 'multi-agent-mode': return worldState['mode'] === 'delta' ? 'mergeable' : 'standalone'
      case 'permissions': return message.role === 'developer' ? 'mergeable' : undefined
      case 'environment': return message.role === 'user' ? 'mergeable' : undefined
      default: return
    }
  }
  // Compaction retains developer context sections while storing them as
  // instructions; restoring their role must retain the same grouping policy.
  if ((source['form'] !== 'snapshot'
    && !(message.role === 'developer' && source['form'] === 'instructions'))
    || !isUnknownArray(source['sections'])) return
  const names = source['sections'].flatMap(section => isRecord(section) && typeof section['name'] === 'string'
    ? [section['name']] : [])
  if (names.includes('codexful-v2:multi-agent-role') || names.includes('codexful-v2:multi-agent-mode')) {
    return 'standalone'
  }
  if (message.role === 'developer') return 'mergeable'
  return names.includes('codexful:environment') ? 'mergeable' : undefined
}

function wireItem(
  input: readonly unknown[],
  message: RequestMessage,
): { index: number; item: Record<string, unknown>; blocks: Record<string, unknown>[] } {
  if (message.id === undefined) {
    throw new LlmError('Codexful strict input requires durable instruction and environment message IDs', 'UNSUPPORTED_CONTENT')
  }
  const id = `msg_${responseItemIdBase(message.id)}`
  const index = input.findIndex(item => isRecord(item) && item['id'] === id)
  const item = input[index]
  if (!isRecord(item) || item['type'] !== 'message' || item['role'] !== message.role
    || !isUnknownArray(item['content']) || item['content'].length !== message.content.length) {
    throw new LlmError('Codexful strict input lost an instruction or environment Responses item', 'UNSUPPORTED_CONTENT')
  }
  const blocks: Record<string, unknown>[] = []
  for (let index = 0; index < message.content.length; index++) {
    const original = message.content[index]
    const block = item['content'][index]
    if (original?.type !== 'text' || !isRecord(block) || block['type'] !== 'input_text' || block['text'] !== original.text) {
      throw new LlmError('Codexful strict input changed an instruction or environment text block', 'UNSUPPORTED_CONTENT')
    }
    blocks.push(block)
  }
  return { index, item, blocks }
}

/**
 * Group adjacent context items and serialize historical assistant text as Codex Responses input.
 * Only mergeable fragments of the same role share an item; roles and initial modes stay separate.
 * The logged messages and their IDs determine the grouping on every retry.
 * @param payload - Codexful Responses payload with stable Session-derived item IDs.
 * @param messages - frozen request history derived from the same Session log.
 * @returns a detached payload with grouped context and Codex-compatible assistant text items.
 */
export function groupStrictCodexfulInput(
  payload: Record<string, unknown>,
  messages: readonly RequestMessage[],
): Record<string, unknown> {
  if (!isUnknownArray(payload['input'])) {
    throw new LlmError('Codexful strict input requires Responses input items', 'UNSUPPORTED_CONTENT')
  }
  const input = [...payload['input']]
  const groups: GroupedContextItem[] = []
  let previous: GroupedContextItem | undefined
  for (const message of messages) {
    const group = contextGroup(message)
    if (group === undefined || group === 'standalone') {
      previous = undefined
      continue
    }
    const current = wireItem(input, message)
    if (previous?.role === message.role) {
      if (current.index !== previous.start + previous.length) {
        throw new LlmError('Codexful strict input separated adjacent mergeable context items', 'UNSUPPORTED_CONTENT')
      }
      previous.length++
      previous.blocks.push(...current.blocks)
    } else {
      previous = { start: current.index, length: 1, role: message.role, item: current.item, blocks: [...current.blocks] }
      groups.push(previous)
    }
  }
  for (const group of groups.toReversed()) {
    if (group.length > 1) input.splice(group.start, group.length, { ...group.item, content: group.blocks })
  }
  return {
    ...payload,
    input: input.map((item) => {
      if (!isRecord(item) || item['type'] !== 'message' || item['role'] !== 'assistant'
        || !isUnknownArray(item['content'])) return item
      return {
        ...item,
        content: item['content'].map(block => isRecord(block) && block['type'] === 'output_text'
          && typeof block['text'] === 'string'
          ? { type: 'output_text', text: block['text'] }
          : block),
      }
    }),
  }
}
