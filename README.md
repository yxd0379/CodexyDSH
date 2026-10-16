# CodexyDSH

> Codex 风格的 DeepSeek Harness：用 `@codexydsh/*` 插件与 profiles 集成进现有 DSH 安装。

跑在**未修改的**上游 `@deepseek-ai/dsh@0.2.1-alpha.2` 上。产品只写进 profile 的 patch，不覆盖上游包、不 fork 上游仓库、不改动已安装的 DSH 文件。

## 为什么用 CodexyDSH

原生 DSH 是通用 agent 平台：账号、桌面窗口、Web shell、工作区、设置、插件加载都已具备。CodexyDSH 不重做这些，它换掉的是模型看到的东西，并补上平台缺的两块。下面每条先给事实，再说为什么值得。

**工具名与调用顺序**

原生 DSH 给模型的是 `bash`、`shell`、`read`、`write`、`edit`、`todo_write`、`subagent_fork`；CodexyDSH 给的是 `exec_command`、`write_stdin`、`apply_patch`、`update_plan`、`view_image`、`request_user_input`，子 Agent 用 `multi_agent_v1`，声明顺序按 Codex 0.162.1 的 wire profile 固定。
→ 为 Codex 写的 AGENTS.md、skills 与提示词里出现的是后一组名字，搬到原生 DSH 上得逐条改名。

**跨会话记忆**

上游安装树里没有任何 memory 包（只有 `dsh-compaction` 系列）；CodexyDSH 有 `@codexydsh/memory`，分两步：先抽取该记的内容，再按相关性检索并注入上下文。
→ 原生 DSH 换个会话就要重新交代项目背景。

**自动审查**

上游的 `dsh-experimental-auto-review` 官方说明是「安装包默认关闭」；CodexyDSH 的 bundle 默认挂载 `@codexydsh/auto-review`，模式 `codexful`。
→ 原生 DSH 默认是每个敏感操作都来问你，或者干脆整体放开权限；这里先由模型审一遍，只有需要更大权限的才转人工。

**远端主机**

上游与远端有关的只有 `dsh-api-remotes`（浏览器到 Host 的能力转发面）和 `dsh-remote-mock`（测试替身），没有任何 SSH 相关包；CodexyDSH 的 `@codexydsh/remote` 用本机 OpenSSH 启动远端的 `dsh --profile codexy`，只监听本地回环地址做 HTTP/WebSocket 转发，并自动部署固定版本的 Node 与 DSH。
→ 原生 DSH 想这样用只能自己搭；这里连上之后远端工作区直接进同一个侧栏与窗口。

**界面**

上游界面来自 `dsh-client-ui-*`；CodexyDSH 换成 `@codexydsh/ui-*`。
→ 对话、轨迹、审批与用量的读法跟 Codex 一致，不用重新学一套。

平台能力不变：登录、账号、已选模型与工作区继续有效；移除 profile 里的产品 patch 行即可回到原版组合。

## 使用

### 安装（发行包）

解压后不需要源码与开发依赖：

```sh
mkdir codexydsh-0.1.0 && tar -xzf codexydsh-0.1.0.tar.gz -C codexydsh-0.1.0
cd codexydsh-0.1.0 && node install.mjs
```

- 需要 Node `^22.19 || >=24`；安装器只用 DSH 公开的 `plugin --profile` 命令，保留你已有的 `cordis.patch.yml` 与用户 bundles，改动前完整备份；非交互执行，每个 profile 最多等十分钟。
  → 不动客户端安装包，改坏了也能用备份退回。
- 默认准备 `desktop`、`web`、`headless` 与产品命名的 `codexy` / `codexy-headless`；加 `--plan` 先看目标组合，不实际安装。
  → 装之前就能确认它到底会碰哪些 profile。
- macOS 客户端安装包已自带 DSH 运行时与 CLI。
  → 不用再装一份 DSH，重开客户端即加载产品插件。

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

- 首次连接会把当前版本的产品包同步过去，并在远端装一份独立的固定版本 Node 与 DSH，不动远端的全局 Node；首版仅支持 Linux ARM64、glibc ≥ 2.28，其他平台在写入前报错，远端需要 `curl`、`tar`、`sha256sum` 与下载站网络。也可以选择“使用已有安装”并指定 Node/DSH 命令。
  → 远端机器不需要预装 DSH，也不需要管理员配合。
- 认证直接用本机 SSH 配置：密钥或 agent，也可以在连接时输入密码、私钥口令、验证码，输入只用于当次认证，不写入配置与日志；主机密钥仍需先加入本机 `known_hosts`。
  → 不要求免密，凭据也不落盘。
- 本地与远端工作区共用一个列表（远端行带主机名），远端会话在同一窗口内打开，断开后已知工作区保留、展开时重连；代码、工具与会话都在远端执行与保存，部署不复制本机的账号、密钥或会话。
  → 换到远端干活不用切窗口，也不会把你的凭据搬过去。

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

具体换掉的行为：

- **Agent loop**：仍是上游 driver，但按 Codexy 的规则放置输入——运行中收到的新消息在步骤边界插入，并区分属于本轮还是下一轮；请求一经构造就冻结（工具、provider、提示词都是快照）。
  → 你插话不会打断正在跑的工具调用；重试与压缩用的还是同一份请求快照，模型不会突然看到另一套工具。
- **工具契约**：`exec_command` / `write_stdin` 的 PTY 会话、`apply_patch`（只用 patch 改文件）、`update_plan`、`request_user_input`、`view_image`，声明顺序按 Codex 0.162.1 的 wire profile 固定。
  → 与 Codex 的工具名、参数与顺序逐项对齐，提示词与 skills 可以直接复用。
- **提示词与上下文**：指令文件仍是 AGENTS.md（另支持 CLAUDE.md），注入格式按 Codex，并按会话刷新；记忆分两步——先抽取该记的内容，再按相关性检索并稳定注入；compaction 用 Codex checkpoint 格式。
  → 记忆的注入位置固定，同一会话的请求前缀不会来回变动。
- **审批与执行**：产品自带的 approval / permission / sandbox 取代上游对应插件，沿用上游的 `ask` / `never` 策略与三档权限模式；区别在 Auto review——上游那层是实验包且默认关闭，产品默认打开，并以 `codexful` 模式保留既有沙箱、只审查需要更大权限的请求。
  → 权限语义与上游一致，你不用重学一遍；只是默认多了一道自动审查。
- **模型请求**：provider 与上游同源（DeepSeek 账号 token、API key、Pi），账号入口与 API key 入口互不回退；差异在请求与流式契约——Codex 原生工具、不可变的请求世代、可重放的协议记录。
  → 同一次请求里的工具与 provider 是快照，重试不会变；协议记录能离线重放，出问题可以逐字节对拍。

三个设计取舍：

- 会话用上游原生 Session 格式，插件状态走设置、凭据或 `storageDomain`，请求诊断只进日志。
  → 上游工具与其他 DSH 客户端照常读得到你的会话，产品卸载后数据也还在标准位置。
- 平台包声明为 peer，profile 关闭自动 peer 安装。
  → 产品与启动器复用同一份平台模块，不会因为模块重复把会话作用域拆开。
- 日志上传、会话遥测与插件清单上传默认关闭。
  → 默认不往外发东西，需要时自己开。

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

每个包目录下都有自己的 `README.md`（如 `packages/runtime/README.md`），写明职责、公开导出与设计取舍。

## 许可

MIT 许可；仓库包含未经修改的 MIT 许可 DeepSeek Harness 代码，从 Codexful 检查点提取的产品实现，以及派生自 OpenAI Codex 并保留各自 LICENSE/NOTICE 文件的 Prompt、Memory、Subagent 包，详见根目录 `LICENSE`。
