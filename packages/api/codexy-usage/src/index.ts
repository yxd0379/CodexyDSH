import { projectProductEvent } from '@codexydsh/runtime/events'
/** Authenticated, read-only usage queries over the active profile's Session corpus. */
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-query'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { collectUsage, totalUsage } from './aggregate.ts'
import type { ModelUsage, UsageRequest, UsageSnapshot } from './types.ts'

export type * from './types.ts'

/** Usage Remote namespace; no independent persistence or billing state. */
export class UsageController extends TypertRemoteService {
  static inject = ['sessionQuery']

  /** @param ctx - Host with the active profile's logical Session corpus. */
  constructor(ctx: Context) { super(ctx, 'usageController', { namespace: 'usage' }) }

  /** Collect usage across retained Sessions without making cold Sessions live.
   * @param request - Optional dispatch-time interval, with an exclusive upper bound.
   * @param signal - Cancels listing and Session reads.
   * @returns Complete model and aggregate counters; rejects on any unreadable Session.
   */
  @Remote
  async snapshot(request: UsageRequest, signal: AbortSignal): Promise<UsageSnapshot> {
    for (const value of [request.since, request.until]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
        throw new RemoteError('gateway/bad-request', 'Usage time bounds must be non-negative integer milliseconds', {})
      }
    }
    if (request.since !== undefined && request.until !== undefined && request.since >= request.until) {
      throw new RemoteError('gateway/bad-request', 'Usage since must be earlier than until', {})
    }
    const models = new Map<string, ModelUsage>()
    const sessions = await this.ctx.sessionQuery.listSessions(signal)
    for (const session of sessions) {
      signal.throwIfAborted()
      using observation = await this.ctx.sessionQuery.observeSession(session.header.id, { signal, projectionMode: 'none' })
      collectUsage(models, observation.events.map(projectProductEvent), observation.inheritedEventCount, request)
    }
    const rows = [...models.values()].sort((left, right) => right.totalTokens - left.totalTokens
      || right.requests - left.requests
      || JSON.stringify([left.provider, left.model]).localeCompare(JSON.stringify([right.provider, right.model])))
    return { capturedAt: Date.now(), totals: totalUsage(rows), models: rows }
  }
}

export default UsageController
