/** Turn text exports derived from durable content and visible activity summaries. */
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import { productEventSource } from '@codexydsh/ui-conversation/client'
import type { SessionEventLikeEntry } from '@codexydsh/ui-conversation/client'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { assembleAssistantStream } from '@deepseek-ai/dsh-llm/assistant-stream'
import type { ChatSnapshot } from '../contract/snapshot.ts'
import type { ChatNode } from '../contract/chat-nodes.ts'
import type { ChatViewSlotProps } from '../contract/slots.ts'

/** One compact activity title captured from its rendered tool header. */
export interface TurnToolSummary {
  readonly callId: string
  readonly text: string
}

/**
 * Read a Turn after loading its start, keeping the selected end fixed while history loads.
 * @param binding - current materialized Session generation.
 * @param turn - owning Turn number.
 * @param endSeq - completed Turn boundary, or omitted for content recorded at invocation.
 * @returns complete durable Turn interval.
 */
export async function readCompleteTurn(
  binding: Pick<SessionBinding, 'eventSource'> & { readonly session: Pick<SessionBinding['session'], 'loadOlder'> },
  turn: number,
  endSeq?: number,
): Promise<readonly SessionEventLikeEntry[]> {
  let window = productEventSource(binding.eventSource).getSnapshot()
  const recordedEnd = endSeq ?? window.entries.find(entry => entry.event.type === 'turn/end'
    && entry.event.data.turn === turn)?.event.seq ?? window.entries.findLast(entry => entry.type === 'event')?.event.seq
  let start = window.entries.find(entry => entry.event.type === 'turn/start' && entry.event.data.turn === turn)
  while (start === undefined && window.hasMore) {
    const revision = window.revision
    await binding.session.loadOlder()
    window = productEventSource(binding.eventSource).getSnapshot()
    if (window.revision === revision) throw new Error('Turn history did not load')
    start = window.entries.find(entry => entry.event.type === 'turn/start' && entry.event.data.turn === turn)
  }
  const end = endSeq === undefined ? undefined : window.entries.find(entry => entry.event.seq === endSeq
    && entry.event.type === 'turn/end' && entry.event.data.turn === turn)
  if (start === undefined || recordedEnd === undefined || (endSeq !== undefined && end === undefined)) {
    throw new Error('Complete Turn history is unavailable')
  }
  const followingTurn = window.entries.find(entry => entry.event.type === 'turn/start'
    && entry.event.seq > start.event.seq && entry.event.seq <= recordedEnd)
  const upperSeq = followingTurn === undefined ? recordedEnd : followingTurn.event.seq - 1
  if (upperSeq < start.event.seq) throw new Error('Complete Turn history is unavailable')
  return window.entries.filter(entry => entry.type === 'event'
    && entry.event.seq >= start.event.seq && entry.event.seq <= upperSeq)
}

/**
 * Capture only displayed tool headers, independent of output disclosures and Turn folding.
 * @param root - the Chat content column containing the action.
 * @param snapshot - currently materialized Chat nodes.
 * @param turn - owning Turn.
 * @returns tool call identities with the same brief titles shown by the UI.
 */
export function renderedTurnToolSummaries(root: Element, snapshot: Pick<ChatSnapshot, 'nodes'>, turn: number): TurnToolSummary[] {
  const summaries: TurnToolSummary[] = []
  for (const row of root.querySelectorAll('[data-chat-flow-kind="tool-call"]')) {
    const key = row.getAttribute('data-chat-node-key')
    const node = key === null ? undefined : snapshot.nodes.get(key) as ChatNode | undefined
    if (node?.kind !== 'tool-call' || (node.location.kind !== 'turn' && node.location.kind !== 'step')
      || node.location.turn.turn !== turn) continue
    const header = row.querySelector('[data-codex-shell] > button, [data-disclosure-row]')
    if (header === null) continue
    const copy = header.cloneNode(true)
    if (!(copy instanceof Element)) continue
    for (const hidden of copy.querySelectorAll('[aria-hidden="true"], [role="status"]')) hidden.remove()
    const text = copy.textContent.replace(/\s+/g, ' ').trim()
    if (text !== '') summaries.push({ callId: node.data.root.callId, text })
  }
  return summaries
}

function contentText(content: readonly ContentBlock[], reasoning: boolean): string {
  return content.map((block) => {
    switch (block.type) {
      case 'text': return block.text
      case 'reasoning': return reasoning ? block.text : ''
      case 'image':
      case 'file': return JSON.stringify(block.attachment)
      case 'tool-call': return '' // Calls are exported at their durable dispatch position.
      default: return JSON.stringify(block) // Merge-extensible content keeps unfamiliar recorded blocks.
    }
  }).filter(text => text !== '').join('\n\n')
}

function shortArguments(raw: string): string {
  let value: unknown
  try { value = JSON.parse(raw) } catch (_error: unknown) { return raw.split('\n')[0] ?? '' }
  if (value === null || typeof value !== 'object') return raw
  for (const key of ['cmd', 'chars', 'path', 'file_path', 'pattern', 'query', 'target', 'message']) {
    const detail: unknown = Reflect.get(value, key)
    if (typeof detail === 'string') return detail.split('\n')[0] ?? ''
  }
  return ''
}

/**
 * Serialize questions, assistant progress/reasoning, tool activity, and answers in recorded order.
 * @param entries - complete durable Turn interval.
 * @param mode - full tool feedback or UI-like concise activity.
 * @param summaries - displayed tool headers, when present in the current Chat window.
 * @param t - Chat translator.
 * @returns copyable plain Markdown, with no preview truncation in full mode.
 */
export function turnCopyText(
  entries: readonly SessionEventLikeEntry[], mode: 'full' | 'brief',
  summaries: readonly TurnToolSummary[], t: ChatViewSlotProps['t'],
): string {
  const output: string[] = []
  const seenCalls = new Set<string>()
  const tools = new Map<string, string>()
  const summaryByCall = new Map(summaries.map(summary => [summary.callId, summary.text]))
  const compactSummaries = new Set(entries.filter(entry => entry.event.type === 'compaction/summary').map(entry => entry.event.seq))
  for (const entry of entries) {
    const event = entry.event
    if (entry.type !== 'event') continue
    switch (event.type) {
      case 'user/message': {
        if (event.surfaceOp !== 'append' || event.data.source.kind !== 'user'
          || event.sourceEventSeqs?.some(seq => compactSummaries.has(seq)) === true) break
        const text = contentText(event.data.content, false)
        if (text !== '') output.push(`## ${t('message.turnCopy.question')}\n\n${text}`)
        break
      }
      case 'assistant/message':
      case 'assistant/attempt': {
        const blocks = event.type === 'assistant/attempt' || event.data.interrupted === true && event.data.stream.length > 0
          ? assembleAssistantStream(event.data.stream).interruptedBlocks() : event.data.message.content
        for (const block of blocks) {
          if (block.type !== 'text' && block.type !== 'reasoning') continue
          const label = t(block.type === 'reasoning' ? 'message.turnCopy.reasoning' : 'message.turnCopy.assistant')
          const text = mode === 'brief' && block.type === 'reasoning'
            ? block.text.replace(/\s+/g, ' ').trim().slice(0, 180) + (block.text.length > 180 ? '…' : '')
            : block.text
          if (text.trim() !== '') output.push(`## ${label}\n\n${text}`)
        }
        break
      }
      case 'tool/call': {
        if (seenCalls.has(event.data.callId)) break
        seenCalls.add(event.data.callId)
        tools.set(event.data.callId, event.data.name)
        if (mode === 'brief') {
          output.push(summaryByCall.get(event.data.callId)
            ?? `${t('message.stepProcess.done.tools')} ${event.data.name} ${shortArguments(event.data.arguments)}`.trimEnd())
        } else output.push(`## ${t('message.turnCopy.tool')}: ${event.data.name}\n\n${t('message.turnCopy.arguments')}:\n${event.data.arguments}`)
        break
      }
      case 'tool/result':
      case 'tool/notification': {
        if (mode !== 'full') break
        const name = tools.get(event.data.message.toolCallId) ?? event.data.message.toolCallId
        const text = event.type === 'tool/notification' && event.data.originalText !== undefined
          ? event.data.originalText : contentText(event.data.message.content, true)
        output.push(`### ${t('message.turnCopy.output')}: ${name}\n\n${text}`)
        break
      }
      default: break // Turn exports omit request headers, policy injections, and log-only lifecycle events.
    }
  }
  return output.join('\n\n')
}
