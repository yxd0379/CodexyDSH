/** Deployment interval validation and browser defaults agree without explicit settings. */
import { Context, resolveConfig } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished } from 'vitest'
import * as memoryUi from '../src/index.ts'
import { resolveStatusPollMs } from '../src/config.ts'
import { plainConfig } from '@codexydsh/test-support/config'

it('defaults to a bounded interval and rejects deployment values outside its supported range', async () => {
  const ctx = new Context()
  const fiber = ctx.plugin(memoryUi)
  onTestFinished(() => ctx.fiber.dispose())
  await fiber.await()
  const runtime = fiber.runtime
  if (runtime === null) throw new Error('Memory settings runtime is missing')
  expect(plainConfig(resolveConfig(runtime, {}))).toEqual({ statusPollMs: 1500 })
  expect(resolveStatusPollMs(undefined)).toBe(1500)
  expect(plainConfig(resolveConfig(runtime, { statusPollMs: 2000 }))).toEqual({ statusPollMs: 2000 })
  expect(resolveStatusPollMs({ statusPollMs: 2000 })).toBe(2000)
  expect(() => resolveConfig(runtime, { statusPollMs: 0 })).toThrow()
  expect(() => resolveConfig(runtime, { statusPollMs: 60_001 })).toThrow()
})
