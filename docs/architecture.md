# CodexyDSH 架构

CodexyDSH 是通过 Cordis 插件组合的独立应用。本次迁移从减负后的 Harness 分支 `dsh-slim`（`133b7259`）出发，将 `origin/main`（`a2fa4d39`）的后端放入同一套分组工作区，不再向官方 DSH 安装覆盖层。

## 应用启动

沿用 `dsh` 启动器：读取 profile、组合 bundle patch，再由 Cordis 按依赖加载服务。Web 选择 `@codexydsh/base` 和 `@codexydsh/web`，headless 选择相同 base 和 `@codexydsh/headless`。桌面端通过已有的子进程启动器运行该 Web profile，不另写产品启动框架或包私有应用入口。

| 职责 | 实现 |
| --- | --- |
| Agent 创建、输入队列、活动 Session 所有权 | 共享 Harness agent registry |
| 请求准备、循环、工具、compact、审查 | Codexy 后端包 |
| 持久化历史、文件、恢复、投影 | 共享 Harness Session 与 JSONL 服务 |
| HTTP、类型化 RPC、上传、工作区浏览 | Harness Host/API 服务与产品 Remote provider |
| 浏览器交互与布局 | 原生 Harness 客户端包，不迁旧 Codexy `ui-*` |
| 桌面生命周期、IPC、打包运行时 | 已有桌面壳与独立产品身份 |

权限和子 agent 的活动 Remote 方法分别只有一个 owner，即产品 provider。API 组装选择其生成的客户端贡献，保留原命名空间。人工审批使用原生 `approval/request` 事件与 UI，私有自动审查仍由产品提供。

## Session 与存储

原生 v4 Session 保存普通 system、user、assistant 和工具事件。必需的 `codexy/fact` 保存产品专有请求与恢复元数据，不给原生事件封装增加字段。产品读取器投影这些事实，原生视图继续读取标准对话。生成的事件词表包含产品标签。兼容性见[持久化变更确认](upgrade-guide/v0.2.1-rc.2/independent-product/guide.md#持久化变更确认)。

不挂载旧 Codexy 存储 provider 和导入工具，初始化不迁移已有官方或远端 Session。插件配置与辅助存储通过共享 storage 服务落在独立数据目录。

## 产品隔离

默认数据目录为 `~/.codexydsh`，Web 默认端口为 `3082`。桌面端在获取单实例锁前选定独立 Electron 用户目录，使用 `io.codexydsh.desktop`，注册 `codexydsh://` 与 `codexydsh` 终端命令。显式环境变量与启动参数仍然有效。

模型请求由运行 agent 的进程发出。本机与远端工作区使用相同的原生侧栏，但每个主机保留自己完整的 Client、Session Controller、上传、文件资源和终端。选择本机工作区时，已连接的远端文档仍保持挂载；导航消息指向所属窗口和文档，不切换全局 Host transport。浏览器偏好按文档部署目录区分。

本机 Host 通过 OpenSSH 部署按内容哈希缓存的 Linux ARM64 服务包，复用已完成的相同部署和运行服务，并在同源路径下转发已认证的 HTTP 与 WebSocket。SSH 主机设置提供密码或密钥口令询问及有长度限制的连接日志。远端使用自己的产品目录和模型配置；旧安装器和模块图覆盖仍未挂载，新 Remote 使用正常 profile 启动器与原生 Client 组合。

## 源码与产物

保留 Harness 包分组与编译分面。运行时使用 workspace 依赖，检查使用源码别名，启动使用构建后的 `lib` 导出。Host 与 Client TypeScript 程序分离；Client 类型导出不能带入 Host Context 声明。Typert 根据服务声明生成 RPC 产物，不使用手写替代物。
