/** Fold only durable file changes from an immutable complete Session observation. */
import type { SessionEvent } from '@codexydsh/runtime/types'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import { recordedFileDiffs, type RecordedFileDiff, type SessionChangesHistory } from './changes.ts'

/**
 * Preserve genuine summary coordinates and successful original file edits across all Turns.
 * @param events - complete observed Session events, including inherited history.
 * @param throughSeq - observation's last durable sequence, or -1 for an empty log.
 * @returns file-only history; model prompts and ordinary tool results are omitted.
 */
export function collectChangesHistory(events: readonly SessionEvent[], throughSeq: number): SessionChangesHistory {
  const turns = new Map<number, { turn: number; changes?: { seq: number }; diffs?: RecordedFileDiff[] }>()
  for (const event of events) {
    if (event.type === 'workspace/changes') {
      const { turn } = event.data
      const current = turns.get(turn) ?? { turn }
      current.changes = { seq: event.seq }
      turns.set(turn, current)
    } else if (event.type === 'tool/result' && isAppendSurfaceEvent(event) && event.data.message.isError !== true) {
      const diffs = recordedFileDiffs(event.data.meta, event.data.message.source.callId)
      if (diffs.length === 0) continue
      const { turn } = event.data
      const current = turns.get(turn) ?? { turn }
      current.diffs ??= []
      current.diffs.push(...diffs)
      turns.set(turn, current)
    }
  }
  return { throughSeq, turns: [...turns.values()].sort((a, b) => a.turn - b.turn) }
}
