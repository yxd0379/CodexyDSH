/** Session-owned dialog state; failed requests never replace an unsaved draft. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { MemoryList, MemoryRead, MemoryRefreshResult, MemorySearch, MemorySnapshot } from '@codexydsh/api-memory/types'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@codexydsh/api-memory/remote'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

/** Only the memory namespace methods called by this dialog. */
export type MemoryRemote = Pick<ClientRemote['memory'], 'snapshot' | 'list' | 'read' | 'search' | 'edit' | 'refresh'>
/** One user-visible request failure or local editing condition. */
export interface MemoryViewError {
  readonly kind: 'conflict' | 'truncated' | 'requestFailed' | 'unsaved' | 'savedReadFailed'
  readonly details?: string
}
/** Detached browser view of public memory files and the retained document draft. */
export interface MemoryView {
  readonly open: boolean
  readonly busy: 'load' | 'read' | 'search' | 'save' | 'refresh' | null
  readonly status: MemorySnapshot | null
  readonly listing: MemoryList | null
  readonly search: MemorySearch | null
  readonly query: string
  readonly document: MemoryRead | null
  readonly draft: string
  readonly editing: boolean
  readonly error: MemoryViewError | null
  /** Status observation failure; manual Reload retries without discarding the editor. */
  readonly statusError: string | null
}

class MemoryRequestError extends Error {
  constructor(readonly failure: RemoteFailure) { super(failure.message) }
}

function result<Value>(response: RemoteResult<Value>): Value {
  if (!response.ok) throw new MemoryRequestError(response.error)
  return response.value
}

/** Whether this complete read can enter the human editor.
 * @param document - The currently displayed bounded read.
 * @returns True only for complete managed summary or index documents.
 */
export function editableMemory(document: MemoryRead | null): boolean {
  return document !== null && !document.truncated && document.start_line_number === 1
    && (document.path === 'memory_summary.md' || document.path === 'MEMORY.md')
}

/** Human dialog lifecycle and compare-and-swap submission for one retained Session. */
export class MemoryViewController {
  /** Bare observable consumed through the Slot runtime's generated hooks. */
  readonly state = createSnapshotStore<MemoryView>({
    open: false, busy: null, status: null, listing: null, search: null, query: '',
    document: null, draft: '', editing: false, error: null, statusError: null,
  })
  private active: AbortController | undefined
  private disposed = false
  private observers = 0
  private statusTimer: ReturnType<typeof setTimeout> | undefined
  private statusRequest: AbortController | undefined
  private statusPaused = false

  /**
   * @param remote - Captured typed memory namespace.
   * @param sessionId - Exact Session that owns reads, edits, and refresh audits.
   * @param notify - App overlay notification, retained when the dialog closes.
   * @param statusPollMs - Current validated delay between settled background-status reads.
   */
  constructor(private readonly remote: MemoryRemote, private readonly sessionId: SessionId,
    private readonly notify: (outcome: 'saved' | MemoryRefreshResult) => void,
    private readonly statusPollMs: () => number) {}

  /** Open the retained draft and lazily load public memory status and entries. */
  open(): void {
    if (this.disposed) return
    this.statusPaused = false
    this.patch({ open: true })
    if (this.state.getSnapshot().status === null) void this.load()
  }
  /** Hide the dialog while retaining its draft and any active operation. */
  close(): void { this.patch({ open: false }) }
  /** Observe status only while this open dialog is mounted.
   * @returns Disposer that stops observation when the dialog closes or changes Sessions.
   */
  observe(): () => void {
    this.observers++
    this.scheduleStatusPolling()
    let live = true
    return () => {
      if (!live) return
      live = false
      this.observers--
      this.scheduleStatusPolling()
    }
  }
  /** Apply a changed polling interval without retaining an idle Session. */
  restartStatusPolling(): void {
    this.cancelStatusPolling()
    this.statusPaused = false
    this.scheduleStatusPolling()
  }
  /** Update the search input without launching a request.
   * @param query - Literal substring to search.
   */
  setQuery(query: string): void {
    if (this.state.getSnapshot().query !== query) this.patch({ query, search: null })
  }
  /** Update an admitted complete-document draft.
   * @param draft - Complete replacement text.
   */
  setDraft(draft: string): void {
    if (this.state.getSnapshot().editing && this.active === undefined) this.patch({ draft })
  }
  /** Enter the complete managed-document editor. */
  beginEdit(): void {
    if (editableMemory(this.state.getSnapshot().document) && this.active === undefined) this.patch({ editing: true, error: null })
  }
  /** Restore the last read content and leave editing without changing a Host file. */
  discard(): void {
    if (this.active === undefined) this.patch({ draft: this.state.getSnapshot().document?.content ?? '', editing: false, error: null })
  }
  /** Read status and the current directory while preserving a retained draft.
   * @returns Settlement of the bounded reload.
   */
  load(): Promise<void> {
    this.statusPaused = false
    return this.run('load', async (signal) => {
      const selected = this.state.getSnapshot().document
      const [status, listing] = await Promise.all([
        this.remote.snapshot(this.sessionId, signal),
        this.remote.list(this.sessionId, { path: this.state.getSnapshot().listing?.path ?? '' }, signal),
      ])
      const document = selected !== null && !this.state.getSnapshot().editing
        ? result(await this.remote.read(this.sessionId, { path: selected.path }, signal)) : null
      this.patch({ status: result(status), listing: result(listing), statusError: null,
        ...(document === null ? {} : { document, draft: document.content }) })
    })
  }
  /** Browse a directory, optionally appending its next page.
   * @param path - Public relative directory.
   * @param cursor - Provider-owned cursor for the displayed directory.
   * @returns Settlement; an unsaved editor keeps its document visible.
   */
  list(path: string, cursor?: string): Promise<void> {
    return this.run('load', async (signal) => {
      const listing = result(await this.remote.list(this.sessionId, { path, ...(cursor === undefined ? {} : { cursor }) }, signal))
      const previous = this.state.getSnapshot().listing
      this.patch({ listing: cursor === undefined || previous === null ? listing : { ...listing, entries: [...previous.entries, ...listing.entries] }, search: null })
    })
  }
  /** Read one document, refusing navigation away from an unsaved editor.
   * @param path - Public relative document.
   * @returns Settlement with the prior draft preserved on failure.
   */
  read(path: string): Promise<void> {
    if (!this.allowNavigation()) return Promise.resolve()
    return this.run('read', async (signal) => {
      const document = result(await this.remote.read(this.sessionId, { path }, signal))
      this.patch({ document, draft: document.content, editing: false })
    })
  }
  /** Search the literal query, optionally appending the next page.
   * @param cursor - Provider-owned cursor for the current query.
   * @returns Settlement of the bounded substring search.
   */
  search(cursor?: string): Promise<void> {
    const query = this.state.getSnapshot().query.trim()
    if (query === '') { this.patch({ search: null }); return Promise.resolve() }
    return this.run('search', async (signal) => {
      const search = result(await this.remote.search(this.sessionId, { queries: [query], ...(cursor === undefined ? {} : { cursor }) }, signal))
      const previous = this.state.getSnapshot().search
      this.patch({ search: cursor === undefined || previous === null ? search : { ...search, matches: [...previous.matches, ...search.matches] } })
    })
  }
  /** Save only the complete admitted read revision; conflicts retain the editor.
   * @returns Settlement without replacing the draft on failure.
   */
  save(): Promise<void> {
    const view = this.state.getSnapshot()
    if (!view.editing || !editableMemory(view.document) || view.document === null) return Promise.resolve()
    const document = view.document
    const draft = view.draft
    return this.run('save', async (signal) => {
      const revision = result(await this.remote.edit(this.sessionId, { path: document.path, content: draft, expectedRevision: document.revision }, signal))
      try {
        const stored = result(await this.remote.read(this.sessionId, { path: document.path }, signal))
        this.patch({ document: stored, draft: stored.content, editing: false })
      } catch (error) {
        this.patch({ document: { ...document, revision }, draft, editing: true,
          error: { kind: 'savedReadFailed', details: error instanceof Error ? error.message : String(error) } })
      }
      this.notify('saved')
    })
  }
  /** Refresh through the current Session model and reload the selected document.
   * @returns Generation and read settlement; failed requests retain the displayed document.
   */
  refresh(): Promise<void> {
    if (!this.allowNavigation()) return Promise.resolve()
    const selected = this.state.getSnapshot().document
    return this.run('refresh', async (signal) => {
      const refreshed = result(await this.remote.refresh(this.sessionId, signal))
      const status = result(await this.remote.snapshot(this.sessionId, signal))
      const listing = result(await this.remote.list(this.sessionId, { path: '' }, signal))
      const document = selected === null ? null : result(await this.remote.read(this.sessionId, { path: selected.path }, signal))
      this.patch({ status, listing, search: null,
        ...(document === null ? {} : { document, draft: document.content, editing: false }) })
      this.notify(refreshed)
    })
  }
  /** Cancel this surface's requests when its owning plugin unloads. */
  dispose(): void {
    this.disposed = true
    this.cancelStatusPolling()
    this.active?.abort(new Error('Memory dialog disposed'))
  }

  private allowNavigation(): boolean {
    const view = this.state.getSnapshot()
    if (!view.editing || view.document?.content === view.draft) return true
    this.patch({ error: { kind: 'unsaved' } })
    return false
  }
  private patch(patch: Partial<MemoryView>): void {
    if (!this.disposed) {
      this.state.set({ ...this.state.getSnapshot(), ...patch })
      this.scheduleStatusPolling()
    }
  }
  private cancelStatusPolling(): void {
    this.clearStatusTimer()
    this.statusRequest?.abort(new Error('Memory status observation stopped'))
  }
  private clearStatusTimer(): void {
    if (this.statusTimer !== undefined) { clearTimeout(this.statusTimer); this.statusTimer = undefined }
  }
  private scheduleStatusPolling(): void {
    const view = this.state.getSnapshot()
    if (this.disposed || this.observers === 0 || !view.open || this.active !== undefined) {
      this.cancelStatusPolling()
      return
    }
    if (view.status?.running !== true || this.statusPaused) { this.clearStatusTimer(); return }
    if (this.statusTimer !== undefined || this.statusRequest !== undefined) return
    this.statusTimer = setTimeout(() => {
      this.statusTimer = undefined
      void this.pollStatus()
    }, this.statusPollMs())
  }
  private async pollStatus(): Promise<void> {
    const request = new AbortController()
    this.statusRequest = request
    const previous = this.state.getSnapshot().status
    try {
      const status = result(await this.remote.snapshot(this.sessionId, request.signal))
      request.signal.throwIfAborted()
      // Session update events precede the provider releasing its global generation lock;
      // only the status read confirms completion. Its remaining reads share cancellation.
      this.patch({ status, statusError: null })
      const view = this.state.getSnapshot()
      if (!status.running && !view.editing && (previous?.revision !== status.revision || previous?.summary !== status.summary)) {
        const listing = view.listing === null ? null : result(await this.remote.list(this.sessionId, { path: view.listing.path ?? '' }, request.signal))
        const document = view.document === null ? null : result(await this.remote.read(this.sessionId, { path: view.document.path }, request.signal))
        request.signal.throwIfAborted()
        if (!this.state.getSnapshot().editing) this.patch({ ...(listing === null ? {} : { listing }),
          ...(document === null ? {} : { document, draft: document.content }) })
      }
    } catch (error) {
      if (!request.signal.aborted && !this.disposed) {
        this.statusPaused = true
        this.patch({ statusError: error instanceof Error ? error.message : String(error) })
      }
    } finally {
      if (this.statusRequest === request) this.statusRequest = undefined
      this.scheduleStatusPolling()
    }
  }
  private async run(busy: NonNullable<MemoryView['busy']>, execute: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.disposed || this.active !== undefined) return
    const active = new AbortController()
    this.active = active
    this.patch({ busy, error: null })
    try {
      await execute(active.signal)
    } catch (error) {
      if (!this.disposed) {
        const code = error instanceof MemoryRequestError ? error.failure.code : undefined
        this.patch({ error: { kind: code === 'memory/conflict' ? 'conflict' : code === 'memory/truncated' ? 'truncated' : 'requestFailed',
          details: error instanceof Error ? error.message : String(error) } })
      }
    } finally {
      if (this.active === active) { this.active = undefined; this.patch({ busy: null }) }
    }
  }
}
