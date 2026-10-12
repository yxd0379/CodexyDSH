// @vitest-environment jsdom
/** Published closure factories use the unmodified fixed DSH ModuleLoader. */
import { readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { ClientModuleSystem, parseBootManifest, parseDshClient } from '@deepseek-ai/dsh-client-modules/client'
import type { ClientModuleLoaderTarget } from '@deepseek-ai/dsh-client-modules/client'
import { getStaticModules } from '@deepseek-ai/dsh-client-web'
import { ClientModuleRegistry } from '@deepseek-ai/dsh-client-modules'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import * as gateway from '@deepseek-ai/dsh-api-gateway/client'
import z from '@deepseek-ai/schemastery'
import { TestRemote } from '@codexydsh/test-support/client'
import { expect, it, onTestFinished, vi } from 'vitest'

const require = createRequire(import.meta.url)
const platformRequire = createRequire(require.resolve('@deepseek-ai/dsh/package.json'))
const packages = resolve(dirname(fileURLToPath(import.meta.url)), '../packages')
const replaced = new Set(['@deepseek-ai/dsh-api-remotes', ...['approval', 'chat', 'commands', 'conversation', 'deliverables', 'input-trigger', 'memory', 'permission-presets', 'skill', 'tool', 'trajectory', 'usage'].map(name => `@deepseek-ai/dsh-client-ui-${name}`)])
interface Entry { id: string; inject: string[]; code: string }
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
async function entry(name: string): Promise<Entry | undefined> {
  const owned = name.startsWith('@codexydsh/')
  const directory = owned ? resolve(packages, name.slice('@codexydsh/'.length)) : undefined
  const manifestPath = directory === undefined ? platformRequire.resolve(`${name}/package.json`) : resolve(directory, 'package.json')
  const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (!record(manifest) || manifest.name !== name) throw new Error(`Invalid artifact manifest for ${name}`)
  const client = parseDshClient(name, record(manifest.dsh) ? manifest.dsh.client : undefined)
  if (client === undefined) return undefined
  const code = await readFile(directory === undefined ? platformRequire.resolve(`${name}/client`) : resolve(directory, 'lib/client.js'), 'utf8')
  return { id: name, inject: client.inject ?? [], code }
}
function moduleSystem(rows: readonly Entry[]) {
  const manifest = parseBootManifest({ rev: 'built', entries: rows.map(row => ({ id: row.id, inject: row.inject, url: row.id + '.js', rev: 'built' })),
    batches: [{ phase: 'application', url: 'batch.js', rev: 'built', entries: rows.map(row => row.id) }] })
  const target: ClientModuleLoaderTarget = { mode: 'queue', pendingQueue: [], load(registration) { this.pendingQueue.push(registration) },
    create() { throw new Error('The fixture constructs the public module system explicitly') } }
  const transport = vi.fn(async () => {
    for (const row of rows) new Function('window', row.code)({ __ModuleLoader__: target })
  })
  const modules = new ClientModuleSystem({ manifest, staticModules: getStaticModules(), registrationTarget: target,
    bootstrapModule: { id: '@deepseek-ai/dsh-client-modules', exports: {} }, loadBundle: transport })
  return { manifest, modules, transport }
}

it('materializes every shipped product browser factory using actual built bytes', async () => {
  const rows = new Map<string, Entry>()
  for (const directory of await readdir(packages)) {
    const row = await entry('@codexydsh/' + directory)
    if (row !== undefined) rows.set(row.id, row)
  }
  const owned = [...rows.keys()]
  const pending = [...rows.values()]
  while (pending.length > 0) {
    for (const dependency of pending.shift()!.inject) {
      if (!dependency.startsWith('@deepseek-ai/') || rows.has(dependency) || replaced.has(dependency)) continue
      const row = await entry(dependency)
      if (row !== undefined) { rows.set(row.id, row); pending.push(row) }
    }
  }
  const { modules, transport } = moduleSystem([...rows.values()])
  expect(owned.length).toBeGreaterThanOrEqual(15)
  for (const name of owned) {
    expect(await modules.import(name), name).toHaveProperty('apply')
    expect(modules.importError(name), name).toBeUndefined()
  }
  expect(transport).toHaveBeenCalledOnce()
})

it('mounts the built product Remote assembly and frozen-draft adapter beside the published browser services', async () => {
  const names = ['@codexydsh/api-remotes', '@codexydsh/ui-settings', '@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-locale']
  const rows: Entry[] = []
  for (const name of names) { const row = await entry(name); if (row === undefined) throw new Error(`Missing browser entry ${name}`); rows.push(row) }
  const { manifest, modules } = moduleSystem(rows)
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const namespace = { ns: 'codexy-remote', schema: z.object({ hosts: z.dict(z.object({ host: z.string().required() })) }).toJSON(),
    value: { hosts: { fixture: { host: 'server' } } }, base: {}, user: {}, revision: 0, autoGenerate: false, applies: 'live' }
  new TestRemote(ctx, { settings: { describe: async () => ({ ok: true, value: { writable: false, hasDocument: false, namespaces: [namespace] } }) } })
  await ctx.plugin(Loader)
  ctx.loader.internal = modules as never
  await modules.entries.start(ctx.loader, manifest)
  await ctx.loader.await()
  expect(ctx.get('slots')).toBeDefined()
  expect(ctx.get('configForms')).toBeDefined()
  expect(ctx.get('locale')).toBeDefined()
  expect(ctx.get('codexySettingsSchema') !== undefined).toBe(true)
  await ctx.configForms.describe().ensure()
  await vi.waitFor(() => expect(ctx.configForms.get('codexy-remote').getSnapshot()).toMatchObject({ status: 'ready', value: namespace.value }))
  expect([...ctx.loader.entries()]).toHaveLength(5)
  expect(modules.entries.state.getSnapshot().failures).toEqual([])
  for (const name of names) expect(modules.importError(name)).toBeUndefined()
})

it('publishes the Session browser provider from the actual Host graph with its Host controller disabled', async () => {
  const host = new Context()
  const browser = new Context()
  onTestFinished(async () => { await browser.fiber.dispose(); await host.fiber.dispose() })
  await host.plugin(Loader, { baseUrl: pathToFileURL(resolve('package.json')).href })
  for (const name of ['@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-session']) {
    const id = await host.loader.create({ id: name, name, config: {} })
    await host.loader.resolve(id).fiber!.await()
  }
  await host.loader.create({ id: 'disabled-session-host', name: '@deepseek-ai/dsh-api-session-controller', disabled: true, config: {} })
  await host.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const origin = `http://127.0.0.1:${host.webServer.port}`
  await host.plugin(ClientModuleRegistry)
  const modules = host.clientModules
  const base = modules.graph()
  const originalDescriptor = Object.getOwnPropertyDescriptor(modules, 'graph')
  const indexListenerCount = () => host.events.dispatch('emit', ['webserver/index-inject']).length
  const originalListeners = indexListenerCount()
  const provider = '@deepseek-ai/dsh-api-session-controller'
  expect(base.entries.some(row => row.id === provider)).toBe(false)
  // This is a built Host artifact: native Node loading preserves the published
  // dsh-app-boot import.meta.url used to read its real runtime version. The
  // browser factories below still run through the public client module system.
  const browserSession = require(resolve(packages, 'browser-session/lib/index.js'))
  const bootstrap = await host.plugin(browserSession)
  expect(indexListenerCount()).toBe(originalListeners + 1)
  const injections = host.webServer.collectIndexInjections()
  const boot = injections.find(row => row.kind === 'global' && row.name === '__DSH_BOOT__')
  if (boot?.kind !== 'global') throw new Error('Missing composed browser boot graph')
  const manifest = parseBootManifest(boot.value)
  expect(manifest.modules.filter(row => row.id === provider)).toHaveLength(1)
  expect(modules.graph()).toBe(modules.graph())
  expect(host.loader.resolve('disabled-session-host').fiber).toBeUndefined()
  expect(await readFile(resolve(packages, 'web/cordis.patch.yml'), 'utf8')).toMatch(/name:\s*['"]@codexydsh\/browser-session['"]/)
  const published = await readFile(platformRequire.resolve(provider + '/client'), 'utf8')
  const providerUrl = origin + '/' + manifest.modules.find(row => row.id === provider)!.url
  const response = await fetch(providerUrl)
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
  expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  expect(await response.text()).toBe(published)
  const head = await fetch(providerUrl, { method: 'HEAD' })
  expect(head.status).toBe(200)
  expect(head.headers.get('cache-control')).toBe(response.headers.get('cache-control'))
  expect(await head.text()).toBe('')
  const unsupported = await fetch(providerUrl, { method: 'POST' })
  expect(unsupported.status).toBe(405)
  await unsupported.arrayBuffer()
  const target: ClientModuleLoaderTarget = { mode: 'queue', pendingQueue: [], load(registration) { this.pendingQueue.push(registration) },
    create() { throw new Error('The fixture constructs the public module system explicitly') } }
  const system = new ClientModuleSystem({ manifest, staticModules: { ...getStaticModules(), '@deepseek-ai/dsh-api-gateway/client': gateway },
    registrationTarget: target, bootstrapModule: { id: '@deepseek-ai/dsh-client-modules', exports: {} },
    async loadBundle(url) {
      const response = await fetch(origin + '/' + url)
      if (!response.ok) throw new Error(`Browser bundle ${url} returned ${response.status}`)
      const body = await response.text()
      new Function('window', body)({ __ModuleLoader__: target })
    } })
  const generationListeners = new Set<() => void>()
  const connection = { generation: { getSnapshot: () => undefined, subscribe(listener: () => void) {
    generationListeners.add(listener)
    return () => { generationListeners.delete(listener) }
  } } }
  class GraphRemote extends TestRemote {
    $stream<Item>(options: gateway.RemoteStreamOptions<Item>): gateway.RemoteStream<Item> {
      return new gateway.RemoteStream(connection, options)
    }
  }
  new GraphRemote(browser, { commands: {}, session: {}, subagents: {} })
  browser.provide('connection', connection)
  browser.provide('fileUpload', {})
  await browser.plugin(TypertRegistry)
  await browser.plugin(Loader)
  browser.loader.internal = system as never
  await system.entries.start(browser.loader, manifest)
  await browser.loader.await()
  await Promise.all([...browser.loader.entries()].map(row => row.fiber?.await()))
  expect(browser.get('sessions')).toBeDefined()
  expect(browser.get('uiSession')).toBeDefined()
  expect(system.entries.state.getSnapshot().failures).toEqual([])
  expect(generationListeners.size).toBeGreaterThan(0)
  await browser.fiber.dispose()
  expect(generationListeners.size).toBe(0)
  await bootstrap.dispose()
  expect(modules.graph()).toBe(base)
  expect(Object.getOwnPropertyDescriptor(modules, 'graph')).toEqual(originalDescriptor)
  expect(indexListenerCount()).toBe(originalListeners)
  const restored = host.webServer.collectIndexInjections().find(row => row.kind === 'global' && row.name === '__DSH_BOOT__')
  if (restored?.kind !== 'global') throw new Error('Missing restored public browser boot graph')
  expect(restored.value).toBe(base)
  const removed = await fetch(providerUrl)
  expect(removed.status).toBe(404)
  await removed.arrayBuffer()
})
