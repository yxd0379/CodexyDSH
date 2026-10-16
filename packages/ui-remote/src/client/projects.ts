/** Native remote Client trees and their projection into the shared workspace list. */
import type { Plugin } from '@deepseek-ai/cordis'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ClientModuleLoader } from '@deepseek-ai/dsh-client-modules/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DirectoryListing } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { IRemoteHosts, RemoteHostsSnapshot } from '@codexydsh/remote/client'
import { RemoteClientRuntime, type RemoteRuntimeState } from './runtime.tsx'

export const REMOTE_PANEL = 'codexy.remote.projects'

export interface RemoteSession { id: string; title: string; running: boolean; pinned?: boolean; archived?: boolean; updatedAt?: number; blank?: boolean }
export interface RemoteProject { id: string; title: string; path: string; sessions: RemoteSession[]; createdAt?: string; updatedAt?: string }
export type RemoteCommand = { action: 'openSession' | 'openWorkspace' | 'newSession' | 'removeWorkspace' | 'archiveSession' | 'unarchiveSession' | 'pinSession' | 'unpinSession' | 'forkSession'; id: string }
  | { action: 'renameWorkspace' | 'renameSession'; id: string; title: string } | { action: 'createWorkspace'; path: string }
export interface RemoteRuntimeEntry extends RemoteRuntimeState { name: string; url: string; runtime: RemoteClientRuntime }
export interface RemoteProjectsSnapshot { runtimes: RemoteRuntimeEntry[]; active: string | null }
/** Durable navigation identity. Connection addresses and credentials never belong here. */
export interface RemoteWorkspaceRef { host: string; workspaceId: string; title: string; path: string }
/** One workspace in the parent browser, independent of the host connection tree. */
export interface RemoteWorkspaceItem extends RemoteWorkspaceRef {
  key: string; sessions: RemoteSession[]; currentSession: string | null
  connected: boolean; ready: boolean; error: string | null
  createdAt?: string; updatedAt?: string
}
export type RemoteWorkspaceStorage = Pick<Storage, 'getItem' | 'setItem'>
export const REMOTE_WORKSPACES_KEY = 'codexy.remote.workspaces.v1'

/** Tuple encoding keeps host/workspace identities distinct even when either contains separators. */
export function workspaceKey(host: string, workspaceId: string): string { return JSON.stringify([host, workspaceId]) }

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function label(value: unknown): value is string { return typeof value === 'string' && value.length <= 16_384 }
function identity(value: unknown): value is string { return label(value) && value.length > 0 }

/** Copy the non-secret persisted vocabulary rather than trusting browser storage. */
export function parseWorkspaceRefs(value: unknown): RemoteWorkspaceRef[] {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.workspaces) || value.workspaces.length > 10_000) return []
  const refs = new Map<string, RemoteWorkspaceRef>()
  for (const item of value.workspaces) {
    if (!record(item) || !identity(item.host) || !identity(item.workspaceId) || !label(item.title) || !label(item.path)) continue
    refs.set(workspaceKey(item.host, item.workspaceId), { host: item.host, workspaceId: item.workspaceId, title: item.title, path: item.path })
  }
  return [...refs.values()]
}

function remoteAddress(address: string): URL {
  const url = new URL(address, window.location.href)
  const sameOriginProxy = url.origin === window.location.origin && url.pathname.startsWith('/codexy-remote/')
  const loopback = ['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (!sameOriginProxy && !loopback) throw new Error('Remote address must use the local SSH proxy or a loopback HTTP origin')
  return url
}

/** Own one ordinary Loader-composed Client tree per connected SSH host. */
export class RemoteProjects {
  readonly state: SnapshotStore<RemoteProjectsSnapshot> = createSnapshotStore({ runtimes: [], active: null })
  readonly workspaces: SnapshotStore<RemoteWorkspaceItem[]> = createSnapshotStore([])
  private readonly pending = new Map<string, AbortController>()
  private readonly connectionRequests = new Map<string, Promise<boolean>>()
  private readonly subscriptions = new Map<string, (() => void)[]>()
  private readonly refs = new Map<string, RemoteWorkspaceRef>()
  private readonly workspaceErrors = new Map<string, string>()
  private disposed = false

  constructor(
    private readonly hosts: IRemoteHosts,
    private readonly modules: ClientModuleLoader,
    private readonly LoaderPlugin: Plugin,
    private readonly selectPanel: () => void,
    private readonly returnLocal: () => void = () => {},
    private readonly storage?: RemoteWorkspaceStorage,
  ) {
    try {
      const raw = storage?.getItem(REMOTE_WORKSPACES_KEY)
      if (raw) for (const ref of parseWorkspaceRefs(JSON.parse(raw))) this.refs.set(workspaceKey(ref.host, ref.workspaceId), ref)
    } catch { /* Storage denial or corrupt data does not prevent navigation. */ }
    this.refreshWorkspaces()
  }

  async connect(name: string, activate = true): Promise<boolean> {
    if (this.disposed) return false
    this.pending.get(name)?.abort()
    const controller = new AbortController()
    this.pending.set(name, controller)
    try {
      const status = await this.hosts.connect(name, controller.signal)
      if (controller.signal.aborted || this.disposed || this.pending.get(name) !== controller) return false
      if (!status.url) throw new Error('The remote connection did not provide an address')
      this.workspaceErrors.delete(name)
      const runtime = this.attach(name, status.url)
      await runtime.start()
      if (controller.signal.aborted || this.disposed) return false
      if (activate) this.activate(name)
      return true
    } catch (error) {
      this.workspaceErrors.set(name, error instanceof Error ? error.message : String(error))
      this.refreshWorkspaces()
      throw error
    } finally {
      if (this.pending.get(name) === controller) this.pending.delete(name)
    }
  }

  attach(name: string, address: string): RemoteClientRuntime {
    const current = this.entry(name)
    if (current?.url === address && current.phase !== 'failed' && current.phase !== 'closed') return current.runtime
    if (current) this.removeRuntime(name, false)
    const runtime = new RemoteClientRuntime(name, remoteAddress(address), this.modules, this.LoaderPlugin)
    const entry: RemoteRuntimeEntry = { name, url: address, runtime, ...runtime.state.getSnapshot() }
    this.state.set({ ...this.state.getSnapshot(), runtimes: [...this.state.getSnapshot().runtimes, entry] })
    const stateStop = runtime.state.subscribe(() => {
      const state = runtime.state.getSnapshot()
      this.patch(name, state)
      if (state.phase === 'ready') this.watchCatalog(name, runtime)
      this.refreshWorkspaces()
    })
    this.subscriptions.set(name, [stateStop])
    void runtime.start().catch(error => {
      this.workspaceErrors.set(name, error instanceof Error ? error.message : String(error))
      this.refreshWorkspaces()
    })
    return runtime
  }

  reconcile(snapshot: RemoteHostsSnapshot): void {
    if (!snapshot.items) return
    for (const item of snapshot.items) if (item.phase === 'connected' && item.url) this.attach(item.name, item.url)
    const connected = new Set(snapshot.items.filter(item => item.phase === 'connected' && item.url).map(item => item.name))
    for (const entry of this.state.getSnapshot().runtimes) if (!connected.has(entry.name)) this.remove(entry.name)
  }

  activate(name: string): void {
    if (!this.entry(name)) return
    this.state.set({ ...this.state.getSnapshot(), active: name })
    this.selectPanel()
  }

  async restart(name: string): Promise<void> {
    const entry = this.entry(name)
    if (!entry) { await this.connect(name); return }
    const address = entry.url
    this.removeRuntime(name, false)
    const runtime = this.attach(name, address)
    await runtime.start()
    this.activate(name)
  }

  async openWorkspace(ref: RemoteWorkspaceRef): Promise<void> { await this.request(ref.host, { action: 'openWorkspace', id: ref.workspaceId }) }
  async openSession(ref: RemoteWorkspaceRef, id: string): Promise<void> { await this.request(ref.host, { action: 'openSession', id }) }
  async newSession(ref: RemoteWorkspaceRef): Promise<void> { await this.request(ref.host, { action: 'newSession', id: ref.workspaceId }) }

  async request(name: string, command: RemoteCommand): Promise<RemoteProject | undefined> {
    const runtime = await this.ensureReady(name)
    if (command.action !== 'createWorkspace') this.activate(name)
    const ctx = runtime.ctx
    let result: RemoteProject | undefined
    if (command.action === 'createWorkspace') {
      if (!/^(?:\/|[A-Za-z]:[\\/])/.test(command.path)) throw new Error('A remote workspace requires an absolute directory path')
      const project = await ctx.workspaces.create({ path: command.path })
      result = { id: project.workspaceId, title: project.title, path: project.path, sessions: [] }
    } else if (command.action === 'openSession') {
      const id = command.id as SessionId
      const session = ctx.sessions.list.getSnapshot().byId[id]
      if (!session || ctx.workspaces.list.getSnapshot().archivedSessionIds.includes(id)) throw new Error('The remote session is no longer available')
      ctx.uiWorkspace.openSession(id)
    } else if (command.action === 'renameWorkspace' || command.action === 'removeWorkspace') {
      const workspace = ctx.workspaces.list.getSnapshot().items.find(item => item.workspaceId === command.id)
      if (!workspace) throw new Error('The remote workspace is no longer available')
      if (command.action === 'renameWorkspace') await ctx.workspaces.rename(workspace.workspaceId, command.title)
      else await ctx.workspaces.delete(workspace.workspaceId)
    } else if (command.action === 'renameSession' || command.action === 'archiveSession' || command.action === 'unarchiveSession'
      || command.action === 'pinSession' || command.action === 'unpinSession' || command.action === 'forkSession') {
      const id = command.id as SessionId
      if (!ctx.sessions.list.getSnapshot().byId[id]) throw new Error('The remote session is no longer available')
      if (command.action === 'renameSession') {
        const reply = await ctx.sessions.using(id, { source: 'workspaceOperation' }, reference => reference.binding.session.rename(command.title))
        if (!reply.ok) throw new Error(reply.error.message)
      } else if (command.action === 'archiveSession') await ctx.uiWorkspace.archiveSession(id)
      else if (command.action === 'unarchiveSession') await ctx.uiWorkspace.unarchiveSession(id)
      else if (command.action === 'pinSession') await ctx.uiWorkspace.pinSession(id)
      else if (command.action === 'unpinSession') await ctx.uiWorkspace.unpinSession(id)
      else await ctx.uiWorkspace.forkSession(id)
    } else {
      const workspace = ctx.workspaces.list.getSnapshot().items.find(item => item.workspaceId === command.id)
      if (!workspace) throw new Error('The remote workspace is no longer available')
      if (command.action === 'newSession') ctx.uiWorkspace.startSession(workspace.workspaceId as WorkspaceId)
      else await ctx.uiWorkspace.openWorkspace(workspace.workspaceId)
    }
    this.refreshWorkspaces()
    return result
  }

  async createWorkspace(name: string, path: string, signal?: AbortSignal): Promise<RemoteWorkspaceRef> {
    signal?.throwIfAborted()
    await this.ensureReady(name)
    signal?.throwIfAborted()
    const project = await this.request(name, { action: 'createWorkspace', path })
    if (!project) throw new Error('The remote workspace action did not return a workspace')
    const ref = { host: name, workspaceId: project.id, title: project.title, path: project.path }
    this.refs.set(workspaceKey(name, project.id), ref)
    this.persistRefs()
    this.refreshWorkspaces()
    return ref
  }

  async listDirectory(name: string, path?: string, signal?: AbortSignal): Promise<DirectoryListing> {
    signal?.throwIfAborted()
    const runtime = await this.ensureReady(name)
    signal?.throwIfAborted()
    const result = await runtime.ctx.remote.directoryPicker.list(path, signal)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }

  async createDirectory(name: string, path: string, child: string): Promise<string> {
    const runtime = await this.ensureReady(name)
    const result = await runtime.ctx.remote.directoryPicker.createDirectory(path, child)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }

  async disconnect(name: string): Promise<void> {
    this.pending.get(name)?.abort()
    this.pending.delete(name)
    this.remove(name)
    await this.hosts.disconnect(name)
  }

  remove(name: string): void { this.removeRuntime(name, true) }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const controller of this.pending.values()) controller.abort()
    this.pending.clear()
    for (const entry of [...this.state.getSnapshot().runtimes]) this.removeRuntime(entry.name, false)
    this.state.set({ runtimes: [], active: null })
    this.refreshWorkspaces()
  }

  private entry(name: string): RemoteRuntimeEntry | undefined { return this.state.getSnapshot().runtimes.find(entry => entry.name === name) }

  async ensureReady(name: string): Promise<RemoteClientRuntime> {
    if (this.disposed) throw new Error('The remote workspace browser was closed')
    let entry = this.entry(name)
    if (entry?.phase === 'failed') { this.removeRuntime(name, false); entry = undefined }
    if (!entry) {
      let connecting = this.connectionRequests.get(name)
      if (!connecting) {
        connecting = this.connect(name, false)
        this.connectionRequests.set(name, connecting)
      }
      try { if (!await connecting) throw new Error('The remote connection was cancelled') }
      finally { if (this.connectionRequests.get(name) === connecting) this.connectionRequests.delete(name) }
      entry = this.entry(name)
    }
    if (!entry) throw new Error('The remote connection was closed')
    await entry.runtime.start()
    const state = entry.runtime.state.getSnapshot()
    if (state.phase !== 'ready') throw new Error(state.error ?? 'The remote Client did not become ready')
    return entry.runtime
  }

  private watchCatalog(name: string, runtime: RemoteClientRuntime): void {
    const stops = this.subscriptions.get(name)
    if (!stops || stops.length > 1 || this.entry(name)?.runtime !== runtime) return
    stops.push(runtime.ctx.workspaces.list.subscribe(() => { this.refreshWorkspaces() }))
    stops.push(runtime.ctx.sessions.list.subscribe(() => { this.refreshWorkspaces() }))
    this.refreshWorkspaces()
  }

  private removeRuntime(name: string, returnLocal: boolean): void {
    const entry = this.entry(name)
    if (!entry) return
    for (const stop of this.subscriptions.get(name) ?? []) stop()
    this.subscriptions.delete(name)
    const snapshot = this.state.getSnapshot()
    this.state.set({ runtimes: snapshot.runtimes.filter(item => item.name !== name), active: snapshot.active === name ? null : snapshot.active })
    void entry.runtime.dispose()
    if (returnLocal && snapshot.active === name) this.returnLocal()
    this.refreshWorkspaces()
  }

  private refreshWorkspaces(): void {
    const entries = this.state.getSnapshot().runtimes
    let changed = false
    for (const entry of entries) {
      if (entry.phase !== 'ready') continue
      const list = entry.runtime.ctx.workspaces.list.getSnapshot()
      const keys = new Set<string>()
      for (const workspace of list.items) {
        const key = workspaceKey(entry.name, workspace.workspaceId)
        keys.add(key)
        const ref = { host: entry.name, workspaceId: workspace.workspaceId, title: workspace.title, path: workspace.path }
        if (JSON.stringify(this.refs.get(key)) !== JSON.stringify(ref)) { this.refs.set(key, ref); changed = true }
      }
      if (list.phase === 'ready' && !list.error) for (const [key, ref] of this.refs) {
        if (ref.host === entry.name && !keys.has(key)) { this.refs.delete(key); changed = true }
      }
    }
    if (changed) this.persistRefs()
    this.workspaces.set([...this.refs].map(([key, ref]) => {
      const entry = entries.find(item => item.name === ref.host)
      if (!entry || entry.phase !== 'ready') return { ...ref, key, sessions: [], currentSession: null, connected: Boolean(entry), ready: false, error: entry?.error ?? this.workspaceErrors.get(ref.host) ?? null }
      const workspaces = entry.runtime.ctx.workspaces.list.getSnapshot()
      const sessions = entry.runtime.ctx.sessions.list.getSnapshot()
      const workspace = workspaces.items.find(item => item.workspaceId === ref.workspaceId)
      const archived = new Set(workspaces.archivedSessionIds)
      const pinned = new Set(workspaces.pinnedSessionIds)
      const current = Object.values(sessions.byId).find(row => (row.retainedBy.mainView ?? 0) > 0)?.id ?? null
      const rows = workspace?.sessionIds.flatMap(id => {
        const row = sessions.byId[id]
        return row && !row.parentId && row.origin !== 'subagent' ? [{ id, title: row.displayTitle, running: row.running,
          archived: archived.has(id), pinned: pinned.has(id), updatedAt: row.updatedAt, blank: row.blank }] : []
      }) ?? []
      return { ...ref, key, sessions: rows, currentSession: rows.some(row => row.id === current) ? current : null,
        connected: true, ready: workspaces.phase === 'ready' && sessions.phase === 'ready', error: workspaces.error?.message ?? entry.error ?? null,
        ...(workspace?.createdAt === undefined ? {} : { createdAt: workspace.createdAt }), ...(workspace?.updatedAt === undefined ? {} : { updatedAt: workspace.updatedAt }) }
    }))
  }

  private persistRefs(): void {
    try { this.storage?.setItem(REMOTE_WORKSPACES_KEY, JSON.stringify({ version: 1, workspaces: [...this.refs.values()] })) }
    catch { /* The current browser remains usable when persistence is unavailable. */ }
  }

  private patch(name: string, changes: RemoteRuntimeState): void {
    this.state.set({ ...this.state.getSnapshot(), runtimes: this.state.getSnapshot().runtimes.map(entry => entry.name === name ? { ...entry, ...changes } : entry) })
  }
}
