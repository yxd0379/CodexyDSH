/** Native request binding and scheduling port over DSH public tool execution. */
export * from '@deepseek-ai/dsh-tools'
export { default } from '@deepseek-ai/dsh-tools'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import type { ToolRuntime, ToolDefinition as PlatformToolDefinition, ToolExecutionInput as PlatformToolExecutionInput, ToolExecutionResult, ToolExecutionMode, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { AssembleContext } from './prompt.ts'
import type { ToolSchema } from './llm.ts'

/** Request captures and bindings are owned by the mounted product tool provider. */
export interface ToolRequestCapture { readonly schemas: readonly ToolSchema[] }
export interface ToolRequestBinding {
  readonly schemas: readonly ToolSchema[]
  readonly nestedSchemas: readonly ToolSchema[]
}
export const TOOL_REQUEST_CAPTURE: unique symbol = Symbol('@codexydsh/runtime.tool-request-capture')
export const TOOL_RUNTIME_SCHEDULER: unique symbol = Symbol('@codexydsh/runtime.tool-scheduler')
/** Native schemas retain their execution implementation from the original registry. */
export interface ToolSchemaRequest { readonly context: AssembleContext; readonly variables: Readonly<Record<string, string | undefined>> }
export type ToolDefinition = ToolSchema & Omit<PlatformToolDefinition, 'name' | 'description' | 'parameters'> & {
  resolveRequest?(request: ToolSchemaRequest): Promise<ToolDefinition>
  deriveRequest?(request: ToolSchemaRequest, preparedCatalog: readonly ToolSchema[]): ToolDefinition
}
/** The product binding travels with a call without altering the DSH execution protocol. */
export interface ToolExecutionInput extends Omit<PlatformToolExecutionInput, 'schema'> {
  readonly requestBinding?: ToolRequestBinding
  readonly schema?: ToolSchema
}
/** A public-execute adapter can prepare a dispatch without invoking the original internal scheduler. */
export type ScheduledToolPreparation =
  | { kind: 'dispatch'; exec: ToolRunContext }
  | { kind: 'post-result'; exec: ToolRunContext; result: ToolExecutionResult }
  | { kind: 'final-result'; exec: ToolRunContext; result: ToolExecutionResult }
export type ScheduledToolDispatch =
  | { kind: 'post-result'; result: ToolExecutionResult }
  | { kind: 'final-result'; result: ToolExecutionResult }
export interface CodexyToolScheduler {
  prepare(exec: ToolExecutionInput): Promise<ScheduledToolPreparation>
  dispatch(exec: ToolRunContext): Promise<ScheduledToolDispatch>
  finalize(exec: ToolRunContext, result: ToolExecutionResult): Promise<ToolExecutionResult>
  finish(exec: ToolRunContext, result: ToolExecutionResult): ToolExecutionResult
}
/** Private catalog preserves per-request freeform/namespace semantics. */
export interface CodexyToolPort extends Pick<ToolRuntime, 'restrict' | 'guard' | 'presentAs'> {
  register(definition: ToolDefinition): () => void
  registerNative(definition: ToolDefinition): () => void
  schemas(scope?: ScopeKey): ToolSchema[]
  ownSchemas(scope?: ScopeKey): ToolSchema[]
  get(name: string, scope?: ScopeKey): ToolDefinition | undefined
  executionMode(exec: ToolExecutionInput): ToolExecutionMode
  prepareRequest(request: { context: AssembleContext; variables: Readonly<Record<string, string | undefined>> }): Promise<ToolRequestCapture>
  bindAssembly(capture: ToolRequestCapture, direct: readonly ToolSchema[], nested?: readonly ToolSchema[]): ToolRequestBinding
  requestSchemas(binding: ToolRequestBinding): readonly ToolSchema[]
  requestToolName(binding: ToolRequestBinding, name: string, namespace?: string): string | undefined
  requestToolKind(binding: ToolRequestBinding, name: string, namespace?: string): 'function' | 'freeform' | undefined
  execute(exec: ToolExecutionInput): Promise<ToolExecutionResult>
  readonly [TOOL_RUNTIME_SCHEDULER]: CodexyToolScheduler
}

declare module '@deepseek-ai/dsh-tools' {
  interface ToolExecutionSuccess {
    /** Execution-local value exposed by a product tool to a nested program. */
    readonly codeModeValue?: import('@deepseek-ai/dsh-util-values').JsonValue
  }
  interface ToolOutputDefinition {
    codeModeResult?(args: unknown, value: import('@deepseek-ai/dsh-util-values').JsonValue, renderedContent: readonly import('@deepseek-ai/dsh-llm').ContentBlock[]): import('@deepseek-ai/dsh-util-values').JsonValue
  }
}
