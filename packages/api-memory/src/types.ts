/** Client-safe memory requests, responses, and Remote failure codes. */
import type {} from '@deepseek-ai/dsh-typert-protocol'

export type { MemoryEditRequest, MemoryListRequest, MemoryReadRequest, MemorySearchRequest, MemoryEntry, MemoryList, MemoryRead, MemoryRefreshResult, MemoryRevision, MemorySearch, MemorySnapshot } from '@codexydsh/memory/types'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** An edit used a stale complete-file revision. */
    'memory/conflict': { readonly path: string }
    /** The provider's bounded read cannot supply the complete editable document. */
    'memory/truncated': { readonly path: string }
  }
}
