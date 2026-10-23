import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '../src/client/index.ts'

describe('中文文案注册表', () => {
  it('固定中文，不根据系统语言或旧选择切换，也不保留英文表', () => {
    const locale = new LocaleRuntime(new Context())
    locale.register('example', 'en', { greeting: 'Hello', englishOnly: 'English only' })
    locale.register('example', 'zh', { greeting: '你好' })
    const t = locale.bind('example')
    expect(locale.getSnapshot().active).toBe('zh')
    expect(locale.getSnapshot().locales).toEqual([{ id: 'zh', label: '中文' }])
    expect(t('greeting')).toBe('你好')
    expect(t('englishOnly')).toBe('englishOnly')
  })

  it('复用公共中文文案并替换参数，未知词条直接显示键名', () => {
    const locale = new LocaleRuntime(new Context())
    locale.register('common', 'zh', { retry: '重试' })
    locale.register('example', 'zh', { greeting: '你好，{name}。{unknown}' })
    const t = locale.bind('example')
    expect(t('retry')).toBe('重试')
    expect(t('greeting', { name: '用户' })).toBe('你好，用户。{unknown}')
    expect(t('missing')).toBe('missing')
    expect(locale.bind('example')).toBe(t)
  })

  it('批量注册只使用中文，字典释放后已绑定的 t 同步更新', () => {
    const locale = new LocaleRuntime(new Context())
    const t = locale.bind('common')
    const changed = vi.fn()
    const unsubscribe = locale.subscribe(changed)
    const remove = locale.register('common', { zh: { retry: '重试' }, en: { retry: 'Retry' } })
    expect(t('retry')).toBe('重试')
    expect(locale.getSnapshot()).toBe(locale.getLocale())
    expect(changed).toHaveBeenCalledTimes(1)
    expect(() => locale.register('common', 'ZH', {})).toThrow('already has locale')
    remove()
    remove()
    expect(t('retry')).toBe('retry')
    expect(changed).toHaveBeenCalledTimes(2)
    unsubscribe()
    locale.register('common', 'zh', { retry: '再试' })
    expect(changed).toHaveBeenCalledTimes(2)
  })
})
