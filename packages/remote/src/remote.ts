/** Remote SSH RPC definitions shared by the Host registry and browser Gateway. */
import { z } from 'zod'
import type { InvocationDescriptor, RemoteResult, RemoteStream, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteHostStatus } from './types.ts'

const status = z.object({
  name: z.string(), host: z.string(), profile: z.string(),
  phase: z.enum(['disconnected', 'connecting', 'connected', 'failed']),
  url: z.string().nullable(), error: z.string().nullable(),
  progress: z.string().optional(), log: z.string().optional(),
  authChallenge: z.object({ id: z.string(), prompt: z.string() }).optional(),
})
const catalog = () => z.array(status)
const parameter = { name: 'name', wire: 'name', source: 'json' as const,
  codec: { mode: 'strict' as const, typeSymbol: '@codexydsh/remote#HostName', create: () => z.string() } }

/** RPC methods exported by the local SSH launcher. */
export const descriptors: readonly InvocationDescriptor[] = [
  { id: '@codexydsh/remote#remoteHosts/list', service: 'remoteLauncher', namespace: 'remoteHosts', method: 'list',
    invocation: { kind: 'direct' }, parameters: [],
    result: { mode: 'strict', typeSymbol: '@codexydsh/remote/types#RemoteHostStatus[]', create: catalog } },
  { id: '@codexydsh/remote#remoteHosts/follow', service: 'remoteLauncher', namespace: 'remoteHosts', method: 'follow',
    invocation: { kind: 'direct' }, mode: 'stream', parameters: [], cancellation: { parameter: 'signal' },
    result: { mode: 'strict', typeSymbol: '@codexydsh/remote/types#RemoteHostStatus[]', create: catalog } },
  { id: '@codexydsh/remote#remoteHosts/connect', service: 'remoteLauncher', namespace: 'remoteHosts', method: 'connect',
    invocation: { kind: 'direct' }, parameters: [parameter], cancellation: { parameter: 'signal' },
    result: { mode: 'strict', typeSymbol: '@codexydsh/remote/types#RemoteHostStatus', create: () => status } },
  { id: '@codexydsh/remote#remoteHosts/disconnect', service: 'remoteLauncher', namespace: 'remoteHosts', method: 'disconnect',
    invocation: { kind: 'direct' }, parameters: [parameter],
    result: { mode: 'strict', typeSymbol: '@codexydsh/remote#Void', create: () => z.void() } },
  { id: '@codexydsh/remote#remoteHosts/respondAuthentication', service: 'remoteLauncher', namespace: 'remoteHosts', method: 'respondAuthentication',
    invocation: { kind: 'direct' }, parameters: [parameter,
      { name: 'challengeId', wire: 'challengeId', source: 'json', codec: { mode: 'strict', typeSymbol: '@codexydsh/remote#AuthenticationChallengeId', create: () => z.string() } },
      { name: 'response', wire: 'response', source: 'json', codec: { mode: 'strict', typeSymbol: '@codexydsh/remote#AuthenticationResponse', create: () => z.string().max(4096).refine(value => new TextEncoder().encode(value).byteLength <= 4096 && !/[\0\r\n]/u.test(value)).nullable() } },
    ], result: { mode: 'strict', typeSymbol: '@codexydsh/remote#Void', create: () => z.void() } },
]

/** Browser mount contribution for the launcher's typed Remote namespace. */
export const TYPERT_REMOTE: TypertRemoteContribution = { package: '@codexydsh/remote', descriptors }
export default TYPERT_REMOTE

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'remoteHosts/list': () => Promise<RemoteResult<RemoteHostStatus[]>>
    'remoteHosts/follow': (signal?: AbortSignal) => RemoteStream<RemoteHostStatus[]>
    'remoteHosts/connect': (name: string, signal?: AbortSignal) => Promise<RemoteResult<RemoteHostStatus>>
    'remoteHosts/disconnect': (name: string) => Promise<RemoteResult<void>>
    'remoteHosts/respondAuthentication': (name: string, challengeId: string, response: string | null) => Promise<RemoteResult<void>>
  }
  interface TypertRemoteNamespaceMap {
    remoteHosts: {
      list: TypertRemoteMap['remoteHosts/list']
      follow: TypertRemoteMap['remoteHosts/follow']
      connect: TypertRemoteMap['remoteHosts/connect']
      disconnect: TypertRemoteMap['remoteHosts/disconnect']
      respondAuthentication: TypertRemoteMap['remoteHosts/respondAuthentication']
    }
  }
}
