/** Recent visible exchanges from Codex 8f195c93 tui/src/app/recap_history.rs. */

import type { ContentBlock } from '@codexydsh/runtime/llm'
import type { SessionEvent, SessionSeq } from '@codexydsh/runtime/session'
import { RECAP_HISTORY_MAX_BYTES, recapBytePrefix } from './recap-prompt.ts'

const MAX_ANSWERED_EXCHANGES = 8
const OMITTED_HISTORY = '[Earlier exchanges omitted]\n\n'
const EXCERPT_MARKER = '\n[... excerpted ...]\n'

interface Cell { readonly role: 'user' | 'assistant'; readonly text: string; readonly seq: SessionSeq }
interface Exchange { user: string; assistant: string; seqs: SessionSeq[] }

/** Selected visible conversation and the exact durable messages contributing to it. */
export interface RecapHistory {
  readonly text: string
  readonly sourceEventSeqs: readonly SessionSeq[]
}

function textContent(content: readonly ContentBlock[]): string {
  return content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
}

/** Original explicit input excludes reconstruction copies and generated interruption notices. */
function isOriginalUser(event: Extract<SessionEvent, { type: 'user/message' }>): boolean {
  return event.surfaceOp === 'append' && event.data.source.kind === 'user' && event.sourceEventSeqs === undefined
}

/** Keep the last readable answer in each Turn, excluding tool-bearing progress messages. */
function visibleCells(events: readonly SessionEvent[]): Cell[] {
  const answers = new Map<number, Extract<SessionEvent, { type: 'assistant/message' }>>()
  for (const event of events) {
    if (event.type === 'assistant/message' && event.surfaceOp === 'append'
      && !event.data.message.content.some(block => block.type === 'tool-call')
      && textContent(event.data.message.content) !== '') answers.set(event.data.turn, event)
  }
  const cells: Cell[] = []
  for (const event of events) {
    if (event.type === 'user/message' && isOriginalUser(event)) {
      const text = textContent(event.data.content)
      if (text !== '') cells.push({ role: 'user', text, seq: event.seq })
    } else if (event.type === 'assistant/message' && answers.get(event.data.turn) === event) {
      cells.push({ role: 'assistant', text: textContent(event.data.message.content), seq: event.seq })
    }
  }
  return cells
}

function recentExchanges(cells: readonly Cell[]): Exchange[] {
  const exchanges: Exchange[] = []
  let current: Exchange = { user: '', assistant: '', seqs: [] }
  let answered = 0
  for (const cell of [...cells].reverse()) {
    if (cell.role === 'assistant' && current.user !== '') {
      answered += Number(current.assistant !== '')
      exchanges.push(current)
      current = { user: '', assistant: '', seqs: [] }
      if (answered === MAX_ANSWERED_EXCHANGES) break
    }
    const field = cell.role
    current[field] = cell.text + (current[field] === '' ? '' : '\n\n' + current[field])
    current.seqs.unshift(cell.seq)
  }
  if (current.user !== '') exchanges.push(current)
  return exchanges.reverse()
}

function fields(exchange: Exchange): Array<readonly [string, string]> {
  const result: Array<readonly [string, string]> = []
  if (exchange.user !== '') result.push([exchange.assistant === '' ? 'Pending user request' : 'User', exchange.user])
  if (exchange.assistant !== '') result.push(['Assistant', exchange.assistant])
  return result
}

function excerpt(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text
  const contentBytes = maxBytes - Buffer.byteLength(EXCERPT_MARKER)
  if (contentBytes < 0) return recapBytePrefix(text, maxBytes)
  const bytes = Buffer.from(text)
  const head = recapBytePrefix(text, Math.floor(contentBytes / 2))
  let tailStart = bytes.length - (contentBytes - Math.floor(contentBytes / 2))
  while (tailStart < bytes.length && ((bytes[tailStart] ?? 0) & 0xc0) === 0x80) tailStart++
  return head + EXCERPT_MARKER + bytes.subarray(tailStart).toString('utf8')
}

/**
 * Select eight answered exchanges and a newer pending correction, retaining both excerpt ends.
 * @param events - complete chronological Session observation, including original pre-compaction events.
 * @returns UTF-8-bounded visible history with durable source identities.
 */
export function recapHistory(events: readonly SessionEvent[]): RecapHistory {
  const exchanges = recentExchanges(visibleCells(events))
  const latest = exchanges.at(-1)
  if (latest === undefined) return { text: '', sourceEventSeqs: [] }
  const blocks = exchanges.map(exchange => fields(exchange).map(([label, text]) => `${label}: ${text}`).join('\n\n'))
  let bytes = blocks.reduce((sum, block) => sum + Buffer.byteLength(block), 0) + 2 * (blocks.length - 1)
  if (bytes <= RECAP_HISTORY_MAX_BYTES) return { text: blocks.join('\n\n'), sourceEventSeqs: exchanges.flatMap(exchange => exchange.seqs) }
  const oldestRetained = Math.max(0, exchanges.length - (latest.assistant === '' ? 2 : 1))
  let start = 0
  while (bytes > RECAP_HISTORY_MAX_BYTES - Buffer.byteLength(OMITTED_HISTORY) && start < oldestRetained) {
    bytes -= Buffer.byteLength(blocks[start] ?? '') + 2
    start++
  }
  const omission = start > 0 ? OMITTED_HISTORY : ''
  const budget = RECAP_HISTORY_MAX_BYTES - Buffer.byteLength(omission)
  const sourceEventSeqs = exchanges.slice(start).flatMap(exchange => exchange.seqs)
  if (bytes <= budget) return { text: omission + blocks.slice(start).join('\n\n'), sourceEventSeqs }
  const allFields = exchanges.slice(start).flatMap(fields)
  const overhead = allFields.reduce((sum, [label]) => sum + Buffer.byteLength(label) + 2, 0) + 2 * (allFields.length - 1)
  let remaining = Math.max(0, budget - overhead)
  const text = allFields.map(([label, content], index) => {
    const share = Math.floor(remaining / (allFields.length - index))
    const reserved = allFields.slice(index + 1).reduce((sum, [, later]) => sum + Math.min(Buffer.byteLength(later), share), 0)
    const selected = excerpt(content, remaining - reserved)
    remaining -= Buffer.byteLength(selected)
    return `${label}: ${selected}`
  }).join('\n\n')
  return { text: omission + text, sourceEventSeqs }
}
