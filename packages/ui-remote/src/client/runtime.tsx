/** A Loader-composed Client tree whose Connection points at one SSH Host. */
import { Context, type Plugin } from '@deepseek-ai/cordis'
import { installConnection, type ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientModuleLoader } from '@deepseek-ai/dsh-client-modules/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ISessions, SessionReference, SessionTarget } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces, WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { StartSessionOptions, UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { MainPanelId, PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import css from './RemoteRuntime.module.css'

const CONNECTION = '@deepseek-ai/dsh-client-connection'
const GATEWAY = '@deepseek-ai/dsh-api-gateway'
const RENDERER = '@deepseek-ai/dsh-client-ui-renderer'
const LAYOUT = '@deepseek-ai/dsh-client-ui-layout'
const LEFT_SIDEBAR = '@deepseek-ai/dsh-client-ui-sidebar'
const WORKSPACE_UI = '@deepseek-ai/dsh-client-ui-workspace'
const REMOTE_UI = '@codexydsh/ui-remote'

const ROOTS = [
  '@codexydsh/api-remotes',
  '@codexydsh/api-session-controller',
  '@deepseek-ai/dsh-api-workspace-controller',
  '@deepseek-ai/dsh-client-ui-session',
  '@deepseek-ai/dsh-client-ui-model-selection',
  '@deepseek-ai/dsh-client-ui-reference',
  '@deepseek-ai/dsh-client-ui-sidebar-right',
  '@deepseek-ai/dsh-client-ui-sidebar-documentpreview',
  '@deepseek-ai/dsh-client-ui-sidebar-terminal',
  '@deepseek-ai/dsh-client-ui-sidebar-files',
  '@codexydsh/ui-conversation',
  '@codexydsh/ui-chat',
  '@codexydsh/ui-input-trigger',
  '@codexydsh/ui-commands',
  '@codexydsh/ui-skill',
  '@codexydsh/ui-approval',
  '@codexydsh/ui-permission-presets',
  '@codexydsh/ui-deliverables',
  '@codexydsh/ui-tool',
  '@codexydsh/ui-trajectory',
] as const

const SKIPPED = new Set([CONNECTION, LAYOUT, LEFT_SIDEBAR, WORKSPACE_UI, '@codexydsh/ui-workspace', REMOTE_UI])

export interface RemoteRuntimeState {
  phase: 'starting' | 'ready' | 'failed' | 'closed'
  error: string | null
}

interface RemoteLayoutState extends PanelInfo {
  rightbar: boolean
  fullscreen: boolean
}

type RemoteShellProps = PropsRuntime<'root'> & PropsRenderSlots<'main' | 'rightbar' | 'shell.bottom' | 'shell.overlay'> & {
  useRemoteLayout: <Selected>(selector: (value: RemoteLayoutState) => Selected) => Selected
}

function RemoteShell({ renderSlot, useRemoteLayout }: RemoteShellProps) {
  const layout = useRemoteLayout(value => value)
  return <div className={css.shell} data-codexy-remote-runtime>
    <main className={css.main}>{renderSlot('main', {}, { entryKey: layout.activePanelId ?? 'conversation' })}</main>
    {layout.rightbar && <aside className={css.rightbar} data-fullscreen={layout.fullscreen || undefined}>
      {renderSlot('rightbar', { width: 420, viewportWidth: window.innerWidth, canShow: true })}
    </aside>}
    <div className={css.bottom}>{renderSlot('shell.bottom', {})}</div>
    <div className={css.overlay}>{renderSlot('shell.overlay', {})}</div>
  </div>
}

/** Select the ordinary plugin rows needed for a remote conversation tree. */
export function remoteRuntimeEntries(modules: Pick<ClientModuleLoader, 'manifest'>): string[] {
  const rows = new Map(modules.manifest.modules.map(row => [row.id, row]))
  const selected = new Set<string>([RENDERER])
  const visit = (id: string): void => {
    if (selected.has(id) || SKIPPED.has(id)) return
    const row = rows.get(id)
    if (row === undefined) return
    selected.add(id)
    for (const dependency of row.inject) visit(dependency)
  }
  for (const root of ROOTS) visit(root)
  return modules.manifest.plugins.map(row => row.id).filter(id => selected.has(id))
}

function remoteFetch(base: URL): (input: string | URL, init: RequestInit) => Promise<Response> {
  return (input, init) => fetch(new URL(String(input).replace(/^\//u, ''), base), init)
}

type UploadFetch = (input: string | URL, init: RequestInit) => Promise<Response>
type TransportGlobals = typeof globalThis & {
  __DSH_TRANSPORT__?: Record<string, unknown>
  __DSH_FILE_UPLOAD__?: { fetch: UploadFetch }
}
let clientBootstrap: Promise<void> = Promise.resolve()

/** Upstream upload providers capture their carrier at construction, before Cordis activation. */
async function withClientTransport<T>(streamBase: URL | undefined, uploadFetch: UploadFetch, operation: () => Promise<T>): Promise<T> {
  const previous = clientBootstrap
  let release!: () => void
  clientBootstrap = new Promise(resolve => { release = resolve })
  return previous.then(async () => {
    const globals = globalThis as TransportGlobals
    const before = globals.__DSH_TRANSPORT__
    const beforeUpload = globals.__DSH_FILE_UPLOAD__
    if (streamBase) globals.__DSH_TRANSPORT__ = { ...before, streamBaseUrl: streamBase.href }
    globals.__DSH_FILE_UPLOAD__ = { fetch: uploadFetch }
    try { return await operation() }
    finally {
      if (streamBase) {
        if (before === undefined) delete globals.__DSH_TRANSPORT__
        else globals.__DSH_TRANSPORT__ = before
      }
      if (beforeUpload === undefined) delete globals.__DSH_FILE_UPLOAD__
      else globals.__DSH_FILE_UPLOAD__ = beforeUpload
      release()
    }
  })
}

function withLegacyStreamBaseSync(base: URL, operation: () => void): void {
  const globals = globalThis as TransportGlobals
  const before = globals.__DSH_TRANSPORT__
  globals.__DSH_TRANSPORT__ = { ...before, streamBaseUrl: base.href }
  try { operation() }
  finally {
    if (before === undefined) delete globals.__DSH_TRANSPORT__
    else globals.__DSH_TRANSPORT__ = before
  }
}

/** One native Client runtime. Feature plugins are created by Loader, never by one another. */
export class RemoteClientRuntime {
  readonly state: SnapshotStore<RemoteRuntimeState> = createSnapshotStore({ phase: 'starting', error: null })
  readonly ctx = new Context()
  private booting: Promise<void> | undefined
  private mounted: (() => void) | undefined
  private closed = false

  constructor(
    readonly name: string,
    readonly base: URL,
    private readonly modules: ClientModuleLoader,
    private readonly LoaderPlugin: Plugin,
  ) {}

  start(): Promise<void> {
    return this.booting ??= this.boot()
  }

  mount(container: HTMLElement): () => void {
    if (this.state.getSnapshot().phase !== 'ready') throw new Error('Remote Client is not ready')
    this.mounted?.()
    const dispose = this.ctx.uiRenderer.mount(container)
    this.mounted = dispose
    return () => {
      if (this.mounted !== dispose) return
      this.mounted = undefined
      dispose()
    }
  }

  async dispose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.mounted?.(); this.mounted = undefined
    await this.ctx.fiber.dispose()
    this.state.set({ phase: 'closed', error: null })
  }

  private async boot(): Promise<void> {
    try {
      // Desktop HTTP uses dsh-app://, while its authenticated WebSocket carrier
      // lives on the shell-owned loopback Host. Preserve the remote mount path.
      const pageTransport = (globalThis as TransportGlobals).__DSH_TRANSPORT__
      const streamBase = new URL(this.base.href)
      if (streamBase.protocol !== 'http:' && streamBase.protocol !== 'https:' && typeof pageTransport?.streamBaseUrl === 'string') {
        const host = new URL(pageTransport.streamBaseUrl)
        host.pathname = streamBase.pathname
        streamBase.href = host.href
      }
      installConnection(this.ctx, {
        transport: { fetch: remoteFetch(this.base), streamBaseUrl: streamBase.href, ownsHost: true },
      })
      await this.ctx.plugin(this.LoaderPlugin)
      this.ctx.loader.internal = this.modules as never
      const entries = remoteRuntimeEntries(this.modules)
      if (!entries.includes(RENDERER)) throw new Error('Remote Client graph has no UI renderer')
      await this.ctx.loader.create({ name: RENDERER })
      await this.ctx.loader.await()
      await this.installShell()
      await this.installNavigation()
      const connection = this.ctx.get('connection') as ConnectionHandle & { openWebSocket?: unknown }
      const legacyGateway = entries.includes(GATEWAY) && connection.openWebSocket === undefined
      if (legacyGateway) this.prepareLegacyGateway(connection, streamBase)
      const activate = async (): Promise<void> => {
        if (entries.includes(GATEWAY)) await this.ctx.loader.create({ name: GATEWAY })
        await Promise.all(entries.filter(id => id !== RENDERER && id !== GATEWAY).map(name => this.ctx.loader.create({
          name,
          ...(name === '@codexydsh/ui-conversation' ? { config: { useHostFilePaths: false } } : {}),
        })))
        await this.ctx.loader.await()
        const failures = [...this.ctx.loader.entries()].flatMap(entry => {
          if (entry.fiber?.state === 2) return []
          const missing = entry.fiber === undefined ? [] : Object.keys(entry.fiber.inject).filter(service => this.ctx.get(service) === undefined)
          return [`${entry.options.name}${missing.length ? ` (missing ${missing.join(', ')})` : ''}`]
        })
        if (failures.length) throw new Error(`Remote Client plugins did not activate: ${failures.join(', ')}`)
        await this.waitConnected()
      }
      // Both hooks are the upstream carrier extension points, captured during activation.
      // Restore the parent page's hooks afterwards; uploads retain this Host's own fetch.
      await withClientTransport(legacyGateway ? streamBase : undefined, remoteFetch(this.base), activate)
      if (this.closed) return
      this.state.set({ phase: 'ready', error: null })
    } catch (error) {
      if (this.closed) return
      const message = error instanceof Error ? error.message : String(error)
      this.state.set({ phase: 'failed', error: message })
      throw error
    }
  }

  /** rc.2 still resolves reconnect sockets from a page global. */
  private prepareLegacyGateway(connection: ConnectionHandle, streamBase: URL): void {
    const start = connection.start.bind(connection)
    connection.start = (sinks, config) => start({ ...sinks,
      onReconnectRequested: () => { withLegacyStreamBaseSync(streamBase, () => { sinks.onReconnectRequested?.() }) },
    }, config)
  }

  private async installShell(): Promise<void> {
    await this.ctx.plugin({
      name: 'codexy-remote-client-shell',
      inject: ['slots'],
      apply: (ctx: Context) => {
        const layout = createSnapshotStore<RemoteLayoutState>({ activePanelId: null, rightbar: false, fullscreen: false })
        let navigation = new AbortController()
        const service = {
          panelInfo: { getSnapshot: () => ({ activePanelId: layout.getSnapshot().activePanelId }), subscribe: layout.subscribe },
          selectPanel(panelId: MainPanelId | null): void {
            if (panelId !== null && !ctx.slots.entries('main').some(entry => entry.options.key === panelId)) throw new Error(`Unknown remote panel ${panelId}`)
            navigation.abort(); layout.set({ ...layout.getSnapshot(), activePanelId: panelId })
          },
          beginNavigation(): AbortSignal { navigation.abort(); navigation = new AbortController(); return navigation.signal },
          toggleSidebar(): void {},
          openRightbar(_track: boolean, fullscreen: boolean): void { layout.set({ ...layout.getSnapshot(), rightbar: true, fullscreen }) },
          closeRightbar(): void { layout.set({ ...layout.getSnapshot(), rightbar: false, fullscreen: false }) },
        }
        ctx.effect(() => {
          const disposeLayout = ctx.reflect.provide('layout', service)
          const disposeRoot = ctx.slots.provideRoot({ hooks: { panelInfo: service.panelInfo } })
          const disposeFrame = ctx.slots.register({
            name: 'root',
            children: {
              main: { kind: 'keyed', scope: 'root' },
              rightbar: { kind: 'single', scope: 'root' },
              'shell.bottom': { kind: 'single', scope: 'root' },
              'shell.overlay': { kind: 'list', scope: 'root' },
              'shell.leading': { kind: 'single', scope: 'root' },
              sidebar: { kind: 'single', scope: 'root' },
            },
            inject: () => ({ hooks: { remoteLayout: layout } }),
          }, RemoteShell)
          return () => { navigation.abort(); disposeFrame(); disposeRoot(); void disposeLayout() }
        })
      },
    })
  }

  /** The parent owns Workspace browsing, so the child needs navigation without a second persisted browser. */
  private async installNavigation(): Promise<void> {
    await this.ctx.plugin({
      name: 'codexy-remote-workspace-navigation',
      inject: ['slots', 'sessions', 'workspaces', 'layout'],
      apply: (ctx: Context) => {
        const navigation = new RemoteWorkspaceNavigation(ctx, ctx.sessions, ctx.workspaces)
        ctx.effect(() => {
          const disposeService = ctx.reflect.provide('uiWorkspace', navigation)
          const disposeHooks = ctx.slots.provideRoot({ hooks: { workspaces: ctx.workspaces.list } })
          return () => { navigation.dispose(); disposeHooks(); void disposeService() }
        })
      },
    })
  }

  private async waitConnected(): Promise<void> {
    const connection = this.ctx.get('connection') as ConnectionHandle
    if (connection.state.getSnapshot() === 'connected') return
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { stop(); reject(new Error('Remote Client did not connect within 30 seconds')) }, 30_000)
      const stop = connection.state.subscribe(() => {
        if (connection.state.getSnapshot() !== 'connected') return
        clearTimeout(timeout); stop(); resolve()
      })
    })
  }
}

/** Remote navigation owns only the active Session; persistence and the Workspace browser stay in the parent. */
class RemoteWorkspaceNavigation implements UiWorkspace {
  private main: SessionReference | undefined
  private disposed = false

  constructor(private readonly ctx: Context, private readonly sessions: ISessions, private readonly workspaces: IWorkspaces) {}

  openSession(target: SessionTarget): void {
    if (this.disposed) return
    const next = this.sessions.retain(target, { source: 'mainView' })
    const previous = this.main
    this.main = next
    previous?.release()
    this.ctx.layout.selectPanel(null)
  }

  async connectWorkspace(workspaceId: WorkspaceId): Promise<SessionId> {
    const workspace = this.workspaces.list.getSnapshot().items.find(item => item.workspaceId === workspaceId)
    if (!workspace) throw new Error(`Remote workspace is no longer available: ${workspaceId}`)
    const archived = new Set(this.workspaces.list.getSnapshot().archivedSessionIds)
    const rows = this.sessions.list.getSnapshot().byId
    const blank = workspace.sessionIds.find(id => rows[id]?.blank && rows[id]?.cwd === workspace.path && !archived.has(id))
    return await this.sessions.create({ workspaceId, ...(blank === undefined ? {} : { sessionId: blank }) })
  }

  async openWorkspace(workspaceId: WorkspaceId, beforeOpen?: (sessionId: SessionId) => void): Promise<void> {
    const signal = this.ctx.layout.beginNavigation()
    const id = await this.connectWorkspace(workspaceId)
    if (signal.aborted || this.disposed) return
    beforeOpen?.(id)
    if (!signal.aborted) this.openSession(id)
  }

  async forkSession(sessionId: SessionId, onCreated?: (childId: SessionId) => void,
    options?: Pick<Parameters<ISessions['fork']>[0], 'allowMigration'>): Promise<SessionId> {
    return await this.sessions.fork({ sessionId, increaseTitle: true, ...(onCreated ? { onCreated } : {}),
      ...(options?.allowMigration === undefined ? {} : { allowMigration: options.allowMigration }) })
  }

  startSession(workspaceId?: WorkspaceId, _options?: StartSessionOptions): void {
    const target = workspaceId ?? this.currentWorkspace() ?? this.workspaces.list.getSnapshot().items[0]?.workspaceId
    if (!target) { this.clear(); return }
    void this.sessions.create({ workspaceId: target }).then(id => { if (!this.disposed) this.openSession(id) })
      .catch(error => { console.warn('remote Session creation failed:', error) })
  }

  async archiveSession(sessionId: SessionId, options?: { readonly stopActivity?: boolean }): Promise<void> {
    await this.workspaces.archiveSession(sessionId, options)
    if (this.main?.sessionId === sessionId) this.clear()
  }

  async unarchiveSession(sessionId: SessionId): Promise<void> { await this.workspaces.unarchiveSession(sessionId) }
  async pinSession(sessionId: SessionId): Promise<void> { await this.workspaces.pinSession(sessionId) }
  async unpinSession(sessionId: SessionId): Promise<void> { await this.workspaces.unpinSession(sessionId) }
  async pickDirectory(): Promise<string | null> { return null }
  async listDirectory(): Promise<never> { throw new Error('Use the shared workspace picker for remote directories') }
  async createDirectory(): Promise<never> { throw new Error('Use the shared workspace picker for remote directories') }

  dispose(): void { this.disposed = true; this.clear() }

  private currentWorkspace(): WorkspaceId | undefined {
    const current = this.main?.sessionId
    if (!current) return
    return this.workspaces.list.getSnapshot().items.find(item => item.sessionIds.includes(current))?.workspaceId
  }

  private clear(): void {
    const previous = this.main
    this.main = undefined
    previous?.release()
    if (!this.disposed) this.ctx.layout.selectPanel(null)
  }
}
