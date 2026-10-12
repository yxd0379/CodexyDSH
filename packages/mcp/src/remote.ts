/** Session-local MCP catalog RPC definition for the Host and browser Gateway. */
import { z } from 'zod'
import type { InvocationDescriptor, RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { McpServerStatus } from './types.ts'

/** The receiving Session is looked up on the Host and never reconstructed from browser data. */
export const descriptor: InvocationDescriptor = {
  id: '@codexydsh/mcp#mcp/catalog', service: 'mcpManager', namespace: 'mcp', method: 'catalog',
  invocation: { kind: 'direct' }, scope: { context: 'agent', wire: 'agentId' },
  parameters: [{ name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent',
    codec: { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-session/types#SessionId', create: () => z.string() } }],
  cancellation: { parameter: 'signal' },
  result: { mode: 'strict', typeSymbol: '@codexydsh/mcp/types#McpServerStatus[]', create: () => z.array(z.object({
    serverName: z.string(), transport: z.enum(['stdio', 'streamable-http']), enabled: z.boolean(),
    phase: z.enum(['disabled', 'connecting', 'connected', 'retrying', 'failed', 'closed']), toolCount: z.number().int().nonnegative(),
  })) },
}

/** Browser mount contribution for the Session-local MCP namespace. */
export const TYPERT_REMOTE: TypertRemoteContribution = { package: '@codexydsh/mcp', descriptors: [descriptor] }
export default TYPERT_REMOTE

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap { 'mcp/catalog': (agentId: SessionId, signal?: AbortSignal) => Promise<RemoteResult<McpServerStatus[]>> }
  interface TypertRemoteNamespaceMap { mcp: { catalog: TypertRemoteMap['mcp/catalog'] } }
  interface TypertRemoteScopeMap { 'agent:mcp/catalog': (signal?: AbortSignal) => Promise<RemoteResult<McpServerStatus[]>> }
}
