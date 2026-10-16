# CodexyDSH

CodexyDSH 是一组独立维护的产品插件和 DSH profiles。开发基线固定为未修改的 `@deepseek-ai/dsh@0.2.1-alpha.2`；其他运行时逐版通过兼容矩阵验证后支持。产品代码使用 `@codexydsh/*`，不覆盖上游包，也不依赖 DeepSeek Harness 分叉工作区。

Agent loop、产品行为、Web UI、MCP 和 Remote 均由本仓库的产品插件提供。组件与验证范围见下文[组件清单与验证范围](#组件清单与验证范围)。

## 产品组成

- `bundle`：Agent 驱动、请求快照、原生工具、提示词、记忆、子 Agent、审批、执行策略、会话存储和 MCP。
- `web`：对话、命令、输入框、审批、工具、轨迹、记忆、用量、MCP 和 Remote 界面，以及产品 BFF。
- 标准 `web` profile：上游 base + Web shell + 产品 bundle + 产品 Web 插件。
- 标准 `headless` profile：上游 base + headless shell + 产品 bundle + 产品 headless 入口。
- `codexy` / `codexy-headless`：相同产品组合的独立命名 profiles，供 Remote 和隔离体验使用。
- `desktop`：继续使用 DSH 通用桌面窗口；安装器把产品 bundle 和 Web 插件加在现有桌面 bundle 后。

这里不是另做一个客户端，也不是把整个旧 Web 应用塞进窗口。界面由保留的平台插件与替换的产品插件共同组成：

| 层 | 保留的 DSH 能力 | CodexyDSH 提供的能力 |
| --- | --- | --- |
| Desktop Host | Electron 窗口、应用生命周期、更新与桌面集成 | 不替换、不修改安装包 |
| Web shell 与平台服务 | 登录/账号、基础布局、工作区、设置、插件加载、凭据与授权 | 产品 API、对话、工具、审批、轨迹、记忆等界面 |
| 本地执行运行时 | 公开 Cordis/Session/模型目录与平台服务接口 | Agent loop、模型请求适配、执行工具、记忆与产品会话持久化 |

桌面同时承载 Web 界面和本地执行进程，不只是加载远端网页的窗口。登录和账号能力来自客户端的原有平台；产品不实现另一套登录，也不导入旧 Web 的账号。`deepseek-account` 使用公开账号服务授权的 token，通过产品原生工具适配器发送 DeepSeek Messages 请求；`deepseek-official` 则是独立的 API-key 模型入口，两者不互相回退。原有账号、已选模型和登录流程应继续有效。

MCP 服务器配置保存在设置里；`/mcp` 的连接和关闭仅影响当前会话。日志上传、会话遥测和插件清单上传默认关闭。

Remote SSH 使用本机 SSH 配置和凭据。默认自动部署：首次连接向远端同步当前安装版本的产品包，并安装独立的固定版本 Node 和 DSH，无需提前安装 DSH，也不替换远端全局 Node。首版仅支持 Linux ARM64、glibc ≥ 2.28；其他平台直接报错，不进行安装。远端需要 curl、tar、sha256sum 以及访问 Node/npm 下载站的网络。SSH 支持现有密钥/agent，也可在连接时输入密码、私钥口令或验证码，不要求免密；输入只用于当前认证，不保存到配置或日志。主机密钥仍需预先确认并加入本机 known_hosts，不自动接受未知或变化的主机密钥。设置中也可选择“使用已有安装”并指定 Node/DSH 命令。

本地和远端工作区共用上游工作区列表，远端行附带主机名。点击工作区只展开或收起，旁边的加号创建会话；选择远程会话后，在同一窗口内展示其内容，可返回本地而不中断远端任务。添加工作区时选择位置，既可输入路径，也可浏览对应机器的目录；添加本身不创建会话。断开后保留已知工作区，展开时重新连接。代码、工具和会话在远端执行与保存；部署保留原有 DSH 数据及所选 profile 的用户配置，不复制本机账号、密钥或会话。首次安装比后续连接慢，默认允许十分钟；下载或安装失败会明确报错，可重试。

本机 Host 通过已认证的 HTTP/WebSocket 代理访问 SSH 隧道，远端登录 token 和 Cookie 留在服务端。每个已连接主机在当前页面中拥有独立的 Cordis/Loader Client 树；父窗口统一显示本地与远端工作区，远端 Client 负责自己的会话、对话和工具状态。实现不使用 iframe、第二套侧栏或跨窗口消息桥；切换工作区不会重建远端 Client。

## 组件清单与验证范围

产品实现来自检查点 `c0b4417c90b07ff7301f92aa9d5ddf006917f586`，平台为未修改的已发布 `@deepseek-ai/dsh@0.2.1-alpha.2`（对应上游 `d743267388641bc76f17c45ce8b4c231aed1d32c`）。平台服务是公开依赖，产品行为位于 `@codexydsh/*`。

| 行为 | 产品 packages | 验证 |
| --- | --- | --- |
| Agent 工厂、流式循环、steering、取消、持久 inbox 与冷恢复 | `runtime` 及其持久化插件 | 真实 AgentFactory 工具回合、取消、JSONL 保存/重开、fork seed 与旧格式导入 |
| 捕获的模型生成、原生 function/freeform 工具与请求控制 | `bridges`、`models`、`deepseek`、`deepseek-extensions`、`token-meter` | 原生 provider 流、畸形工具输入、不可变 review 请求、生命周期与用量锚点用例 |
| 现有 DeepSeek 登录与账号模型选择 | 平台 `deepseek-account` 服务与本产品 `deepseek/account` 插件 | 仅账号目标授权、捕获 token 拒绝、配额映射、原生模型 ID 与 effect 持有的路由释放 |
| 提示词、AGENTS 与 skills、记忆、compaction 与 recap | `prompt-registry`、`prompt`、`instructions`、`skills`、`skill-filesystem`、`memory`、`compaction` | 有序准备、上下文更新、固定提示词、持久记忆与记录的 recap 事实；[prepared compaction](packages/compaction/tests/prepared-compaction.spec.ts) 与 [durable input](packages/compaction/tests/durable-input.spec.ts) 覆盖失败/中止/重试输入、先 flush 再派发、真实 JSONL 写入恢复与待处理事实 |
| 非阻塞固定输入、公开有效工作目录捕获与持久 turn 级 Git 元数据 | `prompt-registry`、`prompt`、`runtime` | 保留附加上下文/工具、真实策略回退、prepared cwd/full/delta/recovery 测试、`packages/prompt/tests/workspace-response-metadata.spec.ts` 的真实 clean/dirty/nested Git、保字节恢复与同 turn compaction 快照、真实打包 CLI 首请求 |
| 显式原生 image/question 接口与捕获的模型限制 | `files`、`prompt`、`runtime` | `packages/files/tests/codex-tools.spec.ts`、`packages/prompt/tests/response-metadata.spec.ts`、`packages/runtime/tests/response-metadata.spec.ts`；opt-in 注册使用真实 attachment/human-answer 服务与持久 prepared 元数据 |
| opt-in 原生 goal 工具、自动续跑与持久记账 | `goals`、`runtime` 的 fact codec；平台公开 goal 服务 | `packages/goals/tests/`、`packages/runtime/tests/goal-facts-codec.spec.ts`；真实 stock-driver 排除、token 预算、子孙/compaction 用量与 clean/unclean artifact 恢复；默认关闭 |
| 显式固定原生 skill 目录与 V1 spawn 指引 | `skills`、`skill-filesystem`、`subagents` | `packages/skills/tests/codex-catalog.spec.ts`、`packages/skill-filesystem/tests/skill-filesystem.spec.ts`、`packages/subagents/tests/spawn-description-wire.spec.ts`；真实 CLI 内置 skills、sidecar 隐式调用策略与 watcher 失效、固定版本源元数据、记录的首请求与真实 effect 持有工具注册 |
| opt-in Responses hosted 输出与固定声明顺序 | `models`、`runtime` | `packages/models/tests/hosted-responses.spec.ts`、`wire-profile.spec.ts`、`codex-01621-tool-order.spec.ts`、`responses-null-namespace.spec.ts`、`compaction-context-grouping.spec.ts`；公开 SDK 字节、可空 namespace 派发、带类型的 reasoning/call 身份与跨持久恢复的上下文分组；默认关闭 hosted 模式 |
| 模型请求录制与离线对拍重放 | 外部包 `dsh-parity`（`link:../dsh-parity`） | 原始 cassette 留存、显式 trace identity/时间比较、独立整轮审计；真实 CLI/评分器结果与合成测试、协议探针范围分开 |
| 执行、文件系统保护、审批与 Auto review | `processes`、`filesystem`、`filesystem-sandbox`、`files`、`permissions`、`approval`、`exec-policy`、`auto-review` | 真实进程 fixture、经公开策略钩子的自有工具、取消与准入拆除 |
| V1/V2 子 Agent、结构化输出与续跑 | `delegation`、`delegation-driver`、`fork`、`spawn`、`subagents` | 真实子 Agent、冷续跑、继承 seed、原生捕获与嵌套 PTC 输出 |
| 计划、目标、任务、终端与文件搜索 | `plans`、`exec` 工具导出 | 工具行为与任务生命周期 |
| 会话控制、原生模型选择、标题、提示词优化与用量 | `api-session-controller`、`api-session`、`api-prompt`、`api-memory`、`api-usage`、`api-remotes`、`headless` | 真实选择辅助、公开 wire codec、辅助模型调用与产品 headless 入口 |
| 对话、历史、折叠、轨迹、工具/审批视图与诊断 | `ui-chat`、`ui-conversation`、`ui-trajectory`、`ui-tool`、`ui-approval`、其余 `ui-*` | 渲染/交互套件、公开 profile 设置与命令归属、构建后 ModuleLoader 冒烟 |
| MCP 配置与按会话连接选择 | `mcp`、`ui-mcp`、`ui-settings` | 真实公开 Settings/Gateway、冻结浏览器字典、真实传输、隔离与恢复 |
| Remote SSH 启动、同窗项目/会话、取消与重连 | `remote`、`ui-remote`、`ui-settings` | SSH fixture 与真实打包 DSH 启动；认证 HTTP/WS 代理、Cordis/Loader 子树、工作区身份和运行时隔离；浏览器交互检查同窗切换与远端会话打开 |
| 产品 profiles、本地档案分发与 Desktop 安装 | `bundle`、`web`、`headless`、`profiles`、安装器 | 校验和、保留用户配置、公开 CLI 组合、独立可移动安装器与打包启动 |

独立命名的产品行会禁用被替换的上游 provider；补丁名称从不重命名上游包。平台包声明为 peer 而非产品依赖，profile 关闭自动 peer 安装，让公开 profile 解析复用安装方持有的同一份平台模块（含作用域标签与事件载体）。不修改任何已安装的 DSH 文件。固定的外部 Pi SDK `0.85.1` 有一处产品自有补丁，用于原生工具流式行为；安装器校验并以包管理器补丁的形式安装它。

产品会话使用上游 `session-persistence-jsonl`，不再单独挂载产品会话存储。记忆基线、审批审查状态等插件数据使用上游 `storageDomain`，不塞进对话历史。遥测、日志上传与插件清单上传由产品 bundle 关闭。

## 开发与安装

需要 Node `^22.19 || >=24` 和 pnpm 11。开发依赖、生成配置和发布插件均在本仓库内维护。

根目录只维护一个 `tsconfig.json`。Host、浏览器及声明输出的编译配置由工具自动生成到被忽略的 `.build/config/`；不需要逐插件维护配置，类型检查和构建会自动准备它们。

首次安装或依赖变化后先执行 `pnpm install`。必要的依赖脚本许可统一放在 `pnpm-workspace.yaml`；构建时若发现依赖未同步，只提示错误，不自动重装。

原生图片兼容模块使用跨平台 WASM。源码编译需要 Rust/Cargo `1.98.1`、`wasm32-unknown-unknown` 标准库以及 `Cargo.lock` 对应的离线依赖缓存。没有 Rust 的开发机（包括 macOS）可设置 `CODEXY_NATIVE_IMAGE_PREBUILT=/path/to/codec`，目录中需包含可信构建生成的 `native-image-codec.wasm` 和 `native-image-codec.build.json`；也可将这两个文件放在本仓库被忽略的 `.build/native-image-codec/prebuilt/` 中供后续构建复用。构建会校验当前源码、锁文件、产物哈希和 WASM 接口，任一不匹配均报错。发布包已包含 WASM，安装和运行不需要 Rust。

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm bundle
pnpm test:artifacts  # 构建和打包后检查原版浏览器加载器、协议及独立安装器
pnpm test:compat -- --dsh /path/to/dsh  # 在临时 home 安装打包产物并验证 Web、真实 CLI 和会话恢复
```

`test:compat` 只验证打包后的 Web 和 headless 用户路径。它在临时 home 中安装候选包，以本地模型替身完成一次工具回合和会话恢复；不读取真实账号、不消耗模型额度，也不修改已有 DSH 安装。`--keep` 可保留该隔离 home 以便排查。

构建通过后，`.artifacts/` 包含产品 tarballs、校验清单、profiles 和 Node 安装器。在源码目录中，安装前可先查看目标组合：

```sh
pnpm apply --web --plan
pnpm apply --web --dsh ./node_modules/.bin/dsh
./node_modules/.bin/dsh --profile codexy --no-open
./node_modules/.bin/dsh --profile codexy-headless "task"
```

解压发行包 `codexydsh-0.1.0.tar.gz` 后，无需项目源码或开发依赖，可直接运行 `node install.mjs`；安装器读取同目录的发行清单。安装需要 Node `^22.19 || >=24`。

安装器使用 DSH 的公开 `plugin --profile` 命令安装依赖，保留已有 `cordis.patch.yml`。产品依赖固定到经校验的本地档案，并写入 profile 的 `pnpm-workspace.yaml` 覆盖设置；平台依赖声明为 peer，profile 使用 `autoInstallPeers: false`，通过 DSH 的公开解析器复用启动器提供的同一份平台模块，避免会话作用域被重复模块分开。现有配置和注释保留，修改 manifest 和工作区配置前分别保存完整备份。发行清单中的固定 Pi SDK 补丁经校验后缓存到产品目录，并加入工作区的 `patchedDependencies`；已有同版本的不同补丁会停止安装并保留原配置。安装时跳过依赖安装脚本，保留现有构建政策；随后只运行经发行清单校验的产品进程修复脚本。产品会话写到独立目录，不读取或覆盖原来的会话。

依赖安装明确采用非交互模式，关闭 PNPM 的后台更新检查，同时允许 lockfile 随新发行的依赖覆盖设置更新。每个 profile 的安装最多等待 10 分钟；超时或中断只清理该安装命令及其子进程，报告失败并保留备份，不把 `Done` 日志当作成功，也不会终止其他 DSH 客户端。

macOS 上从源码构建并安装：先启动一次 DSH Desktop，让它初始化 profile；完全退出客户端后，在仓库根目录运行：

```sh
pnpm build
pnpm bundle
pnpm apply
```

`build` 编译源码，`bundle` 生成 `.artifacts`，`apply` 安装该目录中的产物，不会自动重新构建。这三个命令均可省略 `run`。`pnpm install` 仅安装开发依赖，不会修改客户端。

重新打开原来的 DSH Desktop 即可加载产品插件。默认安装同时准备标准 `desktop`、`web`、`headless` 和产品命名的 `codexy` / `codexy-headless` profiles，让桌面窗口、`dsh --profile web` 和 `dsh --profile headless` 都使用产品组合；不扫描或修改用户自定义 profiles，不启动另一个应用，也不修改客户端安装包。`pnpm apply --all --plan` 可先查看完整目标。非默认位置的客户端可用 `pnpm apply --all --desktop-app "/path/DeepSeek Harness.app"` 指定。

macOS 客户端安装包已经附带 DSH 运行时、Web 界面和 CLI，但 CLI 不一定已加入你的 shell `PATH`；不需要再安装另一份 DSH。安装器会提示客户端自带 CLI 的真实路径，可以直接使用：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" --profile web
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" --profile headless "task"
```

桌面固定启动 `desktop`；上述命令分别启动 `web` 和 `headless`，不是同一个 profile。它们共用默认 DSH home 和同一份安装运行时，但插件组合与 `cordis.patch.yml` 各自独立；在桌面设置里修改的 profile 配置不会自动复制到 Web/headless。产品会话默认都存到 `$DSH_HOME/sessions/codexy`，不是按入口另存一份。

桌面安装仅读取客户端内置 DSH 的准确版本，并调用客户端自带的公开 CLI 安装载体；单独安装的较新 `dsh` 不能冒充旧桌面运行时。`platform.json` 的 `compatibility` 条目记录精确版本、验证状态和适用入口；发行安装器只接受当前入口已验证的版本，拒绝待验证或不支持的版本时不会修改 profile。原配置、用户 bundles 和 patches 保留，修改前有完整备份。

当前已验证 `0.2.0-rc.2` 的 Desktop/Web/headless，以及开发基线 `0.2.1-alpha.2` 的 Web/headless。两版均覆盖真实浏览器加载、CLI 工具回合、会话持久化与跨进程恢复；未验证的版本或入口不会自动放行。

只体验独立 Web/headless 时，显式选择入口，并用安装好的 DSH 启动：

```sh
pnpm apply --web --dsh dsh
dsh --profile codexy
# 或：dsh --profile codexy-headless "task"
```

未检测到已初始化的 macOS 桌面安装时，默认准备标准 `web`、`headless` 和两个产品命名 profiles。`--all` 显式选择同一标准集合；`--desktop`（或单独 `--desktop-app`）只准备桌面，`--web` 只准备产品命名的两个 profiles，适合隔离验证。ACP/SDK 等其他上游入口尚未列入本产品的验证范围，不自动修改。安装工具仅准备 profiles；所有独立应用启动继续使用 `dsh --profile`。

源码构建的发布档案位于 `.artifacts/codexydsh-0.1.0.tar.gz`，生成文件不放在根目录。可用 `pnpm apply --release /path/to/release` 指定其他已解压的发行目录；仓库不预设尚未存在的下载地址。

## 数据与升级

新会话使用 DSH 上游原生 Session 格式，保存在 `$DSH_HOME/sessions` 的标准路径分组目录中。模型消息和工具结果由上游会话存储负责；插件配置和状态由各自的设置、凭据或 `storageDomain` 服务负责。

额外请求诊断走日志，不扩展持久化会话格式。历史私有诊断在一次性迁移时另存审计文件，不注入正常的会话读取流程。

旧 `*.codexy.jsonl` 或分叉 v5 数据通过 `scripts/migrate-sessions.mjs` 一次性转换到独立目标目录；先停止相关写入进程并备份，再转换、读回核对，最后切换目录。工具保留源文件，不覆盖同 ID 会话；同时将记忆基线和审批状态转入插件存储。安装与连接不会自动洗数据。安装包不包含个人配置和密钥。

Remote 连接读取远端同一个 `$DSH_HOME/sessions`，不再使用 `sessions/codexy` 独立目录。旧数据完成转换后，原生会话查询按远端工作目录展示已有会话。

迁移后还需补齐工作区关联：在拥有这些数据的 DSH 实例停止时，执行 `node scripts/reindex-workspaces.mjs "$DSH_HOME/storages/workspace.json"`，然后启动 DSH。脚本先备份工作区文件，只重置上游初始化标记；由上游重新关联会话，保留工作区身份、名称和会话归档/置顶设置。此步骤应在各自机器执行，确保会话目录能正确解析。

## 许可与归属

CodexyDSH 包含 MIT 许可的 DeepSeek Harness 代码，以及从 Codexful 开发检查点 `c0b4417c90b07ff7301f92aa9d5ddf006917f586` 提取的产品实现。以下为原始归属声明（法律文本保留英文）：

> CodexyDSH contains MIT-licensed DeepSeek Harness code and product implementations extracted from the Codexful development checkpoint c0b4417c90b07ff7301f92aa9d5ddf006917f586.
>
> The runtime platform is the unmodified published @deepseek-ai/dsh 0.2.1-alpha.2 release, corresponding to upstream commit d743267388641bc76f17c45ce8b4c231aed1d32c. It is installed as a dependency, not included as a source fork.
>
> Prompt, memory and subagent packages retain their individual OpenAI Codex license and notice files. Package archives include the applicable license and notice files.
