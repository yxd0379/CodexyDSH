/** Remote connection and workspace settings copy. */
export const zh = {
  title: 'SSH 主机', description: '连接远端工作区，文件、终端和模型请求都由对应主机处理。',
  remoteSettings: '远端设置',
  add: '添加主机', edit: '编辑', remove: '移除', connect: '连接', disconnect: '断开', cancel: '取消',
  save: '保存', name: '名称', host: 'SSH 主机', profile: '远端 profile', home: '远端数据目录（可选）',
  proxy: '远端网络', inherit: '继承远端环境', direct: '直连', custom: 'HTTP 代理', proxyUrl: '代理地址',
  log: '连接日志', noLog: '暂无连接日志。', failed: '连接失败', connecting: '正在连接', connected: '已连接', disconnected: '未连接',
  workspaces: '工作区', show: '在侧栏显示', noWorkspaces: '连接后在这里管理工作区的显示。',
  details: '工作区属性', properties: '属性', path: '路径', machine: '主机', rename: '重命名', close: '关闭',
  unavailable: '远端连接尚未就绪，请查看 SSH 主机的连接日志。', empty: '请选择一个远端工作区。',
  archiveNotice: '归档只隐藏工作区，不删除文件或会话。', invalid: '名称仅允许字母、数字、下划线和短横线；请填写 SSH 主机。',
  saveFailed: '设置未保存，请检查配置后重试。', authentication: 'SSH 认证', answer: '密码或口令', submit: '继续',
} as const
export type RemoteKey = keyof typeof zh
