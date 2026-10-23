/** Native OpenAI Responses developer-history transport through pi-ai's pre-send payload hook. */
import { randomBytes } from 'node:crypto'
import { LlmError } from '@codexydsh/runtime/llm'
import type { RequestMessage } from '@codexydsh/runtime/llm'
import { responseItemIdBase } from './response-item-id.ts'

interface DeveloperReplacement {
  readonly marker: string
  readonly texts: readonly string[]
  readonly itemIdBase: string
}

/** Conversion input and the exact developer messages the payload hook must restore. */
export interface DeveloperHistoryPreparation {
  readonly messages: RequestMessage[]
  readonly replacements: readonly DeveloperReplacement[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Substitute private markers only when the bound route can emit native developer input.
 * Markers never enter Session and fail closed if they collide with existing text.
 * @param messages - durable request history in provider order.
 * @param native - whether this exact route supports developer-role Responses input.
 * @returns pi-ai-compatible history and replacements for the pre-send payload hook.
 */
export function prepareDeveloperHistory(
  messages: readonly RequestMessage[],
  native: boolean,
): DeveloperHistoryPreparation {
  const developer = messages.filter(message => message.role === 'developer')
  if (developer.length === 0) return { messages: [...messages], replacements: [] }
  if (!native) throw new LlmError('This provider route cannot send developer-role history', 'UNSUPPORTED_CONTENT')
  const nonce = randomBytes(32).toString('hex')
  const replacements: DeveloperReplacement[] = []
  const prepared = messages.map((message): RequestMessage => {
    if (message.role !== 'developer') return message
    if (message.content.some(block => block.type !== 'text')) {
      throw new LlmError('OpenAI Responses developer history supports text only', 'UNSUPPORTED_CONTENT')
    }
    const marker = `__dsh_developer_${nonce}_${replacements.length}__`
    if (messages.some(entry => entry.content.some(block => block.type === 'text' && block.text.includes(marker)))) {
      throw new LlmError('Developer payload marker collided with request history', 'INVALID_REQUEST')
    }
    replacements.push({
      marker,
      texts: message.content.flatMap(block => block.type === 'text' ? [block.text] : []),
      itemIdBase: responseItemIdBase(message.id),
    })
    return { role: 'user', content: [{ type: 'text', text: marker }] }
  })
  return { messages: prepared, replacements }
}

/**
 * Replace every internal marker with a native developer message before network I/O.
 * Each logged text block remains a separate input_text content block in its original order.
 * @param payload - pi-ai's assembled OpenAI Responses request body.
 * @param replacements - markers generated from the same immutable request history.
 * @param codexfulItemIds - include the durable developer message ID on Codexful Responses input.
 * @returns a detached request body with ordered developer roles and no marker text.
 */
export function restoreDeveloperInput(
  payload: unknown,
  replacements: readonly DeveloperReplacement[],
  codexfulItemIds = false,
): Record<string, unknown> {
  if (!isRecord(payload) || !Array.isArray(payload['input'])) {
    throw new LlmError('pi-ai produced an invalid OpenAI Responses request body', 'UNSUPPORTED_CONTENT')
  }
  const observed: string[] = []
  const input = payload['input'].map((item: unknown): unknown => {
    const serialized = JSON.stringify(item)
    const matches = replacements.filter(entry => serialized.includes(entry.marker))
    if (matches.length === 0) return item
    const replacement = matches[0]
    if (matches.length !== 1 || replacement === undefined
      || !isRecord(item) || item['role'] !== 'user'
      || Object.keys(item).some(key => key !== 'role' && key !== 'content')
      || !Array.isArray(item['content']) || item['content'].length !== 1
      || !isRecord(item['content'][0]) || item['content'][0]['type'] !== 'input_text'
      || item['content'][0]['text'] !== replacement.marker) {
      throw new LlmError('pi-ai changed a developer payload marker before serialization', 'UNSUPPORTED_CONTENT')
    }
    observed.push(replacement.marker)
    return codexfulItemIds
      ? {
        type: 'message', id: `msg_${replacement.itemIdBase}`, role: 'developer',
        content: replacement.texts.map(text => ({ type: 'input_text', text })),
      }
      : {
        type: 'message', role: 'developer',
        content: replacement.texts.map(text => ({ type: 'input_text', text })),
      }
  })
  const request = { ...payload, input }
  if (observed.length !== replacements.length
    || observed.some((marker, index) => marker !== replacements[index]?.marker)
    || replacements.some(entry => JSON.stringify(request).includes(entry.marker))) {
    throw new LlmError('pi-ai did not preserve developer message count and order', 'UNSUPPORTED_CONTENT')
  }
  return request
}
