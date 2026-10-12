/** Released Settings publishes catalogs that its actual Client forms can decode. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SettingsForms from '@deepseek-ai/dsh-settings'
import * as SettingsClient from '@deepseek-ai/dsh-client-ui-settings/client'
import * as ProductSettings from '@codexydsh/ui-settings/client'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { liveConfig } from '@codexydsh/test-support/config'
import { expect, it, onTestFinished, vi } from 'vitest'
import RemoteLauncher from '../src/index.ts'

it('decodes a JSON-transferred host catalog into a ready public Settings form', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codexy-remote-settings-'))
  onTestFinished(() => rm(home, { recursive: true, force: true }))
  const host = new Context()
  onTestFinished(() => host.fiber.dispose())
  await host.plugin(TypertRegistry)
  const { entry } = await liveConfig(host, RemoteLauncher, { hosts: { example: { host: 'server', directory: '/workspace' } } })
  host.provide('profileContext', { home, name: 'test' })
  host.provide('configEditor', {
    documentPath: join(home, 'cordis.patch.yml'),
    configuration: () => [{ entry, inherited: entry.options.config, override: {} }],
  })
  await host.plugin(SettingsForms)
  const descriptor = host.settings.describe().find(form => form.ns === entry.options.id)
  if (descriptor === undefined) throw new Error('Remote settings form is unavailable')
  const wire = JSON.parse(JSON.stringify(descriptor)) as typeof descriptor
  const client = new Context()
  onTestFinished(() => client.fiber.dispose())
  client.provide('remote', {
    $host: { isLoopback: true }, $on: () => () => {},
    settings: { describe: async () => ({ ok: true, value: { writable: true, namespaces: [wire] } }) },
  })
  SettingsClient.apply(client)
  await client.plugin(ProductSettings).await()
  expect(client.settingsSchema.validate(client.settingsSchema.rehydrate(wire.schema), wire.value)).toBeUndefined()
  await vi.waitFor(() => {
    expect(client.configForms.get(entry.options.id!).getSnapshot()).toMatchObject({
      status: 'ready', writable: true, value: { hosts: { example: {
        host: 'server', profile: 'codexy', directory: '/workspace', node: 'node', dsh: 'dsh',
      } } },
    })
  })
})
