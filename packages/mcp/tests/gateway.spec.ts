/** The released Gateway resolves MCP owners on the Host before reading a Session catalog. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import Commands from '@deepseek-ai/dsh-commands'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import { expect, it, onTestFinished } from 'vitest'
import McpManager from '../src/index.ts'
import { TYPERT } from '../src/typert.ts'

it('dispatches only a resolved Session catalog and rejects unavailable or malformed identities', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  for (const plugin of [TypertRegistry, Gateway, SessionStore, SessionProjections, ToolRuntime, Commands, SystemPrompt]) {
    await ctx.plugin(plugin).await()
  }
  await ctx.plugin(McpManager, { servers: {
    example: {
      serverName: 'example', transport: 'stdio', command: 'unused-fixture', autoConnect: false,
      args: [], env: {}, cwd: '', toolCallTimeoutMs: 30000, failOnStartupError: true,
    },
  } }).await()
  const session = ctx.sessions.create(SessionId('receiving-session'))
  const agent = { id: session.id, session } as Agent
  const scope = createScope(ctx, agent)
  Object.assign(agent, { ctx: scope.ctx })
  ctx.typert.lookups.register('agent', {
    parameter: 'agent', wire: 'agentId', hostTypeSymbol: '@deepseek-ai/dsh-agent#Agent',
    wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
    resolve: id => id === agent.id ? agent : undefined,
  })
  ctx.typert.register(TYPERT)
  await expect(ctx.typertGateway.invoke({ namespace: 'mcp', method: 'catalog', args: { agentId: agent.id } })).resolves.toEqual([
    { serverName: 'example', transport: 'stdio', enabled: false, phase: 'disabled', toolCount: 0 },
  ])
  await expect(ctx.typertGateway.invoke({ namespace: 'mcp', method: 'catalog', args: { agentId: 'missing-session' } })).rejects.toMatchObject({ code: 'gateway/lookup-not-found' })
  await expect(ctx.typertGateway.invoke({ namespace: 'mcp', method: 'catalog', args: { agentId: 8 } })).rejects.toMatchObject({ code: 'gateway/input-invalid' })
})
