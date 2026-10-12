/** Aggregate settled attempts without charging fork-inherited history twice. */
import { lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@codexydsh/runtime/types'
import type { ModelUsage, UsageRequest, UsageTotals } from './types.ts'

/** Create independent zero totals.
 * @returns Empty request and token counters.
 */
export function emptyUsage(): UsageTotals {
  return { requests: 0, reportedRequests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

/** Add one immutable Session observation to model counters.
 * @param models - Accumulated routes keyed by their JSON-encoded provider/model pair.
 * @param events - Complete logical log, including inherited header metadata.
 * @param inheritedEventCount - Prefix copied from the parent, excluded from accounting.
 * @param request - Inclusive lower and exclusive upper dispatch-time bounds.
 */
export function collectUsage(models: Map<string, ModelUsage>, events: readonly SessionEvent[],
  inheritedEventCount: SessionLogOffset, request: UsageRequest): void {
  let route: { provider: string; model: string } | undefined
  for (const event of events) {
    if (event.type === 'request/header') route = event.data.header.config
    if (event.type === 'request/context') route = event.data
    if (event.seq < inheritedEventCount || (event.type !== 'assistant/message' && event.type !== 'assistant/attempt')) continue
    // Crash repair can reconstruct content without a settled provider attempt.
    if (event.type === 'assistant/message' && event.data.interrupted === true
      && event.data.stream.length === 0 && event.data.usage === undefined && event.data.requestSentTime === undefined) continue
    const time = event.data.requestSentTime ?? event.time
    if ((request.since !== undefined && time < request.since) || (request.until !== undefined && time >= request.until)) continue
    const source = event.type === 'assistant/message' ? event.data.message.source : route
    const provider = source?.provider ?? null
    const model = source?.model ?? null
    const key = JSON.stringify([provider, model])
    let row = models.get(key)
    if (row === undefined) { row = { provider, model, ...emptyUsage() }; models.set(key, row) }
    row.requests++
    const usage = event.type === 'assistant/message' && event.data.usage !== undefined
      ? event.data.usage : lastAssistantStreamChunk(event.data.stream, 'usage')?.usage
    if (usage === undefined) continue
    row.reportedRequests++
    row.inputTokens += usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
    row.outputTokens += usage.outputTokens
    row.cacheReadTokens += usage.cacheReadTokens ?? 0
    row.cacheWriteTokens += usage.cacheWriteTokens ?? 0
    row.totalTokens = row.inputTokens + row.outputTokens
  }
}

/** Sum disjoint route counters.
 * @param models - Model rows from the same collection.
 * @returns Aggregate request and token counters.
 */
export function totalUsage(models: readonly ModelUsage[]): UsageTotals {
  const totals = emptyUsage()
  for (const row of models) {
    totals.requests += row.requests
    totals.reportedRequests += row.reportedRequests
    totals.inputTokens += row.inputTokens
    totals.outputTokens += row.outputTokens
    totals.totalTokens += row.totalTokens
    totals.cacheReadTokens += row.cacheReadTokens
    totals.cacheWriteTokens += row.cacheWriteTokens
  }
  return totals
}
