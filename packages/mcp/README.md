# @codexydsh/mcp

保存 MCP stdio/Streamable HTTP 服务器目录，通过 `/mcp` 或 `/mcp on|off <server>` 选择当前会话的连接。每个会话各自拥有连接、工具与 server instructions；成功的命令选择从会话日志恢复，失败与未完成的命令不改变已保存选择。

配置行 id 为 `codexy-mcp`，`servers` 为可实时编辑目录；删除继承定义使用 `null`。自动连接默认关闭。env 和 headers 是只写凭据字段，Settings 读取不会返回其值。

Settings schema 可在浏览器重建；字段使用声明式校验，目录 key 与 `serverName` 的关联在加载和配置提交前校验。

DSH 0.2.1-alpha.2 未公开连接状态控制接口，因此连接与重连监督由本包拥有；工具结果、图片和输出投影复用原版 DSH 的公开 `createMcpToolDefinition`。本包不替换或补丁 `@deepseek-ai/dsh-mcp-client`。

卸载、关闭会话和配置替换会关闭 MCP transport 并取消其工具和资源贡献；协商中的连接同样参与 teardown。
