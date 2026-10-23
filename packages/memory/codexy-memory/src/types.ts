/** Cross-session memory documents, retrieval responses, and Session audit events. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Opaque identity of one two-phase memory refresh. */
export type MemoryRunId = Branded<'MemoryRunId'>
/** Content-addressed identity of one published memory revision. */
export type MemoryRevision = Branded<'MemoryRevision'>
/** Coherent extraction, consolidation, and read-instruction revision. */
export type MemoryVersion = 'v1' | 'v2'
/** Provider-independent route for an auxiliary memory request. */
export interface MemoryRoute { readonly provider: string; readonly model: string }
/** Local memory status and bounded summary shown to human consumers. */
export interface MemorySnapshot {
  readonly root: string
  readonly version: MemoryVersion
  readonly summary: string
  readonly running: boolean
  readonly revision?: MemoryRevision
  readonly updatedAt?: number
  readonly lastError?: string
}
/** One paginated entry beneath the memory root. */
export interface MemoryEntry { readonly path: string; readonly entry_type: 'file' | 'directory' }
/** Immediate directory listing with an opaque continuation cursor. */
export interface MemoryList {
  readonly path: string | null
  readonly entries: readonly MemoryEntry[]
  readonly next_cursor: string | null
  readonly truncated: boolean
}
/** Line-numbered, token-bounded local document read. */
export interface MemoryRead {
  readonly path: string
  readonly start_line_number: number
  readonly content: string
  readonly truncated: boolean
  /** Detached content identity for user edit conflict detection. */
  readonly revision: MemoryRevision
}
/** Search predicate shared with the pinned Codex memory extension. */
export type MemoryMatchMode = { readonly type: 'any' | 'all_on_same_line' }
  | { readonly type: 'all_within_lines'; readonly line_count: number }
/** One search hit with adjacent context and source line numbers. */
export interface MemorySearchMatch {
  readonly path: string
  readonly match_line_number: number
  readonly content_start_line_number: number
  readonly content: string
  readonly matched_queries: readonly string[]
}
/** Bounded substring search response. */
export interface MemorySearch {
  readonly queries: readonly string[]
  readonly match_mode: MemoryMatchMode
  readonly path: string | null
  readonly matches: readonly MemorySearchMatch[]
  readonly next_cursor: string | null
  readonly truncated: boolean
}
/** Committed refresh result; no-signal extraction is an ordinary successful outcome. */
export interface MemoryRefreshResult {
  readonly extracted: number
  readonly skipped: number
  readonly consolidated: boolean
  readonly revision?: MemoryRevision
}
/** Optional directory and pagination selection. */
export interface MemoryListRequest { readonly path?: string; readonly cursor?: string; readonly max_results?: number }
/** Optional line slice; line_offset is one-indexed. */
export interface MemoryReadRequest { readonly path: string; readonly line_offset?: number; readonly max_lines?: number }
/** Bounded substring-search selection. */
export interface MemorySearchRequest {
  readonly queries: readonly string[]
  readonly match_mode?: MemoryMatchMode
  readonly path?: string
  readonly cursor?: string
  readonly context_lines?: number
  readonly case_sensitive?: boolean
  readonly normalized?: boolean
  readonly max_results?: number
}
/** Conflict-checked user edit, limited to editable memory documents. */
export interface MemoryEditRequest { readonly path: string; readonly content: string; readonly expectedRevision: MemoryRevision }
/** Exact auxiliary memory request logged before dispatch. */
export interface MemoryRequestEvent {
  readonly runId: MemoryRunId
  readonly phase: 'extract' | 'consolidate'
  readonly version: MemoryVersion
  readonly sourceSessions: readonly SessionId[]
  readonly route: MemoryRoute
  readonly system: string
  readonly messages: Message[]
  readonly maxTokens: number
  readonly temperature: number
}
/** Immutable initial memory contribution restored on cold resume and compaction. */
export interface MemoryContextBaseline {
  readonly version: MemoryVersion
  readonly fragments: readonly string[]
}

declare module '@codexydsh/runtime/types' {
  interface CodexySessionEventMap {
    /** Exact private background extraction or consolidation request. */
    'memory/request': MemoryRequestEvent
    /** Auxiliary completion audit; failures never publish generated documents. */
    'memory/result': {
      readonly runId: MemoryRunId
      readonly phase: 'extract' | 'consolidate'
      readonly sourceSessions: readonly SessionId[]
      readonly outcome: 'succeeded' | 'no-output' | 'failed' | 'cancelled'
      readonly output?: string
      readonly error?: string
    }
    /** Frozen thread-context fragments captured before first request admission. */
    'memory/context': MemoryContextBaseline
    /** Published managed revision, retaining exact source-session attribution. */
    'memory/updated': {
      readonly runId: MemoryRunId
      readonly revision: MemoryRevision
      readonly sourceSessions: readonly SessionId[]
      readonly paths: readonly string[]
    }
    /** Explicit human correction or document edit committed with its backup. */
    'memory/edited': { readonly path: string; readonly revision: MemoryRevision; readonly action: 'note' | 'edit' }
    /** Read-path attribution used for retention and usage ranking. */
    'memory/used': { readonly paths: readonly string[]; readonly sourceSessions: readonly SessionId[] }
  }
}
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'codexful-memory': { readonly kind: 'codexful-memory'; readonly phase: 'extract' | 'consolidate' }
  }
}
