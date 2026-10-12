/** Independently read and refresh file-only Session history without paging the Conversation window. */
import type { SessionEventSource } from '@codexydsh/ui-conversation/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import { changesHistoryUrl, isChangesHistory, recordedFileDiffs, type SessionChangesHistory } from '../changes.ts'

/** Query state retains the last complete inventory during refresh or a failed refresh. */
export type ChangesHistoryState =
  | { readonly phase: 'loading'; readonly history?: SessionChangesHistory }
  | { readonly phase: 'ready'; readonly history: SessionChangesHistory }
  | { readonly phase: 'error'; readonly history?: SessionChangesHistory }

interface ActiveRead {
  refs: number
  readonly source: SessionEventSource
  unsubscribe: () => void
  generation: AbortController
  pending: Promise<void> | undefined
  targetSeq: number
  replacePending: boolean
}

/** One plugin's full-history cache, refreshed only for changes to retained views. */
export class ChangesHistoryStore {
  /** Complete inventories keyed by logical Session identity. */
  readonly state = createSnapshotStore<Record<string, ChangesHistoryState | undefined>>({})
  private readonly lifetime = new AbortController()
  private readonly active = new Map<SessionId, ActiveRead>()
  private readonly pending = new Set<Promise<void>>()

  /**
   * Observe live change announcements and read the complete inventory for one mounted view.
   * @param sessionId - selected Session.
   * @param source - already retained Session's event feed; no extra Chat history is loaded.
   * @returns the view's release callback, cancelling unused reads and detaching its feed.
   */
  retain(sessionId: SessionId, source: SessionEventSource): () => void {
    if (this.lifetime.signal.aborted) return () => {}
    let entry = this.active.get(sessionId)
    if (entry !== undefined && entry.source !== source) {
      this.detach(entry)
      this.active.delete(sessionId)
      entry = undefined
    }
    if (entry === undefined) {
      entry = { refs: 0, source, unsubscribe: () => {}, generation: new AbortController(), pending: undefined,
        targetSeq: -1, replacePending: false }
      this.active.set(sessionId, entry)
      const current = entry
      entry.unsubscribe = source.subscribe(() => { this.changed(sessionId, current) })
      void this.read(sessionId, entry)
    }
    entry.refs += 1
    const retained = entry
    let released = false
    return () => {
      if (released) return
      released = true
      retained.refs -= 1
      if (retained.refs === 0 && this.active.get(sessionId) === retained) {
        this.detach(retained)
        this.active.delete(sessionId)
      }
    }
  }

  /**
   * Retry a failed query for a view that remains mounted.
   * @param sessionId - selected Session.
   * @returns after its current or newly requested read settles.
   */
  retry(sessionId: SessionId): Promise<void> {
    const entry = this.active.get(sessionId)
    return entry === undefined ? Promise.resolve() : this.read(sessionId, entry)
  }

  /** Clear inventories from the previous Host and refresh retained views with new request generations. */
  reset(): void {
    if (this.lifetime.signal.aborted) return
    this.state.set({})
    for (const [sessionId, entry] of this.active) {
      entry.generation.abort()
      entry.generation = new AbortController()
      entry.pending = undefined
      entry.targetSeq = -1
      entry.replacePending = false
      void this.read(sessionId, entry)
    }
  }

  /** Detach all feeds, cancel reads, and wait until every owned request has settled. */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    for (const entry of this.active.values()) this.detach(entry)
    this.active.clear()
    await Promise.all(this.pending)
  }

  private detach(entry: ActiveRead): void {
    entry.unsubscribe()
    entry.generation.abort()
  }

  private changed(sessionId: SessionId, entry: ActiveRead): void {
    const change = entry.source.getSnapshot().change
    if (change.kind === 'replace') entry.replacePending = true
    else if (change.kind === 'append') {
      for (const item of change.entries) {
        if (item.type !== 'event') continue
        const event = item.event
        if (event.type === 'workspace/changes' || event.type === 'tool/result' && isAppendSurfaceEvent(event)
          && event.data.message.isError !== true && recordedFileDiffs(event.data.meta, event.data.message.source.callId).length > 0) {
          entry.targetSeq = Math.max(entry.targetSeq, event.seq)
        }
      }
    } else return
    const history = this.state.getSnapshot()[sessionId]?.history
    if (entry.replacePending || entry.targetSeq > (history?.throughSeq ?? -1)) void this.read(sessionId, entry)
  }

  private read(sessionId: SessionId, entry: ActiveRead): Promise<void> {
    if (entry.pending !== undefined) return entry.pending
    if (this.lifetime.signal.aborted || entry.generation.signal.aborted) return Promise.resolve()
    const history = this.state.getSnapshot()[sessionId]?.history
    this.state.update((state) => { state[sessionId] = { phase: 'loading', ...history === undefined ? {} : { history } } })
    entry.replacePending = false
    const signal = AbortSignal.any([this.lifetime.signal, entry.generation.signal])
    const task = this.fetch(sessionId, signal).finally(() => {
      this.pending.delete(task)
      if (entry.pending !== task) return
      entry.pending = undefined
      if (signal.aborted || this.active.get(sessionId) !== entry) return
      const state = this.state.getSnapshot()[sessionId]
      if (entry.replacePending || state?.phase === 'ready' && entry.targetSeq > state.history.throughSeq) {
        void this.read(sessionId, entry)
      }
    })
    entry.pending = task
    this.pending.add(task)
    return task
  }

  private async fetch(sessionId: SessionId, signal: AbortSignal): Promise<void> {
    let history: SessionChangesHistory | undefined
    try {
      const response = await fetch(changesHistoryUrl(sessionId), { signal })
      if (response.ok) {
        const value: unknown = await response.json()
        if (isChangesHistory(value)) history = value
      }
    } catch (error: unknown) {
      // Network failures remain retryable in the owning view; aborted generations publish nothing.
      void error
    }
    if (signal.aborted) return
    this.state.update((state) => {
      const previous = state[sessionId]?.history
      state[sessionId] = history === undefined
        ? { phase: 'error', ...previous === undefined ? {} : { history: previous } }
        : { phase: 'ready', history }
    })
  }
}
