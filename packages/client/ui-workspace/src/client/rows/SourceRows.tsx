/** Other Workspace sources reuse the native rows without entering local Controllers or action slots. */
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceBrowserProps } from '../contract/slots.ts'
import type { WorkspaceSourceView } from '../sources.ts'
import type { ArchivedFilter } from '../tree.ts'
import { ProjectRowItem, SessionNodeItem } from './Rows.tsx'
import css from './WorkspaceBrowser.module.css'

export interface SourceRowsProps extends Pick<WorkspaceBrowserProps, 'sourceActions' | 't'>,
  PropsRenderSlots<'sidebar.workspaces.session.menu.item' | 'sidebar.workspaces.session.row.action'
    | 'sidebar.session.row.leading' | 'sidebar.session.row.hover'> {
  readonly sourceViews: readonly WorkspaceSourceView[]
}

/** Apply browser search and Session archive visibility without changing source-owned membership. */
export function visibleSourceViews(
  sources: readonly WorkspaceSourceView[], archivedFilter: ArchivedFilter, query: string,
): readonly WorkspaceSourceView[] {
  const needle = query.toLocaleLowerCase()
  return sources.map(source => ({
    ...source,
    groups: source.groups.flatMap(group => {
      const groupMatch = `${source.label} ${group.label} ${group.cwd ?? ''}`.toLocaleLowerCase().includes(needle)
      const sessions = group.sessions.filter(session => {
        const visible = archivedFilter === 'show' || (archivedFilter === 'only' ? session.archived : !session.archived)
        return visible && (needle === '' || groupMatch || session.title.toLocaleLowerCase().includes(needle))
      })
      if (archivedFilter === 'only' && sessions.length === 0) return []
      if (needle !== '' && !groupMatch && sessions.length === 0) return []
      return [{ ...group, sessions, expanded: needle === '' ? group.expanded : true }]
    }),
  }))
}

/** Source-qualified identities keep equal remote and local ids independent during native row animation. */
export function sourceRowKeys(sources: readonly WorkspaceSourceView[]): readonly string[] {
  return sources.flatMap(source => source.groups.flatMap(group => [
    `source:${source.id}:workspace:${group.key}`,
    ...(group.expanded ? group.sessions.map(session => `source:${source.id}:session:${session.id}`) : []),
  ]))
}

/** Native ProjectRowItem and SessionNodeItem, with every gesture explicitly routed back to its owner. */
export function SourceWorkspaceRows({ sourceViews, sourceActions, renderSlot, t }: SourceRowsProps) {
  const now = Date.now()
  return sourceViews.map(source => source.groups.map(group => (
    <div key={`${source.id}:${group.key}`} className={css.groupSection} data-workspace-source={source.id}>
      <ProjectRowItem group={group} hostBadge={source.label} home={source.home}
        rowKey={`source:${source.id}:workspace:${group.key}`}
        onToggle={() => { sourceActions(source.id)?.toggleWorkspace(group.key) }}
        onCreate={() => { sourceActions(source.id)?.startSession(group.workspaceId) }}
        actions={{
          rename: () => { sourceActions(source.id)?.renameWorkspace(group) },
          archive: () => { sourceActions(source.id)?.archiveWorkspace(group) },
          details: () => { sourceActions(source.id)?.showWorkspaceDetails(group) },
        }} t={t} />
      {group.expanded && group.sessions.map(node => (
        <SessionNodeItem key={node.id} node={node} currentId={source.selectedSessionId} now={now}
          rowKey={`source:${source.id}:session:${node.id}`}
          onOpen={id => { sourceActions(source.id)?.openSession(id) }}
          onRenameRequest={(id, title) => { sourceActions(source.id)?.renameSession(id, title) }}
          externalActions={{
            renameSession: (id, title) => { sourceActions(source.id)?.renameSession(id, title) },
            archiveSession: id => { sourceActions(source.id)?.archiveSession(id) },
            unarchiveSession: id => { sourceActions(source.id)?.unarchiveSession(id) },
          }} renderSlot={renderSlot} t={t} />
      ))}
    </div>
  )))
}
