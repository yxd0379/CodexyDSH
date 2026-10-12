/** Product prompt preparation with the original DSH prompt registry. */
export * from '@deepseek-ai/dsh-system-prompt'
export { default } from '@deepseek-ai/dsh-system-prompt'
import type { AssembleContext as PlatformAssembleContext, PromptAssembly as PlatformPromptAssembly, AssembledContext as PlatformAssembledContext, PromptContext as PlatformPromptContext, PromptSection as PlatformPromptSection } from '@deepseek-ai/dsh-system-prompt'
import type { PreparedLlmModel, ToolSchema } from './llm.ts'
import type { ToolRequestCapture } from './tools.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TOOL_REQUEST_CAPTURE } from './tools.ts'

export interface PromptPreparation { readonly variables: Readonly<Record<string, string | undefined>> }
export interface AssembleContext extends PlatformAssembleContext {
  /** Agent whose durable state supplies dynamic product context. */
  readonly agent?: Agent
  preparedModel?: PreparedLlmModel
  readonly promptPreparation?: PromptPreparation
  [TOOL_REQUEST_CAPTURE]?: ToolRequestCapture
}
export interface PromptContext extends Omit<PlatformPromptContext, 'text'> {
  readonly text: string | ((context: AssembleContext) => string | Promise<string>)
  role?: 'user' | 'developer'
}
/** Ordered instructions evaluated with the captured product request context. */
export interface PromptSection extends Omit<PlatformPromptSection, 'text'> {
  readonly text: string | ((context: AssembleContext) => string)
  readonly complete?: boolean
}
export interface ToolProviderResult {
  readonly schemas: readonly ToolSchema[]
  readonly knownNames?: readonly string[]
  /** Captured implementations callable through a composite tool rather than directly by the model. */
  readonly nestedSchemas?: readonly ToolSchema[]
}
export interface AssembledContext extends PlatformAssembledContext { role?: 'user' | 'developer' }
export interface PromptAssembly extends Omit<PlatformPromptAssembly, 'tools' | 'contexts'> {
  tools: ToolSchema[]
  nestedTools?: ToolSchema[]
  contexts: AssembledContext[]
  contextSnapshotIntro?: 'dsh' | 'none'
}

import { renderPrompt as renderPlatformPrompt, renderContextSections as renderPlatformContextSections, joinContextSections as joinPlatformContextSections } from '@deepseek-ai/dsh-system-prompt'
import type { ContextSnapshotSection } from '@deepseek-ai/dsh-llm'
function platformAssembly(assembly: PromptAssembly): PlatformPromptAssembly {
  return { sections: assembly.sections, contexts: assembly.contexts, tools: [], variables: assembly.variables }
}
/** Render instructions through the original interpolation implementation. */
export function renderPrompt(assembly: PromptAssembly): string { return renderPlatformPrompt(platformAssembly(assembly)) }
/** Select the declared role before applying original variable interpolation. */
export function renderContextSections(assembly: PromptAssembly, role: 'user' | 'developer' = 'user'): ContextSnapshotSection[] {
  return renderPlatformContextSections(platformAssembly({ ...assembly, contexts: assembly.contexts.filter(context => (context.role ?? 'user') === role) }))
}
/** A product preset can own framing for contexts already recorded in the session. */
export function joinContextSections(sections: readonly ContextSnapshotSection[], intro?: 'dsh' | 'none'): string {
  return intro === 'none' ? sections.map(section => section.text).join('\n\n') : joinPlatformContextSections(sections)
}

/** Render user-role context with product framing; developer sections retain their own messages. */
export function renderContextSnapshot(assembly: PromptAssembly): string {
  return joinContextSections(renderContextSections(assembly), assembly.contextSnapshotIntro)
}
