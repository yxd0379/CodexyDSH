/** Public ConfigForms validate populated frozen dictionaries without changing their mirror. */
import { Context } from '@deepseek-ai/cordis'
import * as Settings from '@deepseek-ai/dsh-client-ui-settings/client'
import z from '@deepseek-ai/schemastery'
import { TestRemote } from '@codexydsh/test-support/client'
import { expect, it, onTestFinished, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

it('decodes frozen catalogs and restores the original public validator on unload', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const schema = z.object({ hosts: z.dict(z.object({ host: z.string().required() })) })
  const wire = JSON.parse(JSON.stringify({ ns: 'codexy-remote', schema: schema.toJSON(), value: { hosts: { example: { host: 'server' } } },
    base: {}, user: {}, revision: 0, autoGenerate: false, applies: 'live' }))
  new TestRemote(ctx, { settings: { describe: async () => ({ ok: true, value: { writable: true, hasDocument: true, namespaces: [wire] } }) } })
  await ctx.plugin(Settings).await()
  const service = ctx.settingsSchema
  const prior = Object.getOwnPropertyDescriptor(service, 'validate')
  const adaptation = ctx.plugin({ inject: [...inject], apply })
  await adaptation.await()
  await ctx.configForms.describe().ensure()
  const held = ctx.configForms.describe().getSnapshot().view?.namespaces[0]
  if (held === undefined) throw new Error('Settings mirror did not publish the catalog')
  expect(Object.isFrozen(held.value)).toBe(true)
  await vi.waitFor(() => expect(ctx.configForms.get('codexy-remote').getSnapshot()).toMatchObject({ status: 'ready', value: wire.value }))
  expect(held.value).toEqual(wire.value)
  expect(service.validate(service.rehydrate(wire.schema), { hosts: { example: { host: 1 } } })).toBeDefined()
  expect(service.validate(service.rehydrate(wire.schema), () => {})).toBeDefined()
  await adaptation.dispose()
  expect(Object.getOwnPropertyDescriptor(service, 'validate')).toEqual(prior)
  expect(ctx.get('codexySettingsSchema')).toBeUndefined()
})
