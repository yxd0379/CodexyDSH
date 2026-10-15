# @codexydsh/ui-remote

在 Web 设置中编辑 SSH 主机，连接、取消连接和断开本地转发。Host 配置行 id 为 `codexy-remote`，依赖 `@codexydsh/remote` 的 Client 状态模型。

编辑使用读取时的配置 revision；失败保留草稿并在编辑器显示原因，删除需要确认。命令行或 home 覆盖的配置由上游设置服务拒绝保存。

连接后的远端项目显示在现有左侧栏的 **Remote projects** 区域，与本地项目和会话共存。选择项目或会话在当前窗口的中心区域打开，不弹出新窗口。可填写远端绝对目录添加项目，在项目旁新建会话。中心区域显示主机身份并提供返回本地工作区的入口。每个已连接主机保留独立 iframe runtime；切回本地不会丢失远端输入草稿。断开会移除该 runtime，并关闭本地转发，远端任务继续运行。

本地 WorkspaceBrowser 保持原来的注册；远端项目通过 additive `sidebar.footer.action` seat 加入。中心面板通过 keyed `main` seat 导航，iframe 挂在持久的 `shell.overlay` seat 中。远端嵌入模式使用 public sidebar owner width 报告空导航栏的宽度，由父视口裁切，因此没有重复的侧栏；远端 Conversation 和右侧工具仍使用远端自身的插件图与连接。

桥接协议 `codexy.remote.projects.v1` 只投影项目/会话展示字段，命令仅允许打开项目、打开会话、新建会话与添加目录。消息同时验证 window source、精确 origin、每次 runtime 随机生成的 channel；过期 runtime 消息不再生效。相同远端 id 在不同主机下保持独立。URL 和 capability 不写入持久存储。未响应的旧版远端 profile 显示超时与重试入口。SSH 主机须安装包含本包的 Codexy profile。

界面文案通过中英文 locale 字典提供。本包不构造模型请求。

独立集成验证：先使用 `scripts/compatibility.mjs --release <发行目录> --keep` 准备临时安装，然后运行：

```sh
CODEXY_PLAYWRIGHT_PACKAGE=/path/to/test-tools/package.json \
  node --import tsx tests/fixtures/remote-project-browser.mjs \
  /path/to/dsh/package.json /path/to/temporary-validation-home
```

测试启动两个独立真实 DSH Host，仅 SSH 转发使用本地 fixture，不读取个人账号、不发送模型请求。检查同窗项目/会话、切换后的远端草稿、本地与远端存储隔离，截图保留在输出的临时目录。可另设 `CODEXY_TEST_ELECTRON=/path/to/Electron` 验证隐藏的 `dsh-app://app` 测试壳；该测试不启动或改动用户已安装的桌面应用。
