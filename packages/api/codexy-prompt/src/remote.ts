/** Product draft RPC descriptors shared by Host and browser builds. */
import { z } from 'zod'
import type { InvocationDescriptor, RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export const descriptor: InvocationDescriptor = {
  id: '@codexydsh/api-prompt#draft/optimize', service: 'codexyDraft', namespace: 'draft', method: 'optimize',
  invocation: { kind: 'direct' }, scope: { context: 'agent', wire: 'agentId' },
  parameters: [
    { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent',
      codec: { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-session/types#SessionId', create: () => z.string() } },
    { name: 'text', wire: 'text', source: 'json',
      codec: { mode: 'strict', typeSymbol: '@codexydsh/api-prompt#DraftText', create: () => z.string() } },
  ],
  cancellation: { parameter: 'signal' },
  result: { mode: 'strict', typeSymbol: '@codexydsh/api-prompt#DraftRewrite', create: () => z.object({ text: z.string() }) },
}

export const TYPERT_REMOTE: TypertRemoteContribution = { package: '@codexydsh/api-prompt', descriptors: [descriptor] }
export default TYPERT_REMOTE

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap { 'draft/optimize': (agentId: SessionId, text: string, signal?: AbortSignal) => Promise<RemoteResult<{ text: string }>> }
  interface TypertRemoteNamespaceMap { draft: { optimize: TypertRemoteMap['draft/optimize'] } }
  interface TypertRemoteScopeMap { 'agent:draft/optimize': (text: string, signal?: AbortSignal) => Promise<RemoteResult<{ text: string }>> }
}
