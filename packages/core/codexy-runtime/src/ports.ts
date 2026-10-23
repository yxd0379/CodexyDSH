/** Product-owned request providers consumed by the independent Codexy loop. */
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, PreparedLlmCall, PreparedLlmModel } from './llm.ts'
import type { AssembleContext, PromptAssembly, PromptPreparation } from './prompt.ts'
import type { SystemPrompt, PromptSectionOrderName, PromptContextOrderName } from '@deepseek-ai/dsh-system-prompt'
import type { AdapterRegistrationHandle, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import type { NativeAdapter, ToolSchema } from './llm.ts'
import type { PromptContext, PromptSection, ToolProviderResult } from './prompt.ts'
import type { CodexyToolPort } from './tools.ts'
import type {} from './agent-api.ts'

/** Captures the provider generation before prompt and native tool selection. */
export interface CodexyRequestPort extends Pick<LlmRuntime, 'listProviders' | 'listModels' | 'resolveModelInfo' | 'resolveCallConfig' | 'registerConfigurableProviders' | 'registerModelDiscovery'> {
  registerAdapter(providers: string[], adapter: NativeAdapter): AdapterRegistrationHandle
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
  prepareModel(provider: string, model: string, signal?: AbortSignal): Promise<PreparedLlmModel>
  prepareCall(config: LlmCallConfig, signal?: AbortSignal): Promise<PreparedLlmCall>
}
/** Freezes variables before assembling model-specific instructions and schemas. */
export interface CodexyPromptPort extends Pick<SystemPrompt, 'variable'> {
  getSectionOrder(name: PromptSectionOrderName): number
  getContextOrder(name: Exclude<PromptContextOrderName, 'WORKING_DIRECTORY'>): number
  suppressRuntimeContext(): () => void
  inheritedToolSchemas(preparation: PromptPreparation): readonly ToolSchema[]
  preparedWorkingDirectory(preparation: PromptPreparation): string | undefined
  section(section: PromptSection, scope?: ScopeKey): () => void
  context(context: PromptContext, scope?: ScopeKey): () => void
  tools(provider: (context: AssembleContext) => readonly ToolSchema[] | ToolProviderResult, scope?: ScopeKey): () => void
  prepare(context: AssembleContext): Promise<PromptPreparation>
  assemble(context: AssembleContext, preparation: PromptPreparation): Promise<PromptAssembly>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    codexyRequests: CodexyRequestPort
    codexyPrompt: CodexyPromptPort
    codexyTools: CodexyToolPort
  }
}
