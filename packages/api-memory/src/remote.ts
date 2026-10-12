/** Product-owned browser RPC methods and their scoped projections. */
import type {
  RemoteResult,
  TypertRemoteContribution,
} from '@deepseek-ai/dsh-typert-protocol'
import type { MemoryEditRequest, MemoryList, MemoryListRequest, MemoryRead, MemoryReadRequest, MemoryRefreshResult, MemoryRevision, MemorySearch, MemorySearchRequest, MemorySnapshot } from '@codexydsh/memory/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespace$6d656d6f7279 {
    edit: (agentId: SessionId, request: MemoryEditRequest, signal?: AbortSignal) => Promise<RemoteResult<MemoryRevision>>
    list: (agentId: SessionId, request: MemoryListRequest, signal?: AbortSignal) => Promise<RemoteResult<MemoryList>>
    read: (agentId: SessionId, request: MemoryReadRequest, signal?: AbortSignal) => Promise<RemoteResult<MemoryRead>>
    refresh: (agentId: SessionId, signal?: AbortSignal) => Promise<RemoteResult<MemoryRefreshResult>>
    search: (agentId: SessionId, request: MemorySearchRequest, signal?: AbortSignal) => Promise<RemoteResult<MemorySearch>>
    snapshot: (agentId: SessionId, signal?: AbortSignal) => Promise<RemoteResult<MemorySnapshot>>
  }
  interface TypertRemoteMap {
    'memory/edit': (agentId: SessionId, request: MemoryEditRequest, signal?: AbortSignal) => Promise<RemoteResult<MemoryRevision>>
    'memory/list': (agentId: SessionId, request: MemoryListRequest, signal?: AbortSignal) => Promise<RemoteResult<MemoryList>>
    'memory/read': (agentId: SessionId, request: MemoryReadRequest, signal?: AbortSignal) => Promise<RemoteResult<MemoryRead>>
    'memory/refresh': (agentId: SessionId, signal?: AbortSignal) => Promise<RemoteResult<MemoryRefreshResult>>
    'memory/search': (agentId: SessionId, request: MemorySearchRequest, signal?: AbortSignal) => Promise<RemoteResult<MemorySearch>>
    'memory/snapshot': (agentId: SessionId, signal?: AbortSignal) => Promise<RemoteResult<MemorySnapshot>>
  }
  interface TypertRemoteNamespaceMap {
    'memory': TypertRemoteNamespace$6d656d6f7279
  }
  interface TypertRemoteScopeMap {
    'agent:memory/edit': (request: MemoryEditRequest, signal?: AbortSignal) => Promise<RemoteResult<MemoryRevision>>
    'agent:memory/list': (request: MemoryListRequest, signal?: AbortSignal) => Promise<RemoteResult<MemoryList>>
    'agent:memory/read': (request: MemoryReadRequest, signal?: AbortSignal) => Promise<RemoteResult<MemoryRead>>
    'agent:memory/refresh': (signal?: AbortSignal) => Promise<RemoteResult<MemoryRefreshResult>>
    'agent:memory/search': (request: MemorySearchRequest, signal?: AbortSignal) => Promise<RemoteResult<MemorySearch>>
    'agent:memory/snapshot': (signal?: AbortSignal) => Promise<RemoteResult<MemorySnapshot>>
  }
}

import { invocations } from './protocol.ts'
export const TYPERT_REMOTE: TypertRemoteContribution = { package: '@codexydsh/api-memory', descriptors: invocations }
export default TYPERT_REMOTE
