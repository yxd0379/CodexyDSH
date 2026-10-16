# CodexyDSH

> Codex 风格的 DeepSeek Harness：用 `@codexydsh/*` 插件与 profiles 集成进现有 DSH 安装。

跑在**未修改的**上游 `@deepseek-ai/dsh@0.2.1-alpha.2` 上。产品只写进 profile 的 patch，不覆盖上游包、不 fork 上游仓库、不改动已安装的 DSH 文件。

## 为什么用 CodexyDSH

DSH 本身是通用 agent 平台：账号、桌面窗口、Web shell、工作区、设置、插件加载都已具备。CodexyDSH 不重做这些，它把 **agent 的行为换成 Codex 的语义**——模型看到什么工具、工具怎么被调度、提示词与审批怎么组织——并把 Codex 的记忆与子 Agent 机制带过来；此外新增了上游没有的 SSH 远端主机。

| 维度 | 原生 DSH | CodexyDSH |
| --- | --- | --- |
| Agent 行为 | 通用 agent 循环 | 按 Codex 的顺序与派发方式运行 |
| 工具 | 通用工具集 | `exec_command`、`apply_patch`、`update_plan` 等 Codex 工具 |
| 提示词与记忆 | 通用 AGENTS/skills | Codex 指令格式与记忆机制 |
| 审批与沙箱 | 通用审批与权限 | Codex 的 `ask` / `never` 与三个沙箱预设 |
| 子 Agent | 上游子 Agent | Codex V1 与 V2，含续跑 |
| 模型 | 上游模型入口 | DeepSeek 账号与 API key 两个入口 |
| 界面 | 上游界面 | Codex 风格的对话、轨迹、审批与用量 |
| 远端主机 | 无 | SSH 远端主机，同一窗口内的远端工作区 |

界面的形态、工具的名字与调用顺序、模型收到的提示词都会改变，但平台能力不变：你的登录、账号、已选模型与工作区继续有效。移除 profile 里的产品 patch 行即可回到原版组合。

## 使用

### 安装（发行包）

解压后不需要源码与开发依赖：

```sh
mkdir codexydsh-0.1.0 && tar -xzf codexydsh-0.1.0.tar.gz -C codexydsh-0.1.0
cd codexydsh-0.1.0 && node install.mjs
```

- 需要 Node `^22.19 || >=24`。安装器只使用 DSH 公开的 `plugin --profile` 命令，保留你已有的 `cordis.patch.yml` 与用户 bundles，改动前完整备份；安装非交互执行，每个 profile 最多等待十分钟。
- 默认准备 `desktop`、`web`、`headless` 与产品命名的 `codexy` / `codexy-headless`。加 `--plan` 可先查看目标组合，不实际安装。
- macOS 客户端安装包已自带 DSH 运行时与 CLI，不需要再装一份 DSH；安装完成后重新打开客户端即可加载产品插件。

### 构建（源码）

```sh
pnpm install
pnpm build
pnpm bundle
pnpm apply
```

- `build` 编译源码，`bundle` 生成 `.artifacts/`，`apply` 安装该目录中的产物，不会自动重新构建。
- macOS 桌面：先启动一次 DSH Desktop 让它初始化 profile，完全退出客户端后再执行上面三步。
- 原生图片模块以 WASM 构建：需要 Rust/Cargo `1.98.1` 与 `wasm32-unknown-unknown`，或者设置 `CODEXY_NATIVE_IMAGE_PREBUILT=/path/to/codec`（目录内含可信构建的 `native-image-codec.wasm` 与 `native-image-codec.build.json`）。发行包已包含 WASM，运行时不需要 Rust。

### 启动

```sh
dsh --profile codexy             # 独立 Web
dsh --profile codexy-headless "task"
```

桌面固定启动 `desktop`。`desktop` / `web` / `headless` 共用 DSH home 与同一份安装运行时，但插件组合各自独立，桌面设置里的改动不会自动复制到 `web` / `headless`。

### 远端

- 首次连接自动部署：向远端同步当前安装版本的产品包，并安装独立的固定版本 Node 与 DSH。远端不需要预装 DSH，也不替换远端全局 Node。首版仅支持 Linux ARM64、glibc ≥ 2.28，其他平台直接报错；远端需要 `curl`、`tar`、`sha256sum` 与下载站网络。
- 认证沿用本机 SSH 配置：密钥或 agent，也可在连接时输入密码、私钥口令、验证码，输入只用于当次认证，不写入配置与日志。主机密钥需先加入本机 `known_hosts`。也可选择“使用已有安装”并指定 Node/DSH 命令。
- 本地与远端工作区共用一个列表，远端行带主机名；同一窗口内打开远端会话，断开后已知工作区保留、展开时重连。代码、工具与会话都在远端执行与保存，部署不复制本机账号、密钥或会话。

### 数据与升级

新会话使用上游原生 Session 格式，保存在 `$DSH_HOME/sessions`，Remote 读取远端同一个目录。

旧 `*.codexy.jsonl` 或分叉 v5 数据需要一次性转换：停止相关写入并备份 → `node scripts/migrate-sessions.mjs` 转换到独立目标目录（保留源文件、不覆盖同 ID 会话）→ 读回核对后切换 → 在 DSH 停止时执行 `node scripts/reindex-workspaces.mjs "$DSH_HOME/storages/workspace.json"` 再启动。安装与连接不会自动改动数据，安装包也不包含个人配置与密钥。

## 实现

**总的来说**，CodexyDSH 不是另一个客户端，也不是把旧 Web 应用塞进窗口：它是纯插件与 profile 组合。Electron Host、Web shell、登录与账号、工作区、设置、插件加载全部沿用 DSH 平台；产品替换**本地执行运行时**与**界面**，并新增上游没有的 **SSH 远端接入**，三者都通过 Cordis 的公开服务接口接入，不 patch 平台内部。

| 层 | 沿用的 DSH 能力 | 产品替换或新增 |
| --- | --- | --- |
| Desktop Host | 窗口、生命周期、更新、桌面集成 | 不修改安装包 |
| Web shell 与平台服务 | 登录/账号、基础布局、工作区、设置、插件加载、凭据与授权 | 产品 API 与对话、工具、审批、轨迹、记忆等界面 |
| 本地执行运行时 | 公开的 Cordis/Session/模型目录与平台服务接口 | Agent loop、模型请求适配、执行工具、记忆 |
| 远端接入 | 上游只有浏览器到 Host 的 Remote 通道：连接代次、能力与事件转发 | 复用该通道，另加 SSH 启动与隧道、远端部署、远端 Cordis/Loader Client 树 |

具体换掉的行为如下：

- **Agent loop**：Codexy 输入顺序、原生 freeform 工具、冻结的 provider 与工具世代、提前派发已完成的工具调用、完成输出恢复、mailbox 续跑。
- **工具契约**：`exec_command` / `write_stdin` 的 PTY 会话、`apply_patch`（只用 patch 改文件）、`update_plan`、`request_user_input`、`view_image`；工具声明顺序按 Codex 0.162.1 的 wire profile 固定。
- **提示词与上下文**：Codex 指令格式与全局指令、按会话刷新；两阶段记忆抽取、本地检索与稳定注入；compaction 使用 Codex checkpoint 格式。
- **审批与执行**：`ask` / `never` 策略、`read-only` / `workspace-write` / `danger-full-access` 沙箱预设、Auto review 自动审查。
- **模型路由**：`deepseek-account`（账号服务 token）与 `deepseek-official`（独立 API key）互不回退，另有 Pi provider。

三个设计取舍值得说明：产品会话使用上游原生 Session 存储，插件状态走设置、凭据或 `storageDomain`，请求诊断只进日志，因此不扩展会话格式；平台包声明为 peer 且 profile 关闭自动 peer 安装，让产品与启动器复用同一份平台模块；日志上传、会话遥测与插件清单上传默认关闭。

**具体来说**，产品由 65 个包组成，按域划分如下。

| 域 | 包 |
| --- | --- |
| 运行时与模型 | `runtime`、`bridges`、`models`、`deepseek`、`deepseek-extensions`、`retry`、`token-meter`、`compaction` |
| 上下文与记忆 | `prompt-registry`、`prompt`、`instructions`、`skills`、`skill-filesystem`、`memory` |
| 工具与执行 | `exec`、`exec-policy`、`files`、`filesystem`、`filesystem-local`、`filesystem-sandbox`、`processes`、`sandbox`、`plans`、`goals` |
| 权限与审批 | `permissions`、`approval`、`auto-review` |
| 子 Agent | `delegation`、`delegation-driver`、`fork`、`spawn`、`subagents` |
| 会话与产品 API | `api-session`、`api-session-controller`、`api-prompt`、`api-memory`、`api-usage`、`mcp`、`browser-session` |
| 界面 | `ui-*`（对话、工具、审批、记忆、用量、MCP、工作区等） |
| 远端 | `remote`、`ui-remote`、`api-remotes` |
| 组合与分发 | `bundle`、`web`、`headless`、`profiles/`、`scripts/` |
| 开发支持 | `runtime-testkit`、`test-support`、`tool-schema`、`tool-history` |

`bundle` 是产品组合的入口：它声明插件清单并用 `cordis.patch.yml` 关掉被替换的上游行，再挂上对应产品包。`web` 与 `headless` 分别把产品界面或 headless 入口加到上游 base 之后，`profiles/` 里是可直接安装的 profile 定义。

## 许可

MIT 许可；仓库包含未经修改的 MIT 许可 DeepSeek Harness 代码，从 Codexful 检查点提取的产品实现，以及派生自 OpenAI Codex 并保留各自 LICENSE/NOTICE 文件的 Prompt、Memory、Subagent 包，详见根目录 `LICENSE`。
