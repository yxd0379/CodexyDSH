import { deriveProductMessages } from '@codexydsh/runtime/session'
import { projectProductEvent } from '@codexydsh/runtime/session'
import { requestHeaderOf } from '@codexydsh/runtime/session'
import { appendProductEvent } from '@codexydsh/runtime/session'
/** Codex-style cross-session memory: local files, Session extraction, and frozen developer guidance. */

import { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { Memory, MemoryConflictError, MemoryRevision } from './service.ts'
import type { MemoryContextBaseline, MemoryEditRequest, MemoryListRequest, MemoryMutation, MemoryOperation, MemoryReadRequest, MemoryRefreshRequest, MemoryRefreshResult, MemorySearchRequest, MemorySnapshot } from './service.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
import { Config, resolveConfig } from './config.ts'
import type { ConfigInput } from './config.ts'
import { MemoryStore } from './store.ts'
import { memoryInstructions, SESSION_REFERENCE_GUIDANCE } from './prompts.ts'
import { recordUsage, runPipeline } from './pipeline.ts'
import { redactSecrets, revisionOf, tokenBoundedText } from './text.ts'
import { installMemoryTools } from './tools.ts'
import { READ_V2 } from './pinned-prompts.ts'
import { memoryCitation, memoryPathsFromCommand } from './usage.ts'

export type { Config, ConfigInput } from './config.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { memoryContext: MemoryContextBaseline | null }
  interface SessionProjectionMap { memoryContext: MemoryContextBaseline | null }
}

const baselineSchema = z.object({ version: z.enum(['v1', 'v2']), fragments: z.array(z.string()) }).strict().nullable()
const publishedSchema = z.object({ revision: z.string(), updatedAt: z.number(), inputDigest: z.string(), selected: z.array(z.string()), documentHashes: z.record(z.string(), z.string()).optional(), sourceFingerprints: z.record(z.string(), z.string()).optional() }).strict()
const preparedMemory = Symbol('codexful-memory.preparedContext')
type MemoryVariables = Readonly<Record<string, string | undefined>> & { readonly [preparedMemory]?: MemoryContextBaseline }

/** Local cross-session provider; generation never receives execution tools. */
export class CodexfulMemory extends Memory {
  /** Services required by generation, source reads, tools, and prompt contributions. */
  static inject = ['codexyRequests', 'codexyTools', 'llm', 'sessionPersistence', 'sessionProjections', 'codexyPrompt', 'agents', 'tools']
  /** Validated configuration consumed by the Cordis Loader. */
  static Config = Config
  /** Effective immutable deployment settings. */
  readonly config: Config
  private readonly store: MemoryStore
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private active: Promise<MemoryRefreshResult> | undefined
  private lastError: string | undefined
  private readonly started = new WeakSet<Agent>()

  constructor(ctx: Context, config: ConfigInput) {
    super(ctx)
    this.config = resolveConfig(config)
    this.store = new MemoryStore(this.config)
    ctx.effect(() => () => {
      this.lifetime.abort(new Error('Memory provider disposed'))
      return Promise.allSettled([...this.pending]).then(() => {})
    }, 'memory.backgroundLifecycle')
    ctx.effect(() => ctx.sessionProjections.register<'memoryContext', MemoryContextBaseline | null>({
      key: 'memoryContext', stateSchema: baselineSchema, init: () => null,
      apply: (state, envelope) => { const event = projectProductEvent(envelope); return event.type === 'memory/context' ? event.data : state },
      wire: { viewSchema: baselineSchema, view: state => state }, stateVersion: 1,
    }), 'memory.contextProjection')
    this.installContext(ctx)
    this.installUsage(ctx)
    if (this.config.dedicatedTools && this.config.useMemories) installMemoryTools(ctx, this)
  }

  /** Observe default shell retrieval and completed citations without changing tool results or answers. */
  private installUsage(ctx: Context): void {
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      if (result.isError || exec.agent === undefined || exec.name !== 'exec_command') return decision
      const args = exec.arguments
      if (args === null || typeof args !== 'object' || !('cmd' in args) || typeof args.cmd !== 'string') return decision
      const cwd = 'workdir' in args && typeof args.workdir === 'string' ? args.workdir : exec.agent.session.header.cwd ?? process.cwd()
      const paths = memoryPathsFromCommand(args.cmd, this.store.root, cwd)
      if (paths.length > 0) {
        const owner = exec.agent.session
        const work = this.used(paths, { session: owner })
        this.pending.add(work)
        void work.catch(error => ctx.logger('codexful-memory').warn('Memory usage recording failed: %s', String(error)))
          .finally(() => this.pending.delete(work))
      }
      return decision
    })
    ctx.on('agent/step-completed', async ({ agent, needsFollowUp }) => {
      if (needsFollowUp) return
      const latest = deriveProductMessages(agent.session).findLast(message => message.role === 'assistant')
      if (latest === undefined) return
      const text = latest.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      const citation = memoryCitation(text)
      if (citation.paths.length === 0 && citation.sessionIds.length === 0) return
      const sourceSessions = await recordUsage(this.store, citation.paths, citation.sessionIds).catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error)
        return []
      })
      appendProductEvent(agent.session, 'memory/used', { paths: citation.paths, sourceSessions })
    })
  }

  override async snapshot(signal?: AbortSignal): Promise<MemorySnapshot> {
    signal?.throwIfAborted()
    const summary = await this.store.text('memory_summary.md') ?? ''
    const state = await this.store.text('.state/current.json')
    const published = state === undefined ? undefined : publishedSchema.parse(JSON.parse(state))
    signal?.throwIfAborted()
    return { root: this.store.root, version: this.config.version, summary: tokenBoundedText(summary, this.config.summaryTokens), running: this.active !== undefined,
      ...published === undefined ? {} : { revision: MemoryRevision(published.revision), updatedAt: published.updatedAt },
      ...this.lastError === undefined ? {} : { lastError: this.lastError } }
  }

  private async used(paths: readonly string[], operation: MemoryOperation | undefined): Promise<void> {
    if (operation?.session === undefined || paths.length === 0) return
    const sourceSessions = await recordUsage(this.store, paths).catch((error) => {
      // Read success does not depend on a concurrent writer's optional usage ledger.
      this.lastError = error instanceof Error ? error.message : String(error)
      return []
    })
    appendProductEvent(operation.session, 'memory/used', { paths, sourceSessions })
  }

  override async list(request: MemoryListRequest, operation?: MemoryOperation) {
    operation?.signal?.throwIfAborted()
    const result = await this.store.list(request)
    operation?.signal?.throwIfAborted()
    return result
  }

  override async read(request: MemoryReadRequest, operation?: MemoryOperation) {
    operation?.signal?.throwIfAborted()
    const result = await this.store.read(request)
    operation?.signal?.throwIfAborted()
    await this.used([result.path], operation)
    return result
  }

  override async search(request: MemorySearchRequest, operation?: MemoryOperation) {
    operation?.signal?.throwIfAborted()
    const result = await this.store.search(request)
    operation?.signal?.throwIfAborted()
    await this.used([...new Set(result.matches.map(match => match.path))], operation)
    return result
  }

  override async addNote(request: { readonly filename: string; readonly note: string }, operation: MemoryMutation): Promise<string> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}\.md$/.test(request.filename)) throw new Error('memory note filename must be a simple timestamp-slug Markdown filename')
    if (request.note.trim() === '') throw new Error('ad-hoc memory note must not be empty')
    if (Buffer.byteLength(request.note) > this.config.maxNoteBytes) throw new Error('memory note exceeds maxNoteBytes')
    operation.signal?.throwIfAborted()
    const path = 'extensions/ad_hoc/notes/' + request.filename
    const content = redactSecrets(request.note)
    await this.store.writing(async () => {
      operation.signal?.throwIfAborted()
      await this.store.create(path, content)
      appendProductEvent(operation.session, 'memory/edited', { path, revision: revisionOf(content), action: 'note' })
    })
    return path
  }

  override async edit(request: MemoryEditRequest, operation: MemoryMutation) {
    if (request.path !== 'MEMORY.md' && request.path !== 'memory_summary.md') throw new Error('Only MEMORY.md and memory_summary.md are directly editable; use an explicit correction note for source records.')
    operation.signal?.throwIfAborted()
    return this.store.writing(async () => {
      const current = await this.store.text(request.path)
      if (current === undefined || revisionOf(current) !== request.expectedRevision) throw new MemoryConflictError(request.path)
      operation.signal?.throwIfAborted()
      const revision = await this.store.replace(request.path, redactSecrets(request.content), request.expectedRevision)
      await this.store.create(`extensions/ad_hoc/notes/${Date.now()}-${randomUUID()}-user-edit.md`,
        `The user directly replaced ${request.path}. The current document is the authoritative user edit. Preserve its corrections and do not restore claims the user removed from older source summaries.\nEdited content revision: ${revision}\n`)
      appendProductEvent(operation.session, 'memory/edited', { path: request.path, revision, action: 'edit' })
      return revision
    })
  }

  override async refresh(request: MemoryRefreshRequest): Promise<MemoryRefreshResult> {
    if (!this.config.generateMemories) throw new Error('Memory generation is disabled by configuration')
    if (this.active !== undefined) throw new Error('Memory refresh is already running; wait for the current refresh to finish')
    const signal = request.signal === undefined ? this.lifetime.signal : AbortSignal.any([request.signal, this.lifetime.signal])
    signal.throwIfAborted()
    const work = this.store.writing(() => runPipeline(this.ctx, this.store, this.config, { ...request, signal }))
    this.active = work
    this.pending.add(work)
    this.lastError = undefined
    try { return await work } catch (error) {
      this.lastError = redactSecrets(error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      this.pending.delete(work)
      if (this.active === work) this.active = undefined
    }
  }

  /** Capture memory on first real request preparation; later input reuses the logged baseline. */
  private installContext(ctx: Context): void {
    const count = this.config.version === 'v1' ? 1 : Math.ceil((Buffer.byteLength(READ_V2) + Buffer.byteLength(SESSION_REFERENCE_GUIDANCE) + Buffer.byteLength(this.store.root) * 8 + this.config.summaryTokens * 4) / 8_900)
    for (let index = 0; index < count; index++) {
      ctx.effect(() => ctx.codexyPrompt.context({ name: `codexful:memory:${index}`, order: 70 + index, role: 'developer', interpolate: false,
        text: context => (context.promptPreparation?.variables as MemoryVariables | undefined)?.[preparedMemory]?.fragments[index] ?? '' }), `memory.context.${index}`)
    }
    ctx.on('codexy-prompt/prepare', async (variables, context, next) => {
      const agent = context.agent
      if (agent !== undefined) {
        const baseline = ctx.sessionProjections.stateOf(agent.session, 'memoryContext')
        if (baseline === undefined) throw new Error('Memory context projection is unavailable')
        let captured: MemoryContextBaseline
        if (baseline !== null) captured = baseline
        else {
          const summary = !this.config.useMemories || requestHeaderOf(agent.session) !== undefined ? '' : (await this.snapshot(context.signal)).summary
          captured = { version: this.config.version, fragments: memoryInstructions(this.config.version, this.store.root, summary, this.config.summaryTokens) }
          context.signal?.throwIfAborted()
        }
        return { ...await next(), [preparedMemory]: captured }
      }
      void variables
      return next()
    })
    ctx.on('agent/request-input', async ({ agent, promptPreparation, signal }, next) => {
      const admitted = await next()
      signal.throwIfAborted()
      const baseline = ctx.sessionProjections.stateOf(agent.session, 'memoryContext')
      if (baseline === undefined) throw new Error('Memory context projection is unavailable')
      if (baseline === null) {
        const captured = (promptPreparation.variables as MemoryVariables)[preparedMemory]
        if (captured === undefined) throw new Error('Memory request preparation is unavailable')
        appendProductEvent(agent.session, 'memory/context', captured)
      }
      return admitted
    })
    const schedule = (agent: Agent, route?: { provider: string; model: string }): void => {
      if (!this.config.generateMemories || agent.session.header.origin === 'subagent' || agent.session.header.parentSession !== undefined || this.started.has(agent)) return
      if (route === undefined && (this.config.provider === undefined || this.config.model === undefined)) return
      this.started.add(agent)
      const work = this.refresh({ session: agent.session, ...route === undefined ? {} : { route } })
      this.pending.add(work)
      void work.catch(error => ctx.logger('codexful-memory').warn('Background memory refresh failed: %s', redactSecrets(error instanceof Error ? error.message : String(error))))
        .finally(() => this.pending.delete(work))
    }
    ctx.on('agent/created', ({ agent }) => {
      const options = agent.options
      schedule(agent, options.provider !== undefined && options.model !== undefined ? { provider: options.provider, model: options.model } : undefined)
    })
    ctx.on('agent/request-enter', async ({ agent, config }) => { schedule(agent, { provider: config.provider, model: config.model }) })
  }
}

export default CodexfulMemory

export * from './service.ts'
