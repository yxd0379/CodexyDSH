/** Host module discovery does not depend on browser services. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished } from 'vitest'
import * as plugin from '../src/index.ts'

it('loads the Host entry without a browser settings or command runtime', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const fiber = ctx.plugin(plugin)
  await fiber.await()
  expect(fiber.uid).not.toBeNull()
})
