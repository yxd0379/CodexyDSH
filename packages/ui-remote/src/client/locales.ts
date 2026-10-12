/** Remote settings and host identity copy. */
export const zh = {
  title: 'Remote', description: '通过 SSH 启动远端 dsh，连接后在独立页面使用远端项目和会话',
  prerequisites: '先在本地终端确认 SSH 免密连接可用，并在远端安装 Node 和 dsh；可直接填写 SSH 配置中的主机别名',
  empty: '还没有配置远端主机', unavailable: '当前无法保存主机配置',
  name: '主机名称', host: 'SSH 主机', profile: '远端 profile', directory: '初始远端目录（可选）',
  node: '远端 Node 命令或路径', dsh: '远端 dsh 命令或路径',
  add: '添加主机', edit: '编辑', remove: '删除', confirmRemove: '确认删除', cancel: '取消', save: '保存',
  connect: '连接', disconnect: '断开连接', cancelConnection: '取消连接', open: '打开远端', retry: '重试',
  disconnected: '未连接', connecting: '正在连接', connected: '已连接', failed: '连接失败',
  disconnectHint: '断开只关闭本地连接，远端 dsh 和任务继续运行',
  saved: '主机配置已保存', removed: '主机配置已删除', connectionReady: '远端已连接', connectionClosed: '本地连接已断开',
  operationFailed: '操作失败：{message}', observationFailed: '无法读取连接状态：{message}',
  duplicate: '已存在同名主机', rejected: '配置未能保存，请检查是否被覆盖，或重新打开编辑器后重试',
  invalidName: '主机名称须为 1–64 位字母、数字、下划线或连字符，并以字母或数字开头',
  invalidHost: '填写 SSH 主机别名或 user@host，不能包含空白或以连字符开头',
  invalidProfile: '填写有效的远端 Web profile 名称', invalidDirectory: '远端目录须为绝对路径',
  invalidExecutable: '填写有效的远端命令或文件路径', remoteIdentity: 'SSH：{host}', noUrl: '远端连接未提供可用地址',
} as const

/** English dictionary with the same field and feedback keys. */
export const en: Record<keyof typeof zh, string> = {
  title: 'Remote', description: 'Start dsh over SSH and use remote projects and sessions in a separate page.',
  prerequisites: 'Verify key-based SSH access in your local terminal and install Node and dsh remotely. SSH configuration aliases are supported.',
  empty: 'No remote hosts configured', unavailable: 'Host configuration cannot be saved right now',
  name: 'Host name', host: 'SSH host', profile: 'Remote profile', directory: 'Initial remote directory (optional)',
  node: 'Remote Node command or path', dsh: 'Remote dsh command or path',
  add: 'Add host', edit: 'Edit', remove: 'Delete', confirmRemove: 'Confirm delete', cancel: 'Cancel', save: 'Save',
  connect: 'Connect', disconnect: 'Disconnect', cancelConnection: 'Cancel connection', open: 'Open remote', retry: 'Retry',
  disconnected: 'Disconnected', connecting: 'Connecting', connected: 'Connected', failed: 'Connection failed',
  disconnectHint: 'Disconnect closes the local connection. Remote dsh and its tasks keep running.',
  saved: 'Host configuration saved', removed: 'Host configuration deleted', connectionReady: 'Remote connected', connectionClosed: 'Local connection disconnected',
  operationFailed: 'Operation failed: {message}', observationFailed: 'Cannot read connection status: {message}',
  duplicate: 'A host with this name already exists', rejected: 'Configuration was not saved. Check for overrides or reopen the editor and try again.',
  invalidName: 'Use 1–64 letters, digits, underscores, or hyphens, starting with a letter or digit',
  invalidHost: 'Enter an SSH alias or user@host without whitespace or a leading hyphen',
  invalidProfile: 'Enter a valid remote Web profile name', invalidDirectory: 'Use an absolute remote directory path',
  invalidExecutable: 'Enter a valid remote command or file path', remoteIdentity: 'SSH: {host}', noUrl: 'The remote connection did not provide an address',
}
