/** Product workspace controls, separate from the upstream dictionary. */
export const zh = {
  settings: '工作区',
  visibility: '选择在首页显示的工作区。归档不会删除会话、改变会话的归档状态或停止任务。此设置仅保存在当前客户端。',
  archive: '归档工作区',
  includeHidden: '搜索包含已归档工作区',
  details: '工作区详情',
  host: '位置',
  path: '文件夹',
  status: '连接状态',
  local: '本机',
  connected: '已连接',
}
export const en: Record<keyof typeof zh, string> = {
  settings: 'Workspaces',
  visibility: 'Choose workspaces to show on the home page. Archiving does not delete sessions, change their archive state, or stop tasks. This preference is saved only in this client.',
  archive: 'Archive workspace',
  includeHidden: 'Include archived workspaces in search',
  details: 'Workspace details',
  host: 'Location',
  path: 'Folder',
  status: 'Connection status',
  local: 'This computer',
  connected: 'Connected',
}
export type WorkspaceLabels = typeof zh
