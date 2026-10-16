# @codexydsh/remote

在本地通过 OpenSSH 启动或重新找到远端 `dsh --profile codexy`，建立仅监听本地回环地址的 HTTP/WebSocket 转发。默认自动同步当前安装的产品发布包并安装独立 Node/DSH，仅支持 Linux ARM64、glibc ≥ 2.28；其他平台在写入前报错。远端需具备 curl、tar、sha256sum 和 Node/npm 下载网络。本机沿用 SSH 配置与 known_hosts；支持密钥/agent，也支持弹窗输入密码、私钥口令或验证码，不要求免密、不保存认证输入。`deployment: existing` 保留使用预装服务端的方式。

Host 服务保存可实时编辑的 `hosts` 目录并提供 `remoteHosts` Remote namespace；Client 提供共享连接状态模型。断开连接关闭本地 SSH、转发和监听器，远端进程、项目和会话继续存在；再次连接复用远端部署。

SSH 主机设置中的「连接日志」显示当前阶段和本次连接输出。同一发布包重连不下载或安装；产品更新只同步产品包，并复用版本一致的 Node/DSH 基础运行时。安装使用随进程退出释放的系统锁，中断的旧安装锁会保留到诊断备份后重试。远端需提供 `flock`。

每台 SSH 主机可选择继承远端代理环境（默认）、指定 HTTP(S) 代理或直连。指定代理用于远端 DSH 及管理安装时的下载，不改变本机网络；地址中的 `127.0.0.1` 指远端机器。代理路由由上游 DSH 的标准环境变量机制处理，回环流量始终直连。配置保存在本机主机设置，代理凭据如同其他配置以明文保存；连接日志隐藏 URL 中的口令和启动 token，并显示 SSH 参数（内嵌脚本以名称缩写）及 DSH 启动命令。修改后重连会在没有运行中任务时重启远端 Host，无需重新下载同版本服务端。

主机名、可执行文件和路径使用可序列化的 Settings schema，浏览器能重建表单校验并显示当前目录。

本地和远端暂限 Linux/macOS。启动与转发有超时和输出上限；配置改变、取消或插件卸载会等待本地资源退出。错误中隐藏认证 token，子进程环境过滤凭据。

本包基于 DSH 0.2.1-alpha.2 的公开 Cordis、Typert、Settings 和 Gateway API。默认远端 profile 为 `codexy`，没有回退到普通 Web 的路径。
