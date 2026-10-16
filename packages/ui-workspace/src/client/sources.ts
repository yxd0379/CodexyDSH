/** Workspace browser projection. Host controllers remain the owners of their data. */
import { Service, type Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState, SessionSearchResultItem } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot, WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { StartSessionOptions } from './navigation.ts'

/** Each location contributes existing model observables and narrow user actions. */
export interface WorkspaceBrowserSource {
  readonly label: string
  readonly workspaces: HostObservable<WorkspaceSnapshot>
  readonly sessions: HostObservable<SessionListState>
  readonly statuses: HostObservable<SessionStatusSnapshot>
  readonly active: HostObservable<boolean>
  prepareWorkspace?(): void
  availability?(): { state: 'connecting' | 'offline'; label: string } | undefined
  open(id: SessionId): void
  start(workspaceId?: WorkspaceId, options?: StartSessionOptions): void
  renameWorkspace(id: WorkspaceId, title: string): Promise<void>
  removeWorkspace(id: WorkspaceId): Promise<void>
  reorderWorkspace(id: WorkspaceId, before?: WorkspaceId): Promise<void>
  renameSession(id: SessionId, title: string): Promise<void>
  forkSession(id: SessionId, onCreated?: (id: SessionId) => void, options?: { allowMigration?: boolean }): Promise<SessionId>
  archiveSession(id: SessionId, options?: { readonly stopActivity?: boolean }): Promise<void>
  unarchiveSession(id: SessionId): Promise<void>
  pinSession(id: SessionId): Promise<void>
  unpinSession(id: SessionId): Promise<void>
  search(query: string, signal: AbortSignal): Promise<{ items: readonly SessionSearchResultItem[]; hasMore: boolean }>
}

declare module '@deepseek-ai/cordis' {
  interface Context { workspaceBrowser: WorkspaceBrowserSources }
}

/** IDs are presentation identities only; original IDs are sent to their owning Host. */
function browserId<T extends string>(source: string, id: T): T {
  return (source === '' ? id : `remote:${JSON.stringify([source, id])}`) as T
}

export class WorkspaceBrowserSources extends Service {
  readonly workspaces = createSnapshotStore<WorkspaceSnapshot>({ items: [], archivedSessionIds: [], pinnedSessionIds: [], phase: 'pending', state: 'loading', error: null })
  readonly sessions = createSnapshotStore<SessionListState>({ ids: [], byId: {}, projectionsBySession: {}, phase: 'pending' })
  readonly statuses = createSnapshotStore<SessionStatusSnapshot>(new Map())
  readonly active = createSnapshotStore(false)
  private readonly sources = new Map<string, WorkspaceBrowserSource>()
  private readonly sessionOwners = new Map<SessionId, { source: WorkspaceBrowserSource; key: string; id: SessionId }>()
  private readonly workspaceOwners = new Map<WorkspaceId, { source: WorkspaceBrowserSource; key: string; id: WorkspaceId }>()

  constructor(ctx: Context) { super(ctx, 'workspaceBrowser') }

  register(key: string, source: WorkspaceBrowserSource): () => void {
    if (this.sources.has(key)) throw new Error(`Workspace location already registered: ${key}`)
    this.sources.set(key, source)
    const stops = [source.workspaces, source.sessions, source.statuses, source.active].map(value => value.subscribe(() => { this.publish() }))
    this.publish()
    return () => {
      for (const stop of stops) stop()
      this.sources.delete(key)
      this.publish()
    }
  }

  private publish(): void {
    const local = this.sources.get('')
    const base = local?.workspaces.getSnapshot()
    const items: WorkspaceSnapshot['items'][number][] = []
    const archivedSessionIds: SessionId[] = [], pinnedSessionIds: SessionId[] = []
    const ids: SessionId[] = [], byId: SessionListState['byId'] = {}, projectionsBySession: Record<SessionId, SessionListState['projectionsBySession'][SessionId]> = {}
    const statuses = new Map<SessionId, SessionStatusSnapshot extends ReadonlyMap<SessionId, infer S> ? S : never>()
    this.sessionOwners.clear()
    this.workspaceOwners.clear()
    let active = false
    for (const [key, source] of this.sources) {
      const selected = source.active.getSnapshot()
      active ||= selected
      const workspace = source.workspaces.getSnapshot(), sessions = source.sessions.getSnapshot()
      for (const row of workspace.items) {
        const id = browserId(key, row.workspaceId)
        this.workspaceOwners.set(id, { source, key, id: row.workspaceId })
        items.push({ ...row, workspaceId: id, sessionIds: row.sessionIds.map(id => browserId(key, id)) })
      }
      archivedSessionIds.push(...workspace.archivedSessionIds.map(id => browserId(key, id)))
      pinnedSessionIds.push(...workspace.pinnedSessionIds.map(id => browserId(key, id)))
      ids.push(...sessions.ids.map(id => browserId(key, id)))
      for (const row of Object.values(sessions.byId)) {
        const id = browserId(key, row.id)
        this.sessionOwners.set(id, { source, key, id: row.id })
        byId[id] = { ...row, id, ...(row.parentId ? { parentId: browserId(key, row.parentId) } : {}),
          retainedBy: selected ? row.retainedBy : { ...row.retainedBy, mainView: 0 } }
      }
      for (const [id, value] of Object.entries(sessions.projectionsBySession)) projectionsBySession[browserId(key, id as SessionId)] = value
      for (const [id, status] of source.statuses.getSnapshot()) statuses.set(browserId(key, id), status)
    }
    this.workspaces.set({ items, archivedSessionIds, pinnedSessionIds, phase: base?.phase ?? 'pending', state: base?.state ?? 'loading', error: base?.error ?? null })
    this.sessions.set({ ids, byId, projectionsBySession, phase: local?.sessions.getSnapshot().phase ?? 'pending' })
    this.statuses.set(statuses)
    this.active.set(active)
  }

  location(id: WorkspaceId): string | undefined { return this.workspaceOwners.get(id)?.source.label || undefined }
  availability(id: WorkspaceId) { return this.workspaceOwners.get(id)?.source.availability?.() }
  prepareWorkspace(id: WorkspaceId): void { this.workspace(id).source.prepareWorkspace?.() }
  session(id: SessionId) {
    const owner = this.sessionOwners.get(id)
    if (!owner) throw new Error('Session is no longer available')
    return owner
  }
  workspace(id: WorkspaceId) {
    const owner = this.workspaceOwners.get(id)
    if (!owner) throw new Error('Workspace is no longer available')
    return owner
  }
  open(id: SessionId): void { const target = this.session(id); target.source.open(target.id) }
  start(id?: WorkspaceId, options?: StartSessionOptions): void {
    if (id !== undefined) { const target = this.workspace(id); target.source.start(target.id, options); return }
    const source = [...this.sources.values()].find(source => source.active.getSnapshot()) ?? this.sources.get('')
    source?.start(undefined, options)
  }
  async renameSession(id: SessionId, title: string): Promise<void> { const target = this.session(id); await target.source.renameSession(target.id, title) }
  async forkSession(id: SessionId, onCreated?: (id: SessionId) => void, options?: { allowMigration?: boolean }): Promise<SessionId> {
    const target = this.session(id)
    const result = await target.source.forkSession(target.id, child => { onCreated?.(browserId(target.key, child)) }, options)
    return browserId(target.key, result)
  }
  async archiveSession(id: SessionId, options?: { readonly stopActivity?: boolean }): Promise<void> { const target = this.session(id); await target.source.archiveSession(target.id, options) }
  async unarchiveSession(id: SessionId): Promise<void> { const target = this.session(id); await target.source.unarchiveSession(target.id) }
  async pinSession(id: SessionId): Promise<void> { const target = this.session(id); await target.source.pinSession(target.id) }
  async unpinSession(id: SessionId): Promise<void> { const target = this.session(id); await target.source.unpinSession(target.id) }
  async renameWorkspace(id: WorkspaceId, title: string): Promise<void> { const target = this.workspace(id); await target.source.renameWorkspace(target.id, title) }
  async removeWorkspace(id: WorkspaceId): Promise<void> { const target = this.workspace(id); await target.source.removeWorkspace(target.id) }
  async reorderWorkspace(id: WorkspaceId, before?: WorkspaceId): Promise<void> {
    const target = this.workspace(id), anchor = before === undefined ? undefined : this.workspace(before)
    await target.source.reorderWorkspace(target.id, anchor?.source === target.source ? anchor.id : undefined)
  }
  async search(query: string, signal: AbortSignal): Promise<{ items: readonly SessionSearchResultItem[]; hasMore: boolean }> {
    const results = await Promise.all([...this.sources].map(async ([key, source]) => {
      const result = await source.search(query, signal)
      return { ...result, items: result.items.map(item => ({ ...item, sessionId: browserId(key, item.sessionId) })) }
    }))
    return { items: results.flatMap(result => result.items), hasMore: results.some(result => result.hasMore) }
  }
}
