/** Usage dictionary, settings section and Remote contribution leave with the plugin. */
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@codexydsh/api-usage/remote'
import { expect, it, onTestFinished, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { apply as applyHost } from '../src/index.ts'
import type { UsageSectionInjected } from '../src/client/UsageSection.tsx'

it('registers Usage in Settings and removes its section and Remote namespace on unload', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin({ apply: applyHost }).await()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } },
    ({ renderSlot }: PropsRenderSlots<'settings.section'>) => renderSlot('settings.section', { close: () => {} }))
  const snapshot = { capturedAt: 0, models: [], totals: {
    requests: 0, reportedRequests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  } }
  const usage = { snapshot: vi.fn<Context['remote']['usage']['snapshot']>().mockResolvedValue({ ok: true, value: snapshot }) }
  const unmounted = vi.fn()
  ctx.provide('remote', {
    usage,
    $mount: async (_contribution: TypertRemoteContribution) => {
      const fiber = ctx.plugin((owner) => { owner.provide('remote.usage', usage) })
      await fiber.await()
      return async () => { unmounted(); await fiber.dispose() }
    },
  } as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const entry = ctx.slots.entries('settings.section')[0]
  expect(entry?.options.id).toBe('usage')
  const label = entry?.options.label
  expect(typeof label === 'function' ? label() : label).toBe('Usage')
  expect(usage.snapshot).not.toHaveBeenCalled()
  if (entry?.inject === undefined) throw new Error('Usage section missing')
  const resolve = entry.inject as (() => UsageSectionInjected) & NonNullable<typeof entry.inject>
  const input = resolve()
  input.select('all')
  expect(usage.snapshot).not.toHaveBeenCalled()
  await input.refresh()
  expect(usage.snapshot).toHaveBeenCalledExactlyOnceWith({}, expect.any(AbortSignal))
  expect(input.hooks.usage.getSnapshot().snapshot).toEqual(snapshot)
  await fiber.dispose()
  expect(ctx.slots.entries('settings.section')).toHaveLength(0)
  expect(unmounted).toHaveBeenCalledOnce()
})
