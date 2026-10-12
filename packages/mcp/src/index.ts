/** Persistent MCP catalog and independently scoped, command-selected Session connections. */
import { Context, type Fiber, type Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CommandDefinitionId, type CommandInvocation } from '@deepseek-ai/dsh-commands'
import type { CommandResult } from '@deepseek-ai/dsh-commands/types'
import { Config as ClientConfig, type Config as ServerConfig } from '@deepseek-ai/dsh-mcp-client'
import { openConnection } from './client.ts'
import type { ConnectionHandle } from './connection.ts'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@codexydsh/prompt-registry'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { McpServerStatus } from './types.ts'
import { mcpSelectionProjection, parseMcpSelection } from './selection.ts'

/** One saved server, optionally selected automatically in Sessions without an override. */
export type ManagedServerConfig = ServerConfig & {
  /** Connect in Sessions that have no explicit on/off selection for this server. */
  autoConnect: boolean
}

/** Loader-owned settings sampled before a catalog read, command, or model request. */
export interface Config {
  /** Named server definitions; keys must equal each definition's serverName. */
  servers: Volatile<Record<string, ManagedServerConfig | null>>
}

const ClientSettingsConfig = new z<ServerConfig>(ClientConfig.toJSON())
for (const branch of ClientSettingsConfig.list ?? []) {
  if (branch.dict?.env) branch.dict.env.meta.role = 'secret'
  if (branch.dict?.headers) branch.dict.headers.meta.role = 'secret'
  if (branch.dict?.command) branch.dict.command = branch.dict.command.pattern(/\S/u)
  if (branch.dict?.url) branch.dict.url = branch.dict.url.pattern(/^https?:\/\/[^/@\s]+(?:[/?#]|$)/iu)
}
const Server: z<ManagedServerConfig> = z.intersect([
  ClientSettingsConfig,
  z.object({ autoConnect: z.boolean().default(false) }),
])
const Servers = z.dict(z.union([Server, z.const(null)])).default({})

function resolveCatalog(servers: Catalog): Catalog {
  for (const [key, server] of Object.entries(servers)) {
    if (server === null) continue
    if (key !== server.serverName) throw new Error('MCP catalog keys must match serverName')
    if (server.transport === 'streamable-http') {
      const url = new URL(server.url)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('MCP endpoint must use HTTP or HTTPS')
      if (url.username || url.password) throw new Error('Use MCP headers for authentication instead of URL credentials')
    } else if (!server.command.trim()) throw new Error('MCP stdio command must not be empty')
  }
  return servers
}

interface ConnectionEntry {
  fingerprint: string
  fiber: Fiber
  connection?: ConnectionHandle
}

interface SessionConnections {
  overrides: Map<string, boolean>
  entries: Map<string, ConnectionEntry>
  queue: Promise<void>
  disposed: boolean
}

type Catalog = ReturnType<Config['servers']['get']>

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Catalog owner and per-Session MCP connection controller. */
    mcpManager: McpManager
  }
}

declare module '@codexydsh/prompt-registry' {
  interface AssembleContext { agent?: Agent }
}

/** Own managed connections for each Agent and publish the command and typed catalog API. */
export class McpManager extends TypertRemoteService {
  static inject = ['tools', 'commands', 'typert', 'sessionProjections', 'systemPrompt']
  static Config = z.object({ servers: Servers.volatile() })
  private readonly sessions = new Map<Agent, SessionConnections>()

  /** @param ctx - Host services and effect owner.
   * @param config - Validated, live catalog settings.
   */
  constructor(ctx: Context, private readonly config: Config) {
    resolveCatalog(config.servers.get())
    super(ctx, 'mcpManager', { namespace: 'mcp' })
    ctx.on('internal/config', function (input: Parameters<typeof McpManager.Config>[0], next: () => Parameters<typeof McpManager.Config>[0]) {
      const resolved = next()
      if (this === ctx.fiber) resolveCatalog(McpManager.Config(resolved).servers.get())
      return resolved
    })
    ctx.effect(() => ctx.sessionProjections.register(mcpSelectionProjection))
    ctx.inject(['settings'], (scope) => { scope.effect(() => scope.settings.configure({ auto: false }, ctx.fiber)) })
    ctx.effect(() => ctx.commands.register({
      definitionId: CommandDefinitionId('codexydsh/mcp'),
      name: 'mcp', description: 'Connect or disconnect MCP servers for this Session',
      input: { hint: 'on|off <server>' },
      handler: invocation => this.command(invocation),
    }))
    ctx.on('codexy-prompt/prepare', async (_variables, context, next) => {
      if (context.agent) await this.catalog(context.agent, context.signal ?? new AbortController().signal)
      return next()
    })
    ctx.on('loader/volatile-update', () => {
      for (const [agent, state] of this.sessions) {
        void this.enqueue(state, () => this.reconcile(agent, state, this.config.servers.get()))
          .catch((error: unknown) => { ctx.logger.warn('MCP catalog reconciliation failed: %s', String(error)) })
      }
    })
    ctx.effect(() => async () => {
      await Promise.all([...this.sessions.values()].map(state => this.disposeSession(state)))
      this.sessions.clear()
    })
  }

  /** Read and reconcile this Session's selected connections without exposing credentials.
   * @param agent - Receiving Session owner retained by Remote.
   * @param signal - Caller cancellation.
   * @returns Configured servers and their Session-local states.
   */
  @Remote
  catalog(agent: Agent, signal: AbortSignal): Promise<McpServerStatus[]> {
    const state = this.stateFor(agent)
    return this.enqueue(state, async () => {
      signal.throwIfAborted()
      const servers = this.config.servers.get()
      await this.reconcile(agent, state, servers)
      this.checkActive(state)
      signal.throwIfAborted()
      return Object.values(servers).filter(server => server !== null).map((server) => {
        const connection = state.entries.get(server.serverName)?.connection
        return {
          serverName: server.serverName, transport: server.transport,
          enabled: state.overrides.get(server.serverName) ?? server.autoConnect,
          ...connection?.status() ?? { phase: 'disabled' as const, toolCount: 0 },
        }
      })
    })
  }

  private stateFor(agent: Agent): SessionConnections {
    const existing = this.sessions.get(agent)
    if (existing) return existing
    const restored = this.ctx.sessionProjections.stateOf(agent.session, 'mcpSelection')
    if (!restored) throw new Error('MCP selection projection is unavailable')
    const state: SessionConnections = {
      overrides: new Map(Object.entries(restored.overrides)), entries: new Map(), queue: Promise.resolve(), disposed: false,
    }
    this.sessions.set(agent, state)
    agent.ctx.effect(() => async () => {
      await this.disposeSession(state)
      this.sessions.delete(agent)
    })
    return state
  }

  private enqueue<T>(state: SessionConnections, operation: () => Promise<T>): Promise<T> {
    const result = state.queue.then(() => {
      this.checkActive(state)
      return operation()
    })
    state.queue = result.then(() => {}, (_error: unknown) => { /* The caller receives the operation failure. */ })
    return result
  }

  private checkActive(state: SessionConnections): void {
    if (state.disposed) throw new Error('MCP Session has been disposed')
  }

  private async reconcile(agent: Agent, state: SessionConnections, servers: Catalog): Promise<void> {
    this.checkActive(state)
    for (const [name, entry] of state.entries) {
      const server = servers[name]
      if (server && (state.overrides.get(name) ?? server.autoConnect) && entry.fingerprint === JSON.stringify(server)) continue
      await entry.fiber.dispose()
      state.entries.delete(name)
    }
    for (const server of Object.values(servers)) {
      if (server === null) continue
      if (state.disposed) return
      if (!(state.overrides.get(server.serverName) ?? server.autoConnect) || state.entries.has(server.serverName)) continue
      let connection: ConnectionHandle | undefined
      const fiber = agent.ctx.plugin({
        name: `managed-mcp-${server.serverName}`,
        inject: ['tools'],
        async apply(inner: Context) {
          const spec: ServerConfig = server.transport === 'stdio'
            ? { ...server, args: [...server.args], env: { ...server.env }, failOnStartupError: false }
            : { ...server, headers: { ...server.headers }, failOnStartupError: false }
          connection = openConnection(inner, spec)
          await connection.ready
        },
      })
      const entry: ConnectionEntry = { fingerprint: JSON.stringify(server), fiber }
      state.entries.set(server.serverName, entry)
      try {
        await fiber.await()
        if (!connection) throw new Error(`MCP server ${server.serverName} did not activate`)
        if (this.sessions.get(agent)?.disposed) { await fiber.dispose(); return }
        entry.connection = connection
      } catch (error) {
        await fiber.dispose()
        state.entries.delete(server.serverName)
        throw error
      }
    }
  }

  private async command({ agent, rawInput, signal }: CommandInvocation): Promise<CommandResult> {
    if (!rawInput.trim()) {
      const servers = await this.catalog(agent, signal)
      return { kind: 'success', text: servers.length
        ? servers.map(server => `${server.serverName}: ${server.phase} (${server.toolCount} tools)`).join('\n')
        : 'No MCP servers configured. Add a server in Settings → MCP.' }
    }
    const parsed = parseMcpSelection(rawInput)
    if (!parsed) return { kind: 'error', text: 'Usage: /mcp on <server> or /mcp off <server>' }
    const state = this.stateFor(agent)
    return this.enqueue(state, async () => {
      signal.throwIfAborted()
      const servers = this.config.servers.get()
      if (!Object.hasOwn(servers, parsed.serverName) || servers[parsed.serverName] === null) return { kind: 'error', text: `Unknown MCP server: ${parsed.serverName}` }
      const previous = state.overrides.get(parsed.serverName)
      state.overrides.set(parsed.serverName, parsed.enabled)
      try {
        await this.reconcile(agent, state, servers)
        this.checkActive(state)
        signal.throwIfAborted()
      } catch (error) {
        if (previous === undefined) state.overrides.delete(parsed.serverName)
        else state.overrides.set(parsed.serverName, previous)
        if (!state.disposed) await this.reconcile(agent, state, servers)
        throw error
      }
      const status = state.entries.get(parsed.serverName)?.connection?.status().phase ?? 'disabled'
      return { kind: 'success', text: `${parsed.serverName}: ${status}` }
    })
  }

  private async disposeSession(state: SessionConnections): Promise<void> {
    state.disposed = true
    // Close pending negotiations before waiting for their queue settlement.
    await Promise.all([...state.entries.values()].map(entry => entry.fiber.dispose()))
    await state.queue
    state.entries.clear()
  }
}

export default McpManager
