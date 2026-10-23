# CodexyDSH

CodexyDSH 是基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的独立编程 agent 客户端，组合 Codexy 的运行时、工具与 Harness 的 Session 服务和原生 Web/Desktop 界面，不再向官方 DSH 安装扩展。

内部能力仍通过 Cordis 插件与现有 profile 启动链组合；不为改名而改名，因此保留部分上游包名和内部 `dsh` 命令。

当前仍在迁移中，不会自动导入官方或旧 Codexy 对话，也不会代替用户配置模型。添加 SSH 主机并连接后，应用可自动部署独立的远端服务；现阶段支持 Linux ARM64。

## 从源码运行

使用 Node.js `^22.19` 或 `>=24`，pnpm 版本见 `package.json`。

```sh
pnpm install
pnpm build
pnpm dsh web --no-open
```

Web 默认地址为 `http://127.0.0.1:3082`。发送任务前，请在本应用的设置中配置模型。官方 npm 包启动的仍是官方 DSH，不是本 fork。

```sh
pnpm dsh headless "task"
pnpm start:desktop
```

`pnpm build:artifacts` 构建可运行产物，`pnpm build:check` 基于最新产物检查聚合程序。开发 Web 时，`pnpm dev:web` 会重建客户端 bundle。桌面运行与打包说明见 [apps/desktop](apps/desktop/README.md)。

## 与官方 DSH 共存

默认数据目录为 `~/.codexydsh`。桌面端使用独立应用身份和单实例目录，注册 `codexydsh`，不改官方 `dsh` 命令。显式 `DSH_HOME` 会覆盖默认路径；若要数据独立，不要将它指向 `~/.dsh`。

默认不配置官方更新下载源。保持官方应用和数据不变，无需安装之前的 Codexy 插件。数据与更新行为见[升级说明](docs/upgrade-guide/v0.2.1-rc.2/independent-product/guide.md)。

## 架构

[架构概览](docs/architecture.md)说明产品装配和共享基础设施。源码继续按 `packages/<group>/<package>` 分组，不另建一套包目录或启动器。

## 来源与许可

上游 Harness 与 Cordis 代码保留原有许可证和声明。本 fork 并非 DeepSeek 官方客户端。[MIT](LICENSE)。

第三方依赖及许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
