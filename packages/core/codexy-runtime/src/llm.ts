/** Codexy native request metadata layered on the original DSH LLM vocabulary. */
export * from '@deepseek-ai/dsh-llm'
export { default } from '@deepseek-ai/dsh-llm'
import type { LlmAdapter, LlmCallConfig, LlmResolvedModelInfo, LlmModelInfo, PreparedLlmCall as PlatformPreparedLlmCall } from '@deepseek-ai/dsh-llm'

export type { ToolSchema, FunctionToolSchema, FreeformToolSchema, FreeformToolFormat, CodexyResponsesConfig, LlmRequestTiming, ProviderOutputBlock, GenerateOptions, FinishReason, StreamChunk, CodexNativeImageFacts } from './types.ts'
export { encodeCodexClientMetadata, compactionClientMetadata } from './response-metadata.ts'
export type { CodexResponseMetadataFacts, CodexCompactionMetadataFacts, CodexClientMetadata,
  CodexWorkspaceMetadata, CodexWorkspacesMetadata } from './response-metadata.ts'
export { isCodexWorkspacesMetadata } from './response-metadata.ts'
import type { CodexyResponsesConfig, GenerateOptions, StreamChunk } from './types.ts'

/** Model adapter supporting product tool declarations and captured provider generations. */
export interface NativeAdapter extends Omit<LlmAdapter, 'prepareCall' | 'stream'> {
  prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall>
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/** Provider generation whose controls and schemas were selected together. */
export interface PreparedLlmCall extends Omit<PlatformPreparedLlmCall, 'stream'> {
  developerHistory?: 'native'
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}
/** Captured model and dispatch generation for prompt, tools, and the call. */
export interface PreparedLlmModel {
  readonly model: LlmResolvedModelInfo
  listModels(): Promise<LlmModelInfo[]>
  resolveModelInfo(model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
  withModel(model: string, signal?: AbortSignal): Promise<PreparedLlmModel>
  prepareCall(config: LlmCallConfig): PreparedLlmCall
}

declare module '@deepseek-ai/dsh-llm' {
  interface LlmCallConfig { codexfulResponses?: CodexyResponsesConfig }
}

export { BlockAssembler } from './block-assembler.ts'

const productRequests = new WeakSet<GenerateOptions>()
/** Mark one frozen loop request without changing its model-visible fields. */
export function markAgentLoopRequest<T extends GenerateOptions>(request: T): T {
  productRequests.add(request)
  return request
}
/** Whether a request was assembled from a logged Codexy session. */
export function isAgentLoopRequest(request: GenerateOptions): boolean { return productRequests.has(request) }

import { createToolResultMessage as createPlatformToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { ToolResultMessageInput, ToolResultMessage } from '@deepseek-ai/dsh-llm'
/** Preserve native output identity using the original immutable message constructor. */
export function createToolResultMessage(input: ToolResultMessageInput & { toolKind?: 'function' | 'freeform'; name?: string }): ToolResultMessage {
  const message = createPlatformToolResultMessage(input)
  if (input.toolKind === undefined && input.name === undefined) return message
  return Object.freeze({ ...message, source: Object.freeze({ ...message.source,
    ...input.toolKind === undefined ? {} : { toolKind: input.toolKind },
    ...input.name === undefined ? {} : { name: input.name },
  }) })
}

/** Adapter-owned generation shared by model lookup and provider dispatch. */
export interface PreparedAdapterCall {
  readonly model: LlmResolvedModelInfo
  readonly developerHistory?: 'native'
  listModels?(): Promise<readonly LlmModelInfo[]>
  resolveModel?(model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
  withModel?(model: string, signal?: AbortSignal): Promise<PreparedAdapterCall>
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

import type { CodexyRequestPort } from './ports.ts'
declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Wrap a captured native request without changing its immutable model input.
     * @param options - frozen native request, including freeform tool declarations.
     * @param next - continue dispatch through the captured provider generation.
     * @mode waterfall
     */
    'codexy-llm/stream'(this: CodexyRequestPort, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>
  }
}
