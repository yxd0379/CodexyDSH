/** Connect remote model snapshots to the workspace UI through its Cordis service. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@codexydsh/ui-workspace/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { WorkspaceSnapshot, WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { RemoteProjects } from './projects.ts'
import type { RemoteClientRuntime } from './runtime.tsx'
import { REMOTE_PANEL } from './projects.ts'

export function installRemoteWorkspaceSources(ctx: Context, projects: RemoteProjects, reportError: (error: unknown) => void,
  statusLabel: (state: 'connecting' | 'disconnected') => string): void {
  ctx.effect(() => {
    const registrations = new Map<string, { update(): void; dispose(): void }>()
    const register = (name: string) => {
      const workspaces = createSnapshotStore<WorkspaceSnapshot>({
        items: [], archivedSessionIds: [], pinnedSessionIds: [], phase: 'ready', state: 'idle', error: null,
      })
      const sessions = createSnapshotStore<SessionListState>({ ids: [], byId: {}, projectionsBySession: {}, phase: 'ready' })
      const statuses = createSnapshotStore<SessionStatusSnapshot>(new Map())
      let bound: RemoteClientRuntime | undefined
      let connecting = 0
      let stops: (() => void)[] = []
      const withRemote = async <T>(action: (remote: Context) => T | Promise<T>): Promise<T> => {
        if (bound) return action(bound.ctx)
        connecting++
        workspaces.set({ ...workspaces.getSnapshot() })
        try { return await action((await projects.ensureReady(name)).ctx) }
        finally { connecting--; workspaces.set({ ...workspaces.getSnapshot() }) }
      }
      const run = (action: (remote: Context) => void): void => { void withRemote(action).catch(reportError) }
      const dispose = ctx.workspaceBrowser.register(name, {
        label: name, workspaces, sessions, statuses,
        availability: () => bound ? undefined : { state: connecting ? 'connecting' : 'offline', label: statusLabel(connecting ? 'connecting' : 'disconnected') },
        active: {
          getSnapshot: () => ctx.layout.panelInfo.getSnapshot().activePanelId === REMOTE_PANEL && projects.state.getSnapshot().active === name,
          subscribe: listener => {
            const stopState = projects.state.subscribe(listener), stopPanel = ctx.layout.panelInfo.subscribe(listener)
            return () => { stopState(); stopPanel() }
          },
        },
        prepareWorkspace: () => { run(() => {}) },
        open: id => { run(remote => { remote.uiWorkspace.openSession(id); projects.activate(name) }) },
        start: (id, options) => { run(remote => { remote.uiWorkspace.startSession(id, options); projects.activate(name) }) },
        renameWorkspace: (id, title) => withRemote(async remote => { await remote.workspaces.rename(id, title) }),
        removeWorkspace: id => withRemote(remote => remote.workspaces.delete(id)),
        reorderWorkspace: (id, before) => withRemote(remote => remote.workspaces.insertBefore(id, before)),
        renameSession: (id, title) => withRemote(async remote => {
          const result = await remote.sessions.using(id, { source: 'workspaceOperation' }, ref => ref.binding.session.rename(title))
          if (!result.ok) throw new Error(result.error.message)
        }),
        forkSession: (id, onCreated, options) => withRemote(remote => remote.uiWorkspace.forkSession(id, onCreated, options)),
        archiveSession: (id, options) => withRemote(remote => remote.uiWorkspace.archiveSession(id, options)),
        unarchiveSession: id => withRemote(remote => remote.uiWorkspace.unarchiveSession(id)),
        pinSession: id => withRemote(remote => remote.uiWorkspace.pinSession(id)),
        unpinSession: id => withRemote(remote => remote.uiWorkspace.unpinSession(id)),
        search: async (query, signal) => {
          // Searching local history must not start every disconnected SSH host.
          if (!bound) return { items: [], hasMore: false }
          const result = await bound.ctx.sessions.search(query, signal)
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
      })
      const update = (): void => {
        const runtime = projects.state.getSnapshot().runtimes.find(entry => entry.name === name && entry.phase === 'ready')?.runtime
        if (runtime !== bound) {
          for (const stop of stops) stop()
          stops = []
          bound = runtime
          if (runtime) {
            const remote = runtime.ctx
            const publish = (): void => {
              const snapshot = remote.workspaces.list.getSnapshot()
              if (snapshot.phase === 'ready') workspaces.set(snapshot)
              sessions.set(remote.sessions.list.getSnapshot())
              statuses.set(remote.uiSession.sessionStatus.getSnapshot())
            }
            stops = [remote.workspaces.list, remote.sessions.list, remote.uiSession.sessionStatus].map(source => source.subscribe(publish))
            publish()
          } else {
            sessions.set({ ids: [], byId: {}, projectionsBySession: {}, phase: 'ready' })
            statuses.set(new Map())
          }
        }
        if (!runtime) {
          // Keep durable workspace identity visible; do not invent remote Session state.
          const refs = projects.workspaces.getSnapshot().filter(item => item.host === name)
          workspaces.set({
            items: refs.map(ref => ({ workspaceId: ref.workspaceId as WorkspaceId, title: ref.title, path: ref.path, sessionIds: [],
              createdAt: ref.createdAt ?? '', updatedAt: ref.updatedAt ?? '' })),
            archivedSessionIds: [], pinnedSessionIds: [], phase: 'ready', state: 'idle', error: null,
          })
        }
      }
      return { update, dispose: () => { for (const stop of stops) stop(); dispose() } }
    }
    const reconcile = (): void => {
      const names = new Set([
        ...projects.workspaces.getSnapshot().map(item => item.host),
        ...projects.state.getSnapshot().runtimes.map(entry => entry.name),
      ])
      for (const name of names) {
        let registration = registrations.get(name)
        if (!registration) { registration = register(name); registrations.set(name, registration) }
        registration.update()
      }
      for (const [name, registration] of registrations) {
        if (names.has(name)) continue
        registration.dispose()
        registrations.delete(name)
      }
    }
    const stopState = projects.state.subscribe(reconcile)
    const stopWorkspaces = projects.workspaces.subscribe(reconcile)
    reconcile()
    return () => {
      stopState(); stopWorkspaces()
      for (const registration of registrations.values()) registration.dispose()
    }
  })
}
