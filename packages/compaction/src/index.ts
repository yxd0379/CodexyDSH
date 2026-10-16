import { requestHeaderOf } from '@codexydsh/runtime/session'
/**
 * Basic replay-aware compaction backend.
 *
 * @module @codexydsh/compaction
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CompactionEngine, ManualCompactionError } from './service.ts'
import type { CompactionInitialContextInjection, CompactionResult, CompactionTrigger } from './service.ts'
import type { Session, SessionSeq } from '@codexydsh/runtime/session'
import { CONTEXT_WINDOW_EXCEEDED_CODE, ReasoningEffortId } from '@codexydsh/runtime/llm'
import type { CodexCompactionMetadataFacts, LlmCallConfig, PreparedLlmModel } from '@codexydsh/runtime/llm'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { PromptPreparation } from '@codexydsh/runtime/prompt'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
// Type-only: makes the optional sibling service available to `ctx.get()`.
import type {} from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import {
  resolveCompactSpec,
  resolveConfig,
  resolveTargetPolicy,
  TargetPressureConfigError,
} from './config.ts'
import {
  assertNoActiveCompaction,
  compactSurfaceRegion,
  selectCompactableRange,
} from './region.ts'
import { summarizeWithLlm } from './summarizer.ts'
import type { CapturedConversationModel, SummarizationInput, SummaryResult } from './summarizer.ts'
import type {
  BasicCompactionConfig,
  ModelCompactPolicyConfig,
  ResolvedConfig,
} from './types.ts'

export type {
  BasicCompactionConfig,
  CompactionPolicyConfig,
  ModelCompactPolicyConfig,
  ResolvedCompactSpec,
  ResolvedConfig,
  ResolvedRetention,
  ResolvedTargetPolicy,
} from './types.ts'

/** Resolve the exact provider/model durably routed for the latest request. */
function routedTarget(
  session: Session,
): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const config = requestHeaderOf(session)?.config
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) {
    return undefined
  }
  return { provider: config.provider, model: config.model }
}

/**
 * Output tokens the routed request reserves, which the provider charges to the
 * same window as the prompt. The effective envelope's own cap wins; otherwise
 * the adapter's per-request default, which the adapter materializes when that
 * envelope omits one. No declared cap means no reservation.
 */
function reservedCompletionTokens(agent: Agent, defaultMaxTokens: number | undefined): number {
  const configured = requestHeaderOf(agent.session)?.config.maxTokens
  return configured ?? defaultMaxTokens ?? 0
}

/** Resolve the conversation target used to select an optional policy override. */
function conversationTarget(
  agent: Agent,
): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const routed = routedTarget(agent.session)
  if (routed !== undefined) return routed
  if (agent.options.provider === undefined || agent.options.provider.length === 0
    || agent.options.model === undefined || agent.options.model.length === 0) return undefined
  return { provider: agent.options.provider, model: agent.options.model }
}

/** Process-local settings for a Codex turn or one ordinary DSH step. */
interface CompactionModelCapture extends CapturedConversationModel {
  readonly turn: number
  readonly step: number
  config: LlmCallConfig
  finalized: boolean
  promptPreparation?: PromptPreparation
}

/** Resolve explicit settings without inheriting a previous adapter generation's defaults. */
function initialConversationConfig(
  agent: Agent,
  preparedModel: PreparedLlmModel,
  variables: Readonly<Record<string, string | undefined>> | undefined,
): LlmCallConfig {
  const { provider, id: model } = preparedModel.model
  const header = requestHeaderOf(agent.session)
  const sameHeader = header?.config.provider === provider && header.config.model === model
  const config: LlmCallConfig = header === undefined
    ? { provider, model } : { ...structuredClone(header.config), provider, model }
  if (!sameHeader || header.adapterDefaults?.reasoningEffort === true) delete config.reasoningEffort
  if (header?.adapterDefaults?.maxTokens === true) delete config.maxTokens
  if (config.codexfulResponses !== undefined) {
    const { lite: _automaticLite, ...responses } = config.codexfulResponses
    config.codexfulResponses = responses
  }
  const sameOptions = agent.options.provider === provider && agent.options.model === model
  if (config.maxTokens === undefined && sameOptions && agent.options.maxTokens !== undefined) {
    config.maxTokens = agent.options.maxTokens
  }
  const selectedEffort = variables?.reasoning_effort
  if (selectedEffort !== undefined) {
    delete config.reasoningEffort
    if (selectedEffort.length > 0) config.reasoningEffort = ReasoningEffortId(selectedEffort)
  } else if (sameOptions && agent.options.reasoningEffort !== undefined) {
    config.reasoningEffort = agent.options.reasoningEffort
  }
  return preparedModel.prepareCall(config).config
}

const thresholdRatioSchema = z.number()
const headroomTokensSchema = z.number().step(1).min(0)
const retainRatioSchema = z.number()
const retainTokensSchema = z.number().step(1).min(0)
const summarizationProviderSchema = z.string()
const summarizationModelSchema = z.string()
const maxTokensSchema = z.number().step(1).min(1)
const compactionRetriesSchema = z.number().step(1).min(0)
const maxOverflowRetriesSchema = z.number().step(1).min(0)

const modelPolicy: z<ModelCompactPolicyConfig> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  thresholdRatio: thresholdRatioSchema,
  headroomTokens: headroomTokensSchema,
  retainRatio: retainRatioSchema,
  retainTokens: retainTokensSchema,
  summarizationProvider: summarizationProviderSchema,
  summarizationModel: summarizationModelSchema,
  maxTokens: maxTokensSchema,
  compactionRetries: compactionRetriesSchema,
  maxOverflowRetries: maxOverflowRetriesSchema,
})

/**
 * Dependency-light compaction backend using `ctx.codexyTokenMeter` for pressure,
 * retention, cited source events, and summary-convergence pricing.
 *
 * `summarize()` is the sole subclass customization hook; the replay and durable
 * mutation strategy stays fixed so every pricing decision uses the singleton
 * token meter.
 */
export class BasicCompactionEngine extends CompactionEngine {
  static inject = ['llm', 'codexyTokenMeter', 'sessions', 'codexyRequests']

  static Config: z<BasicCompactionConfig> = z.object({
    checkpointFormat: z.union([z.const('dsh'), z.const('codex')]),
    codexUserMessageTokens: z.number().step(1).min(0),
    thresholdRatio: thresholdRatioSchema,
    headroomTokens: headroomTokensSchema,
    retainRatio: retainRatioSchema,
    retainTokens: retainTokensSchema,
    summarizationProvider: summarizationProviderSchema,
    summarizationModel: summarizationModelSchema,
    maxTokens: maxTokensSchema,
    compactionRetries: compactionRetriesSchema,
    maxOverflowRetries: maxOverflowRetriesSchema,
    modelPolicies: z.array(modelPolicy),
    auto: z.boolean(),
  })

  /** Resolved and validated compaction configuration. */
  readonly config: ResolvedConfig

  private readonly warnedPressureConfigTargets = new Set<string>()
  private readonly overflowRetries = new WeakMap<Agent, number>()
  private readonly overflowAgents = new WeakMap<Session, Agent>()
  private readonly capturedModels = new WeakMap<Agent, CompactionModelCapture>()
  private readonly capturedSessions = new WeakMap<Session, CompactionModelCapture>()

  constructor(ctx: Context, config: BasicCompactionConfig = {}) {
    super(ctx)
    this.config = resolveConfig(config)
    if (this.config.auto) this._registerAutomaticCompaction()
  }

  /**
   * Register automatic between-step pressure and model-request overflow
   * recovery. `compactIfNeeded` stays dynamically dispatched so subclass
   * overrides are honored at event time.
   */
  private _registerAutomaticCompaction(): void {
    const { ctx } = this
    const logResult = (result: CompactionResult, trigger: string): void => {
      ctx.logger.info(
        `compaction (${trigger}): shadowed ${result.shadowedSeqs.length} surface nodes `
        + `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, `
        + `~${result.shadowedTokenCount} tokens)`,
      )
    }

    ctx.on('codexy-agent/pre-step', async (
      { agent, turn, step, signal, promptPreparation, preparedModel },
      next,
    ): Promise<PreStepDecision> => {
      if (this.config.checkpointFormat === 'codex') return next()
      if (!signal.aborted) {
        try {
          this.capturedModels.delete(agent)
          this.capturedSessions.delete(agent.session)
          if (preparedModel !== undefined) {
            const captured: CompactionModelCapture = {
              turn, step, preparedModel, finalized: false,
              config: initialConversationConfig(agent, preparedModel, promptPreparation?.variables),
              ...promptPreparation === undefined ? {} : { promptPreparation },
            }
            this.capturedModels.set(agent, captured)
            this.capturedSessions.set(agent.session, captured)
          }
          const result = await this.compactIfNeeded(agent, 'pressure', signal)
          if (result !== null) logResult(result, 'step pressure')
        } catch (error: unknown) {
          if (error instanceof TargetPressureConfigError) {
            if (this.warnedPressureConfigTargets.has(error.targetKey)) return next()
            this.warnedPressureConfigTargets.add(error.targetKey)
          }
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`step compaction failed: ${message}; continuing the turn`)
        }
      }
      return next()
    })

    ctx.on('agent/request-enter', async ({ agent, turn, step, attempt, signal, config, preparedModel, promptPreparation }) => {
      if (this.config.checkpointFormat !== 'codex' || attempt !== 1) return
      signal.throwIfAborted()
      const previous = this.capturedModels.get(agent)
      if (previous?.turn !== turn) {
        this.capturedModels.delete(agent)
        this.capturedSessions.delete(agent.session)
        if (preparedModel === undefined) {
          const targetKey = `${config.provider}/${config.model}`
          if (!this.warnedPressureConfigTargets.has(targetKey)) {
            this.warnedPressureConfigTargets.add(targetKey)
            ctx.logger.warn(`Codex pressure skipped: no captured model metadata for ${targetKey}`)
          }
          return
        }
        const captured: CompactionModelCapture = {
          turn, step, preparedModel, config, finalized: true, promptPreparation,
        }
        this.capturedModels.set(agent, captured)
        this.capturedSessions.set(agent.session, captured)
      } else {
        previous.promptPreparation = promptPreparation
      }
      if (step !== 1) return
      try {
        const result = await this.compactIfNeeded(agent, 'pressure', signal, 'do-not-inject', 'pre_turn')
        if (result !== null) logResult(result, 'pre-turn pressure')
      } catch (error: unknown) {
        if (!(error instanceof TargetPressureConfigError)) throw error
        if (this.warnedPressureConfigTargets.has(error.targetKey)) return
        this.warnedPressureConfigTargets.add(error.targetKey)
        ctx.logger.warn(error.message)
      }
    })

    ctx.on('agent/step-completed', async ({ agent, turn, signal, needsFollowUp }) => {
      if (this.config.checkpointFormat !== 'codex' || !needsFollowUp) return
      signal.throwIfAborted()
      if (this.capturedModels.get(agent)?.turn !== turn) return
      try {
        const result = await this.compactIfNeeded(agent, 'pressure', signal, 'before-last-user-message', 'mid_turn')
        if (result !== null) logResult(result, 'mid-turn pressure')
      } catch (error: unknown) {
        if (!(error instanceof TargetPressureConfigError)) throw error
        if (this.warnedPressureConfigTargets.has(error.targetKey)) return
        this.warnedPressureConfigTargets.add(error.targetKey)
        ctx.logger.warn(error.message)
      }
    })

    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') {
        this.overflowRetries.delete(agent)
        this.capturedModels.delete(agent)
        this.capturedSessions.delete(agent.session)
      }
    })

    // A successful response starts a fresh overflow-recovery sequence even
    // when tool calls continue the same turn into another request.
    ctx.on('session/event', (session, event) => {
      if (event.type === 'request/header') {
        const captured = this.capturedSessions.get(session)
        const config = event.data.header.config
        if (captured !== undefined && !captured.finalized
          && config.provider === captured.config.provider && config.model === captured.config.model) {
          captured.config = config
          captured.finalized = true
        }
        return
      }
      if (event.type !== 'assistant/message') return
      const agent = this.overflowAgents.get(session)
      if (agent !== undefined) this.overflowRetries.delete(agent)
    })

    ctx.on('agent/request-error', async (
      { agent, failure, signal },
      next,
    ) => {
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next()
      this.overflowAgents.set(agent.session, agent)
      const target = this.capturedModels.get(agent)?.config ?? routedTarget(agent.session)
      if (target === undefined) return next()
      const policy = resolveTargetPolicy(this.config, target)
      const retries = this.overflowRetries.get(agent) ?? 0
      if (retries >= policy.maxOverflowRetries) return next()

      const generation = agent.session.surface.replaceGeneration
      let result: CompactionResult | null
      try {
        result = await this.compactIfNeeded(agent, 'context-overflow', signal, 'before-last-user-message', 'mid_turn')
      } catch (recoveryError: unknown) {
        const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
        // A model-free prune can land before later summary work fails. That
        // durable reduction is sufficient retry proof; do not discard it just
        // because the optional second phase threw. Cancellation still wins.
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while recovery is awaited.
        if (!signal.aborted && agent.session.surface.replaceGeneration > generation) {
          ctx.logger.warn(
            `context-overflow compaction failed after durable surface progress: ${message}; `
            + 'retrying from the replacement surface',
          )
          this.overflowRetries.set(agent, retries + 1)
          return { kind: 'retry' }
        }
        ctx.logger.warn(
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while recovery is awaited.
          `context-overflow compaction failed: ${message}; ${signal.aborted
            ? 'cancellation prevents retry'
            : 'preserving the original request error'}`,
        )
        return next()
      }
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while compaction is awaited.
      if (signal.aborted
        || agent.session.surface.replaceGeneration <= generation) return next()
      if (result !== null) logResult(result, 'context overflow recovery')
      this.overflowRetries.set(agent, retries + 1)
      return { kind: 'retry' }
    })
  }

  /**
   * Summarize the replayed conversation region through a direct one-shot
   * registration-bound call that replays the conversation's system prompt and
   * messages. DSH format also replays tools; Codex format omits them.
   * Override this sole hook for a template or remote summarizer.
   * @param input - replayed conversation messages and optional DSH-format tools to condense.
   * @param agent - supplies routed-model history, fallback model, and session id.
   * @param signal - optional cancellation forwarded to the adapter.
   * @returns safe text summary blocks and the exact auxiliary call envelope and output.
   */
  protected async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    const captured = this.capturedModels.get(agent)
    const target = captured?.config ?? conversationTarget(agent)
    const config = target === undefined
      ? this.config
      : resolveTargetPolicy(this.config, target)
    return summarizeWithLlm(this.ctx, { ...config, checkpointFormat: this.config.checkpointFormat }, input, agent, signal, captured)
  }

  /**
   * Compact for replayed step-boundary pressure or one provider-confirmed context
   * overflow. Automatic Codex calls retain initial-turn settings; ordinary DSH
   * calls retain this step's preparation. Calls without preparation use the
   * latest durable routed request envelope. Both triggers price logged history;
   * overflow bypasses the normal threshold and retained-tail policy so it can
   * force one useful balanced reduction.
   * @param agent - agent whose latest durable routed request is measured.
   * @param trigger - normal step-boundary pressure or context-overflow recovery.
   * @param signal - live turn cancellation signal forwarded to summarization.
   * @param initialContextInjection - Codex replacement-context placement; ordinary DSH ignores it.
   * @param phase - phase known by the real automatic entry point, never inferred from placement.
   * @returns the latest summary compaction result, or `null` when no summary ran.
   */
  override async compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
    initialContextInjection: CompactionInitialContextInjection = 'before-last-user-message',
    phase?: CodexCompactionMetadataFacts['phase'],
  ): Promise<CompactionResult | null> {
    const metadata: CodexCompactionMetadataFacts | undefined = this.config.checkpointFormat !== 'codex' || phase === undefined
      ? undefined : Object.freeze({ trigger: 'auto', reason: 'context_limit', implementation: 'responses', phase, strategy: 'memento' })
    const captured = this.capturedModels.get(agent)
    const durableTarget = routedTarget(agent.session)
    if (trigger === 'pressure' && this.config.checkpointFormat === 'dsh' && durableTarget === undefined) return null
    const target = captured?.config ?? durableTarget
    if (target === undefined) return null
    const policy = resolveTargetPolicy(this.config, target)
    const meter = this.ctx.codexyTokenMeter
    let measurement = meter.measure(agent.session)
    switch (trigger) {
      case 'context-overflow':
        break
      case 'pressure':
        break
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        assertNever(trigger, 'compaction trigger')
    }

    // Pruning is optional so compaction-basic remains independently composable.
    // Overflow always qualifies; pressure first resolves the routed model's
    // capacity and checks its target-specific threshold.
    const prune = this.ctx.get('toolResultPruner')

    if (trigger === 'context-overflow') {
      if (prune !== undefined) {
        prune.pruneSession(agent.session)
        measurement = meter.measure(agent.session)
      }
      const range = selectCompactableRange(
        agent.session, measurement, 0, this.config.checkpointFormat === 'codex',
      )
      if (range === null) return null
      return this.compactRegion(range.start, range.end, agent, signal, initialContextInjection, metadata)
    }

    const info = captured?.preparedModel.model
      ?? await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)
    assertNoActiveCompaction(agent.session, 'automatic pressure compaction')
    const targetKey = `${target.provider}/${target.model}`
    if (info.context === undefined) {
      throw new TargetPressureConfigError(
        targetKey,
        `compaction-basic: no context capacity for ${targetKey}; `
        + 'configure contextWindow on that adapter model',
      )
    }
    const spec = resolveCompactSpec(
      policy,
      info.context.contextWindow,
      captured === undefined
        ? reservedCompletionTokens(agent, info.defaultMaxTokens)
        : captured.config.maxTokens ?? info.defaultMaxTokens ?? 0,
    )
    if (measurement.totalTokens < spec.thresholdTokens) return null

    // Once pressure qualifies, land the model-free pass before choosing a
    // summary range, then remeasure through the singleton replay fold.
    if (prune !== undefined) {
      prune.pruneSession(agent.session)
      measurement = meter.measure(agent.session)
    }
    if (measurement.totalTokens < spec.thresholdTokens) return null

    let result: CompactionResult | null = null
    for (let attempt = 0; attempt <= spec.compactionRetries; attempt += 1) {
      const range = selectCompactableRange(
        agent.session, measurement, spec.retainTokens, this.config.checkpointFormat === 'codex',
      )
      if (range === null) {
        /* v8 ignore else -- concrete replacement preserves a compactable checkpoint; subclass hooks cannot mutate it. */
        if (result === null) return null
        /* v8 ignore next -- paired with the defensive post-success branch above. */
        break
      }
      result = await this.compactRegion(range.start, range.end, agent, signal, initialContextInjection, metadata)
      if (this.config.checkpointFormat === 'codex') return result
      measurement = meter.measure(agent.session)
      if (measurement.totalTokens < spec.thresholdTokens) return result
    }

    throw new Error(
      `compaction still above threshold after ${spec.compactionRetries + 1} compaction attempts `
      + `(${measurement.totalTokens} estimated tokens >= threshold ${spec.thresholdTokens})`,
    )
  }

  /**
   * Compact one inclusive positional range from the agent-owned surface using
   * the effective token meter for all retention and shrink pricing.
   * @param start - inclusive first surface-node seq.
   * @param end - inclusive last surface-node seq.
   * @param agent - owner of the target session, used by the summarizer.
   * @param signal - optional summarization cancellation signal.
   * @param initialContextInjection - Codex replacement-context placement, defaulting to before the last retained user message.
   * @param metadata - immutable operation facts supplied by its real owner; direct unknown origins omit them.
   * @returns the successful durable compaction result.
   */
  override async compactRegion(
    start: SessionSeq,
    end: SessionSeq,
    agent: Agent,
    signal?: AbortSignal,
    initialContextInjection: CompactionInitialContextInjection = 'before-last-user-message',
    metadata?: CodexCompactionMetadataFacts,
  ): Promise<CompactionResult> {
    return compactSurfaceRegion(
      this.regionDependencies(metadata),
      agent.session,
      start,
      end,
      agent,
      { owner: 'current-turn', stability: 'whole-surface', initialContextInjection },
      signal,
    )
  }

  /**
   * Force one useful idle-session compaction below the pressure threshold, and
   * resolve only after its standalone marker pair is durably checkpointed.
   * @param agent - idle agent whose next-turn admission this call reserves.
   * @param signal - cancellation scoped to this compaction request.
   * @param sourceCommandId - initiating command identity for presentation correlation.
   * @returns the committed result, or `null` when no safe useful range exists.
   */
  override compactNow(
    agent: Agent,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    try {
      return agent.runMaintenance(async (agentSignal) => {
        const operationSignal = AbortSignal.any([agentSignal, signal])
        try {
          operationSignal.throwIfAborted()
          const range = selectCompactableRange(
            agent.session,
            this.ctx.codexyTokenMeter.measure(agent.session),
            0,
            this.config.checkpointFormat === 'codex',
          )
          if (range === null) return null
          return await compactSurfaceRegion(
            this.regionDependencies(this.config.checkpointFormat === 'codex'
              ? Object.freeze({ trigger: 'manual', reason: 'user_requested', implementation: 'responses', phase: 'standalone_turn', strategy: 'memento' })
              : undefined),
            agent.session,
            range.start,
            range.end,
            agent,
            {
              owner: null,
              stability: 'selected-span',
              initialContextInjection: 'do-not-inject',
              ...sourceCommandId === undefined ? {} : { sourceCommandId },
              flush: async () => {
                await this.ctx.sessions.flush(agent.session)
              },
            },
            operationSignal,
          )
        } catch (error: unknown) {
          if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) {
            throw new ManualCompactionError(
              'cancelled',
              'manual compaction was cancelled',
              { cause: error },
            )
          }
          operationSignal.throwIfAborted()
          throw error
        }
      })
    } catch (error: unknown) {
      throw new ManualCompactionError(
        'busy',
        'manual compaction requires an idle agent with no waking queued work',
        { cause: error },
      )
    }
  }

  /** Bind the effective token meter and dynamically dispatched summarizer hook. */
  private regionDependencies(metadata?: CodexCompactionMetadataFacts): Parameters<typeof compactSurfaceRegion>[0] {
    return {
      checkpointFormat: this.config.checkpointFormat,
      codexUserMessageTokens: this.config.codexUserMessageTokens,
      meter: this.ctx.codexyTokenMeter,
      initialContext: (agent, signal) => {
        const promptPreparation = this.capturedModels.get(agent)?.promptPreparation
        return this.ctx.waterfall('codexy-compaction/initial-context', {
          agent,
          ...signal === undefined ? {} : { signal },
          ...promptPreparation === undefined ? {} : { promptPreparation },
        }, () => Promise.resolve(undefined))
      },
      summarize: (input, owner, abort) => this.summarize(metadata === undefined
        ? input : { ...input, compactionMetadata: metadata }, owner, abort),
      recover: (error, agent, sourceEventSeqs, signal) => this.ctx.waterfall('compaction/summary-error', {
        session: agent.session,
        sourceEventSeqs,
        error,
        ...signal === undefined ? {} : { signal },
      }, () => false),
    }
  }
}

export default BasicCompactionEngine
