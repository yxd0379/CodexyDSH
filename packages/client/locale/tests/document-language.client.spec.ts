// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply, inject } from '../src/client/index.ts'

it('页面声明中文，不使用浏览器语言或旧的原生语言桥', async () => {
  const ctx = new Context()
  const read = vi.fn(() => { throw new Error('不应读取语言偏好') })
  document.documentElement.lang = 'en'
  vi.stubGlobal('__DSH_LOCALE__', { read })
  vi.stubGlobal('navigator', { languages: ['en-US'], language: 'en-US' })
  try {
    await ctx.plugin(SlotRegistry).await()
    await ctx.plugin({ inject, apply }).await()
    expect(document.documentElement.lang).toBe('zh-CN')
    expect(read).not.toHaveBeenCalled()
  } finally {
    vi.unstubAllGlobals()
    await ctx.fiber.dispose()
  }
})
