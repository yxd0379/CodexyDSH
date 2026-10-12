# @codexydsh/ui-mcp

在 Web 设置中保存 MCP 服务器，并为当前会话的 `/mcp` 命令提供连接/关闭选择菜单。Host 配置行 id 为 `codexy-mcp`，依赖 `@codexydsh/mcp` 的 typed Remote namespace。

保存操作按读取 revision 修改配置；修改已有服务器不会覆盖未重新输入的 env/headers。服务器名创建后不变，删除需要确认。连接菜单显示当前会话的状态和工具数量，其他会话的开关不受影响。

中英文文案由 locale 字典提供。选择操作保留当前会话引用直到 Host 操作完成。
