---
kind: upgrade-guide
description: CodexyDSH 使用独立的应用数据、Web 端口和桌面命令。
---

# 独立的 CodexyDSH 应用

## 变更

CodexyDSH 默认使用 `~/.codexydsh`，不再使用官方应用的 `~/.dsh`。Web 默认端口为 `3082`。桌面端使用 `CodexyDSH` 应用身份、`io.codexydsh.desktop` 应用 ID、`codexydsh://` 协议和 `codexydsh` 终端命令。仓库内部保留现有的 `dsh` profile 启动链。

显式指定的 `DSH_HOME`、Web 端口和 Electron 用户数据路径仍然有效。应用不会自动导入官方 DSH 的 profile、凭据或对话。会话存储保留 Harness 格式，不启用旧 Codexy 专有文件存储。

桌面更新没有默认下载源。打包时可显式指定 `DOWNLOAD_TEST_ORIGIN` 或 `DOWNLOAD_PROD_ORIGIN`；未指定时，即使签名构建也不发布更新元数据。账号授权成功后，通过已有的账号状态通知激活独立应用自己的窗口。

<a id="持久化变更确认"></a>

持久化变更确认：原生 v4 事件封装和对话事件保持不变。本构建新增必需的 `codexy/fact` 事件，记录产品元数据，包括原生请求头无法表示的完整 Codex 请求控制参数，并将该事件登记到生成的读取词表中。较旧的官方读取器会拒绝该事件，不会悄悄丢弃必需事实。这是通过事件标签区分的同版本扩展，不代表官方 DSH 能读取 Codexy 对话。已移除能力的事件标签不属于本构建生成的词表。本次不重写或导入任何已有会话。

隔离的冷恢复回归会写入原生对话事件与产品事实，关闭所有 writer，再用新 context 打开 JSONL 并比较恢复后的历史，不使用用户会话。

## 迁移

1. 保持官方 DSH 安装和数据不变，不要为此 fork 向其中安装旧 Codexy 插件。
2. 如果 shell 的 `DSH_HOME` 指向 `~/.dsh`，请移除该覆盖，或显式选择一个独立目录。在独立应用的设置中配置模型。
3. 使用 CodexyDSH 桌面应用或仓库已有的 profile 启动方式。桌面终端集成注册 `codexydsh`，不修改已有的 `dsh` 命令。
4. 确认新应用使用独立数据目录和 Web 监听地址。官方对话仍可通过官方应用访问；本次更改不执行数据迁移。
