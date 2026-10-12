/** Settings test fixtures instantiate the public platform provider. */
import { Context } from '@deepseek-ai/cordis'
import { apply } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client'
import { onTestFinished } from 'vitest'
import { TestRemote } from './remote.ts'

/**
 * Provide one scripted Settings namespace through the real public forms owner.
 * @param api - Operations explicitly exercised by the feature test.
 * @param persistence - Host-backed forms or a process-local remote browser.
 * @returns Context and the public describe face; test completion disposes them.
 */
export function settingsFixture(api: object, persistence: 'host' | 'memory' = 'host'): { ctx: Context; mirror: SettingsDescribeFace } {
  const ctx = new Context()
  const remote = new TestRemote(ctx, { settings: api })
  remote.$host.isLoopback = persistence === 'host'
  apply(ctx)
  onTestFinished(() => ctx.fiber.dispose())
  return { ctx, mirror: ctx.configForms.describe() }
}
