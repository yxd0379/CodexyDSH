// @vitest-environment jsdom
/** Fixed ModuleLoader activates stock browser packages beside an owned Remote provider. */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { ClientModuleSystem, parseBootManifest } from '@deepseek-ai/dsh-client-modules/client'
import type { ClientModuleLoaderTarget } from '@deepseek-ai/dsh-client-modules/client'
import { getStaticModules } from '@deepseek-ai/dsh-client-web'
import { apply as applyRemotes, inject as remoteInject } from '../packages/api-remotes/src/client/index.ts'
import { TestRemote } from '@codexydsh/test-support/client'
import { expect, it, onTestFinished, vi } from 'vitest'

const require = createRequire(import.meta.url)

it('boots stock locale, settings, and renderer without the absent stock Remote package row', async () => {
  const stock = ['@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-locale']
  const owner = '@codexydsh/api-remotes'
  const metadata = await Promise.all(stock.map(async (name) => {
    const manifest = JSON.parse(await readFile(require.resolve(`${name}/package.json`), 'utf8'))
    return { name, inject: manifest.dsh.client.inject as string[], code: await readFile(require.resolve(`${name}/client`), 'utf8') }
  }))
  const entries = [{ id: owner, url: 'owned.js', rev: 'owned', inject: ['@deepseek-ai/dsh-api-gateway'] },
    ...metadata.map(({ name, inject }) => ({ id: name, url: `${name}.js`, rev: 'stock', inject }))]
  const manifest = parseBootManifest({ rev: 'test', entries, batches: [{ phase: 'application', url: 'batch.js', rev: 'batch', entries: entries.map(row => row.id) }] })
  expect(manifest.modules.some(row => row.id === '@deepseek-ai/dsh-api-remotes')).toBe(false)
  expect(manifest.modules.some(row => row.inject.includes('@deepseek-ai/dsh-api-remotes'))).toBe(true)
  const target: ClientModuleLoaderTarget = {
    mode: 'queue', pendingQueue: [],
    load(registration) { this.pendingQueue.push(registration) },
    create() { throw new Error('The fixture constructs the public module system explicitly') },
  }
  target.load({ id: owner, factory: () => ({ apply: applyRemotes, inject: remoteInject }) })
  const transport = vi.fn(async () => {
    for (const { code } of metadata) new Function('window', code)({ __ModuleLoader__: target })
  })
  const modules = new ClientModuleSystem({ manifest, staticModules: getStaticModules(),
    registrationTarget: target, bootstrapModule: { id: '@deepseek-ai/dsh-client-modules', exports: {} }, loadBundle: transport })
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  new TestRemote(ctx, { settings: { describe: async () => ({ ok: true, value: { writable: false, hasDocument: false, namespaces: [] } }) } })
  await ctx.plugin(Loader)
  ctx.loader.internal = modules as never
  await modules.entries.start(ctx.loader, manifest)
  await ctx.loader.await()
  expect(ctx.get('slots')).toBeDefined()
  expect(ctx.get('configForms')).toBeDefined()
  expect(ctx.get('locale')).toBeDefined()
  expect([...ctx.loader.entries()]).toHaveLength(4)
  expect(modules.entries.state.getSnapshot().failures).toEqual([])
  for (const row of entries) expect(modules.importError(row.id)).toBeUndefined()
  expect(transport).toHaveBeenCalledOnce()
})
