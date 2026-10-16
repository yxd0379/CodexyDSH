# CodexyDSH

> Codex 风格的 DeepSeek Harness：用 `@codexydsh/*` 插件与 profiles 集成进现有 DSH 安装。

开发基线是**未修改的**上游 `@deepseek-ai/dsh@0.2.1-alpha.2`。产品代码全部使用 `@codexydsh/*`，不覆盖上游包、不 fork 上游仓库，也不修改已安装的 DSH 文件——产品只写进 profile 的 patch，移除那些行即可回到原版组合。

## 能力

| 能力 | 说明 |
| --- | --- |
| Agent loop | 产品驱动的流式循环、steering、取消、持久 inbox 与冷恢复 |
| 模型接入 | `deepseek-account`（账号服务 token）与 `deepseek-official`（独立 API key）互不回退，另有 Pi provider |
| 工具与执行 | `exec_command` / `write_stdin` 风格的原生工具、`apply_patch`、计划、目标、skills 与 compaction |
| 记忆 | 持久记忆基线、召回与编辑，随会话上下文更新 |
| 子 Agent | V1/V2 子 Agent、结构化输出、续跑与 fork |
| 界面 | 对话、轨迹、工具、审批、记忆、用量、MCP 与设置 |
| Remote SSH | 同一窗口内使用远端工作区与会话，本机 Host 代理隧道 |
| 权限与审批 | 执行策略、沙箱、审批与 Auto review |

## 组成

| profile | 内容 | 启动 |
| --- | --- | --- |
| `desktop` | 沿用 DSH 桌面窗口；安装器把产品 bundle 与 Web 插件接在现有桌面 bundle 之后 | 打开 DeepSeek Harness |
| `web` | 上游 base + Web shell + 产品 bundle + 产品 Web 插件 | `dsh --profile web` |
| `headless` | 上游 base + headless shell + 产品 bundle + headless 入口 | `dsh --profile headless "task"` |
| `codexy` / `codexy-headless` | 同一产品组合的独立命名 profiles，供 Remote 与隔离验证 | `dsh --profile codexy` |

这不是另做一个客户端：窗口、登录、账号、工作区与插件加载仍由 DSH 平台提供，产品替换的是界面与本地执行运行时。

| 层 | 保留的 DSH 能力 | 产品提供 |
| --- | --- | --- |
| Desktop Host | Electron 窗口、生命周期、更新、桌面集成 | 不修改安装包 |
| Web shell 与平台服务 | 登录/账号、基础布局、工作区、设置、插件加载、凭据与授权 | 产品 API 与对话、工具、审批、轨迹、记忆界面 |
| 本地执行运行时 | 公开的 Cordis/Session/模型目录与平台服务接口 | Agent loop、模型请求适配、执行工具、记忆 |

产品不实现第二套登录，也不导入旧 Web 的账号；原有账号、已选模型与登录流程继续有效。MCP 服务器配置保存在设置里，`/mcp` 的连接开关只影响当前会话。日志上传、会话遥测与插件清单上传默认关闭。

### 包一览

| 域 | 包 |
| --- | --- |
| 运行时与模型 | `runtime`、`bridges`、`models`、`deepseek`、`deepseek-extensions`、`retry`、`token-meter`、`compaction` |
| 上下文与记忆 | `prompt-registry`、`prompt`、`instructions`、`skills`、`skill-filesystem`、`memory` |
| 工具与执行 | `exec`、`exec-policy`、`files`、`filesystem`、`filesystem-local`、`filesystem-sandbox`、`processes`、`sandbox`、`plans`、`goals` |
| 权限与审批 | `permissions`、`approval`、`auto-review` |
| 子 Agent | `delegation`、`delegation-driver`、`fork`、`spawn`、`subagents` |
| 会话与产品 API | `api-session`、`api-session-controller`、`api-prompt`、`api-memory`、`api-usage`、`api-remotes`、`mcp`、`browser-session` |
| 界面 | `ui-*`（对话、工具、审批、记忆、用量、MCP、工作区、Remote 等） |
| 组合与分发 | `bundle`、`web`、`headless`、`profiles/`、`scripts/` |
| 开发支持 | `runtime-testkit`、`test-support`、`tool-schema`、`tool-history` |

## 安装

### 发行包

解压 `codexydsh-0.1.0.tar.gz` 后不需要源码与开发依赖：

```sh
node install.mjs
```

安装需要 Node `^22.19 || >=24`。安装器只使用 DSH 公开的 `plugin --profile` 命令，保留已有 `cordis.patch.yml` 与用户 bundles，修改前完整备份；平台依赖声明为 peer 且 profile 关闭自动 peer 安装，从而复用启动器持有的同一份平台模块。安装非交互执行，每个 profile 最多等待十分钟。

### 从源码

```sh
pnpm install
pnpm build
pnpm bundle
pnpm apply
```

`build` 编译源码，`bundle` 生成 `.artifacts/`，`apply` 安装该目录中的产物，不会自动重新构建。

macOS 桌面：先启动一次 DSH Desktop 让它初始化 profile，完全退出客户端后再执行上面三步，重新打开客户端即加载产品插件。`pnpm apply --all --plan` 可先查看目标，非默认安装位置用 `--desktop-app "/path/DeepSeek Harness.app"` 指定。

只体验独立 Web/headless 时显式选择入口：

```sh
pnpm apply --web --dsh dsh
dsh --profile codexy
```

桌面固定启动 `desktop`；`web` 与 `headless` 是各自独立的 profile，共用 DSH home 与安装运行时，但插件组合各自独立，桌面设置里的改动不会自动复制过去。

## 开发

需要 Node `^22.19 || >=24` 与 pnpm 11。根目录只维护一个 `tsconfig.json`，Host、浏览器与声明输出的编译配置由工具生成到被忽略的 `.build/config/`；依赖脚本许可集中在 `pnpm-workspace.yaml`。

| 命令 | 作用 |
| --- | --- |
| `pnpm typecheck` | Host 与 Client 两套项目的类型检查 |
| `pnpm test` | 产品行为测试（套件正在重写，目前只覆盖部分包） |
| `pnpm build` | 编译 Host 模块与浏览器插件 |
| `pnpm bundle` | 生成 `.artifacts/` 中的 tarballs、校验清单、profiles 与 Node 安装器 |
| `pnpm test:artifacts` | 构建打包后检查原版浏览器加载器、协议与独立安装器 |
| `pnpm test:compat -- --dsh /path/to/dsh` | 在临时 home 安装打包产物，以本地模型替身验证 Web 与 headless 用户路径；`--keep` 保留该 home |

`test:compat` 不读取真实账号、不消耗模型额度，也不修改已有 DSH 安装。

原生图片兼容模块使用跨平台 WASM。源码编译需要 Rust/Cargo `1.98.1` 与 `wasm32-unknown-unknown`，或设置 `CODEXY_NATIVE_IMAGE_PREBUILT=/path/to/codec`（目录内含可信构建的 `native-image-codec.wasm` 与 `native-image-codec.build.json`），也可预置到 `.build/native-image-codec/prebuilt/`。构建会校验源码、锁文件、产物哈希与 WASM 接口，任一不匹配即报错；发行包已包含 WASM，运行时不需要 Rust。

## Remote SSH

- 默认自动部署：首次连接向远端同步当前安装版本的产品包，并安装独立的固定版本 Node 与 DSH。不需要远端预装 DSH，也不替换远端全局 Node。首版仅支持 Linux ARM64、glibc ≥ 2.28，其他平台直接报错；远端需要 `curl`、`tar`、`sha256sum` 与下载站网络。也可在设置中选择“使用已有安装”并指定 Node/DSH 命令。
- 认证沿用本机 SSH 配置：密钥或 agent，也可在连接时输入密码、私钥口令、验证码；输入只用于当次认证，不写入配置与日志。主机密钥必须先加入本机 `known_hosts`，不自动接受未知或变化的主机密钥。
- 工作区：本地与远端共用一个列表，远端行附带主机名；点击只展开或收起，加号创建会话。添加工作区时选择位置，可输入路径或浏览该机器的目录，添加本身不创建会话。断开后保留已知工作区，展开时重连；代码、工具与会话在远端执行与保存，部署不复制本机账号、密钥或会话。
- 实现：本机 Host 通过已认证的 HTTP/WebSocket 代理访问 SSH 隧道，远端 token 与 Cookie 留在服务端；每个已连接主机在当前页面拥有独立的 Cordis/Loader Client 树，切换工作区不会重建远端 Client。不使用 iframe、第二套侧栏或跨窗口消息桥。

## 数据与升级

新会话使用上游原生 Session 格式，保存在 `$DSH_HOME/sessions` 的路径分组目录中：模型消息与工具结果由上游会话存储负责，插件状态走设置、凭据或 `storageDomain`，请求诊断只进日志、不扩展会话格式。Remote 读取远端同一个 `$DSH_HOME/sessions`。

旧 `*.codexy.jsonl` 或分叉 v5 数据需要一次性转换：

1. 停止相关写入进程并备份；
2. 运行 `node scripts/migrate-sessions.mjs` 转换到独立目标目录——保留源文件，不覆盖同 ID 会话，并把记忆基线与审批状态转入插件存储；
3. 读回核对后切换目录；
4. 在拥有这些数据的机器上、DSH 停止时执行 `node scripts/reindex-workspaces.mjs "$DSH_HOME/storages/workspace.json"`，再启动 DSH，让上游重新关联会话；工作区身份、名称与归档/置顶设置保留。

安装与连接不会自动改动数据，安装包也不包含个人配置与密钥。

## 兼容性

`platform.json` 的 `compatibility` 记录精确版本与已验证入口，发行安装器只接受当前入口已验证的版本，拒绝时不会修改 profile。

| 运行时 | 已验证入口 |
| --- | --- |
| `0.2.0-rc.2` | desktop、web、headless |
| `0.2.1-alpha.2`（开发基线） | web、headless |

桌面安装只读取客户端内置 DSH 的准确版本并调用其自带的公开 CLI，单独安装的其他版本不能冒充；ACP/SDK 等其他上游入口尚未列入验证范围，安装器不会改动它们。

源码构建的发布档案位于 `.artifacts/codexydsh-0.1.0.tar.gz`；`pnpm apply --release /path/to/release` 可指定其他已解压的发行目录。

## 许可与归属

CodexyDSH 包含 MIT 许可的 DeepSeek Harness 代码，以及从 Codexful 开发检查点 `c0b4417c90b07ff7301f92aa9d5ddf006917f586` 提取的产品实现。以下为原始归属声明（法律文本保留英文）：

> CodexyDSH contains MIT-licensed DeepSeek Harness code and product implementations extracted from the Codexful development checkpoint c0b4417c90b07ff7301f92aa9d5ddf006917f586.
>
> The runtime platform is the unmodified published @deepseek-ai/dsh 0.2.1-alpha.2 release, corresponding to upstream commit d743267388641bc76f17c45ce8b4c231aed1d32c. It is installed as a dependency, not included as a source fork.
>
> Prompt, memory and subagent packages retain their individual OpenAI Codex license and notice files. Package archives include the applicable license and notice files.
