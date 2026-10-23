import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply, inject, type LocaleRuntime } from '../src/client/index.ts'

it('只依赖文案注入服务，不再等待设置、RPC 或原生语言初始化', async () => {
  const ctx = new Context()
  try {
    expect(inject).toEqual(['slots'])
    await ctx.plugin(SlotRegistry).await()
    await ctx.plugin({ inject, apply }).await()
    const locale = ctx.get('locale') as LocaleRuntime
    expect(locale.bind('common')('retry')).toBe('重试')
    expect(ctx.slots.entries('settings.general.item')).toEqual([])
  } finally {
    await ctx.fiber.dispose()
  }
})
