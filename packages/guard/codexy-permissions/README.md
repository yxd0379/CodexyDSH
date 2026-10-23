# Codexy 权限预设

`codexyPermissions` 配置沙箱、审批策略和审批方式的命名预设。`/permission` 只切换当前会话；设置页决定新会话的默认预设。客户端通过 `permissionPresets/catalog` 获取选项，通过 `permissions` 会话投影读取当前选择。

启用自动审批服务后，`approve-for-me` 显示为“自动审批”：保留工作区沙箱，需要额外权限时由模型审查授权请求。`auto` 在逐工具审查服务启用时可用。恢复这些预设需要对应服务仍可用。产品策略与预设事件使用 Codexy 的持久化记录，沙箱变更通过公开的 DSH 策略接口写入。
