---
description: "具有显式快照、订阅与生命周期所有权的浏览器可观察状态存储。"
kind: "package-library"
---
# @deepseek-ai/dsh-client-store

## 概述

供 Client 控制器与 renderer 适配器共用的不依赖 React 的 observable 和快照存储基础原语。本包负责同步与 animation-frame 发布、基于 Immer 的更新、浅比较和可选的浏览器持久化；React 钩子的构造仍属于 `@deepseek-ai/dsh-client-ui-renderer`。当 Client 状态必须在不依赖 React 的情况下发布稳定快照时，请使用它。

持久化名称按所属文档的部署目录（`new URL('.', document.baseURI).pathname`）隔离，并在实例创建时固定。应用根页面（包括 `/index.html`）保留既有 key；部署于 `/foo/` 的文档给同一名称加上 `/foo/` 前缀。查询参数与视图片段不影响身份。读取、写入与 `clearPersisted()` 始终指向同一 owner，包括 Session 后缀。新的独立部署从自己的初始值开始，不导入不安全的共享根值。这在不改变 Session 格式、不替换浏览器存储的前提下隔离同源应用；非浏览器消费方仍使用根名称。

## 目录

- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包提供浏览器侧状态基础原语，不注册任何面向模型的内容。

#### KV Cache 影响

无；这些存储既不组装也不发送模型请求。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **持久化仅限浏览器本地**——持久化存储使用 `localStorage` 中的 JSON；非浏览器运行时会禁用持久化，本包也不提供跨设备同步。
- **Web 壳构建输入**——静态 ESM 为 Vite 保留第三方导入；独立消费方自行提供开发依赖（[依赖规则](../AGENTS.md#dependency-declaration)）。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
