/** Remote-side adapter: project public Controller state and execute explicit navigation. */
import { useEffect } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { BRIDGE, parseCommand, trustedParent, type RemoteCatalog } from './projects.ts'

export interface EmbeddedLocation { parent: string; channel: string }

/** Standalone remote pages cannot accidentally activate the embed protocol. */
export function embeddedLocation(location: Location, embedded = window.parent !== window): EmbeddedLocation | undefined {
  const hash = new URLSearchParams(location.hash.slice(1))
  const parent = hash.get('codexy-parent')
  const channel = hash.get('codexy-channel')
  if (!embedded || hash.get('codexy-embed') !== '1' || !parent || !trustedParent(parent) || !channel || !/^[a-zA-Z0-9-]{16,128}$/.test(channel)) return
  return { parent, channel }
}

/** Install after public Controller/navigation services exist; no Remote or Connection replacement. */
export function installEmbeddedProjects(ctx: Context, location: EmbeddedLocation): void {
  const send = (payload: Record<string, unknown>): void => { window.parent.postMessage({ bridge: BRIDGE, channel: location.channel, ...payload }, location.parent) }
  let inset = 0
  let disposed = false
  const publish = (): void => {
    const workspaces = ctx.workspaces.list.getSnapshot()
    const sessions = ctx.sessions.list.getSnapshot()
    const archived = new Set(workspaces.archivedSessionIds)
    const pinned = new Set(workspaces.pinnedSessionIds)
    const catalog: RemoteCatalog = {
      projects: workspaces.items.map(project => ({ id: project.workspaceId, title: project.title, path: project.path,
        sessions: project.sessionIds.flatMap(id => {
          const row = sessions.byId[id]
          return row && !row.parentId && row.origin !== 'subagent' ? [{ id, title: row.displayTitle, running: row.running,
            archived: archived.has(id), pinned: pinned.has(id), updatedAt: row.updatedAt, blank: row.blank }] : []
        }),
      })),
      current: Object.values(sessions.byId).find(row => (row.retainedBy.mainView ?? 0) > 0)?.id ?? null,
      ready: workspaces.phase === 'ready' && sessions.phase === 'ready',
      error: workspaces.error ? String(workspaces.error.message) : null,
    }
    send({ type: 'catalog', catalog })
  }
  const handle = async (event: MessageEvent): Promise<void> => {
    if (event.source !== window.parent || event.origin !== location.parent || !event.data || event.data.bridge !== BRIDGE || event.data.channel !== location.channel) return
    if (event.data.type === 'hello') { send({ type: 'inset', width: inset }); publish(); return }
    if (event.data.type !== 'command') return
    const command = parseCommand(event.data.command)
    if (!command) return
    const requestId = typeof event.data.requestId === 'string' ? event.data.requestId : undefined
    try {
      let result: RemoteCatalog['projects'][number] | undefined
      if (command.action === 'createWorkspace') {
        const project = await ctx.workspaces.create({ path: command.path })
        if (!disposed) await ctx.uiWorkspace.openWorkspace(project.workspaceId)
        result = { id: project.workspaceId, title: project.title, path: project.path, sessions: [] }
      } else if (command.action === 'openSession') {
        const session = ctx.sessions.list.getSnapshot().byId[command.id as SessionId]
        if (!session || ctx.workspaces.list.getSnapshot().archivedSessionIds.includes(session.id)) throw new Error('The remote session is no longer available')
        ctx.uiWorkspace.openSession(session.id)
      } else if (command.action === 'renameWorkspace' || command.action === 'removeWorkspace') {
        const project = ctx.workspaces.list.getSnapshot().items.find(item => item.workspaceId === command.id)
        if (!project) throw new Error('The workspace is no longer available')
        if (command.action === 'renameWorkspace') await ctx.workspaces.rename(project.workspaceId, command.title)
        else await ctx.workspaces.delete(project.workspaceId)
      } else if (['renameSession', 'archiveSession', 'unarchiveSession', 'pinSession', 'unpinSession', 'forkSession'].includes(command.action)) {
        const id = command.id as SessionId
        if (!ctx.sessions.list.getSnapshot().byId[id]) throw new Error('The session is no longer available')
        if (command.action === 'renameSession') {
          const reply = await ctx.sessions.using(id, { source: 'workspaceOperation' }, reference => reference.binding.session.rename(command.title))
          if (!reply.ok) throw new Error(reply.error.message)
        } else if (command.action === 'archiveSession') await ctx.uiWorkspace.archiveSession(id)
        else if (command.action === 'unarchiveSession') await ctx.uiWorkspace.unarchiveSession(id)
        else if (command.action === 'pinSession') await ctx.uiWorkspace.pinSession(id)
        else if (command.action === 'unpinSession') await ctx.uiWorkspace.unpinSession(id)
        else await ctx.uiWorkspace.forkSession(id)
      } else {
        const project = ctx.workspaces.list.getSnapshot().items.find(item => item.workspaceId === command.id)
        if (!project) throw new Error('The remote project is no longer available')
        if (command.action === 'newSession') ctx.uiWorkspace.startSession(project.workspaceId as WorkspaceId)
        else await ctx.uiWorkspace.openWorkspace(project.workspaceId)
      }
      if (!disposed) { publish(); if (requestId) send({ type: 'result', requestId, result }) }
    } catch (error) {
      if (!disposed) send(requestId ? { type: 'result', requestId, error: error instanceof Error ? error.message : String(error) }
        : { type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }
  ctx.effect(() => {
    const listener = (event: MessageEvent): void => { void handle(event) }
    window.addEventListener('message', listener)
    const workspace = ctx.workspaces.list.subscribe(publish)
    const sessions = ctx.sessions.list.subscribe(publish)
    send({ type: 'ready' }); publish()
    return () => { disposed = true; window.removeEventListener('message', listener); workspace(); sessions() }
  })
  /** Keep the remote shell's geometry and crop its empty navigation track in the parent. */
  function EmbeddedSidebar({ width, collapsed }: PropsRuntime<'sidebar'>) {
    useEffect(() => { inset = width; send({ type: 'inset', width }); if (!collapsed) ctx.layout.toggleSidebar() }, [width, collapsed])
    return null
  }
  ctx.slots.inject('sidebar', () => ctx.slots.register({ name: 'sidebar', priority: -1000 }, EmbeddedSidebar))
  ctx.slots.inject('shell.leading', () => ctx.slots.register({ name: 'shell.leading', priority: -1000 }, () => null))
}
