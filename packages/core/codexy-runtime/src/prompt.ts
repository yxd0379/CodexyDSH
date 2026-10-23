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

import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { CodexyPromptPort } from './ports.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Resolve the variables shared by tool preparation and prompt assembly.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): scoped listeners
     * receive only that scope's preparation requests. Call
     * next() to preserve the captured variable-provider values.
     * @param variables - frozen values from the scoped variable providers.
     * @param context - frozen per-preparation context wrapper.
     * @mode waterfall
     */
    'codexy-prompt/prepare'(this: Scoped<CodexyPromptPort>, variables: Readonly<Record<string, string | undefined>>, context: AssembleContext, next: () => Promise<Readonly<Record<string, string | undefined>>>): Promise<Readonly<Record<string, string | undefined>>>
    /**
     * Expert waterfall over the assembled sections, contexts, tools, and variables.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): scoped listeners
     * receive only that scope's assemblies. The returned value is authoritative.
     * A supplied signal controls only this explicit assembly request and must not
     * be retained to control later turns. A registered complete section is
     * restored after this waterfall, so listeners cannot add to or replace
     * that scope's system prompt.
     * @param assembly - the mutable assembly built from registered providers.
     * @param context - frozen assembly wrapper retaining the prepared caller fields.
     * @mode waterfall
     */
    'codexy-prompt/assemble'(this: Scoped<CodexyPromptPort>, assembly: PromptAssembly, context: AssembleContext, next: () => Promise<PromptAssembly>): Promise<PromptAssembly>
    /**
     * Observe successful assembly after all transformations and cancellation checks.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): scoped listeners
     * receive only their scope's final returned assembly.
     * Observer failures are contained; this notification cannot reject assembly.
     * @param assembly - final assembly after complete-section and runtime-context enforcement.
     * @param context - captured caller context with the service-validated preparation token.
     * @mode emit
     */
    'codexy-prompt/assembled'(this: Scoped<CodexyPromptPort>, assembly: PromptAssembly, context: AssembleContext): void
    /**
     * Emitted when any prompt provider changes. This registry notification is
     * unfiltered because a global change affects every scope.
     * @mode emit
     */
    'codexy-prompt/change'(): void
  }
}
