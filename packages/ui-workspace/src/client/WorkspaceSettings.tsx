import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceBrowserSources } from './sources.ts'
import type { createWorkspaceViewStore } from './stores.ts'
import { workspaceDisplayTitle } from '@deepseek-ai/dsh-api-workspace-controller/default-workspace'
import css from './WorkspaceSettings.module.css'

type Injected = {
  hooks: { workspaceCatalog: WorkspaceBrowserSources['workspaces'] }
  location: WorkspaceBrowserSources['location']
  defaultWorkspaceName: () => string
}
type Props = PropsRuntime<'settings.section'> & PropsLocale<'codexy-workspace'>
  & PropsStore<ReturnType<typeof createWorkspaceViewStore>> & InjectFace<Injected>

/** Visibility is a client preference; no host mutation occurs here. */
export function WorkspaceSettings({ useWorkspaceCatalog, useStore, actions, location, defaultWorkspaceName, t }: Props) {
  const workspaces = useWorkspaceCatalog(snapshot => snapshot.items)
  const hidden = useStore(state => state.hiddenWorkspaceIds)
  return <section>
    <p>{t('visibility')}</p>
    <div className={css.list}>
      {workspaces.map(workspace => <label className={css.row} key={workspace.workspaceId}>
        <input type="checkbox" checked={!hidden?.includes(workspace.workspaceId)}
          onChange={event => { actions.setWorkspaceHidden(workspace.workspaceId, !event.target.checked) }} />
        <span className={css.description}>
          <span>{workspaceDisplayTitle(workspace.title, defaultWorkspaceName())} · {location(workspace.workspaceId) || t('local')}</span>
          <span className={css.path}>{workspace.path}</span>
        </span>
      </label>)}
    </div>
  </section>
}
