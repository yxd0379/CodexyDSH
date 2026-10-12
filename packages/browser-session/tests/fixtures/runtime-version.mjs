/** Independent module graph: every platform import comes from one real install. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import { ClientModuleRegistry } from '@deepseek-ai/dsh-client-modules'
import WebServer from '@deepseek-ai/dsh-host-webserver'

const require = createRequire(import.meta.url)
const provider = '@deepseek-ai/dsh-api-session-controller'
const version = getDshRuntimeVersion()
const publishedManifest = JSON.parse(await readFile(require.resolve(provider + '/package.json'), 'utf8'))
assert.equal(publishedManifest.version, version)

if (process.argv.includes('--mismatch')) {
  // This product-local fixture shadows only metadata. The installed platform
  // packages remain byte-for-byte unchanged, including app-boot's real version.
  const directory = join(process.cwd(), 'product/node_modules', provider)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({ ...publishedManifest, version: '9.9.9' }))
  const bridge = await import('./product/index.js')
  const ctx = new Context()
  let registrations = 0
  const base = { rev: 'empty', entries: [], batches: [] }
  const modules = { graph: () => base }
  ctx.provide('clientModules', modules)
  ctx.provide('webServer', { register() { registrations++; return () => {} } })
  const graph = modules.graph
  const listeners = ctx.events.dispatch('emit', ['webserver/index-inject']).length
  try {
    assert.throws(() => bridge.apply(ctx), /version/)
    assert.equal(registrations, 0)
    assert.equal(modules.graph, graph)
    assert.equal(ctx.events.dispatch('emit', ['webserver/index-inject']).length, listeners)
  } finally { await ctx.fiber.dispose() }
  process.stdout.write(JSON.stringify({ version, rejectedBeforeRegistration: true }))
} else {
  const host = new Context()
  try {
    await host.plugin(Loader, { baseUrl: pathToFileURL(join(process.cwd(), 'package.json')).href })
    for (const name of ['@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-session']) {
      const id = await host.loader.create({ id: name, name, config: {} })
      await host.loader.resolve(id).fiber.await()
    }
    await host.loader.create({ id: 'disabled-session-host', name: provider, disabled: true, config: {} })
    await host.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await host.plugin(ClientModuleRegistry)
    const modules = host.clientModules
    const originalDescriptor = Object.getOwnPropertyDescriptor(modules, 'graph')
    const base = modules.graph()
    assert.equal(base.entries.some(entry => entry.id === provider), false)
    const listeners = () => host.events.dispatch('emit', ['webserver/index-inject']).length
    const originalListeners = listeners()
    const bridge = await host.plugin(await import('./product/index.js'))
    const composed = modules.graph()
    assert.equal(modules.graph(), composed)
    assert.equal(listeners(), originalListeners + 1)
    const rows = composed.entries.filter(entry => entry.id === provider)
    assert.equal(rows.length, 1)
    assert.notEqual(composed.rev, base.rev)
    assert.deepEqual(composed.entries.filter(entry => entry.id !== provider), base.entries)
    assert.deepEqual(composed.batches.filter(batch => !batch.entries.includes(provider)), base.batches)
    const entry = rows[0]
    assert.deepEqual(entry.inject, publishedManifest.dsh.client.inject)
    assert.deepEqual(entry.external, publishedManifest.dsh.client.external)
    assert.equal(composed.batches.filter(batch => batch.entries.includes(provider)).length, 1)
    const published = await readFile(require.resolve(provider + '/client'))
    assert.equal(entry.rev, createHash('sha256').update(published).digest('hex'))
    const registration = []
    new Function('window', published.toString())({ __ModuleLoader__: { load: row => registration.push(row) } })
    assert.equal(registration.length, 1)
    assert.equal(registration[0].id, provider)
    assert.equal(typeof registration[0].factory, 'function')
    const injection = host.webServer.collectIndexInjections().find(row => row.kind === 'global' && row.name === '__DSH_BOOT__')
    assert.equal(injection.value, composed)
    assert.equal(host.loader.resolve('disabled-session-host').fiber, undefined)
    const origin = `http://127.0.0.1:${host.webServer.port}`
    const url = origin + '/' + entry.url
    const response = await fetch(url)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8')
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), published)
    const head = await fetch(url, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('cache-control'), response.headers.get('cache-control'))
    assert.equal(await head.text(), '')
    const unsupported = await fetch(url, { method: 'POST' })
    assert.equal(unsupported.status, 405)
    await unsupported.arrayBuffer()
    // A later public loader entry changes the base generation. The bridge must
    // contribute to the new live graph and its corresponding index injection.
    const locale = await host.loader.create({ id: 'live-locale', name: '@deepseek-ai/dsh-client-locale', config: {} })
    await host.loader.resolve(locale).fiber.await()
    const live = modules.graph()
    assert.notEqual(live, composed)
    assert.equal(live.entries.filter(row => row.id === provider).length, 1)
    assert.equal(live.entries.some(row => row.id === '@deepseek-ai/dsh-client-locale'), true)
    assert.equal(modules.graph(), live)
    assert.equal(host.webServer.collectIndexInjections().find(row => row.kind === 'global' && row.name === '__DSH_BOOT__').value, live)
    await bridge.dispose()
    assert.deepEqual(Object.getOwnPropertyDescriptor(modules, 'graph'), originalDescriptor)
    assert.equal(listeners(), originalListeners)
    assert.equal(modules.graph().entries.some(row => row.id === provider), false)
    const removed = await fetch(url)
    assert.equal(removed.status, 404)
    await removed.arrayBuffer()
    process.stdout.write(JSON.stringify({ version, actualPlatformGraph: true, actualPublishedBytes: true, initialAndLiveGraph: true, disposed: true }))
  } finally { await host.fiber.dispose() }
}
