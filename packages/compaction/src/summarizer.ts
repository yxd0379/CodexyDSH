import { requestHeaderOf } from '@codexydsh/runtime/session'
import type { CompactionRequestFailure, CompactionRequestSource, PreparedCompactionModelInput, SessionEventMap } from '@codexydsh/runtime/types'
/**
 * Default summarization and durable checkpoint framing.
 *
 * @module @codexydsh/compaction/summarizer
 */

import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { contentHasImage, BlockAssembler, compactionClientMetadata, CONTEXT_WINDOW_EXCEEDED_CODE, LlmError } from '@codexydsh/runtime/llm'
import { deepFreeze, snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import type {
  ContentBlock, FinishReason, GenerateOptions, LlmCallConfig, Message, PreparedLlmModel, RequestMessage, StreamChunk, TokenUsage, ToolSchema,
  CodexClientMetadata, CodexCompactionMetadataFacts,
} from '@codexydsh/runtime/llm'
import type { Agent } from '@deepseek-ai/dsh-agent'

interface SummaryConfig {
  readonly summarizationProvider: string
  readonly summarizationModel: string
  readonly maxTokens: number
  readonly checkpointFormat: 'dsh' | 'codex'
}

/** Conversation configuration and adapter generation selected before automatic compaction. */
export interface CapturedConversationModel {
  /** Model metadata and adapter dispatch from the same preparation. */
  readonly preparedModel: PreparedLlmModel
  /** Initial conversation request settings used by the local summary request. */
  readonly config: LlmCallConfig
}

/** Tags wrapping the structured summary inside the landed checkpoint node. */
const SUMMARY_OPEN_TAG = '<compacted-summary>'
const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/**
 * The summarization directive, delivered as the FINAL user message after the
 * replayed conversation rather than as a distinct summarizer system prompt.
 * Keeping the conversation's own system prompt, tools, and message prefix in
 * front of it makes the auxiliary call a genuine prefix of the last routed
 * request, so the provider's KV cache is reused instead of invalidated.
 */
const COMPACTION_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
].join('\n')

/** Framing that makes the replacement user message established context. */
const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

/** The pinned Codex compaction directive, sent after the conversation as one user message. */
const CODEX_COMPACTION_INSTRUCTION = 'You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.\n\nInclude:\n- Current progress and key decisions made\n- Important context, constraints, or user preferences\n- What remains to be done (clear next steps)\n- Any critical data, examples, or references needed to continue\n\nBe concise, structured, and focused on helping the next LLM seamlessly continue the work.\n'

/** The pinned Codex summary prefix shown to the continuing model. */
const CODEX_SUMMARY_PREFIX = 'Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:'

/**
 * The replayed conversation surface the summarizer condenses. Reproducing the
 * last routed request's system prompt and leading messages preserves its
 * message prefix. The DSH format also replays tools for prefix-cache reuse;
 * the Codex format omits them as its pinned local summary request does.
 */
export interface SummarizationInput {
  /** Provenance supplied by a real region transaction, never guessed for direct calls. */
  readonly source?: Pick<CompactionRequestSource, 'compactionId' | 'sourceCommandId' | 'sourceEventSeqs' | 'shadowedRange'>
  /** Captured by the actual entry point; unknown direct-call origins remain absent. */
  readonly compactionMetadata?: CodexCompactionMetadataFacts
  /** The conversation's tool schemas, sent only by the DSH summary format. */
  readonly tools?: readonly ToolSchema[]
  /** Count of leading system-head messages, regardless of their projected model role. */
  readonly headMessageCount: 0 | 1
  /** The derived system head, when present, followed by the shadowed region in surface order. */
  readonly messages: readonly Message[]
}

/** Safe summary content plus the successful auxiliary call envelope recorded with it. */
export type SummaryResult = {
  /** The successful auxiliary request's immutable metadata, retained in its summary event. */
  clientMetadata?: CodexClientMetadata
  summary: ContentBlock[]
  provider: string
  model: string
  maxTokens?: number
  /** Number of history messages removed after Codex summary context overflow. */
  omittedInputMessages?: number
  /** Provider-reported usage for this summarization request. */
  usage?: TokenUsage
} & (
  | {
    /** Complete provider output before the text-only summary projection. */
    rawOutput: ContentBlock[]
    /** Identifies the successful call through this context's `ctx.codexyRequests.stream()`. */
    llmStreamCall: true
  }
  | {
    /** Optional complete output from an unmarked template, remote, or other summarizer. */
    rawOutput?: ContentBlock[]
    /** An unmarked result does not identify a call through this context's LLM seam. */
    llmStreamCall?: never
  }
)

/** Remove the oldest history message and any tool outputs paired with its calls. */
function trimOldestCodexHistory(messages: readonly RequestMessage[], protectedCount: number): RequestMessage[] {
  const oldest = messages[protectedCount]
  const remaining = [...messages.slice(0, protectedCount), ...messages.slice(protectedCount + 1)]
  if (oldest?.role !== 'assistant') return remaining
  const callIds = new Set(oldest.content.filter(block => block.type === 'tool-call').map(block => block.id))
  return callIds.size === 0
    ? remaining
    : remaining.filter(message => message.role !== 'tool' || !callIds.has(message.toolCallId))
}

/**
 * Run a registration-bound summarization request: replay the conversation
 * messages, then append the compaction instruction as the final user message.
 * @param ctx - context providing the LLM service.
 * @param config - resolved backend configuration.
 * @param input - replayed conversation messages and optional DSH-format tools to condense.
 * @param agent - supplies routed-model history, fallback model, and session id.
 * @param signal - optional cancellation forwarded to the adapter.
 * @param conversation - captured conversation model; an override captures its own generation once.
 * @returns safe text-only summary blocks and the successful call envelope and output.
 */
export async function summarizeWithLlm(
  ctx: Context,
  config: SummaryConfig,
  input: SummarizationInput,
  agent: Agent,
  signal?: AbortSignal,
  conversation?: CapturedConversationModel,
): Promise<SummaryResult> {
  const header = requestHeaderOf(agent.session)
  const latest = conversation?.config ?? header?.config
  const configured = config.summarizationProvider.length === 0
    ? undefined
    : { provider: config.summarizationProvider, model: config.summarizationModel }
  const agentTarget = agent.options.provider !== undefined
    && agent.options.provider.length > 0
    && agent.options.model !== undefined
    && agent.options.model.length > 0
    ? { provider: agent.options.provider, model: agent.options.model }
    : undefined
  const target = configured ?? latest ?? agentTarget
  if (target === undefined) {
    throw new Error(
      'no provider/model available for summarization: set both BasicCompactionConfig summarization fields, route one request, or set both AgentOptions fields',
    )
  }
  const codexfulResponses = config.checkpointFormat === 'codex'
    && latest?.provider === target.provider && latest.model === target.model
    ? latest.codexfulResponses : undefined

  const instruction = deepFreeze<RequestMessage>({
    role: 'user',
    content: [{ type: 'text', text: config.checkpointFormat === 'codex' ? CODEX_COMPACTION_INSTRUCTION : COMPACTION_INSTRUCTION }],
  })
  const historyStart = input.headMessageCount
  let omittedInputMessages = 0
  let options: GenerateOptions = {
    provider: target.provider,
    model: target.model,
    messages: [...input.messages, instruction],
    ...config.checkpointFormat === 'codex' || input.tools === undefined
      ? {} : { tools: [...input.tools] },
    ...codexfulResponses === undefined ? { maxTokens: config.maxTokens } : {},
    ...config.checkpointFormat === 'codex' && latest?.provider === target.provider
      && latest.model === target.model && latest.reasoningEffort !== undefined
      && (conversation !== undefined || header?.adapterDefaults?.reasoningEffort !== true)
      ? { reasoningEffort: latest.reasoningEffort } : {},
    ...codexfulResponses === undefined
      ? {} : { codexfulResponses: {
        omitDefaultMaxTokens: true, reasoningSummary: codexfulResponses.reasoningSummary,
        ...codexfulResponses.wireProfile === undefined ? {} : { wireProfile: codexfulResponses.wireProfile },
        ...codexfulResponses.strictModelInput === true ? { strictModelInput: true as const } : {},
      } },
    sessionId: agent.session.id,
    purpose: 'compaction',
    ...signal === undefined ? {} : { signal },
  }
  const invocationId = randomUUID()
  const source = jsonSnapshot<CompactionRequestSource>({
    checkpointFormat: config.checkpointFormat, headMessageCount: input.headMessageCount,
    ...input.compactionMetadata === undefined ? {} : { compactionMetadata: input.compactionMetadata },
    ...input.source,
  }, 'compaction source')
  // Capture from the original history before awaits or overflow trimming. The
  // auxiliary request may omit old input without removing it from the session.
  const assistantHistoryText = latestAssistantText(input.messages)
  let attempt = 0
  const identity = () => ({ version: 1 as const, invocationId, requestId: randomUUID(),
    attempt: attempt + 1, omittedInputMessages, source })
  const preparationError = async (error: unknown, stage: 'model' | 'call') => {
    ctx.logger.debug('compaction/preparation-error %o', {
      sessionId: agent.session.id,
      ...identity(), dispatchInvoked: false, stage, proposedInput: modelInputSnapshot(options), failure: requestFailure(error),
    })
  }
  let preparedModel: PreparedLlmModel
  try {
    preparedModel = conversation !== undefined
      && conversation.config.provider === target.provider && conversation.config.model === target.model
      ? conversation.preparedModel : await ctx.codexyRequests.prepareModel(target.provider, target.model, signal)
  } catch (error: unknown) {
    await preparationError(error, 'model')
    throw error
  }
  let retries = 0
  let metadataCaptured = false
  let assembler: BlockAssembler
  let completedFinish: FinishReason | undefined
  for (;;) {
    assembler = new BlockAssembler()
    let preparedCall: ReturnType<PreparedLlmModel['prepareCall']>
    let preparedInput: PreparedCompactionModelInput
    try {
      preparedCall = preparedModel.prepareCall({
        provider: options.provider, model: options.model,
        ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        ...options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort },
        ...options.codexfulResponses === undefined ? {} : { codexfulResponses: options.codexfulResponses },
      })
      options = { ...options, ...preparedCall.config }
      if (!metadataCaptured) {
        metadataCaptured = true
        const controls = options.codexfulResponses
        const clientMetadata = controls?.wireProfile === 'codex-0.162.1'
          ? compactionClientMetadata(codexfulResponses?.clientMetadata, input.compactionMetadata) : undefined
        if (controls !== undefined && clientMetadata !== undefined) {
          options = { ...options, codexfulResponses: { ...controls, clientMetadata } }
          // Defaults are now known. Seal the captured metadata into a fresh call
          // from this same model generation before its first and only dispatch.
          preparedCall = preparedModel.prepareCall({ ...preparedCall.config, codexfulResponses: options.codexfulResponses })
          options = { ...options, ...preparedCall.config }
        }
      }
      preparedInput = modelInputSnapshot(options)
    } catch (error: unknown) {
      await preparationError(error, 'call')
      throw error
    }
    const retryPolicy = config.checkpointFormat === 'codex' ? preparedCall.retryPolicy : undefined
    const request = identity()
    attempt += 1
    ctx.logger.debug('compaction/request %o', { sessionId: agent.session.id, ...request, preparedInput })
    signal?.throwIfAborted()
    options = deepFreeze<GenerateOptions>({ ...preparedInput, ...signal === undefined ? {} : { signal } })
    let streamFailure: unknown
    let failed = false
    let finish: FinishReason | undefined
    let terminalReplayState: SessionEventMap['compaction/request-result']['replayState']
    const streamChunks: StreamChunk[] = []
    try {
      for await (const chunk of preparedCall.stream(options)) {
        const observed = jsonSnapshot(chunk, 'compaction stream chunk')
        streamChunks.push(observed)
        assembler.push(observed)
        if (observed.type === 'finish') {
          finish = observed.reason
          terminalReplayState = observed.replayState
        }
      }
      const nativeHistorySummary = usesCodexHistorySummary(source, options)
      const acceptsCappedSummary = nativeHistorySummary && assembler.finish.kind === 'max-tokens'
        && (hasVisibleText(assembler.blocks()) || assistantHistoryText !== undefined)
      const error = acceptsCappedSummary ? undefined : finishError(assembler.finish)
      if (error !== undefined) throw error
    } catch (error: unknown) {
      streamFailure = error
      failed = true
    }
    let output: ContentBlock[] = []
    let outputProjection: SessionEventMap['compaction/request-result']['outputProjection'] = failed ? 'interrupted-text-and-provider' : 'assembled'
    let completedReplayState: SessionEventMap['compaction/request-result']['completedReplayState']
    let projectionError: unknown
    let projectionFailed = false
    try {
      output = failed ? assembler.interruptedBlocks() : assembler.blocks()
      completedReplayState = assembler.completedReplayState
    } catch (error: unknown) {
      // A malformed/incomplete block must not erase the observed native chunks
      // or turn a completed port stream into a fabricated provider failure.
      projectionError = error
      projectionFailed = true
      outputProjection = 'unavailable'
    }
    const result: SessionEventMap['compaction/request-result'] = {
      ...request, dispatchInvoked: true,
      outcome: !failed ? 'completed' : signal?.aborted === true || failureCode(streamFailure) === 'ABORTED' ? 'aborted' : 'error',
      ...finish === undefined ? {} : { finish },
      ...!failed ? {} : { failure: requestFailure(streamFailure) },
      streamChunks, output, outputProjection,
      ...!projectionFailed ? {} : { projectionFailure: requestFailure(projectionError) },
      ...assembler.usage === undefined ? {} : { usage: assembler.usage },
      ...terminalReplayState === undefined ? {} : { replayState: terminalReplayState },
      ...completedReplayState === undefined ? {} : { completedReplayState },
      ...assembler.attemptReplayState === undefined ? {} : { attemptReplayState: assembler.attemptReplayState },
    }
    ctx.logger.debug('compaction/request-result %o', { sessionId: agent.session.id, ...result })
    if (!failed && projectionFailed) throw projectionError
    if (!failed) { completedFinish = finish; break }
    {
      const error = streamFailure
      if (config.checkpointFormat === 'codex' && signal?.aborted !== true
        && failureCode(error) === CONTEXT_WINDOW_EXCEEDED_CODE
        && options.messages.length - 1 > historyStart) {
        const history = options.messages.slice(0, -1)
        const retained = trimOldestCodexHistory(history, historyStart)
        omittedInputMessages += history.length - retained.length
        retries = 0
        options = {
          ...options,
          messages: [...retained, instruction],
        }
        continue
      }
      if (retryPolicy === undefined || signal?.aborted === true
        || !retryableCompactionFailure(error)
        || (retryPolicy.mode === 'normal' && retries >= retryPolicy.maxRetries)) throw error
      retries += 1
      const exponential = Math.min(retryPolicy.initialDelayMs * 2 ** Math.min(retries - 1, 1024), retryPolicy.maxDelayMs)
      const jitter = 1 - retryPolicy.jitterRatio + 2 * retryPolicy.jitterRatio * Math.random()
      await delay(Math.min(exponential * jitter, retryPolicy.maxDelayMs), undefined, { signal })
    }
  }

  const rawOutput = assembler.blocks()
  const currentSummary = summaryText(rawOutput)
  const fallback = completedFinish !== undefined && !hasVisibleText(currentSummary) && usesCodexHistorySummary(source, options)
    ? assistantHistoryText : undefined
  const summary = fallback === undefined ? currentSummary : [{ type: 'text' as const, text: fallback }]
  if (!summary.some(block => block.text.trim().length > 0)) {
    throw new Error('summarization produced no text summary content')
  }
  return {
    summary,
    rawOutput,
    llmStreamCall: true,
    provider: options.provider,
    model: options.model,
    ...options.codexfulResponses?.clientMetadata === undefined
      ? {} : { clientMetadata: options.codexfulResponses.clientMetadata },
    ...omittedInputMessages === 0 ? {} : { omittedInputMessages },
    ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
    ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
  }
}

/** Codex's local non-post-turn compaction reads the latest assistant from its history snapshot. */
function usesCodexHistorySummary(
  source: CompactionRequestSource,
  options: GenerateOptions,
): boolean {
  const metadata = source.compactionMetadata
  return source.checkpointFormat === 'codex'
    && options.codexfulResponses?.wireProfile === 'codex-0.162.1'
    && metadata?.implementation === 'responses' && metadata.strategy === 'memento'
    && (metadata.phase === 'pre_turn' || metadata.phase === 'mid_turn' || metadata.phase === 'standalone_turn')
}

function hasVisibleText(blocks: readonly ContentBlock[]): boolean {
  return blocks.some(block => block.type === 'text' && block.text.trim().length > 0)
}

/** Keep visible text bytes, including line breaks; reasoning and tool-only messages are not summaries. */
function latestAssistantText(messages: readonly Message[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role !== 'assistant') continue
    const parts = message.content.flatMap(block => block.type === 'text' && block.text.length > 0 ? [block.text] : [])
    if (parts.length === 0) continue
    const text = parts.join('\n')
    return text.trim().length === 0 ? undefined : text
  }
  return undefined
}

/** Lossless JSON snapshot of native input, excluding only live invocation controls. */
function modelInputSnapshot(options: GenerateOptions): PreparedCompactionModelInput {
  const { signal: _signal, onRequestTiming: _timing, ...input } = options
  return jsonSnapshot(input, 'prepared compaction input')
}

function jsonSnapshot<T>(value: T, subject: string): T {
  const detached = snapshotJsonValue(value)
  if (detached === undefined) throw new TypeError(`${subject} must contain lossless JSON`)
  return deepFreeze(detached)
}

/** Preserve provider facts without serializing live Error objects or inventing a code. */
function requestFailure(error: unknown): CompactionRequestFailure {
  if (error instanceof LlmError) return { ...error.failure, name: error.name }
  return { message: error instanceof Error ? error.message : String(error),
    ...error instanceof Error ? { name: error.name } : {},
    ...failureCode(error) === undefined ? {} : { code: failureCode(error) },
  }
}

/** Stable provider error class for an in-band failure or a thrown adapter error. */
function failureCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code : undefined
}

/** Failures that Codex handles outside its bounded compaction stream retry. */
function retryableCompactionFailure(error: unknown): boolean {
  const code = failureCode(error)
  return code !== CONTEXT_WINDOW_EXCEEDED_CODE
    && code !== 'ABORTED'
    && code !== 'QUOTA'
    && code !== 'MAX_TOKENS'
}

/**
 * Wrap raw summary blocks in the durable checkpoint framing.
 * @param summary - safe text-only model output.
 * @param format - DSH's tagged checkpoint or the pinned Codex handoff prefix.
 * @returns content for the synthesized replacement user message.
 */
export function frameSummary(
  summary: readonly ContentBlock[],
  format: 'dsh' | 'codex' = 'dsh',
): ContentBlock[] {
  if (format === 'codex') {
    return [
      { type: 'text', text: `${CODEX_SUMMARY_PREFIX}\n` },
      ...summary,
    ]
  }
  return [
    { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
    ...summary,
    { type: 'text', text: SUMMARY_CLOSE_TAG },
  ]
}

/** Map a terminal summarization finish to its fail-closed error. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      return new LlmError(finish.failure.message, finish.failure.code, finish.failure)
    }
    case 'max-tokens': {
      const error = new Error('summarization truncated at the token cap (incomplete checkpoint)') as Error & { code?: string }
      error.code = 'MAX_TOKENS'
      return error
    }
    default:
      return undefined
  }
}

/** Reject visual output and keep only text before synthesizing a user message. */
function summaryText(
  blocks: readonly ContentBlock[],
): Array<Extract<ContentBlock, { type: 'text' }>> {
  if (contentHasImage(blocks)) {
    throw new LlmError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT')
  }
  return blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
}
