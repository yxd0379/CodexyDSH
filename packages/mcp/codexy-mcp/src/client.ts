/** Effect-owned MCP transport and tool generations for managed Session connections. */
import type { Context } from '@deepseek-ai/cordis'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type { Config } from '@deepseek-ai/dsh-mcp-client'
import { resolveReconnectPolicy, startConnection, type ConnectionHandle } from './connection.ts'
import { registerServerContext } from './server-context.ts'

const activeServerNames = new WeakMap<object, Set<string>>()

/** Open one Session-scoped server and retain status observations in this plugin.
 * @param ctx - The connection's plugin effect owner.
 * @param config - Validated server configuration.
 * @returns Initial readiness, current status, and joined transport disposal.
 */
export function openConnection(ctx: Context, config: Config): ConnectionHandle {
  const reconnect = resolveReconnectPolicy(config.reconnect, `codexydsh-mcp(${config.serverName}): reconnect`)
  ctx.effect(() => {
    const owner = scopeOf(ctx) ?? ctx.root
    const prefix = `mcp__${config.serverName}__`
    if (ctx.tools.schemas(scopeOf(ctx)).some(tool => tool.name.startsWith(prefix))) {
      throw new Error(`MCP serverName "${config.serverName}" is already in use in this Session`)
    }
    let names = activeServerNames.get(owner)
    if (!names) { names = new Set(); activeServerNames.set(owner, names) }
    if (names.has(config.serverName)) throw new Error(`MCP serverName "${config.serverName}" is already in use in this Session`)
    names.add(config.serverName)
    return () => { names.delete(config.serverName) }
  })
  const connection = startConnection(ctx, config, reconnect)
  registerServerContext(ctx, config.serverName, connection)
  let stopping: Promise<void> | undefined
  const dispose = (): Promise<void> => stopping ??= connection.dispose()
  ctx.on('internal/plugin', (fiber) => {
    if (fiber === ctx.fiber && fiber.uid === null) return dispose()
  }, { global: true })
  ctx.effect(() => dispose)
  return connection
}
