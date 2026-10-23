/** 工作区显示偏好与属性；归档仅隐藏侧栏，不触碰 Host 或 Session 数据。 */
import { useState } from 'react'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { workspaceDisplayTitle } from '@deepseek-ai/dsh-api-workspace-controller/default-workspace'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { WorkspaceViewStoreHandle } from './contract/slots.ts'
import css from './WorkspaceManagement.module.css'

export type WorkspaceManagementProps = PropsRuntime<'settings.section'> & PropsLocale<'workspace'>
  & PropsStore<WorkspaceViewStoreHandle> & PropsRenderSlots<'settings.workspaces.source'>

/** 本机和其他来源共用同一原生工作区设置页。 */
export function WorkspaceManagement({ useWorkspaces, useStore, actions, renderSlot, t }: WorkspaceManagementProps) {
  const workspaces = useWorkspaces(state => state.items)
  const phase = useWorkspaces(state => state.phase)
  const archived = useStore(state => state.archivedWorkspaceIds)
  const [details, setDetails] = useState<WorkspaceView | null>(null)
  return <section className={css.section}>
    <p className={css.description}>归档工作区只将其从侧栏隐藏，不会停止对话、归档会话或删除文件。可随时在这里恢复显示。</p>
    <h3 className={css.heading}>本机</h3>
    {workspaces.map(workspace => {
      const title = workspaceDisplayTitle(workspace.title, t('workspace.defaultName'))
      return <div className={css.row} key={workspace.workspaceId}>
        <label className={css.workspace}>
          <input type="checkbox" checked={!archived?.includes(workspace.workspaceId)}
            aria-label={`在侧栏显示 本机: ${title}`}
            onChange={event => { actions.setWorkspaceVisible(workspace.workspaceId, event.target.checked) }} />
          <span className={css.name}>{title}<small className={css.path}>{workspace.path}</small></span>
        </label>
        <Button onClick={() => { setDetails(workspace) }}>{t('workspace.details')}</Button>
      </div>
    })}
    {workspaces.length === 0 && <p className={css.description}>{phase === 'ready' ? '暂无本机工作区。' : '正在加载工作区…'}</p>}
    {renderSlot('settings.workspaces.source', {})}
    <WorkspaceDetails workspace={details} onClose={() => { setDetails(null) }} />
  </section>
}

/** 属性读取现有注册信息，不为显示属性而打开或保留会话。 */
export function WorkspaceDetails({ workspace, onClose }: { workspace: WorkspaceView | null; onClose: () => void }) {
  if (workspace === null) return null
  return <Modal open onClose={onClose} title="工作区属性" closeLabel="关闭">
    <dl className={css.details}>
      <dt>名称</dt><dd>{workspaceDisplayTitle(workspace.title, '默认工作区')}</dd>
      <dt>主机</dt><dd>本机</dd>
      <dt>路径</dt><dd>{workspace.path}</dd>
      <dt>会话</dt><dd>{workspace.sessionIds.length} 个</dd>
    </dl>
  </Modal>
}
