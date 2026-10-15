/** Versioned, capability-scoped bridge between independent browser runtimes. */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { IRemoteHosts, RemoteHostsSnapshot } from '@codexydsh/remote/client'

export const REMOTE_PANEL = 'codexy.remote.projects'
export const BRIDGE = 'codexy.remote.projects.v1'

export interface RemoteSession { id: string; title: string; running: boolean; pinned?: boolean; archived?: boolean; updatedAt?: number; blank?: boolean }
export interface RemoteProject { id: string; title: string; path: string; sessions: RemoteSession[]; createdAt?: string; updatedAt?: string }
export interface RemoteCatalog { projects: RemoteProject[]; current: string | null; ready: boolean; error: string | null }
export type RemoteCommand = { action: 'openSession' | 'openWorkspace' | 'newSession' | 'removeWorkspace' | 'archiveSession' | 'unarchiveSession' | 'pinSession' | 'unpinSession' | 'forkSession'; id: string }
  | { action: 'renameWorkspace' | 'renameSession'; id: string; title: string } | { action: 'createWorkspace'; path: string }
export interface RemoteFrame {
  name: string; url: string; origin: string; channel: string; catalog: RemoteCatalog | null
  inset: number; error: string | null; ready: boolean
}
export interface RemoteProjectsSnapshot { frames: RemoteFrame[]; active: string | null }
export interface MessageWindow { postMessage(message: unknown, targetOrigin: string): void }
interface ReadyWaiter { name: string; resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
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

/** Custom Electron schemes retain their explicit serialized origin. */
export function browserOrigin(url: URL): string {
  return url.origin === 'null' && url.protocol === 'dsh-app:' && url.host === 'app' ? 'dsh-app://app' : url.origin
}

/** Accept only origins served by the local app or the local SSH forwarder. */
export function trustedParent(origin: string): boolean {
  if (origin === 'dsh-app://app') return true
  try {
    const url = new URL(origin)
    return (url.protocol === 'http:' || url.protocol === 'https:') && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.origin === origin
  } catch { return false }
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function label(value: unknown): value is string { return typeof value === 'string' && value.length <= 16_384 }
function identity(value: unknown): value is string { return label(value) && value.length > 0 }

/** Copy only the small, display-only catalog vocabulary across the boundary. */
export function parseCatalog(value: unknown): RemoteCatalog | undefined {
  if (!record(value) || !Array.isArray(value.projects) || value.projects.length > 10_000 || typeof value.ready !== 'boolean'
    || !(value.current === null || identity(value.current)) || !(value.error === null || label(value.error))) return
  const projects: RemoteProject[] = []
  const projectIds = new Set<string>()
  for (const project of value.projects) {
    if (!record(project) || !identity(project.id) || projectIds.has(project.id) || !label(project.title) || !label(project.path)
      || (project.createdAt !== undefined && !label(project.createdAt)) || (project.updatedAt !== undefined && !label(project.updatedAt))
      || !Array.isArray(project.sessions) || project.sessions.length > 100_000) return
    projectIds.add(project.id)
    const sessions: RemoteSession[] = []
    const sessionIds = new Set<string>()
    for (const session of project.sessions) {
      if (!record(session) || !identity(session.id) || sessionIds.has(session.id) || !label(session.title) || typeof session.running !== 'boolean'
        || ['pinned', 'archived', 'blank'].some(key => session[key] !== undefined && typeof session[key] !== 'boolean')
        || (session.updatedAt !== undefined && (typeof session.updatedAt !== 'number' || !Number.isFinite(session.updatedAt)))) return
      sessionIds.add(session.id)
      sessions.push({ id: session.id, title: session.title, running: session.running,
        ...(session.pinned === undefined ? {} : { pinned: session.pinned as boolean }), ...(session.archived === undefined ? {} : { archived: session.archived as boolean }),
        ...(session.blank === undefined ? {} : { blank: session.blank as boolean }), ...(session.updatedAt === undefined ? {} : { updatedAt: session.updatedAt as number }) })
    }
    projects.push({ id: project.id, title: project.title, path: project.path, sessions,
      ...(project.createdAt === undefined ? {} : { createdAt: project.createdAt }), ...(project.updatedAt === undefined ? {} : { updatedAt: project.updatedAt }) })
  }
  return { projects, current: value.current, ready: value.ready, error: value.error }
}

/** Reject arbitrary methods and payloads; child resolves identities against its current catalog. */
export function parseCommand(value: unknown): RemoteCommand | undefined {
  if (!record(value)) return
  if (value.action === 'createWorkspace' && identity(value.path) && /^(?:\/|[A-Za-z]:[\\/])/.test(value.path)) return { action: value.action, path: value.path }
  if (['renameWorkspace', 'renameSession'].includes(String(value.action)) && identity(value.id) && label(value.title)) return { action: value.action as 'renameWorkspace', id: value.id, title: value.title }
  if (['openSession', 'openWorkspace', 'newSession', 'removeWorkspace', 'archiveSession', 'unarchiveSession', 'pinSession', 'unpinSession', 'forkSession'].includes(String(value.action)) && identity(value.id)) return { action: value.action as 'openSession', id: value.id }
}

/** Own iframe identities, retain them across navigation, and fence every asynchronous connection. */
export class RemoteProjects {
  readonly state: SnapshotStore<RemoteProjectsSnapshot> = createSnapshotStore<RemoteProjectsSnapshot>({ frames: [], active: null })
  readonly workspaces: SnapshotStore<RemoteWorkspaceItem[]> = createSnapshotStore<RemoteWorkspaceItem[]>([])
  private readonly windows = new Map<string, MessageWindow>()
  private readonly pending = new Map<string, AbortController>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly refs = new Map<string, RemoteWorkspaceRef>()
  private readonly connectionRequests = new Map<string, Promise<boolean>>()
  private readonly readyWaiters = new Set<ReadyWaiter>()
  private readonly requests = new Map<string, { name: string; resolve(value: RemoteProject | undefined): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  private readonly workspaceErrors = new Map<string, string>()
  private readonly unsubscribe: () => void
  private disposed = false
  constructor(private readonly hosts: IRemoteHosts, private readonly parentOrigin: string, private readonly selectPanel: () => void, private readonly returnLocal: () => void = () => {}, private readonly storage?: RemoteWorkspaceStorage) {
    try { const raw = storage?.getItem(REMOTE_WORKSPACES_KEY); if (raw) for (const ref of parseWorkspaceRefs(JSON.parse(raw))) this.refs.set(workspaceKey(ref.host, ref.workspaceId), ref) } catch { /* Storage denial or corrupt data does not prevent navigation. */ }
    this.unsubscribe = this.state.subscribe(() => { this.refreshWorkspaces(); this.flushReady() })
    this.refreshWorkspaces()
  }

  async connect(name: string): Promise<boolean> {
    if (this.disposed) return false
    this.pending.get(name)?.abort()
    const controller = new AbortController()
    this.pending.set(name, controller)
    try {
      const status = await this.hosts.connect(name, controller.signal)
      if (controller.signal.aborted || this.disposed || this.pending.get(name) !== controller) return false
      if (!status.url) throw new Error('The remote connection did not provide an address')
      this.workspaceErrors.delete(name)
      this.attach(name, status.url)
      this.activate(name)
      return true
    } finally { if (this.pending.get(name) === controller) this.pending.delete(name) }
  }

  attach(name: string, address: string): void {
    const previous = this.state.getSnapshot().frames.find(frame => frame.name === name)
    // An unchanged forwarder URL preserves the runtime, input drafts, and Session ownership.
    if (previous?.url === address) return
    const url = new URL(address, this.parentOrigin + '/')
    const origin = browserOrigin(url)
    const localProxy = origin === this.parentOrigin && url.pathname.startsWith('/codexy-remote/')
    if (!localProxy && (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('Remote address must use the local proxy or a loopback HTTP origin')
    if (previous) this.rejectPending(name, new Error('The remote connection was replaced'))
    const channel = crypto.randomUUID()
    const frame: RemoteFrame = { name, url: address, origin, channel, catalog: null, inset: 0, error: null, ready: false }
    this.windows.delete(name)
    this.state.set({ ...this.state.getSnapshot(), frames: [...this.state.getSnapshot().frames.filter(item => item.name !== name), frame] })
  }

  /** Authentication stays in iframe memory; never save an address into durable UI state. */
  frameUrl(frame: RemoteFrame): string {
    const url = new URL(frame.url, this.parentOrigin + '/')
    const hash = new URLSearchParams(url.hash.slice(1))
    hash.set('codexy-embed', '1'); hash.set('codexy-parent', this.parentOrigin); hash.set('codexy-channel', frame.channel)
    url.hash = hash.toString()
    return url.href
  }

  reconcile(snapshot: RemoteHostsSnapshot): void {
    if (!snapshot.items) return
    for (const item of snapshot.items) if (item.phase === 'connected' && item.url) this.attach(item.name, item.url)
    // A transient observation loss keeps runtimes alive; an authoritative close removes them.
    const connected = new Set(snapshot.items.filter(item => item.phase === 'connected' && item.url).map(item => item.name))
    for (const frame of this.state.getSnapshot().frames) if (!connected.has(frame.name)) this.remove(frame.name)
  }

  activate(name: string): void {
    if (!this.state.getSnapshot().frames.some(frame => frame.name === name)) return
    this.state.set({ ...this.state.getSnapshot(), active: name }); this.selectPanel()
  }
  bind(name: string, target: MessageWindow | null): void { if (target) this.windows.set(name, target); else this.windows.delete(name); this.flushReady() }
  loaded(name: string): void {
    this.clearTimer(name)
    this.patch(name, { ready: false, catalog: null, error: null })
    this.send(name, { type: 'hello' })
    this.timers.set(name, setTimeout(() => { this.timers.delete(name); this.patch(name, { error: 'The remote project bridge did not respond. Update the remote Codexy profile and retry.' }) }, 20_000))
  }
  reload(name: string): void {
    this.rejectPending(name, new Error('The remote workspace browser was reloaded'))
    this.clearTimer(name); this.windows.delete(name)
    this.patch(name, { channel: crypto.randomUUID(), ready: false, catalog: null, inset: 0, error: null })
  }
  command(name: string, command: RemoteCommand): void { this.activate(name); this.send(name, { type: 'command', command }) }

  /** Existing workspace rows reconnect lazily, then navigate only after the child catalog arrives. */
  async openWorkspace(ref: RemoteWorkspaceRef): Promise<void> { await this.navigate(ref.host, { action: 'openWorkspace', id: ref.workspaceId }) }
  async openSession(ref: RemoteWorkspaceRef, id: string): Promise<void> { await this.navigate(ref.host, { action: 'openSession', id }) }
  async newSession(ref: RemoteWorkspaceRef): Promise<void> { await this.navigate(ref.host, { action: 'newSession', id: ref.workspaceId }) }

  /** Correlated bridge actions let a creator wait for the actual remote registration. */
  async request(name: string, command: RemoteCommand): Promise<RemoteProject | undefined> {
    await this.ensureReady(name)
    if (!this.isReady(name)) throw new Error('The remote connection was closed')
    const requestId = crypto.randomUUID()
    this.activate(name)
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(requestId); reject(new Error('The remote workspace action did not respond')) }, 20_000)
      this.requests.set(requestId, { name, resolve, reject, timer })
      this.send(name, { type: 'command', command, requestId })
    })
  }

  async createWorkspace(name: string, path: string): Promise<RemoteWorkspaceRef> {
    const command = parseCommand({ action: 'createWorkspace', path })
    if (!command) throw new Error('A remote workspace requires an absolute directory path')
    const project = await this.request(name, command)
    if (!project) throw new Error('The remote workspace action did not return a workspace')
    const ref = { host: name, workspaceId: project.id, title: project.title, path: project.path }
    const frame = this.state.getSnapshot().frames.find(item => item.name === name)
    if (frame?.catalog) this.patch(name, { catalog: { ...frame.catalog, projects: [...frame.catalog.projects.filter(item => item.id !== project.id), project] } })
    else { this.refs.set(workspaceKey(name, project.id), ref); this.persistRefs(); this.refreshWorkspaces() }
    return ref
  }

  receive(event: Pick<MessageEvent, 'origin' | 'source' | 'data'>): void {
    const frame = this.state.getSnapshot().frames.find(item => event.source === this.windows.get(item.name) && event.origin === item.origin)
    if (!frame || !record(event.data) || event.data.bridge !== BRIDGE || event.data.channel !== frame.channel) return
    if (event.data.type === 'ready') { this.clearTimer(frame.name); this.patch(frame.name, { ready: true, error: null }); this.send(frame.name, { type: 'hello' }) }
    else if (event.data.type === 'catalog') { const catalog = parseCatalog(event.data.catalog); if (catalog) { this.clearTimer(frame.name); this.patch(frame.name, { ready: true, catalog, error: null }) } }
    else if (event.data.type === 'inset' && typeof event.data.width === 'number' && Number.isFinite(event.data.width) && event.data.width >= 0 && event.data.width <= 1000) this.patch(frame.name, { inset: event.data.width })
    else if (event.data.type === 'error' && label(event.data.message)) this.patch(frame.name, { error: event.data.message })
    else if (event.data.type === 'result' && identity(event.data.requestId)) {
      const pending = this.requests.get(event.data.requestId)
      if (!pending || pending.name !== frame.name) return
      if (label(event.data.error)) {
        clearTimeout(pending.timer); this.requests.delete(event.data.requestId); pending.reject(new Error(event.data.error))
      } else if (event.data.error === undefined) {
        const result = event.data.result === undefined ? undefined : parseCatalog({ projects: [event.data.result], current: null, ready: true, error: null })?.projects[0]
        if (event.data.result !== undefined && !result) return
        clearTimeout(pending.timer); this.requests.delete(event.data.requestId); pending.resolve(result)
      }
    }
  }

  async disconnect(name: string): Promise<void> {
    this.pending.get(name)?.abort(); this.pending.delete(name); this.remove(name)
    await this.hosts.disconnect(name)
  }
  remove(name: string): void {
    this.rejectPending(name, new Error('The remote connection was closed'))
    this.clearTimer(name)
    this.windows.delete(name)
    const snapshot = this.state.getSnapshot()
    this.state.set({ frames: snapshot.frames.filter(frame => frame.name !== name), active: snapshot.active === name ? null : snapshot.active })
    if (snapshot.active === name) this.returnLocal()
  }
  dispose(): void {
    this.disposed = true
    for (const waiter of [...this.readyWaiters]) this.settleReady(waiter, new Error('The remote workspace browser was closed'))
    for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(new Error('The remote workspace browser was closed')) }
    this.requests.clear(); this.unsubscribe()
    for (const controller of this.pending.values()) controller.abort()
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear(); this.pending.clear(); this.windows.clear(); this.state.set({ frames: [], active: null }); this.refreshWorkspaces()
  }
  private async navigate(name: string, command: RemoteCommand): Promise<void> {
    await this.ensureReady(name)
    if (!this.isReady(name)) throw new Error('The remote connection was closed')
    this.command(name, command)
  }
  private async ensureReady(name: string): Promise<void> {
    if (this.disposed) throw new Error('The remote workspace browser was closed')
    if (!this.state.getSnapshot().frames.some(frame => frame.name === name)) {
      let connecting = this.connectionRequests.get(name)
      if (!connecting) {
        connecting = this.connect(name)
        this.connectionRequests.set(name, connecting)
      }
      try { if (!await connecting) throw new Error('The remote connection was cancelled') }
      catch (error) { this.workspaceErrors.set(name, error instanceof Error ? error.message : String(error)); this.refreshWorkspaces(); throw error }
      finally { if (this.connectionRequests.get(name) === connecting) this.connectionRequests.delete(name) }
    }
    if (this.isReady(name)) return
    await new Promise<void>((resolve, reject) => {
      const waiter = { name, resolve, reject, timer: setTimeout(() => { this.settleReady(waiter, new Error('The remote workspace catalog did not become ready')) }, 20_000) }
      this.readyWaiters.add(waiter); this.flushReady()
    })
  }
  private isReady(name: string): boolean { const frame = this.state.getSnapshot().frames.find(item => item.name === name); return Boolean(frame?.ready && frame.catalog?.ready && this.windows.has(name)) }
  private flushReady(): void {
    for (const waiter of [...this.readyWaiters]) {
      const frame = this.state.getSnapshot().frames.find(item => item.name === waiter.name)
      if (frame?.error || frame?.catalog?.error) this.settleReady(waiter, new Error(frame.error ?? frame.catalog!.error!))
      else if (this.isReady(waiter.name)) this.settleReady(waiter)
    }
  }
  private settleReady(waiter: ReadyWaiter, error?: Error): void {
    clearTimeout(waiter.timer); this.readyWaiters.delete(waiter); if (error) waiter.reject(error); else waiter.resolve()
  }
  private rejectPending(name: string, error: Error): void {
    for (const waiter of [...this.readyWaiters]) if (waiter.name === name) this.settleReady(waiter, error)
    for (const [id, request] of this.requests) if (request.name === name) { clearTimeout(request.timer); this.requests.delete(id); request.reject(error) }
  }
  private refreshWorkspaces(): void {
    const frames = this.state.getSnapshot().frames
    let changed = false
    for (const frame of frames) if (frame.catalog) {
      const keys = new Set<string>()
      for (const project of frame.catalog.projects) {
        const key = workspaceKey(frame.name, project.id)
        keys.add(key)
        const ref = { host: frame.name, workspaceId: project.id, title: project.title, path: project.path }
        if (JSON.stringify(this.refs.get(key)) !== JSON.stringify(ref)) { this.refs.set(key, ref); changed = true }
      }
      if (frame.catalog.ready && !frame.catalog.error) for (const [key, ref] of this.refs) if (ref.host === frame.name && !keys.has(key)) { this.refs.delete(key); changed = true }
    }
    if (changed) this.persistRefs()
    this.workspaces.set([...this.refs].map(([key, ref]) => {
      const frame = frames.find(item => item.name === ref.host)
      const project = frame?.catalog?.projects.find(item => item.id === ref.workspaceId)
      return { ...ref, key, sessions: project?.sessions ?? [], currentSession: project?.sessions.some(session => session.id === frame?.catalog?.current) ? frame!.catalog!.current : null,
        connected: Boolean(frame), ready: Boolean(frame?.ready && frame.catalog?.ready), error: frame?.error ?? frame?.catalog?.error ?? this.workspaceErrors.get(ref.host) ?? null,
        ...(project?.createdAt === undefined ? {} : { createdAt: project.createdAt }), ...(project?.updatedAt === undefined ? {} : { updatedAt: project.updatedAt }) }
    }))
  }
  private persistRefs(): void { try { this.storage?.setItem(REMOTE_WORKSPACES_KEY, JSON.stringify({ version: 1, workspaces: [...this.refs.values()] })) } catch { /* The current browser remains usable when persistence is unavailable. */ } }
  private clearTimer(name: string): void { const timer = this.timers.get(name); if (timer) clearTimeout(timer); this.timers.delete(name) }
  private send(name: string, payload: Record<string, unknown>): void {
    const frame = this.state.getSnapshot().frames.find(item => item.name === name)
    if (frame) this.windows.get(name)?.postMessage({ bridge: BRIDGE, channel: frame.channel, ...payload }, frame.origin)
  }
  private patch(name: string, changes: Partial<RemoteFrame>): void { this.state.set({ ...this.state.getSnapshot(), frames: this.state.getSnapshot().frames.map(frame => frame.name === name ? { ...frame, ...changes } : frame) }) }
}
