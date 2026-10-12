/** Usage query lifetime and range selection owned by the settings feature. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { UsageRequest, UsageSnapshot } from '@codexydsh/api-usage/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

/** Rolling intervals offered by the Usage page. */
export type UsageRange = 'week' | 'month' | 'all'

/** Observable page state; a failed refresh retains the last successful response. */
export interface UsageView {
  readonly range: UsageRange
  readonly snapshot: UsageSnapshot | null
  readonly busy: boolean
  readonly failed: boolean
}

/** Owns one cancellable query and suppresses responses from replaced queries. */
export class UsageController {
  /** Read-only observable consumed through the Slot runtime. */
  readonly state = createSnapshotStore<UsageView>({ range: 'all', snapshot: null, busy: false, failed: false })
  private active: AbortController | undefined

  /**
   * @param read - Captured typed usage namespace query.
   * @param now - Epoch clock used to freeze each rolling interval.
   */
  constructor(private readonly read: (request: UsageRequest, signal: AbortSignal) => Promise<RemoteResult<UsageSnapshot>>,
    private readonly now: () => number = Date.now) {}

  /** Start a fresh observation when the page mounts.
   * @returns Cleanup cancelling the pending query when the page closes.
   */
  readonly observe = (): (() => void) => {
    void this.load()
    return () => { this.cancel() }
  }

  /** Select and query a rolling interval.
   * @param range - New interval; selecting the current one does nothing.
   */
  readonly select = (range: UsageRange): void => {
    if (range === this.state.getSnapshot().range) return
    this.state.set({ range, snapshot: null, busy: false, failed: false })
    void this.load()
  }

  /** Refresh the selected range, retaining existing figures on failure.
   * @returns Settlement after publishing the latest response or query error.
   */
  readonly load = async (): Promise<void> => {
    this.cancel()
    const active = new AbortController()
    this.active = active
    const current = this.state.getSnapshot()
    this.state.set({ ...current, busy: true, failed: false })
    const until = this.now()
    const request: UsageRequest = current.range === 'all' ? {} : {
      since: Math.max(0, until - (current.range === 'week' ? 7 : 30) * 24 * 60 * 60 * 1000), until,
    }
    try {
      const result = await this.read(request, active.signal)
      if (this.active !== active) return
      if (!result.ok) throw new Error(result.error.message)
      this.state.set({ ...current, snapshot: result.value, busy: false, failed: false })
    } catch {
      if (this.active === active) this.state.set({ ...current, busy: false, failed: true })
    } finally {
      if (this.active === active) this.active = undefined
    }
  }

  /** Stop the active read; late results cannot publish into the next observation. */
  cancel(): void {
    this.active?.abort()
    this.active = undefined
  }
}
