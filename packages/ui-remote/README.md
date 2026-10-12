# @codexydsh/ui-remote

在 Web 设置中编辑 SSH 主机，连接、取消连接、打开远端页面和断开本地转发。Host 配置行 id 为 `codexy-remote`，依赖 `@codexydsh/remote` 的 Client 状态模型。

编辑使用读取时的配置 revision；失败保留草稿并在编辑器显示原因，删除需要确认。命令行或 home 覆盖的配置由上游设置服务拒绝保存。连接操作在用户手势中打开等待页面，Host 返回地址后导航；失败关闭等待页并显示提示。远端页面显示主机身份及现有连接状态。

界面文案通过中英文 locale 字典提供。本包不构造模型请求。
