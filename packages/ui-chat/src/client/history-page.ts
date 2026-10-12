/** Product paging preferences over the upstream Session's public history operations. */
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'

/** A history source and loader sharing one exact Session generation. */
export type HistoryBinding = Pick<SessionBinding, 'session' | 'eventSource'>

const pending = new WeakMap<HistoryBinding, Promise<void>>()

/**
 * Prepend upstream pages until the requested number of older messages is visible.
 * Stops on exhaustion or lack of progress, including a softly reported read failure.
 * @param binding - Exact retained browser Session.
 * @param minimumMessages - Product page preference, bounded to 500 messages.
 * @returns Completion of the shared paging operation for this generation.
 */
export function loadHistoryPage(binding: HistoryBinding, minimumMessages: number): Promise<void> {
  const current = pending.get(binding)
  if (current !== undefined) return current
  const operation = load(binding, Math.max(1, Math.min(500, minimumMessages)))
  pending.set(binding, operation)
  const settle = (): void => { if (pending.get(binding) === operation) pending.delete(binding) }
  void operation.then(settle, settle)
  return operation
}

async function load(binding: HistoryBinding, minimum: number): Promise<void> {
  const beginning = binding.eventSource.getSnapshot().entries[0]?.event.seq ?? Infinity
  while (binding.session.getSnapshot().hasMore) {
    const before = binding.eventSource.getSnapshot().entries[0]?.event.seq
    await binding.session.loadOlder()
    const entries = binding.eventSource.getSnapshot().entries
    const after = entries[0]?.event.seq
    if (before === after || after === undefined) return
    const count = entries.filter(entry => entry.type === 'event' && entry.event.seq < beginning
      && (entry.event.type === 'user/message' || entry.event.type === 'assistant/message')).length
    if (count >= minimum) return
  }
}
