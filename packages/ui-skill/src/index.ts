/**
 * Host configuration for the skill completion source and browser tool row.
 * The browser half discovers the invocation sigil through settings.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

/** Skill completion input configuration. */
export interface Config {
  /** Human invocation sigil advertised in the composer. */
  trigger?: '/' | '$'
}

/** Validated completion sigil projected to the browser. */
export const Config = z.object({ trigger: z.union(['/', '$'] as const).default('/').volatile() })

/**
 * Publish skill completion configuration to the browser.
 * @param ctx - Host plugin context carrying the optional settings registry.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
}
