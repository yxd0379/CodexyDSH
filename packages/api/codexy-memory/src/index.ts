/** Session-owned human memory access over the typed Remote gateway. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MemoryConflictError } from '@codexydsh/memory'
import type { MemoryEditRequest, MemoryListRequest, MemoryReadRequest, MemorySearchRequest, MemoryList, MemoryRead, MemoryRefreshResult, MemoryRevision, MemorySearch, MemorySnapshot } from '@codexydsh/memory/types'
import type {} from '@codexydsh/runtime/ports'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Session-owned human memory Remote operations. */
    memoryController: MemoryController
  }
}

/** Human retrieval, revision-checked edits, and explicit auxiliary refresh. */
export class MemoryController extends TypertRemoteService {
  static inject = ['memory', 'codexyPrompt', 'typert']

  /** @param ctx - Host carrying memory, prompt preparation, and typed Remote services. */
  constructor(ctx: Context) { super(ctx, 'memoryController', { namespace: 'memory' }) }

  /** Read memory status without changing this Session's frozen prompt.
   * @param agent - Exact Session owner retained by the gateway.
   * @param signal - Request cancellation.
   * @returns Current bounded summary and refresh status.
   */
  @Remote
  snapshot(agent: Agent, signal: AbortSignal): Promise<MemorySnapshot> {
    void agent
    signal.throwIfAborted()
    return this.ctx.memory.snapshot(signal)
  }

  /** List public memory entries and audit reads against the receiving Session.
   * @param agent - Exact receiving Session owner.
   * @param request - Relative directory and optional continuation cursor.
   * @param signal - Request cancellation.
   * @returns Bounded directory entries.
   */
  @Remote
  list(agent: Agent, request: MemoryListRequest, signal: AbortSignal): Promise<MemoryList> {
    return this.ctx.memory.list(request, { session: agent.session, signal })
  }

  /** Read a bounded public document with its complete-file revision.
   * @param agent - Exact receiving Session owner.
   * @param request - Relative document and optional line slice.
   * @param signal - Request cancellation.
   * @returns Line-numbered content; truncated reads cannot be edited through this API.
   */
  @Remote
  read(agent: Agent, request: MemoryReadRequest, signal: AbortSignal): Promise<MemoryRead> {
    return this.ctx.memory.read(request, { session: agent.session, signal })
  }

  /** Search public memory documents without adding their text to the current prompt.
   * @param agent - Exact receiving Session owner.
   * @param request - Substring predicates and optional pagination.
   * @param signal - Request cancellation.
   * @returns Bounded source-path and line-numbered matches.
   */
  @Remote
  search(agent: Agent, request: MemorySearchRequest, signal: AbortSignal): Promise<MemorySearch> {
    return this.ctx.memory.search(request, { session: agent.session, signal })
  }

  /** Preserve the prior file and publish a complete human edit with compare-and-swap.
   * @param agent - Session owning the durable edit audit.
   * @param request - Editable document, complete replacement, and observed revision.
   * @param signal - Request cancellation.
   * @returns Newly published revision; partial or stale edits leave the file unchanged.
   */
  @Remote
  async edit(agent: Agent, request: MemoryEditRequest, signal: AbortSignal): Promise<MemoryRevision> {
    if (request.path !== 'memory_summary.md' && request.path !== 'MEMORY.md') {
      throw new RemoteError('gateway/bad-request', 'Only memory_summary.md and MEMORY.md are editable', {})
    }
    const operation = { session: agent.session, signal }
    const current = await this.ctx.memory.read({ path: request.path }, operation)
    if (current.truncated || current.start_line_number !== 1) {
      throw new RemoteError('memory/truncated', 'A truncated memory document cannot be overwritten', { path: request.path })
    }
    if (current.revision !== request.expectedRevision) {
      throw new RemoteError('memory/conflict', 'The memory document changed; your draft was not saved', { path: request.path })
    }
    try {
      return await this.ctx.memory.edit(request, operation)
    } catch (error) {
      if (error instanceof MemoryConflictError) {
        throw new RemoteError('memory/conflict', 'The memory document changed; your draft was not saved', { path: request.path }, { cause: error })
      }
      throw error
    }
  }

  /** Generate memory using the currently selected Agent provider and model.
   * @param agent - Session owning the auxiliary request and publication audit.
   * @param signal - Request cancellation.
   * @returns Extraction and consolidation outcome; active Sessions remain excluded.
   */
  @Remote
  async refresh(agent: Agent, signal: AbortSignal): Promise<MemoryRefreshResult> {
    const preparation = await this.ctx.codexyPrompt.prepare({ agent, scope: agent, signal })
    const provider = preparation.variables.provider ?? agent.options.provider
    const model = preparation.variables.model ?? agent.options.model
    if (provider === undefined || model === undefined) {
      throw new RemoteError('gateway/bad-request', 'Select a provider and model before refreshing memory', {})
    }
    return this.ctx.memory.refresh({ session: agent.session, signal, route: { provider, model }, force: true })
  }
}

export default MemoryController
