/** Optional Usage Remote contribution and effect-owned settings registration. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import usageRemote from '@codexydsh/api-usage/remote'
import { UsageController } from './controller.ts'
import { UsageSection } from './UsageSection.tsx'
import { NS, en, zh } from './locales.ts'

/** Required Client services; this feature mounts its own Remote contribution. */
export const inject = ['slots', 'locale', 'remote']

/** Register the Usage settings page and release its active read on unload.
 * @param ctx - Client root containing the Remote carrier and Slot registry.
 * @returns Generated Remote contribution disposer.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'usage: dictionaries')
  const unmount = await ctx.remote.$mount(usageRemote)
  ctx.inject(['remote.usage'], (scope) => {
    const usage = scope.remote.usage
    const controller = new UsageController((request, signal) => usage.snapshot(request, signal))
    scope.effect(() => () => { controller.cancel() }, 'usage: query lifetime')
    scope.slots.inject('settings.section', () => scope.slots.register({
      name: 'settings.section', id: 'usage', order: 20, locale: NS,
      label: () => scope.locale.bind(NS)('nav'),
      inject: () => ({ hooks: { usage: controller.state }, observe: controller.observe,
        refresh: controller.load, select: controller.select }),
    }, UsageSection))
  })
  return unmount
}
