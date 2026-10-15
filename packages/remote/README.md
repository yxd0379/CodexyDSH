# @codexydsh/remote

在本地通过 OpenSSH 启动或重新找到远端 `dsh --profile codexy`，建立仅监听本地回环地址的 HTTP/WebSocket 转发。默认自动同步当前安装的产品发布包并安装独立 Node/DSH，仅支持 Linux ARM64、glibc ≥ 2.28；其他平台在写入前报错。远端需具备 curl、tar、sha256sum 和 Node/npm 下载网络。本机沿用 SSH 配置与 known_hosts；支持密钥/agent，也支持弹窗输入密码、私钥口令或验证码，不要求免密、不保存认证输入。`deployment: existing` 保留使用预装服务端的方式。

Host 服务保存可实时编辑的 `hosts` 目录并提供 `remoteHosts` Remote namespace；Client 提供共享连接状态模型。断开连接关闭本地 SSH、转发和监听器，远端进程、项目和会话继续存在；再次连接复用远端部署。

主机名、可执行文件和路径使用可序列化的 Settings schema，浏览器能重建表单校验并显示当前目录。

本地和远端暂限 Linux/macOS。启动与转发有超时和输出上限；配置改变、取消或插件卸载会等待本地资源退出。错误中隐藏认证 token，子进程环境过滤凭据。

本包基于 DSH 0.2.1-alpha.2 的公开 Cordis、Typert、Settings 和 Gateway API。默认远端 profile 为 `codexy`，没有回退到普通 Web 的路径。
