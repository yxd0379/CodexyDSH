/** Product-owned browser RPC methods and their scoped projections. */
import type {
  RemoteResult,
  TypertRemoteContribution,
} from '@deepseek-ai/dsh-typert-protocol'
import type { UsageRequest, UsageSnapshot } from '@codexydsh/api-usage/types'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespace$7573616765 {
    snapshot: (request: UsageRequest, signal?: AbortSignal) => Promise<RemoteResult<UsageSnapshot>>
  }
  interface TypertRemoteMap {
    'usage/snapshot': (request: UsageRequest, signal?: AbortSignal) => Promise<RemoteResult<UsageSnapshot>>
  }
  interface TypertRemoteNamespaceMap {
    'usage': TypertRemoteNamespace$7573616765
  }
}

import { invocations } from './protocol.ts'
export const TYPERT_REMOTE: TypertRemoteContribution = { package: '@codexydsh/api-usage', descriptors: invocations }
export default TYPERT_REMOTE
