/** 中文文案注册表，保留现有 UI 的 ctx.locale 与 t 注入方式。 */
import type { Context } from '@deepseek-ai/cordis'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import type { LocaleDictOf, LocaleNamespaceMap, Translate, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { zh, type CommonKey } from '../locales/index.ts'

export type { CommonKey } from '../locales/index.ts'
export type { Translate, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { common: CommonKey }
}

export type LocaleDict = Record<string, string>
export interface LocaleSnapshot {
  active: string
  locales: readonly { readonly id: string; readonly label: string }[]
  revision: number
}

declare module '@deepseek-ai/cordis' {
  interface Context { locale: LocaleRuntime }
}

export const COMMON_NS = 'common'
const CHINESE = Object.freeze([Object.freeze({ id: 'zh', label: '中文' })])

/** 按命名空间注册中文文案，不读取系统语言或用户语言偏好。 */
export class LocaleRuntime {
  private dicts = new Map<string, LocaleDict>()
  private bound = new Map<string, Translate>()
  private listeners = new Set<() => void>()
  private snapshot: LocaleSnapshot = Object.freeze({ active: 'zh', locales: CHINESE, revision: 0 })

  constructor(_ctx: Context) {}

  /**
   * 读取当前中文文案状态。
   * @returns 文案版本快照。
   */
  getLocale(): LocaleSnapshot { return this.snapshot }
  /**
   * 供 UI 订阅读取快照。
   * @returns 文案版本快照。
   */
  getSnapshot(): LocaleSnapshot { return this.snapshot }

  /**
   * 第三方插件仍可提供纯字符串；已有 manifest 的中文字段优先。
   * @param text - 插件提供的原始文案。
   * @returns 中文字段，或插件原本的默认文案。
   */
  resolveText(text: LocalizedText): string {
    return typeof text === 'string' ? text : text.zh ?? text.en
  }

  /**
   * 订阅字典注册与释放。
   * @param fn - 文案版本变更回调。
   * @returns 取消订阅。
   */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  /**
   * 注册命名空间的中文文案；其他语言字典不保留。
   * @param ns - 文案命名空间。
   * @param dicts - 包含中文文案的字典。
   * @returns 释放本次注册。
   */
  register<N extends Extract<keyof LocaleNamespaceMap, string>>(ns: N, dicts: { zh: LocaleDictOf<N> } & Record<string, LocaleDict>): () => void
  /**
   * 接收上游包的逐表注册调用，只采纳 zh。
   * @param ns - 文案命名空间。
   * @param locale - 字典语言。
   * @param dict - 文案字典。
   * @returns 释放本次注册。
   */
  register(ns: string, locale: string, dict: LocaleDict): () => void
  register(ns: string, localeOrDicts: string | Record<string, LocaleDict>, dict?: LocaleDict): () => void {
    const chinese = typeof localeOrDicts === 'string'
      ? (localeOrDicts.toLowerCase() === 'zh' ? dict : undefined)
      : localeOrDicts.zh
    // 上游包仍可能同时提交英文表，固定中文后不保留这些字典。
    if (chinese === undefined) return () => {}
    if (this.dicts.has(ns)) throw new Error(`locale namespace "${ns}" already has locale "zh"`)
    this.dicts.set(ns, chinese)
    this.publish()
    return () => {
      if (this.dicts.get(ns) !== chinese) return
      this.dicts.delete(ns)
      this.publish()
    }
  }

  /**
   * 绑定具有类型提示的中文文案函数。
   * @param ns - 文案命名空间。
   * @returns 身份稳定的文案函数。
   */
  bind<N extends Extract<keyof LocaleNamespaceMap, string>>(ns: N): TranslateNS<N>
  /**
   * 绑定动态命名空间的中文文案函数。
   * @param ns - 文案命名空间。
   * @returns 身份稳定的文案函数。
   */
  bind(ns: string): Translate
  bind(ns: string): Translate {
    let t = this.bound.get(ns)
    if (t === undefined) {
      t = (key, params) => {
        const template = this.dicts.get(ns)?.[key] ?? this.dicts.get(COMMON_NS)?.[key] ?? key
        if (params === undefined) return template
        return template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
      }
      this.bound.set(ns, t)
    }
    return t
  }

  private publish(): void {
    this.snapshot = Object.freeze({ active: 'zh', locales: CHINESE, revision: this.snapshot.revision + 1 })
    for (const listener of [...this.listeners]) listener()
  }
}

export const inject = ['slots']

/** 安装中文文案服务，不再加载语言包或注册语言设置行。 */
export function apply(ctx: Context): void {
  const locale = new LocaleRuntime(ctx)
  locale.register(COMMON_NS, { zh })
  ctx.provide('locale', locale)
  ctx.slots.installLocale(locale)
  if (typeof document !== 'undefined') document.documentElement.lang = 'zh-CN'
}
