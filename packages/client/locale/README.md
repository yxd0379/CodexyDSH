# 中文界面文案

CodexyDSH 固定使用中文。这个包保留现有 UI 的 `ctx.locale` 和框架注入的 `t`，负责文案查找、参数替换与字典生命周期，不再提供语言切换功能。

## 使用

组件所属的包注册自己的中文文案：

```ts
export const inject = ['locale']

export function apply(ctx) {
  ctx.effect(() => ctx.locale.register('example', 'zh', {
    greeting: '你好，{name}',
  }), 'example: 中文文案')

  const t = ctx.locale.bind('example')
  t('greeting', { name: '用户' }) // 你好，用户
}
```

已声明类型的命名空间可用 `register(namespace, { zh })`。逐表注册形式继续接收上游包的调用，但只保存中文表，其他语言表不会进入运行时注册表。

查找顺序是当前命名空间、公共中文文案 `common`、键名本身。没有跨语言回退链。已绑定的 `t` 函数身份稳定，注册或释放字典会更新文案版本，供已挂载组件订阅。

`resolveText` 用于插件 manifest 的标题和描述：纯字符串原样返回，映射优先取 `zh`；如果外部插件只有默认文案，则继续显示该文案，不要求外部插件改数据格式。

## 不再维护的功能

- 语言选择行、语言包注册与区域语言匹配。
- 浏览器或操作系统语言探测。
- `locale.preference` 的读取、写入与设置分区。
- 桌面语言初始化桥、语言切换事件和英文文案表。

Web 页面声明为 `zh-CN`；桌面菜单、欢迎页和对话框也固定中文。本包不修改会话、模型请求或任何用户数据。

## 源码

- [中文文案服务](src/client/index.ts)：注册、查找、参数替换和订阅。
- [公共词条](src/locales/zh.ts)：UI 共用的中文文案。
- [Host 入口](src/index.ts)：仅保留装配入口，不声明语言配置。
