/** Browser-safe Codexy transcript and native-provider vocabulary. */
export type * from '@deepseek-ai/dsh-session/types'
import type { SessionSeq, SessionEvent as PlatformSessionEvent, SessionEventType as PlatformSessionEventType, EpochHeader as PlatformEpochHeader, SessionEventMap as PlatformSessionEventMap } from '@deepseek-ai/dsh-session/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-compaction/types'
import type { FileAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { GenerateOptions as PlatformGenerateOptions, FinishReason as PlatformFinishReason, StreamChunk as PlatformStreamChunk, ReplayEnvelope } from '@deepseek-ai/dsh-llm/types'

/** Verbatim source owned by the product's native view_image path, beside its canonical UI image. */
export interface CodexNativeImageFacts {
  /** 1 retains the released Sharp policy; 2 uses the pinned native Rust codec. */
  readonly version: 1 | 2
  readonly tool: 'view_image'
  readonly file: FileAttachmentRef
  readonly mediaType: ImageMediaType
  readonly width: number
  readonly height: number
}

/** Backend-executed Responses output, never a client-dispatched function call. */
export interface ProviderOutputBlock {
  type: 'provider-output'
  api: 'openai-responses'
  outputIndex: number
  /** The original provider item, including ids, action, status, and unknown JSON fields. */
  item: { type: 'web_search_call'; id: string; [key: string]: JsonValue }
}

/**
 * Provider-neutral description of a function or freeform tool.
 *
 * Declared here (not in dsh-tools) because it is part of {@link GenerateOptions};
 * dsh-tools' ToolDefinition and dsh-system-prompt's PromptAssembly both import
 * it from this package.
 */
interface ToolSchemaBase {
  /**
   * Requests deferred loading of the tool definition into model context,
   * independently of whether a tool-addition block records the tool.
   * Uses Anthropic's defer_loading terminology.
   */
  deferLoading?: true
  /** Codex Responses Lite namespace on routes that explicitly support grouped tools. */
  namespace?: {
    /** Provider-visible namespace name. */
    name: string
    /** Description shown for the provider-visible namespace. */
    description: string
    /** Tool name inside the namespace; {@link ToolSchema.name} remains the dispatch name. */
    toolName: string
  }
  name: string
  description: string
  /** Maximum disclosed input-schema bytes for code-mode introspection, not a call-input limit. */
  inputSchemaMaxBytes?: number
  /** Optional structured function output used by code-mode introspection. */
  outputSchema?: Record<string, unknown>
}

/** A JSON function tool; omitted kind preserves existing function definitions. */
export interface FunctionToolSchema extends ToolSchemaBase {
  kind?: 'function'
  /** JSON Schema object for the arguments. */
  parameters: Record<string, unknown>
}

/** Provider grammar for an unwrapped freeform input string. */
export interface FreeformToolFormat {
  type: 'grammar'
  syntax: 'lark' | 'regex'
  definition: string
}

/** A native custom tool whose input is supplied without JSON serialization. */
export interface FreeformToolSchema extends ToolSchemaBase {
  kind: 'freeform'
  format: FreeformToolFormat
  /** Freeform tools disclose a grammar instead of JSON parameters. */
  parameters?: never
}

/** Model-visible function or native freeform tool declaration. */
export type ToolSchema = FunctionToolSchema | FreeformToolSchema


/** Wire controls retained by the Codexy Responses providers. */
export interface CodexyResponsesConfig {
  omitDefaultMaxTokens: boolean
  reasoningSummary: 'auto' | 'none'
  /** Explicit experimental serialization; omitted retains the existing wire format. */
  wireProfile?: 'codex-0.162.1'
  /** Captured Codex client facts; the explicit wire profile projects this snapshot. */
  clientMetadata?: Readonly<Record<string, string>>
  lite?: true
  strictModelInput?: true
}
/** Provider transport milestone, excluded from model input. */
export interface LlmRequestTiming {
  phase: 'adapter-start' | 'images-ready' | 'credentials-ready' | 'files-ready' | 'body-ready' | 'http-start' | 'response-headers' | 'response-ready' | 'first-byte'
  time: number
}
export interface EpochHeader {
  config: PlatformEpochHeader['config'] & { codexfulResponses?: CodexyResponsesConfig }
  adapterDefaults?: PlatformEpochHeader['adapterDefaults']
  tools?: ToolSchema[]
}
/** Native, sealed model input before adapter projection; not an HTTP wire packet. */
export type PreparedCompactionModelInput = Omit<GenerateOptions, 'signal' | 'onRequestTiming'>
/** Browser-safe native request vocabulary, shared by host ports and durable facts. */
export interface GenerateOptions extends Omit<PlatformGenerateOptions, 'tools'> {
  tools?: ToolSchema[]
  codexfulResponses?: CodexyResponsesConfig
  onRequestTiming?: (timing: LlmRequestTiming) => void
}
/** Completed response items can retain their individual replay metadata. */
export type FinishReason = Exclude<PlatformFinishReason, { kind: 'stop' }> | { kind: 'stop'; endTurn?: false }
export type StreamChunk = Exclude<PlatformStreamChunk, { type: 'block-start' | 'block-end' | 'tool-call-delta' | 'finish' }>
  | (Extract<PlatformStreamChunk, { type: 'block-start' | 'block-end' }> & { replayState?: ReplayEnvelope })
  | (Extract<PlatformStreamChunk, { type: 'tool-call-delta' }> & { kind?: 'function' | 'freeform' })
  | { type: 'finish'; reason: FinishReason; replayState?: ReplayEnvelope }
/** Only origins observed by the entry point are recorded; direct calls have no inferred span. */
export interface CompactionRequestSource {
  checkpointFormat: 'dsh' | 'codex'
  headMessageCount: 0 | 1
  compactionMetadata?: import('./response-metadata.ts').CodexCompactionMetadataFacts
  compactionId?: string
  sourceCommandId?: string
  sourceEventSeqs?: readonly SessionSeq[]
  shadowedRange?: { start: SessionSeq; end: SessionSeq }
}
/** Serializable error facts; missing provider codes remain missing. */
export type CompactionRequestFailure = { message: string; code?: string; name?: string } & Partial<import('@deepseek-ai/dsh-llm/types').LlmFailure>
interface CompactionRequestIdentity {
  version: 1
  /** One summarizer invocation, including its existing stream retries and trims. */
  invocationId: string
  requestId: string
  attempt: number
  omittedInputMessages: number
  source: CompactionRequestSource
}
/** Product event vocabulary; owners add their own events through declaration merging. */
export interface CodexySessionEventMap extends Omit<PlatformSessionEventMap, 'request/header' | 'assistant/attempt' | 'assistant/message' | 'tool/call' | 'schedule/change' | 'compaction/summary'> {
  /** Optional turn-owned Git enrichment; absence on a request does not imply completion. */
  'codexful/workspace-enrichment': {
    turnStartSeq: SessionSeq
    cwd: string
    phase: 'pending' | 'ready'
    workspaces?: import('./response-metadata.ts').CodexWorkspacesMetadata
  }
  'compaction/summary': PlatformSessionEventMap['compaction/summary'] & { clientMetadata?: Readonly<Record<string, string>> }
  /** Flushed before invoking the prepared port; absence of a result is pending/unknown, never replay permission. */
  'compaction/request': CompactionRequestIdentity & { preparedInput: PreparedCompactionModelInput }
  /** Actual prepared-port invocation terminated; this does not assert HTTP transmission. */
  'compaction/request-result': CompactionRequestIdentity & {
    dispatchInvoked: true
    outcome: 'completed' | 'error' | 'aborted'
    /** The actual terminal chunk, absent when the stream provided none. */
    finish?: FinishReason
    failure?: CompactionRequestFailure
    /** Original native port chunks, including incomplete tool/provider/recovery facts. */
    streamChunks: StreamChunk[]
    outputProjection: 'assembled' | 'interrupted-text-and-provider' | 'unavailable'
    projectionFailure?: CompactionRequestFailure
    output: import('@deepseek-ai/dsh-llm/types').ContentBlock[]
    usage?: import('@deepseek-ai/dsh-llm/types').TokenUsage
    /** Exact replay state on the observed terminal chunk, if present. */
    replayState?: ReplayEnvelope
    completedReplayState?: ReplayEnvelope
    attemptReplayState?: ReplayEnvelope
  }
  /** Defaults/metadata could not be sealed; proposed input is not a prepared or dispatched request. */
  'compaction/preparation-error': CompactionRequestIdentity & {
    dispatchInvoked: false
    stage: 'model' | 'call'
    proposedInput: PreparedCompactionModelInput
    failure: CompactionRequestFailure
  }
  'request/header': Omit<PlatformSessionEventMap['request/header'], 'header'> & { header: EpochHeader; codexyHeader?: EpochHeader }
  'assistant/attempt': PlatformSessionEventMap['assistant/attempt'] & { requestSentTime?: number; requestTimings?: LlmRequestTiming[]; replayState?: import('@deepseek-ai/dsh-llm/types').ReplayEnvelope }
  'assistant/message': PlatformSessionEventMap['assistant/message'] & { requestSentTime?: number; requestTimings?: LlmRequestTiming[] }
  'tool/call': PlatformSessionEventMap['tool/call'] & { kind?: 'function' | 'freeform'; namespace?: string }
  'tool/notification': { turn: number; callSeq: SessionSeq; message: import('@deepseek-ai/dsh-llm/types').ToolResultMessage; historyTruncationTokenLimit?: number; originalText?: string }
  'assistant/output-item': { turn: number; step: number; index: number; block: import('@deepseek-ai/dsh-llm/types').TextBlock | import('@deepseek-ai/dsh-llm/types').ReasoningBlock | import('@deepseek-ai/dsh-llm/types').ToolCallBlock | ProviderOutputBlock; provider: string; model: string; replayState?: import('@deepseek-ai/dsh-llm/types').ReplayEnvelope }
  'llm/request-timing': { turn: number; step: number; timing: LlmRequestTiming }
  'runtime/feature': { name: 'tool-notification' | 'native-request-header'; version: 1 }
  'runtime/import': { path: string; sha256: string; version: number; originalEventCount: number }
  'request/feature': { name: 'codexful-responses'; version: 1 }
}
/** Product vocabulary projected from native events and Codexy fact records. */
export type SessionEventMap = CodexySessionEventMap
export type SessionEventType = keyof SessionEventMap
export type SessionEvent<T extends SessionEventType = SessionEventType> = {
  [K in SessionEventType]: (K extends PlatformSessionEventType ? Omit<PlatformSessionEvent<K>, 'data'> : K extends 'tool/notification' ? { type: K; seq: SessionSeq; time: number; ignorable?: true; surfaceOp: 'append'; sourceEventSeqs?: readonly SessionSeq[] } : { type: K; seq: SessionSeq; time: number; ignorable?: true; surfaceOp?: never; sourceEventSeqs?: never }) & { data: SessionEventMap[K] }
}[T]
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Required product fact; the inner type selects the Codexy payload interpreter. */
    'codexy/fact': { type: string; data: JsonValue }
  }
}
/** Durable carrier for native tool outputs on the original user-message surface. */
export interface ToolNotificationSource {
  kind: 'codexy-tool-notification'
  notification: SessionEventMap['tool/notification']
}
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'codexy-tool-notification': ToolNotificationSource
    'codexy-tool-output': { kind: 'codexy-tool-output'; callId: import('@deepseek-ai/dsh-llm').ToolCallId }
  }
}
declare module '@deepseek-ai/dsh-llm' {
  interface ContentBlockMap { 'provider-output': ProviderOutputBlock }
  interface ImageBlock { codexNativeImage?: CodexNativeImageFacts }
  interface LlmModelInfo { showInPicker?: boolean; multiAgentVersion?: 'disabled' | 'v1' | 'v2'; serviceTiers?: readonly string[] }
  interface LlmResolvedModelInfo { codexResponsesLite?: true; toolNamespaces?: 'native' }
}
declare module '@deepseek-ai/dsh-llm/types' {
  interface ToolCallBlock { namespace?: string; kind?: 'function' | 'freeform' }
}
declare module '@deepseek-ai/dsh-llm' {
  interface ToolMessageSource { toolKind?: 'function' | 'freeform'; name?: string }
}
