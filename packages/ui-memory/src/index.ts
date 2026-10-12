/** Host settings for the independently composed browser memory controls. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_STATUS_POLL_MS } from './config.ts'
import type { MemoryUiConfig } from './config.ts'

/** Validated deployment configuration for the browser. */
export type Config = MemoryUiConfig
/** Browser-visible interval for bounded background-status observation. */
export const Config = z.object({ statusPollMs: z.number().min(250).max(60_000).default(DEFAULT_STATUS_POLL_MS).volatile() })

/** Publish the memory browser configuration through the existing settings registry.
 * @param ctx - Host plugin context.
 * @param _config - Loader-validated values consumed by the browser settings projection.
 */
export function apply(ctx: Context, _config: Config): void {
  ctx.inject(['settings'], (scope) => { scope.effect(() => scope.settings.configure({ auto: false }, ctx.fiber)) })
}
