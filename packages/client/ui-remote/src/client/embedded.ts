/** Connects a native child Client to its same-origin parent navigation surface. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-shortcuts/client'
import type { GroupNode, SessionNode, WorkspaceSourceSnapshot } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { workspaceDisplayTitle } from '@deepseek-ai/dsh-api-workspace-controller/default-workspace'
import { acceptsFrameOrigin, frameTargetOrigin, requestSchema, type FrameCommand } from './protocol.ts'

/** Read the existing native list projections without retaining or opening listed Sessions. */
export function snapshot(ctx: Context): WorkspaceSourceSnapshot {
  const workspaces = ctx.workspaces.list.getSnapshot()
  const list = ctx.sessions.list.getSnapshot()
  const selected = (ctx.uiSession.adapter.current.getSnapshot().key
    ?? Object.values(list.byId).find(row => (row.retainedBy.mainView ?? 0) > 0)?.id) as SessionId | undefined
  const archived = new Set(workspaces.archivedSessionIds)
  const pinned = new Set(workspaces.pinnedSessionIds)
  const status = ctx.uiSession.sessionStatus.getSnapshot()
  const members = new Set(workspaces.items.flatMap(item => item.sessionIds))
  const rows = (ids: readonly SessionId[]): SessionNode[] => ids.flatMap((id) => {
    const summary = list.byId[id]
    if (summary === undefined || summary.origin === 'subagent' || (summary.blank && id !== selected)) return []
    const state = status.get(id)
    const pending = state?.pendingInteraction?.kind
    const runningSubagentCount = list.projectionsBySession[id]?.values.subagentCatalog?.reduce((count, child) =>
      count + ((status.get(child.id)?.running ?? list.byId[child.id]?.running) === true ? 1 : 0), 0) ?? 0
    return [{ id, title: summary.title ?? '', blank: summary.blank, running: state?.running ?? summary.running,
      runningSubagentCount, completed: state?.completionUnread ?? false,
      pinned: !archived.has(id) && pinned.has(id), archived: archived.has(id), updatedAt: summary.updatedAt,
      ...(pending === 'approval' || pending === 'plan-review' || pending === 'question' ? { pendingInteraction: pending } : {}),
    }]
  })
  const groups: GroupNode[] = workspaces.items.map(item => {
    const sessions = rows(item.sessionIds)
    return { key: item.workspaceId, workspaceId: item.workspaceId, cwd: item.path,
      createdAt: Date.parse(item.createdAt), label: workspaceDisplayTitle(item.title, ctx.locale.bind('workspace')('workspace.defaultName')),
      sessionCount: sessions.length, expanded: true, containsCurrent: selected !== undefined && item.sessionIds.includes(selected), sessions }
  })
  const loose = rows(list.ids.filter(id => !members.has(id)))
  if (loose.length > 0) groups.push({ key: '', workspaceId: undefined, cwd: undefined, createdAt: undefined,
    label: '', sessionCount: loose.length, expanded: true, containsCurrent: loose.some(row => row.id === selected), sessions: loose })
  const home = ctx.remote.$host.home
  return { groups, ...(selected === undefined ? {} : { selectedSessionId: selected }),
    ...(home === undefined ? {} : { home }) }
}

async function execute(ctx: Context, command: FrameCommand): Promise<unknown> {
  switch (command.kind) {
    case 'refresh': return null
    case 'settings': {
      const command = ctx.shortcuts.catalog.getSnapshot().find(entry => entry.id === 'settings.open')
      if (command === undefined) throw new Error('Remote settings are not available')
      ctx.shortcuts.invoke(command.id)
      return null
    }
    case 'open': ctx.uiWorkspace.openSession(command.sessionId); return null
    case 'start': ctx.uiWorkspace.startSession(command.workspaceId, command.options); return null
    case 'renameWorkspace': await ctx.workspaces.rename(command.workspaceId, command.title); return null
    case 'renameSession': {
      const result = await ctx.sessions.using(command.sessionId, { source: 'workspaceOperation' },
        reference => reference.binding.session.rename(command.title))
      if (!result.ok) throw new Error(result.error.message)
      return null
    }
    case 'archiveSession': await ctx.uiWorkspace.archiveSession(command.sessionId); return null
    case 'unarchiveSession': await ctx.uiWorkspace.unarchiveSession(command.sessionId); return null
    case 'listDirectory': return ctx.uiWorkspace.listDirectory(command.path)
    case 'createDirectory': return ctx.uiWorkspace.createDirectory(command.path, command.name)
    case 'createWorkspace': await ctx.workspaces.create({ path: command.path }); return null
  }
}

/** Install frame-local navigation, keeping all conversation and file services on this Host.
 * @param ctx - Native remote Client composition.
 */
export function installEmbedded(ctx: Context): void {
  ctx.layout.setSidebarVisible(false)
  ctx.effect(() => {
    const frameId = crypto.randomUUID()
    let active = true
    let scheduled = false
    const post = (message: object): void => {
      if (active) window.parent.postMessage({ ...message, frameId }, frameTargetOrigin(window.location))
    }
    const publish = (): void => { post({ source: 'codexydsh-child', kind: 'snapshot', value: snapshot(ctx) }) }
    const schedulePublish = (): void => {
      if (scheduled || !active) return
      scheduled = true
      queueMicrotask(() => { scheduled = false; if (active) publish() })
    }
    const receive = (event: MessageEvent<unknown>): void => {
      if (event.source !== window.parent || !acceptsFrameOrigin(event.origin, window.location)) return
      if (typeof event.data === 'object' && event.data !== null && 'source' in event.data
        && event.data.source === 'codexydsh-native-shortcut') {
        const commandId = 'commandId' in event.data ? event.data.commandId : undefined
        const command = ctx.shortcuts.catalog.getSnapshot().find(entry => entry.id === commandId)
        if (command !== undefined) ctx.shortcuts.invoke(command.id)
        return
      }
      const parsed = requestSchema.safeParse(event.data)
      if (!parsed.success) return
      const { id, command, frameId: targetFrameId } = parsed.data
      // Only the side-effect-free readiness probe may precede knowledge of this document identity.
      if (targetFrameId !== frameId && !(targetFrameId === undefined && command.kind === 'refresh')) return
      void execute(ctx, command).then(value => {
        post({ source: 'codexydsh-child', kind: 'result', id, ok: true, value }); publish()
      }, (error: unknown) => { post({ source: 'codexydsh-child', kind: 'result', id, ok: false,
        error: error instanceof Error ? error.message : String(error) }) })
    }
    window.addEventListener('message', receive)
    const stops = [ctx.workspaces.list.subscribe(schedulePublish), ctx.sessions.list.subscribe(schedulePublish),
      ctx.uiSession.adapter.current.subscribe(schedulePublish), ctx.uiSession.sessionStatus.subscribe(schedulePublish),
      ctx.on('connection/reset', schedulePublish)]
    publish()
    return () => { active = false; window.removeEventListener('message', receive); for (const stop of stops) stop(); ctx.layout.setSidebarVisible(true) }
  }, 'remote: embedded native Client navigation')
}
