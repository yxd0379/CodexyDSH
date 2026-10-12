/** Select memory-relevant Session evidence without reasoning or private auxiliary calls. */

import type { ContentBlock } from '@codexydsh/runtime/llm'
import type { SessionEvent } from '@codexydsh/runtime/session'
import { boundedText, redactSecrets } from './text.ts'

/** One framed evidence row with source identity, chronology, and selection priority. */
export interface EvidenceRow {
  readonly seq: number
  readonly time: number
  readonly priority: number
  readonly text: string
}

/** Sanitize model-visible text; media and private reasoning remain absent. */
function contentText(content: readonly ContentBlock[]): string {
  return content.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text).join('\n')
}

/** Extract human, assistant, and tool evidence from a complete stored Session.
 * @param events - Validated chronological source events.
 * @returns Redacted rows; background memory/reviewer requests never become evidence.
 */
export function evidenceRows(events: readonly SessionEvent[]): readonly EvidenceRow[] {
  const rows: EvidenceRow[] = []
  for (const event of events) {
    let value: object | undefined
    let priority = 4
    switch (event.type) {
      case 'user/message': {
        const kind: string = event.data.source.kind
        if (kind === 'codexful-memory' || kind === 'runtime-context' || kind === 'model-selection') break
        priority = kind === 'user' ? 0 : kind === 'agent-message' ? 2 : 4
        value = { role: kind === 'user' ? 'human' : 'context', source: kind, content: boundedText(contentText(event.data.content), 10_000).text }
        break
      }
      case 'assistant/message': {
        priority = 1
        const content = contentText(event.data.message.content)
        if (content !== '') value = { role: 'assistant', interrupted: event.data.interrupted === true, content: boundedText(content, 10_000).text }
        break
      }
      case 'tool/call':
        priority = 5
        value = { role: 'tool-call', name: event.data.name, call_id: event.data.callId, arguments: boundedText(event.data.arguments, 10_000).text }
        break
      case 'tool/result':
        priority = 5
        value = { role: 'tool-result', call_id: event.data.message.source.callId, is_error: event.data.message.isError === true, content: boundedText(contentText(event.data.message.content), 8_000).text }
        break
      case 'turn/end':
        priority = 3
        value = { role: 'turn-state', turn: event.data.turn, reason: event.data.reason }
        break
      default:
        // SessionEventMap is merge-extensible; log-only and private events supply no extraction evidence.
        break
    }
    if (value !== undefined) rows.push({ seq: event.seq, time: event.time, priority, text: redactSecrets(JSON.stringify({ seq: event.seq, time: event.time, ...value })) })
  }
  return rows
}

/** Select recent rows by human/final/tool priority, then restore original chronology.
 * @param rows - Sanitized source rows.
 * @param maxBytes - Complete UTF-8 evidence allowance.
 * @returns JSONL evidence with an explicit omission marker; no row is cut into invalid JSON.
 */
export function selectEvidence(rows: readonly EvidenceRow[], maxBytes: number): string {
  const omission = '[... response items omitted ...]\n'
  let bytes = Buffer.byteLength(omission)
  const selected: EvidenceRow[] = []
  for (const row of [...rows].sort((a, b) => a.priority - b.priority || b.seq - a.seq)) {
    const size = Buffer.byteLength(row.text) + 1
    if (bytes + size > maxBytes) continue
    bytes += size
    selected.push(row)
  }
  if (!selected.some(row => row.priority === 0)) throw new Error('memory input budget cannot retain a human message')
  const ordered = selected.sort((a, b) => a.seq - b.seq)
  return (selected.length < rows.length ? omission : '') + ordered.map(row => row.text).join('\n')
}
