/** The managed supervisor distinguishes a usable zero-tool server from a closed connection. */
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import McpResources from '@deepseek-ai/dsh-mcp-resources'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Config } from '@deepseek-ai/dsh-mcp-client'
import { InMemoryTransport, type Transport } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { expect, it, onTestFinished, vi } from 'vitest'
import { startConnection, resolveReconnectPolicy } from '../src/connection.ts'

const { transport } = vi.hoisted(() => ({ transport: vi.fn<() => Transport>() }))
vi.mock('../src/transport.ts', () => ({ createTransport: transport }))

it('reports resource-only server readiness and closes its owned SDK generation', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt).await()
  await ctx.plugin(ToolRuntime).await()
  const server = new McpServer({ name: 'resource-only', version: '1' })
  server.registerResource('memo', 'memo://readme', {}, async () => ({
    contents: [{ uri: 'memo://readme', text: 'memo' }],
  }))
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const serving = serveStdio(() => server, { transport: serverTransport })
  transport.mockReturnValue(clientTransport)
  const config: Config = {
    transport: 'stdio', serverName: 'memo', command: 'fixture', args: [], env: {}, cwd: '',
    toolCallTimeoutMs: 5_000, failOnStartupError: true,
  }
  const connection = startConnection(ctx, config, resolveReconnectPolicy({ enabled: false }, 'test'))
  onTestFinished(async () => { await connection.dispose(); await serving.close(); await ctx.fiber.dispose() })
  expect(await connection.ready).toEqual({})
  expect(connection.status()).toEqual({ phase: 'connected', toolCount: 0 })
  await ctx.plugin(McpResources).await()
  ctx.mcpResources.register('memo', connection.resources)
  expect(await ctx.tools.execute({ name: 'read_mcp_resource', arguments: { server: 'memo', uri: 'memo://readme' },
    callId: ToolCallId('read-memo'), signal: new AbortController().signal }))
    .toMatchObject({ isError: false, value: { contents: [{ uri: 'memo://readme', text: 'memo' }] } })
  await connection.dispose()
  expect(connection.status()).toEqual({ phase: 'closed', toolCount: 0 })
})
