/** A single workspace browser whose actions stay on the workspace's owning host. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { RemoteProjects, RemoteWorkspaceRef } from './projects.ts'
import { REMOTE_PANEL } from './projects.ts'
import type { RemoteSettings } from './model.ts'
import { draftOf, draftOperations } from './model.ts'
import { UnifiedWorkspaces, type UnifiedWorkspaceSnapshot, type UnifiedWorkspaceRow, type UnifiedWorkspaceSession, type UnifiedWorkspacesInjected } from './UnifiedWorkspaces.tsx'

/** Register one shared list after the native local workspace services are ready. */
export function installUnifiedWorkspaces(ctx: Context, projects: RemoteProjects, form: ConfigForm<RemoteSettings>): void {
  const state = createSnapshotStore<UnifiedWorkspaceSnapshot>({ items: [], hosts: [] })
  const local = ctx.workspaces
  const sessions = ctx.sessions
  const navigation = ctx.uiWorkspace
  const ref = (row: UnifiedWorkspaceRow): RemoteWorkspaceRef => ({ host: row.host!, workspaceId: row.id, title: row.title, path: row.path })
  const useLocal = (): void => { if (ctx.layout.panelInfo.getSnapshot().activePanelId === REMOTE_PANEL) ctx.layout.selectPanel(null) }
  const publish = (): void => {
    const workspaces = local.list.getSnapshot()
    const sessionList = sessions.list.getSnapshot()
    const localActive = ctx.layout.panelInfo.getSnapshot().activePanelId !== REMOTE_PANEL
    const archived = new Set(workspaces.archivedSessionIds)
    const pinned = new Set(workspaces.pinnedSessionIds)
    const item = (id: SessionId): UnifiedWorkspaceSession | undefined => {
      const session = sessionList.byId[id]
      if (!session || session.parentId || session.origin === 'subagent') return
      const active = localActive && (session.retainedBy.mainView ?? 0) > 0
      if (session.blank && !active) return
      return { key: `local:${id}`, id, title: session.displayTitle, running: session.running, active,
        pinned: pinned.has(id), archived: archived.has(id), updatedAt: session.updatedAt }
    }
    const items: UnifiedWorkspaceRow[] = workspaces.items.map(workspace => ({ key: `local:${workspace.workspaceId}`,
      id: workspace.workspaceId, title: workspace.title === 'default-workspace' ? '默认工作区' : workspace.title || workspace.path.split('/').filter(Boolean).at(-1) || '工作区', path: workspace.path,
      sessions: workspace.sessionIds.flatMap(id => { const value = item(id); return value ? [value] : [] }) }))
    const accounted = new Set(workspaces.items.flatMap(workspace => workspace.sessionIds))
    const ungrouped = sessionList.ids.filter(id => !accounted.has(id)).flatMap(id => { const value = item(id); return value ? [value] : [] })
    if (ungrouped.length) items.push({ key: 'local:ungrouped', id: '', title: '未分组', path: '', sessions: ungrouped })
    const selected = projects.state.getSnapshot()
    for (const workspace of projects.workspaces.getSnapshot()) items.push({ key: workspace.key, id: workspace.workspaceId,
      title: workspace.title === 'default-workspace' ? '默认工作区' : workspace.title || workspace.path.split('/').filter(Boolean).at(-1) || '工作区', path: workspace.path, host: workspace.host,
      connected: workspace.connected, error: workspace.error ?? undefined,
      sessions: workspace.sessions.filter(session => !session.blank || workspace.currentSession === session.id).map(session => ({
        key: `${workspace.key}:${session.id}`, id: session.id, title: session.title, running: session.running,
        active: !localActive && selected.active === workspace.host && workspace.currentSession === session.id,
        pinned: session.pinned, archived: session.archived, updatedAt: session.updatedAt,
      })) })
    state.set({ items, hosts: Object.entries(form.getSnapshot().value?.hosts ?? {}).flatMap(([name, host]) => host ? [{ name, label: host.host }] : []),
      loading: workspaces.phase !== 'ready', error: workspaces.error?.message })
  }
  const remoteAction = async (row: UnifiedWorkspaceRow, action: Parameters<RemoteProjects['request']>[1]): Promise<void> => { await projects.request(row.host!, action) }
  const injected: UnifiedWorkspacesInjected = {
    hooks: { unifiedWorkspaces: state },
    openWorkspace: async row => { if (row.host) await projects.openWorkspace(ref(row)); else if (row.id) { useLocal(); await navigation.openWorkspace(row.id as WorkspaceId) } },
    openSession: async (row, session) => { if (row.host) await projects.openSession(ref(row), session.id); else { useLocal(); navigation.openSession(session.id as SessionId) } },
    newSession: async row => { if (row.host) await projects.newSession(ref(row)); else { useLocal(); navigation.startSession((row.id || undefined) as WorkspaceId | undefined) } },
    renameWorkspace: async (row, title) => { if (row.host) await remoteAction(row, { action: 'renameWorkspace', id: row.id, title }); else await local.rename(row.id as WorkspaceId, title) },
    removeWorkspace: async row => { if (row.host) await remoteAction(row, { action: 'removeWorkspace', id: row.id }); else await local.delete(row.id as WorkspaceId) },
    renameSession: async (row, session, title) => {
      if (row.host) return remoteAction(row, { action: 'renameSession', id: session.id, title })
      const result = await sessions.using(session.id as SessionId, { source: 'workspaceOperation' }, reference => reference.binding.session.rename(title))
      if (!result.ok) throw new Error(result.error.message)
    },
    forkSession: async (row, session) => { if (row.host) await remoteAction(row, { action: 'forkSession', id: session.id }); else await navigation.forkSession(session.id as SessionId) },
    pinSession: async (row, session, pinned) => {
      if (row.host) await remoteAction(row, { action: pinned ? 'pinSession' : 'unpinSession', id: session.id })
      else if (pinned) await navigation.pinSession(session.id as SessionId); else await navigation.unpinSession(session.id as SessionId)
    },
    archiveSession: async (row, session, archived) => {
      if (row.host) await remoteAction(row, { action: archived ? 'archiveSession' : 'unarchiveSession', id: session.id })
      else if (archived) await navigation.archiveSession(session.id as SessionId); else await navigation.unarchiveSession(session.id as SessionId)
    },
    pickLocalDirectory: () => navigation.pickDirectory(),
    createWorkspace: async input => {
      let host = input.host
      if (input.newHost) {
        const snapshot = form.getSnapshot()
        if (snapshot.revision === undefined || !snapshot.writable) throw new Error('主机配置暂时不可用')
        host = Object.entries(snapshot.value?.hosts ?? {}).find(([, value]) => value?.host === input.newHost)?.[0]
        if (!host) {
          const base = input.newHost.replace(/[^A-Za-z0-9_-]/gu, '-').replace(/^-+/u, '').slice(0, 50) || 'remote'
          host = base
          for (let n = 2; snapshot.value?.hosts[host]; n++) host = `${base}-${n}`
          const draft = { ...draftOf(snapshot.revision), name: host, host: input.newHost }
          if (!await form.mutate(draftOperations(draft), snapshot.revision)) throw new Error('主机配置未能保存，请重试')
        }
      }
      if (host) await projects.createWorkspace(host, input.path)
      else { const workspace = await local.create({ path: input.path }); useLocal(); await navigation.openWorkspace(workspace.workspaceId) }
    },
  }
  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register({ name: 'sidebar.workspaces', priority: -1000, inject: () => injected }, UnifiedWorkspaces))
  ctx.effect(() => {
    const dispose = [local.list.subscribe(publish), sessions.list.subscribe(publish), projects.workspaces.subscribe(publish),
      projects.state.subscribe(publish), form.subscribe(publish), ctx.layout.panelInfo.subscribe(publish)]
    publish()
    return () => { for (const stop of dispose) stop() }
  })
}
