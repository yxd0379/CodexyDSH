/** Local navigation and frame lifetimes; remote Session ids never enter local Controllers. */
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore, storageKey, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { GroupNode, WorkspaceSourceSnapshot } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { RemoteHostConfig, RemoteHostStatus } from '@codexydsh/remote/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { acceptsFrameOrigin, directorySchema, frameTargetOrigin, responseSchema, type FrameCommand } from './protocol.ts'
import type {} from '@deepseek-ai/dsh-client-ui-directory-picker-browse/client'

/** Native main panel containing the selected remote document. */
export const REMOTE_PANEL = 'codexydsh-remote' as MainPanelId
export interface RemoteSettings { hosts: Record<string, RemoteHostConfig | null> }
export type RemoteDialog = { kind: 'details'; host: string; group: GroupNode }
  | { kind: 'rename'; host: string; target: { workspace: string } | { session: SessionId }; title: string }
  | null
export interface RemoteView {
  hosts: readonly RemoteHostStatus[]
  selectedHost: string | null
  rect: { left: number; top: number; width: number; height: number } | null
  error: string | null
  dialog: RemoteDialog
  groups: Readonly<Record<string, readonly GroupNode[]>>
  hidden: Readonly<Record<string, readonly string[]>>
}
interface Frame {
  element?: HTMLIFrameElement
  documentId?: string
  onLoad?: () => void
  ready: boolean
  source: SnapshotStore<WorkspaceSourceSnapshot>
  raw: WorkspaceSourceSnapshot
  folded: Set<string>
  dispose: () => void
}
interface Pending {
  host: string
  frame: Frame
  documentId?: string
  sent: boolean
  send(): void
  resolve(value: unknown): void
  reject(error: unknown): void
}

/** Owns one local window's remote connections and embedded native documents. */
export class RemoteWorkspaceController {
  readonly view = createSnapshotStore<RemoteView>({ hosts: [], selectedHost: null, rect: null, error: null, dialog: null, groups: {}, hidden: {} })
  readonly form: ConfigForm<RemoteSettings>
  private readonly frames = new Map<string, Frame>()
  private readonly pending = new Map<string, Pending>()
  private readonly lifetime = new AbortController()
  private readonly connections = new Map<string, AbortController>()
  private readonly hidden = new Map<string, Set<string>>()
  private surfaceObserver: ResizeObserver | undefined
  private surfaceCleanup: (() => void) | undefined

  constructor(private readonly ctx: Context) {
    this.form = ctx.configForms.get<RemoteSettings>('codexy-remote')
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(storageKey('codexydsh.remote.hidden-workspaces', document.baseURI)) ?? '{}')
      if (typeof saved === 'object' && saved !== null) for (const [host, value] of Object.entries(saved)) {
        if (Array.isArray(value) && value.every((id: unknown) => typeof id === 'string')) this.hidden.set(host, new Set<string>(value))
      }
    } catch (error) { console.warn('Remote workspace visibility could not be restored:', error) }
    ctx.effect(() => {
      const receive = (event: MessageEvent<unknown>): void => {
        if (this.lifetime.signal.aborted || !acceptsFrameOrigin(event.origin, window.location)) return
        const match = [...this.frames].find(([, frame]) => frame.element?.contentWindow === event.source)
        if (match === undefined) return
        const parsed = responseSchema.safeParse(event.data)
        if (!parsed.success) return
        const [host, frame] = match
        if (parsed.data.kind === 'snapshot') {
          if (frame.documentId !== undefined && frame.documentId !== parsed.data.frameId) {
            this.rejectPending(frame, new Error('Remote document restarted'), true)
          }
          frame.documentId = parsed.data.frameId
          frame.ready = true; frame.raw = parsed.data.value; this.publishSource(host, frame)
          for (const pending of this.pending.values()) if (pending.frame === frame && !pending.sent) pending.send()
        } else {
          const result = parsed.data
          const pending = this.pending.get(result.id)
          if (pending?.host !== host || pending.frame !== frame || pending.documentId !== result.frameId) return
          if (result.ok) pending.resolve(result.value)
          else pending.reject(new Error(result.error))
        }
      }
      window.addEventListener('message', receive)
      const offPanel = ctx.layout.panelInfo.subscribe(() => {
        for (const [host, frame] of this.frames) this.publishSource(host, frame)
      })
      void this.follow()
      return () => {
        window.removeEventListener('message', receive); offPanel(); this.lifetime.abort(); this.surfaceCleanup?.()
        for (const controller of this.connections.values()) controller.abort()
        for (const frame of this.frames.values()) frame.dispose()
        this.frames.clear()
        for (const pending of this.pending.values()) pending.reject(new Error('Remote view closed'))
        this.pending.clear()
      }
    }, 'remote: local frame and connection lifetimes')
  }

  private async follow(): Promise<void> {
    try {
      for await (const hosts of this.ctx.remote.remoteHosts.follow(this.lifetime.signal)) {
        if (this.lifetime.signal.aborted) break
        for (const host of hosts) if (host.phase === 'connected' && host.url !== null && !this.frames.has(host.name)) this.register(host.name)
        for (const [name, frame] of this.frames) if (!hosts.some(host => host.name === name && host.phase === 'connected')) {
          frame.dispose(); this.frames.delete(name)
          this.rejectPending(frame, new Error('Remote connection closed'))
        }
        // Publish renderable Hosts only after attach() can resolve their frame ownership.
        this.view.update(state => { state.hosts = hosts })
      }
    } catch (error) { if (!this.lifetime.signal.aborted) this.report(error) }
  }

  private register(name: string): void {
    const source = createSnapshotStore<WorkspaceSourceSnapshot>({ groups: [] })
    const frame: Frame = { ready: false, source, raw: { groups: [] }, folded: new Set(), dispose: () => {} }
    this.frames.set(name, frame)
    const offSource = this.ctx.uiWorkspace.registerSource({ id: `ssh:${name}`, label: name, state: source, actions: {
      toggleWorkspace: key => { if (frame.folded.has(key)) frame.folded.delete(key); else frame.folded.add(key); this.publishSource(name, frame) },
      openSession: sessionId => { this.select(name); this.run(name, { kind: 'open', sessionId }) },
      startSession: (workspaceId, options) => { this.select(name); this.run(name, { kind: 'start',
        ...(workspaceId === undefined ? {} : { workspaceId }), ...(options === undefined ? {} : { options }) }) },
      renameWorkspace: group => { if (group.workspaceId !== undefined) this.view.update(state => { state.dialog = { kind: 'rename', host: name, target: { workspace: group.workspaceId! }, title: group.label } }) },
      archiveWorkspace: group => { this.setVisible(name, group.key, false) },
      showWorkspaceDetails: group => { this.showDetails(name, group) },
      renameSession: (session, title) => { this.view.update(state => { state.dialog = { kind: 'rename', host: name, target: { session }, title } }) },
      archiveSession: sessionId => { this.run(name, { kind: 'archiveSession', sessionId }) },
      unarchiveSession: sessionId => { this.run(name, { kind: 'unarchiveSession', sessionId }) },
    } })
    const offLocation = this.ctx.directoryPickerLocations.register({ id: `ssh:${name}`, label: name,
      listDirectory: async (path, signal) => directorySchema.parse(await this.request(name, { kind: 'listDirectory', ...(path === undefined ? {} : { path }) }, signal)),
      createDirectory: async (path, child) => {
        const value = await this.request(name, { kind: 'createDirectory', path, name: child })
        if (typeof value !== 'string') throw new Error('Remote directory creation returned no path')
        return value
      },
      onPicked: async path => { await this.request(name, { kind: 'createWorkspace', path }) },
    })
    frame.dispose = () => {
      this.rejectPending(frame, new Error('Remote connection closed'))
      if (frame.onLoad !== undefined) frame.element?.removeEventListener('load', frame.onLoad)
      delete frame.element; delete frame.onLoad; delete frame.documentId; frame.ready = false
      offLocation(); offSource()
    }
  }

  private publishSource(name: string, frame: Frame): void {
    const hidden = this.hidden.get(name)
    const selected = this.view.getSnapshot().selectedHost === name && this.ctx.layout.panelInfo.getSnapshot().activePanelId === REMOTE_PANEL
    const { selectedSessionId, ...raw } = frame.raw
    frame.source.set({ ...raw, ...(selected && selectedSessionId !== undefined ? { selectedSessionId } : {}),
      groups: frame.raw.groups.filter(group => !hidden?.has(group.key)).map(group => ({ ...group,
        expanded: !frame.folded.has(group.key), containsCurrent: selected && group.containsCurrent })) })
    this.view.update(state => { state.groups = { ...state.groups, [name]: frame.raw.groups }; state.hidden = Object.fromEntries([...this.hidden].map(([host, ids]) => [host, [...ids]])) })
  }

  /** Bind a newly mounted frame; the child announces readiness after native Client boot. */
  attach = (host: string, element: HTMLIFrameElement | null): void => {
    const frame = this.frames.get(host)
    if (frame === undefined) return
    if (frame.element === element) return
    if (frame.onLoad !== undefined) frame.element?.removeEventListener('load', frame.onLoad)
    if (frame.element !== undefined) this.rejectPending(frame, new Error('Remote document detached'))
    frame.ready = false
    delete frame.documentId; delete frame.onLoad
    if (element === null) delete frame.element
    else {
      frame.element = element
      frame.onLoad = () => {
        frame.ready = false; delete frame.documentId
        this.rejectPending(frame, new Error('Remote document reloaded'), true)
        this.probe(frame)
      }
      element.addEventListener('load', frame.onLoad)
      this.probe(frame)
    }
  }

  /** Refresh is the sole request allowed before the child's per-document identity is known. */
  private probe(frame: Frame): void {
    try {
      frame.element?.contentWindow?.postMessage({ source: 'codexydsh-parent', id: crypto.randomUUID(),
        command: { kind: 'refresh' } }, frameTargetOrigin(window.location))
    } catch (error) { if (!this.lifetime.signal.aborted) this.report(error) }
  }

  private rejectPending(frame: Frame, error: Error, sentOnly = false): void {
    for (const pending of this.pending.values()) {
      if (pending.frame === frame && (!sentOnly || pending.sent)) pending.reject(error)
    }
  }

  /** Position the persistent document over the native main panel's own rectangle. */
  surface = (element: HTMLDivElement | null): void => {
    this.surfaceCleanup?.(); this.surfaceCleanup = undefined
    if (element === null) { this.view.update(state => { state.rect = null }); return }
    const update = (): void => {
      const rect = element.getBoundingClientRect()
      this.view.update(state => { state.rect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height } })
    }
    this.surfaceObserver = new ResizeObserver(update); this.surfaceObserver.observe(element)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    this.surfaceCleanup = () => {
      this.surfaceObserver?.disconnect()
      window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true)
    }
    update()
  }

  private select(name: string): void {
    this.view.update(state => { state.selectedHost = name; state.error = null })
    this.ctx.layout.selectPanel(REMOTE_PANEL)
    for (const [host, frame] of this.frames) this.publishSource(host, frame)
  }

  /** Open the selected Host's native settings, not the local model/provider configuration. */
  openSettings = (host: string): void => { this.closeDialog(); this.select(host); this.run(host, { kind: 'settings' }) }

  /** Return a single frame's operation result; cancellation removes only this observer. */
  request(host: string, command: FrameCommand, signal?: AbortSignal): Promise<unknown> {
    const frame = this.frames.get(host)
    if (frame === undefined || this.lifetime.signal.aborted) return Promise.reject(new Error(this.ctx.locale.bind('remoteWorkspace')('unavailable')))
    if (signal?.aborted === true) return Promise.reject(signal.reason)
    const id = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (operation: () => void): void => {
        if (settled) return
        settled = true; clearTimeout(timer); this.pending.delete(id)
        signal?.removeEventListener('abort', aborted); operation()
      }
      const aborted = (): void => { finish(() => reject(signal?.reason)) }
      const timer = setTimeout(() => finish(() => reject(new Error(frame.ready
        ? 'Remote operation timed out' : this.ctx.locale.bind('remoteWorkspace')('unavailable')))), 30_000)
      const pending: Pending = { host, frame, sent: false,
        resolve: value => finish(() => resolve(value)), reject: error => finish(() => reject(error)),
        send: () => {
          const target = frame.element?.contentWindow
          if (settled || pending.sent || !frame.ready || frame.documentId === undefined || target == null) return
          pending.sent = true; pending.documentId = frame.documentId
          try { target.postMessage({ source: 'codexydsh-parent', frameId: frame.documentId, id, command }, frameTargetOrigin(window.location)) }
          catch (error) { pending.reject(error) }
        },
      }
      this.pending.set(id, pending)
      signal?.addEventListener('abort', aborted, { once: true })
      pending.send()
    })
  }

  private run(host: string, command: FrameCommand): void { void this.request(host, command).catch(error => { this.report(error) }) }
  private report(error: unknown): void { this.view.update(state => { state.error = error instanceof Error ? error.message : String(error) }) }
  /** Dismiss the last operation failure without changing connection or selection state. */
  dismissError = (): void => { this.view.update(state => { state.error = null }) }
  /** Connect a saved host without blocking other workspace navigation. */
  connect = (name: string): void => {
    const abort = new AbortController(); this.connections.get(name)?.abort(); this.connections.set(name, abort)
    this.view.update(state => { state.error = null })
    void this.ctx.remote.remoteHosts.connect(name, abort.signal).catch(() => {
      // The Host retains the complete failure in its connection log.
      if (!abort.signal.aborted) this.report(this.ctx.locale.bind('remoteWorkspace')('failed'))
    })
      .finally(() => { if (this.connections.get(name) === abort) this.connections.delete(name) })
  }
  /** Disconnect locally while leaving remote conversations running. */
  disconnect = (name: string): void => {
    this.connections.get(name)?.abort(); this.connections.delete(name)
    void this.ctx.remote.remoteHosts.disconnect(name).catch(error => { this.report(error) })
  }
  /** Persist only sidebar visibility, without changing remote membership or files. */
  setVisible = (host: string, group: string, visible: boolean): void => {
    const hidden = this.hidden.get(host) ?? new Set<string>(); this.hidden.set(host, hidden)
    if (visible) hidden.delete(group); else hidden.add(group)
    try { localStorage.setItem(storageKey('codexydsh.remote.hidden-workspaces', document.baseURI), JSON.stringify(Object.fromEntries([...this.hidden].map(([name, ids]) => [name, [...ids]])))) }
    catch (error) { this.report(error) }
    const frame = this.frames.get(host); if (frame !== undefined) this.publishSource(host, frame)
  }
  /** Save a complete catalog edit through the native settings write queue. */
  save = async (name: string, host: RemoteHostConfig, previous?: string): Promise<boolean> => {
    const hosts = { ...this.form.getSnapshot().value?.hosts, ...(previous !== undefined && previous !== name ? { [previous]: null } : {}), [name]: host }
    return this.form.set('hosts', hosts)
  }
  /** Remove a connection definition, never its remote files. */
  remove = async (name: string): Promise<void> => { await this.form.set('hosts', { ...this.form.getSnapshot().value?.hosts, [name]: null }) }
  /** Close the view's transient dialog. */
  closeDialog = (): void => { this.view.update(state => { state.dialog = null }) }
  /** Show existing workspace metadata without opening or changing a remote session. */
  showDetails = (host: string, group: GroupNode): void => {
    this.view.update(state => { state.dialog = { kind: 'details', host, group } })
  }
  /** Apply the explicitly named row rename. */
  rename = async (title: string): Promise<void> => {
    const dialog = this.view.getSnapshot().dialog
    if (dialog?.kind !== 'rename') return
    if ('workspace' in dialog.target) await this.request(dialog.host, { kind: 'renameWorkspace', workspaceId: dialog.target.workspace as import('@deepseek-ai/dsh-api-workspace-controller/client').WorkspaceId, title })
    else await this.request(dialog.host, { kind: 'renameSession', sessionId: dialog.target.session, title })
    this.closeDialog()
  }
  /** Answer an OpenSSH challenge for the exact host and attempt. */
  authenticate = async (host: string, challenge: string, response: string | null): Promise<void> => { await this.ctx.remote.remoteHosts.respondAuthentication(host, challenge, response) }
}
