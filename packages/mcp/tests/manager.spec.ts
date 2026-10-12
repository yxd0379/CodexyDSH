/** Real Loader and MCP transport coverage for Session isolation and selection restoration. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context, resolveConfig } from '@deepseek-ai/cordis'
import SettingsForms from '@deepseek-ai/dsh-settings'
import * as ProductSettings from '@codexydsh/ui-settings/client'
import * as SettingsClient from '@deepseek-ai/dsh-client-ui-settings/client'
import z from '@deepseek-ai/schemastery'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import CommandRuntime, { CommandId } from '@deepseek-ai/dsh-commands'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import PromptRegistry from '@codexydsh/prompt-registry'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { startHttpMcpFixture } from './http-fixture.ts'
import McpManager from '../src/index.ts'
import { Config as ClientConfig, apply as applyClient } from '@deepseek-ai/dsh-mcp-client'

async function boot(autoConnect = false, server: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-manager-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const http = await startHttpMcpFixture()
  onTestFinished(() => http.close())
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, {
    include: Include, session: SessionStore, commands: CommandRuntime, tools: ToolRuntime,
    prompt: SystemPrompt, codexyPrompt: PromptRegistry, typert: TypertRegistry, projections: SessionProjections, manager: McpManager,
  })
  const config = join(root, 'cordis.yml')
  await writeFile(config, JSON.stringify([
    ...['session', 'commands', 'tools', 'prompt', 'codexyPrompt', 'typert', 'projections'].map(name => ({ name: `cordis:${name}` })),
    { name: 'cordis:manager', id: 'mcp-manager', config: { servers: {
      example: { serverName: 'example', transport: 'streamable-http', url: http.url, autoConnect, headers: { Authorization: 'test-secret' }, ...server },
    } } },
  ]))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  expect(ctx.mcpManager).toBeDefined()
  return { ctx, http }
}

async function owner(ctx: Context, id: string, existing?: Session): Promise<{ agent: Agent; scope: Scope }> {
  const session = existing ?? ctx.sessions.create(SessionId(id))
  const agent = { id: session.id, session } as Agent
  let scope: Scope | undefined
  await ctx.plugin({ inject: ['tools'], apply(inner: Context) {
    scope = createScope(inner, agent)
    Object.assign(agent, { ctx: scope.ctx })
  } })
  if (!scope) throw new Error('Agent scope did not activate')
  return { agent, scope }
}

const signal = (): AbortSignal => new AbortController().signal
const execute = (ctx: Context, agent: Agent, line: string) => ctx.commands.execute(agent, line, [], signal())

describe('managed MCP connections', () => {
  it('leaves manually selected servers disconnected by default', async () => {
    const { ctx, http } = await boot()
    const { agent } = await owner(ctx, 'empty')
    expect(await ctx.mcpManager.catalog(agent, signal())).toEqual([
      { serverName: 'example', transport: 'streamable-http', enabled: false, phase: 'disabled', toolCount: 0 },
    ])
    expect(http.authorization).toEqual([])
    expect((await execute(ctx, agent, '/mcp invalid'))?.result.kind).toBe('error')
    expect((await execute(ctx, agent, '/mcp on missing'))?.result.kind).toBe('error')
  })

  it('connects only the selected Session and removes its tools on disconnect', async () => {
    const { ctx, http } = await boot()
    const a = await owner(ctx, 'a')
    const b = await owner(ctx, 'b')
    expect((await execute(ctx, a.agent, '/mcp on example'))?.result).toEqual({ kind: 'success', text: 'example: connected' })
    expect(ctx.tools.schemas(a.agent).map(tool => tool.name)).toContain('mcp__example__ping')
    expect(ctx.tools.schemas(b.agent).map(tool => tool.name)).not.toContain('mcp__example__ping')
    expect(http.authorization).toContain('test-secret')
    expect(await ctx.mcpManager.catalog(a.agent, signal())).toEqual([
      { serverName: 'example', transport: 'streamable-http', enabled: true, phase: 'connected', toolCount: 1 },
    ])
    expect((await execute(ctx, a.agent, '/mcp off example'))?.result).toEqual({ kind: 'success', text: 'example: disabled' })
    expect(ctx.tools.schemas(a.agent).map(tool => tool.name)).not.toContain('mcp__example__ping')
    await execute(ctx, a.agent, '/mcp on example')
    await a.scope.dispose()
    expect(ctx.tools.schemas(a.agent).map(tool => tool.name)).not.toContain('mcp__example__ping')
  })

  it('restores successful selections while failed and unfinished commands leave them unchanged', async () => {
    const { ctx } = await boot(true)
    const first = await owner(ctx, 'restore')
    await execute(ctx, first.agent, '/mcp off example')
    await execute(ctx, first.agent, '/mcp on unknown')
    first.agent.session.append('command/run', {
      commandId: CommandId('unfinished-on'), name: 'mcp', args: ' on example', source: { kind: 'user' },
    })
    await first.scope.dispose()
    const restored = await owner(ctx, 'restore', first.agent.session)
    expect((await ctx.mcpManager.catalog(restored.agent, signal()))[0]?.phase).toBe('disabled')
    await execute(ctx, restored.agent, '/mcp on example')
    await restored.scope.dispose()
    const connected = await owner(ctx, 'restore', first.agent.session)
    expect((await ctx.mcpManager.catalog(connected.agent, signal()))[0]?.phase).toBe('connected')
  })

  it('connects defaults before prompt preparation captures the model tools', async () => {
    const { ctx } = await boot(true)
    const { agent } = await owner(ctx, 'first-request')
    expect(ctx.tools.schemas(agent).map(tool => tool.name)).not.toContain('mcp__example__ping')
    await ctx.codexyPrompt.prepare({ agent, scope: agent, signal: signal() })
    expect(ctx.tools.schemas(agent).map(tool => tool.name)).toContain('mcp__example__ping')
  })

  it('reconciles catalog edits and null removals without replacing the manager', async () => {
    const { ctx, http } = await boot()
    const { agent } = await owner(ctx, 'catalog-edit')
    const manager = [...ctx.loader.entries()].find(entry => entry.options.id === 'mcp-manager')
    if (!manager?.fiber) throw new Error('Manager entry is unavailable')
    const uid = manager.fiber.uid
    await execute(ctx, agent, '/mcp on example')
    const invalid = { servers: { wrong: { serverName: 'example', transport: 'streamable-http', url: http.url } } }
    expect(() => resolveConfig(manager.fiber!.runtime!, manager.fiber!.ctx.waterfall(
      manager.fiber!, 'internal/config', invalid, () => invalid,
    ))).toThrow('keys must match')
    expect(manager.options.config).not.toEqual(invalid)
    expect((await ctx.mcpManager.catalog(agent, signal()))[0]?.phase).toBe('connected')
    await manager.update({ config: { servers: { example: {
      serverName: 'example', transport: 'streamable-http', url: http.url, headers: { Authorization: 'replacement-secret' },
    } } } })
    expect((await ctx.mcpManager.catalog(agent, signal()))[0]?.phase).toBe('connected')
    expect(http.authorization).toContain('replacement-secret')
    expect(manager.fiber.uid).toBe(uid)
    expect((await execute(ctx, agent, '/mcp'))?.result.text).toContain('example: connected (1 tools)')
    await manager.update({ config: { servers: { example: null } } })
    expect(await ctx.mcpManager.catalog(agent, signal())).toEqual([])
    expect(ctx.tools.schemas(agent).map(tool => tool.name)).not.toContain('mcp__example__ping')
    expect((await execute(ctx, agent, '/mcp on example'))?.result.kind).toBe('error')
    expect((await execute(ctx, agent, '/mcp'))?.result.text).toContain('Settings → MCP')
    await ctx.codexyPrompt.prepare({ agent, scope: agent })
    await ctx.codexyPrompt.prepare({})
    const aborted = new AbortController()
    aborted.abort()
    await expect(ctx.mcpManager.catalog(agent, aborted.signal)).rejects.toThrow()
    agent.session.append('command/run', { commandId: CommandId('empty-mcp'), name: 'mcp', source: { kind: 'user' } })
    agent.session.append('command/done', { commandId: CommandId('empty-mcp'), kind: 'success' })
  })

  it('keeps an explicit off selection after a namespace collision refuses connection', async () => {
    const { ctx, http } = await boot()
    const { agent } = await owner(ctx, 'namespace-collision')
    await execute(ctx, agent, '/mcp off example')
    const legacy = agent.ctx.plugin({ inject: ['tools'], apply(inner: Context) {
      return applyClient(inner, ClientConfig({ serverName: 'example', transport: 'streamable-http', url: http.url }))
    } })
    await legacy.await()
    await expect(execute(ctx, agent, '/mcp on example')).rejects.toThrow('already in use')
    expect(await ctx.mcpManager.catalog(agent, signal())).toMatchObject([{ enabled: false, phase: 'disabled' }])
    await legacy.dispose()
    await execute(ctx, agent, '/mcp on example')
    expect((await ctx.mcpManager.catalog(agent, signal()))[0]?.phase).toBe('connected')
  })

  it('withdraws its manual settings policy and projection on unload', async () => {
    const { ctx } = await boot()
    const configured = vi.fn()
    const configure = vi.fn(() => configured)
    ctx.provide('settings', { configure } as never)
    await ctx.fiber.await()
    expect(configure).toHaveBeenCalledWith({ auto: false }, expect.anything())
    const manager = ctx.mcpManager
    const entry = [...ctx.loader.entries()].find(row => row.options.id === 'mcp-manager')
    if (!entry?.fiber) throw new Error('Manager entry is unavailable')
    await entry.fiber.dispose()
    expect(configured).toHaveBeenCalledOnce()
    const { agent } = await owner(ctx, 'unloaded')
    expect(() => { void manager.catalog(agent, signal()) }).toThrow('projection is unavailable')
  })

  it('reports a conflicting automatic connection and closes it after removing the competing client', async () => {
    const { ctx, http } = await boot(true)
    const { agent } = await owner(ctx, 'live-collision')
    await ctx.mcpManager.catalog(agent, signal())
    const entry = [...ctx.loader.entries()].find(row => row.options.id === 'mcp-manager')
    if (!entry) throw new Error('Manager entry is unavailable')
    await entry.update({ config: { servers: { example: {
      serverName: 'example', transport: 'streamable-http', url: http.url, autoConnect: false,
    } } } })
    await ctx.mcpManager.catalog(agent, signal())
    const legacy = agent.ctx.plugin({ inject: ['tools'], apply(inner: Context) {
      return applyClient(inner, ClientConfig({ serverName: 'example', transport: 'streamable-http', url: http.url }))
    } })
    await legacy.await()
    await entry.update({ config: { servers: { example: {
      serverName: 'example', transport: 'streamable-http', url: http.url, autoConnect: true,
    } } } })
    await expect(ctx.mcpManager.catalog(agent, signal())).rejects.toThrow('already in use')
    await legacy.dispose()
    expect((await ctx.mcpManager.catalog(agent, signal()))[0]?.phase).toBe('connected')
  })

  it('closes an in-flight negotiation when the manager unloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-managed-mcp-probe-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const eventsPath = join(root, 'events.jsonl')
    const releasePath = join(root, 'release')
    await writeFile(eventsPath, '')
    const fixture = fileURLToPath(new URL('./fixtures/negotiation-lifecycle.mjs', import.meta.url))
    const { ctx } = await boot(false, { transport: 'stdio', command: process.execPath, args: [fixture, eventsPath, releasePath] })
    const { agent } = await owner(ctx, 'unload')
    const events = async () => (await readFile(eventsPath, 'utf8')).split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as { event: string; pid: number })
    const selected = expect(execute(ctx, agent, '/mcp on example')).rejects.toThrow('MCP Session has been disposed')
    await vi.waitFor(async () => { expect((await events()).some(event => event.event === 'server/discover')).toBe(true) }, { timeout: 15_000 })
    const manager = [...ctx.loader.entries()].find(entry => entry.options.id === 'mcp-manager')?.fiber
    if (!manager) throw new Error('Manager plugin did not activate')
    const disposing = manager.dispose()
    await writeFile(releasePath, '')
    await selected
    await disposing
    const starts = (await events()).filter(event => event.event === 'start')
    expect(starts).toHaveLength(1)
    for (const event of starts) expect(() => process.kill(event.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    expect(ctx.tools.schemas(agent).map(tool => tool.name)).not.toContain('mcp__example__ping')
  })

  it('refuses a connection disposed before its plugin activates', async () => {
    const { ctx } = await boot()
    const { agent } = await owner(ctx, 'activation-disposal')
    const disposed: Promise<void>[] = []
    ctx.on('internal/plugin', (fiber) => {
      if (fiber.uid !== null && fiber.runtime?.name === 'managed-mcp-example') disposed.push(fiber.dispose())
    }, { global: true })
    await expect(execute(ctx, agent, '/mcp on example')).rejects.toThrow('did not activate')
    await Promise.all(disposed)
    expect((await ctx.mcpManager.catalog(agent, signal()))[0]?.enabled).toBe(false)
  })

  it('starts no replacement server when unload overlaps asynchronous connection teardown', async () => {
    const { ctx, http } = await boot(true)
    const { agent } = await owner(ctx, 'replacement-disposal')
    const closing = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    ctx.on('internal/plugin', (fiber) => {
      if (fiber.uid !== null && fiber.runtime?.name === 'managed-mcp-example') {
        fiber.ctx.effect(() => async () => { closing.resolve(undefined); await release.promise })
      }
    }, { global: true })
    await ctx.mcpManager.catalog(agent, signal())
    const entry = [...ctx.loader.entries()].find(row => row.options.id === 'mcp-manager')
    if (!entry?.fiber) throw new Error('Manager entry is unavailable')
    const before = http.authorization.length
    await entry.update({ config: { servers: {
      example: null, replacement: { serverName: 'replacement', transport: 'streamable-http', url: http.url, autoConnect: true },
    } } })
    await closing.promise
    const disposing = entry.fiber.dispose()
    release.resolve(undefined)
    await disposing
    expect(http.authorization).toHaveLength(before)
    expect(ctx.tools.schemas(agent).map(tool => tool.name)).not.toContain('mcp__replacement__ping')
  })

  it('rejects invalid catalog keys and endpoint protocols at validation', () => {
    expect(McpManager.Config({}).servers.get()).toEqual({})
    const common = { serverName: 'example', toolCallTimeoutMs: 60_000, failOnStartupError: false, autoConnect: false }
    expect(() => new McpManager(new Context(), McpManager.Config({ servers: {
      wrong: { ...common, transport: 'stdio', command: 'node', args: [], env: {}, cwd: '' },
    } }))).toThrow('keys must match')
    expect(() => McpManager.Config({ servers: {
      example: { ...common, transport: 'streamable-http', url: 'file:///tmp/mcp', headers: {} },
    } })).toThrow()
    expect(() => McpManager.Config({ servers: {
      example: { ...common, transport: 'streamable-http', url: 'https://user:secret@example.com/mcp', headers: {} },
    } })).toThrow()
    expect(() => McpManager.Config({ servers: {
      example: { ...common, transport: 'stdio', command: ' ', args: [], env: {}, cwd: '' },
    } })).toThrow()
    expect(McpManager.Config({ servers: { example: null } }).servers.get()).toEqual({ example: null })
  })

  it('serializes a public settings form and hides server credentials', async () => {
    const { ctx } = await boot()
    const entry = [...ctx.loader.entries()].find(row => row.options.id === 'mcp-manager')
    if (!entry) throw new Error('MCP settings entry is unavailable')
    const home = await mkdtemp(join(tmpdir(), 'codexy-mcp-settings-'))
    onTestFinished(() => rm(home, { recursive: true, force: true }))
    ctx.provide('profileContext', { home, name: 'test' } as never)
    ctx.provide('configEditor', {
      documentPath: join(home, 'cordis.patch.yml'),
      configuration: () => [{ entry, inherited: entry.options.config, override: {} }],
    } as never)
    await ctx.plugin(SettingsForms).await()
    const descriptor = ctx.settings.describe({ redactSecrets: true }).find(form => form.ns === 'mcp-manager')
    if (!descriptor) throw new Error('MCP settings form is unavailable')
    expect(JSON.stringify(descriptor)).not.toContain('test-secret')
    expect(descriptor.secrets).toContainEqual({ path: ['servers', 'example', 'headers'], set: true })
    expect(JSON.parse(JSON.stringify(descriptor))).toMatchObject({
      ns: 'mcp-manager', secrets: expect.arrayContaining([{ path: ['servers', 'example', 'headers'], set: true }]),
    })
    const wire = JSON.parse(JSON.stringify(descriptor)) as typeof descriptor
    expect(new z(wire.schema)(wire.value)).toEqual(wire.value)
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
      expect(client.configForms.get('mcp-manager').getSnapshot()).toMatchObject({
        status: 'ready', value: wire.value, revision: wire.revision, writable: true,
      })
    })
  })
})
