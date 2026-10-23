# @codexydsh/remote

本机 Host 通过 OpenSSH 安装或查找独立的 CodexyDSH 服务，并在 `/codexy-remote/<name>/` 下转发经过认证的 HTTP 与 WebSocket 流量。会话历史、工具、终端、文件和模型请求均属于选定的远端 Host；不向官方 DSH 安装插件，也不共享 `~/.dsh`。

`remoteLauncher` 提供 `remoteHosts` 的 `list`、`follow`、`connect`、`disconnect` 和 `respondAuthentication` 方法。`follow` 包含连接阶段、限长日志和临时认证问题；密码与密钥口令只保存在内存中。OpenSSH 配置、已知主机检查和 SSH agent 继续生效。本机断开连接或取消操作只释放本机子进程与隧道，不终止远端服务或会话。

应用内置 `server/linux-arm64.tar.gz`，`serverArchive` 留空时使用该资源；开发时可用绝对路径覆盖。压缩包根目录包含 `node/bin/node`、位于 `dsh/` 下的标准生产 CLI（入口为 `dsh/lib/bin.js`），以及从 `server-launcher.sh` 复制的可执行文件 `bin/codexydsh`。自动部署支持 glibc 2.28 及以上的 Linux ARM64，需要 tar、gzip、sha256sum 和 flock；其他平台在创建文件前报错。远端不执行包管理器安装，也不从公共仓库下载依赖。

应用产物就绪后，运行 `tsx scripts/build-remote-server.ts prepare --output /absolute/builds`。把生成的准备包复制到隔离的 Linux ARM64 构建环境，解压后运行 `node --experimental-strip-types build-remote-server.ts finalize --directory ./payload`。桌面打包前，将最终压缩包放到本包的 `server/linux-arm64.tar.gz`。准备阶段排除服务包自身，避免嵌套复制；中间构建保留，不删除先前产物。

每台主机可设置绝对路径 `home`，省略时使用远端的 `~/.codexydsh`。完成的部署按压缩包 SHA-256 缓存在该目录下；重连会探查相同部署与现有服务，不重复上传。失败的安装和先前版本都会保留。设置 `deployment: existing` 时改用明确配置的 `node` 与 `dsh` 可执行文件，不上传服务包。

同一 home/profile 的启动通过 util-linux 的 `launch.flock` 内核锁串行化；取消或进程退出后由操作系统释放，不猜测 PID 或删除活动锁。旧版 `launch.lock` 原样保留，不再参与新启动，空文件也不会堵住连接。

代理模式支持 `inherit`、`custom` 和 `direct`，只影响远端服务，不影响本机 UI；代理地址中的回环地址指远端机器。日志不包含启动令牌或 URL 密码。主机设置包括 SSH 主机、profile（默认为 `web`）、初始目录、数据目录和代理模式。

转发保留二进制上传和工作区文件响应，不对它们解码。原生终端与其他 Remote 流共用 Gateway WebSocket 多路复用。浏览器侧的所有 Session API、文件上传和右侧面板资源都必须绑定同一 Host；本包不替换 Controller，也不改写浏览器模块图。

## 模型行为

不注册工具或提示词。模型请求由远端进程发出，使用该进程配置的模型提供商与凭据；部署不会复制本机模型凭据。

## 已知限制

自动部署仅支持 Linux ARM64，不自动导入已有官方或旧版会话。更新服务或修改代理可能需要在服务空闲时重启；取消连接不会强制停止活动会话。打包压缩包时，需要给启动器模板设置可执行权限。
