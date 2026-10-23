import { describe, expect, it } from 'vitest'
import { formatDesktopMessage, resolveDesktopLocale, resolveDesktopStartupLocale, zh } from '../src/locale.ts'

describe('桌面中文文案', () => {
  it('固定中文，不使用系统语言或旧语言偏好', () => {
    expect(resolveDesktopLocale('en-US')).toEqual({ id: 'zh-CN', messages: zh })
    expect(resolveDesktopStartupLocale('en', ['en-US'])).toEqual({ id: 'zh-CN', messages: zh })
    expect(resolveDesktopStartupLocale()).toEqual({ id: 'zh-CN', messages: zh })
  })

  it('替换已有参数并保留未知占位符', () => {
    expect(formatDesktopMessage('{name}@{version} {missing}', { name: 'plugin', version: '1.2.3' }))
      .toBe('plugin@1.2.3 {missing}')
  })
})
