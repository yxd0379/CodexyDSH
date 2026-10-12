/**
 * Host configuration for the command UI; execution belongs to the separately
 * mounted command registry. The browser half discovers these values through settings.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

/** Browser command input configuration. */
export interface Config {
  /** Enable Codexful's leading ! shell input when the Host provides /shell. */
  shellInput?: boolean
}

/** Validated command input configuration projected through settings. */
export const Config = z.object({ shellInput: z.boolean().default(false).volatile() })

/**
 * Publish command input configuration to the browser.
 * @param ctx - Host plugin context carrying the optional settings registry.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
}
