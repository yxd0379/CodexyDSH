/** Provider-independent cross-session memory service backed by durable Session evidence. */

import { Context, Service } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Session } from '@codexydsh/runtime/session'
import type { MemoryEditRequest, MemoryList, MemoryListRequest, MemoryRead, MemoryReadRequest, MemoryRefreshResult, MemoryRevision as Revision, MemoryRoute, MemoryRunId as RunIdentity, MemorySearch, MemorySearchRequest, MemorySnapshot } from './types.ts'

export type * from './types.ts'
/** Opaque refresh identity exported beside its branding constructor. */
export type MemoryRunId = RunIdentity
/** Content digest exported beside its branding constructor. */
export type MemoryRevision = Revision

/** Brand a validated memory refresh identity.
 * @param value - Provider-owned run identity.
 * @returns The same string carrying its domain brand.
 */
export const MemoryRunId = (value: string): MemoryRunId => brandString<MemoryRunId>(value)
/** Brand a content-addressed memory revision.
 * @param value - Provider-owned content digest.
 * @returns The same string carrying its domain brand.
 */
export const MemoryRevision = (value: string): MemoryRevision => brandString<MemoryRevision>(value)

/** A human edit observed an older content revision; callers retain their unsaved draft. */
export class MemoryConflictError extends Error {
  override name = 'MemoryConflictError'
  /** Stable error identity for API and UI conflict handling. */
  readonly code = 'MEMORY_CONFLICT'
  constructor(path: string) { super(`Memory document '${path}' changed; reload it before saving your draft.`) }
}

/** Optional ownership for durable read-usage audit and cancellation. */
export interface MemoryOperation { readonly session?: Session; readonly signal?: AbortSignal }
/** A memory mutation requires an explicit owner for its durable audit. */
export interface MemoryMutation { readonly session: Session; readonly signal?: AbortSignal }
/** Auxiliary refresh with a captured conversation route or explicit provider configuration. */
export interface MemoryRefreshRequest extends MemoryMutation {
  readonly route?: MemoryRoute
  /** Explicit human refresh may bypass the idle delay; active sessions remain excluded. */
  readonly force?: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context { memory: Memory }
}

/** Cross-session retrieval, explicit corrections, and bounded two-phase generation. */
export abstract class Memory extends Service {
  constructor(ctx: Context) { super(ctx, 'memory') }
  /** Read current summary and operation status without changing a thread's frozen prompt.
   * @param signal - Optional cancellation.
   * @returns Detached bounded status.
   */
  abstract snapshot(signal?: AbortSignal): Promise<MemorySnapshot>
  /** List immediate public entries; internal revision and job directories are hidden.
   * @param request - Directory and pagination selection.
   * @param operation - Optional ownership and cancellation.
   * @returns Bounded listing with an opaque cursor.
   */
  abstract list(request: MemoryListRequest, operation?: MemoryOperation): Promise<MemoryList>
  /** Read a safe relative public document without following escaping symlinks.
   * @param request - Document and line selection.
   * @param operation - Optional ownership and cancellation.
   * @returns Bounded content and conflict-detection revision.
   */
  abstract read(request: MemoryReadRequest, operation?: MemoryOperation): Promise<MemoryRead>
  /** Search public files using Codex-style substring matching.
   * @param request - Search and pagination selection.
   * @param operation - Optional ownership and cancellation.
   * @returns Bounded line-numbered hits.
   */
  abstract search(request: MemorySearchRequest, operation?: MemoryOperation): Promise<MemorySearch>
  /** Append an explicit remember, forget, or correction note; existing notes are never overwritten.
   * @param request - Small Markdown note with an exclusive timestamp-slug filename.
   * @param operation - Human-authorized owner and cancellation.
   * @returns The public note path; consolidation applies the note as data.
   */
  abstract addNote(request: { readonly filename: string; readonly note: string }, operation: MemoryMutation): Promise<string>
  /** Preserve the prior document and apply a human edit if the read revision still matches.
   * @param request - Editable path, replacement text, and observed revision.
   * @param operation - Human-authorized owner and cancellation.
   * @returns Published content revision; stale edits reject without changing the file.
   */
  abstract edit(request: MemoryEditRequest, operation: MemoryMutation): Promise<MemoryRevision>
  /** Extract eligible old Sessions and consolidate useful records without shell or network tools.
   * @param request - Owner, route, human refresh flag, and cancellation.
   * @returns Extracted count and publication outcome; failed or cancelled generations publish nothing.
   */
  abstract refresh(request: MemoryRefreshRequest): Promise<MemoryRefreshResult>
}

export default Memory
