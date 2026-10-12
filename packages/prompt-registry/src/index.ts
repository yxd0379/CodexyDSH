/**
 * Registry for ordered system sections, dynamic context, tool schemas, and prompt variables.
 *
 * @module @codexydsh/prompt-registry
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { isAbsolute } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { AnonymousEntries, NamedEntries, ScopedLayers, scopeTarget } from '@deepseek-ai/dsh-scope'
import type { ScopeKey, ScopeLayer, Scoped } from '@deepseek-ai/dsh-scope'
import type { ContextSnapshotSection, PreparedLlmModel, ToolSchema } from '@codexydsh/runtime/llm'
import type { Session } from '@codexydsh/runtime/session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@codexydsh/runtime/ports'

declare module '@deepseek-ai/cordis' {
  interface Context {
  }

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
    'codexy-prompt/prepare'(this: Scoped<SystemPrompt>, variables: Readonly<Record<string, string | undefined>>, context: AssembleContext, next: () => Promise<Readonly<Record<string, string | undefined>>>): Promise<Readonly<Record<string, string | undefined>>>
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
    'codexy-prompt/assemble'(this: Scoped<SystemPrompt>, assembly: PromptAssembly, context: AssembleContext, next: () => Promise<PromptAssembly>): Promise<PromptAssembly>
    /**
     * Observe successful assembly after all transformations and cancellation checks.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): scoped listeners
     * receive only their scope's final returned assembly.
     * Observer failures are contained; this notification cannot reject assembly.
     * @param assembly - final assembly after complete-section and runtime-context enforcement.
     * @param context - captured caller context with the service-validated preparation token.
     * @mode emit
     */
    'codexy-prompt/assembled'(this: Scoped<SystemPrompt>, assembly: PromptAssembly, context: AssembleContext): void
    /**
     * Emitted when any prompt provider changes. This registry notification is
     * unfiltered because a global change affects every scope.
     * @mode emit
     */
    'codexy-prompt/change'(): void
  }
}

/** Merge-extensible context for one prompt assembly. */
export interface AssembleContext {
  /** Agent whose durable state supplies dynamic product context. */
  agent?: import('@deepseek-ai/dsh-agent').Agent
  /**
   * Scope whose providers and waterfall listeners participate. When absent,
   * only global providers and subject-less listeners participate.
   */
  scope?: ScopeKey
  /** Explicit control signal for the turn that requested this assembly, when any. */
  signal?: AbortSignal
  /** Model capabilities and dispatch generation captured before tool and prompt providers run. */
  preparedModel?: PreparedLlmModel
  /** Service-validated token supplied to assembly providers and listeners; absent during preparation. */
  readonly promptPreparation?: PromptPreparation
}

/** Opaque, service-owned variable snapshot shared by one request's preparation and assembly. */
export interface PromptPreparation {
  /** Detached frozen variables selected before asynchronous tool preparation. */
  readonly variables: Readonly<Record<string, string | undefined>>
}

/** Captured caller context; scoped identities retain their original references. */
interface PromptPreparationState {
  readonly context: Readonly<AssembleContext>
  readonly inherited: import('@deepseek-ai/dsh-system-prompt').PromptAssembly
  readonly workingDirectory: string | undefined
}

/** Optional public service contract, without adding a required platform peer. */
interface PublicWorkingDirectory {
  get(session: Session): unknown
}

/** Snapshot the effective directory after the stock assembly has performed its own ensure. */
function captureWorkingDirectory(ctx: Context, context: Readonly<AssembleContext>): string | undefined {
  if (context.agent === undefined) return undefined
  const service: unknown = ctx.get('workingDirectory')
  if (typeof service !== 'object' || service === null
    || typeof Reflect.get(service, 'get') !== 'function') return undefined
  const cwd = (service as PublicWorkingDirectory).get(context.agent.session)
  return typeof cwd === 'string' && isAbsolute(cwd) ? cwd : undefined
}

/**
 * Derive preparation-local metadata from the final frozen variable set.
 * Existing string variables and private symbols must retain their values.
 * @param variables - final waterfall values, shared unchanged by all finalizers.
 * @returns additional string variables and private symbol metadata; duplicate values must agree.
 */
export type PromptPreparationFinalizer = (
  variables: Readonly<Record<string, string | undefined>>,
) => Readonly<Record<string, string | undefined>>

const preparationFinalizers = Symbol('prompt preparation finalizers')

type FinalizablePreparationVariables = Readonly<Record<string, string | undefined>> & {
  readonly [preparationFinalizers]?: readonly PromptPreparationFinalizer[]
}

/**
 * Attach a synchronous derivation captured during the preparation waterfall.
 * Finalizers run once after all selectors settle and cancellation passes, using
 * the same frozen values. Their private callback list is removed from the token.
 * @param variables - contribution values whose existing private metadata is retained.
 * @param finalize - pure derivation using captured settings and the final variables.
 * @returns copied variables carrying this finalizer after previously attached finalizers.
 */
export function withPromptPreparationFinalizer(
  variables: Readonly<Record<string, string | undefined>>,
  finalize: PromptPreparationFinalizer,
): FinalizablePreparationVariables {
  const previous: FinalizablePreparationVariables = variables
  return { ...variables, [preparationFinalizers]: Object.freeze([...(previous[preparationFinalizers] ?? []), finalize]) }
}

/** One contributed section of the system prompt (registry input). */
export interface PromptSection {
  /** Unique name — a duplicate registration throws (see {@link SystemPrompt.section}). */
  readonly name: string
  /**
   * Sections are concatenated in ascending order. Equal orders use code-unit
   * name order.
   */
  readonly order: number
  /**
   * Static text or a provider evaluated at each assembly with that assembly's
   * {@link AssembleContext}. The text may reference `{{variable}}`s — they are
   * interpolated later, by {@link renderPrompt}, unless `interpolate` is false.
   */
  readonly text: string | ((context: AssembleContext) => string)
  /** Whether to interpolate prompt variables. Defaults to true; false preserves literal text. */
  readonly interpolate?: boolean
  /**
   * Treat this contribution as the complete system prompt. Assembly still
   * runs the cooperative waterfall so tools, contexts, and variables can be
   * resolved, then restores this exact section as the sole prompt section.
   * More than one effective complete section makes assembly fail.
   */
  readonly complete?: boolean
}

/** Dynamic model context materialized in its declared conversation role. */
export interface PromptContext {
  /** Unique name — a duplicate registration throws (see {@link SystemPrompt.context}). */
  readonly name: string
  /** Contexts are joined in ascending order. */
  readonly order: number
  /** Static text or a provider evaluated for each assembly. Empty text contributes nothing. */
  readonly text: string | ((context: AssembleContext) => string)
  /** The durable message role; omitted contexts use the user-role snapshot. */
  readonly role?: 'user' | 'developer'
  /** Whether to interpolate prompt variables. Defaults to true; false preserves literal text. */
  readonly interpolate?: boolean
}

/** One section of an assembly: {@link PromptSection} with its text resolved. */
export interface AssembledSection {
  /** The contributing section's unique name. */
  name: string
  /** The resolved (but not yet interpolated) section text. */
  text: string
  /** Whether to interpolate prompt variables. Defaults to true; false preserves literal text. */
  interpolate?: boolean
}

/** One resolved dynamic context contribution. */
export interface AssembledContext {
  /** The contributing context's unique name. */
  name: string
  /** The resolved text before variable interpolation. */
  text: string
  /** The durable message role; omitted contexts use the user-role snapshot. */
  role?: 'user' | 'developer'
  /** Whether to interpolate prompt variables. Defaults to true; false preserves literal text. */
  interpolate?: boolean
}

/** Tool schemas visible in one assembly and their pre-restriction name set. */
export interface ToolProviderResult {
  /** The schemas this provider contributes to THIS assembly. */
  readonly schemas: readonly ToolSchema[]
  /** The pre-restriction name universe for config validation (defaults to `schemas`' names). */
  readonly knownNames?: readonly string[]
  /** Captured implementations exposed through a composite tool's SDK. */
  readonly nestedSchemas?: readonly ToolSchema[]
}

/**
 * Merge-extensible assembled model input. Sections and contexts remain
 * uninterpolated until rendered; tools are already in canonical order.
 */
export interface PromptAssembly {
  sections: AssembledSection[]
  contexts: AssembledContext[]
  tools: ToolSchema[]
  /** Explicitly selected inner schemas for composite execution; absent means no nested tools. */
  nestedTools?: ToolSchema[]
  variables: Record<string, string | undefined>
  /** Omit DSH's replacement notice when a preset owns the model-visible context framing. */
  contextSnapshotIntro?: 'dsh' | 'none'
}

const SECTION_ORDERS = {
  HARNESS_IDENTITY: -1000,
  DEPLOYMENT_PERSONA_PREFIX: 0,
  PLAN_POLICY: 500,
  TEAM_POLICY: 600,
  PTC_ONLY: 800,
  FILE_REFERENCE: 900,
  TOOL_BASH: 1000,
  TOOL_PWSH: 1010,
  TOOL_READ: 1100,
  TOOL_WRITE: 1200,
  TOOL_EDIT: 1300,
  TOOL_GLOB: 1400,
  TOOL_GREP: 1500,
  TOOL_JOBS: 1600,
  TOOL_PTY: 1700,
  TOOL_WEB_SEARCH: 2000,
  TOOL_WEB_FETCH: 2100,
  TOOL_LSP: 2200,
  TOOL_SESSION_QUERY: 2300,
  TOOL_GOAL: 2400,
  TOOL_WORKFLOW: 2600,
  TOOL_RALPH: 2700,
  TOOL_SUBAGENT: 2800,
  TOOL_REPORT: 2900,
  TOOL_COMPUTER_USE: 3000,
  MCP_SERVERS: 3100,
  TOOLS_SDK: 5000,
  DELIVERABLE_FILE_REFERENCES: 9000,
  STRUCTURED_OUTPUT: 9900,
  // Local paths and endpoints follow reusable instructions.
  HARNESS_SOURCE: 10000,
  WEB_SURFACE: 10100,
  DEPLOYMENT_PERSONA_SUFFIX: 10200,
} as const

/** Name of a centrally allocated prompt-section position. */
export type PromptSectionOrderName = keyof typeof SECTION_ORDERS

const CONTEXT_ORDERS = {
  SANDBOX_POLICY: 110,
  APPROVAL_POLICY: 115,
  SUBAGENT_DELEGATION: 120,
} as const

/** Name of a centrally allocated runtime-context position. */
export type PromptContextOrderName = keyof typeof CONTEXT_ORDERS

/**
 * The deployment persona prefix's section name. Exported because a
 * composition can replace this slot — an agent preset shadows the
 * deployment's persona with its own — and both sides naming the same section
 * is what makes the replacement work rather than duplicate.
 */
export const PERSONA_PREFIX_SECTION = 'deployment:persona-prefix'

/** Deployment persona suffix section name shared by global and scoped contributions. */
export const PERSONA_SUFFIX_SECTION = 'deployment:persona-suffix'

/** Valid variable names: how they are written between the braces. */
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/

/** A complete `{{...}}` reference group at the scan position (validated after). */
const GROUP_AT = /^\{\{([^{}]*)\}\}/

/** Reserved {@link Config.toolOrder} marker for unlisted tools. */
export const TOOL_ORDER_REST = '<unlisted-tools>'

/**
 * Validate duplicate names and the required {@link TOOL_ORDER_REST} marker.
 * Registered names are checked later because plugins have not loaded yet.
 */
function validateToolOrder(toolOrder: string[] | undefined): string[] | undefined {
  if (toolOrder === undefined) return undefined
  const seen = new Set<string>()
  for (const name of toolOrder) {
    if (seen.has(name)) throw new Error(`toolOrder lists "${name}" more than once`)
    seen.add(name)
  }
  if (!seen.has(TOOL_ORDER_REST)) {
    throw new Error(`toolOrder must contain the "${TOOL_ORDER_REST}" rest entry (where unlisted tools are inserted)`)
  }
  return toolOrder
}

/**
 * Apply configured tool order, inserting unlisted tools lexicographically at
 * {@link TOOL_ORDER_REST}. Unknown configured names fail; known but restricted
 * names may be absent.
 */
function orderTools(tools: ToolSchema[], toolOrder: string[] | undefined, knownNames: ReadonlySet<string>): ToolSchema[] {
  const reserved = tools.find(tool => tool.name === TOOL_ORDER_REST)
  if (reserved !== undefined) {
    throw new Error(`tool provider returned reserved tool name "${TOOL_ORDER_REST}" (reserved for toolOrder's rest entry)`)
  }
  if (toolOrder === undefined) return tools.sort(compareToolNames)
  const unknown = toolOrder.filter(name => name !== TOOL_ORDER_REST && !knownNames.has(name))
  if (unknown.length > 0) {
    throw new Error(`toolOrder lists unregistered tool${unknown.length > 1 ? 's' : ''} ${unknown.map(name => `"${name}"`).join(', ')}; known tools: ${[...knownNames].sort().join(', ') || '(none)'}`)
  }
  const listed = new Set(toolOrder)
  const rest = tools.filter(tool => !listed.has(tool.name)).sort(compareToolNames)
  return toolOrder.flatMap(name =>
    name === TOOL_ORDER_REST ? rest : tools.filter(tool => tool.name === name))
}

/** Code-unit name comparison — locale-independent, so the order is identical on every machine. */
function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Order prompt sections by their explicit placement, then deterministically by name. */
function comparePromptSections(a: PromptSection, b: PromptSection): number {
  return a.order - b.order || compareNames(a.name, b.name)
}

/** Order tool schemas lexicographically by name. */
function compareToolNames(a: ToolSchema, b: ToolSchema): number {
  return compareNames(a.name, b.name)
}

/** Plugin config: the deployment-authored fragment of the system prompt (see {@link Config.personaPrefix} for its contract). */
export interface Config {
  /** Include the fixed DeepSeek Harness identity before the deployment persona (default true). */
  includeHarnessIdentity?: boolean
  /** Include dynamic runtime-context snapshots in model history (default true). */
  includeRuntimeContext?: boolean
  /**
   * Deployment-wide persona prefix template before first-party guidance. A scoped section named
   * `deployment:persona-prefix` shadows it; `{{variable}}` references are strict.
   */
  personaPrefix?: string
  /**
   * Persona suffix template after first-party guidance. A scoped `deployment:persona-suffix`
   * section shadows it; `{{variable}}` references are strict. Defaults to empty.
   */
  personaSuffix?: string
  /**
   * Model-facing tool names in order, with {@link TOOL_ORDER_REST} exactly once.
   * Invalid fields fail at load and unknown names fail at assembly; known names
   * hidden in one scope may be absent there. Omitted means lexicographic order.
   */
  toolOrder?: string[]
}

/**
 * Interpolate strict `{{variable}}` references, drop empty sections, and join
 * the rest with blank lines. Sections with `interpolate: false` retain literal
 * text. Malformed, unknown, or undefined references in other sections throw;
 * a lone `{{` without any later `}}` is literal prose, and substituted values
 * are not scanned again.
 * @param assembly - the assembly whose sections and variables to render.
 * @returns the rendered prompt, or `''` when all sections are empty.
 */
export function renderPrompt(assembly: PromptAssembly): string {
  return assembly.sections
    .map(section => section.interpolate === false ? section.text : interpolate(section, assembly.variables, 'section'))
    .filter(text => text.length > 0)
    .join('\n\n')
}

/**
 * Render the complete dynamic context snapshot.
 * @param assembly - the assembly whose contexts and variables to render.
 * @returns the current full snapshot, or `''` when no context is active.
 */
export function renderContextSnapshot(assembly: PromptAssembly): string {
  return joinContextSections(renderContextSections(assembly), assembly.contextSnapshotIntro)
}

/**
 * The model-facing snapshot text for an already-rendered section list.
 *
 * A caller that also needs the sections renders them once and joins here, so a
 * request does not interpolate every context twice.
 * @param sections - sections from {@link renderContextSections}.
 * @param introduction - whether to prepend DSH's replacement notice.
 * @returns the current full snapshot, or `''` when no context is active.
 */
export function joinContextSections(
  sections: readonly ContextSnapshotSection[],
  introduction: PromptAssembly['contextSnapshotIntro'] = 'dsh',
): string {
  const body = sections.map(section => section.text).join('\n\n')
  if (body.length === 0) return ''
  return introduction === 'none'
    ? body
    : `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${body}`
}

/**
 * Render named context contributions for one durable message role.
 *
 * {@link renderContextSnapshot} joins these for the model; a consumer that
 * presents the snapshot uses them to attribute each part to the subsystem that
 * contributed it, without re-splitting the joined prose.
 * @param assembly - the assembly whose contexts and variables to render.
 * @param role - the message role to render; omitted selects user contexts.
 * @returns one entry per contributing context that rendered to non-empty text.
 */
export function renderContextSections(
  assembly: PromptAssembly,
  role: 'user' | 'developer' = 'user',
): ContextSnapshotSection[] {
  return assembly.contexts
    .filter(context => (context.role ?? 'user') === role)
    .map(context => ({ name: context.name, text: context.interpolate === false ? context.text : interpolate(context, assembly.variables, 'context') }))
    .filter(section => section.text.length > 0)
}

/** Interpolate one section or context and attribute diagnostics to its owning input. */
function interpolate(
  input: AssembledSection | AssembledContext,
  variables: Record<string, string | undefined>,
  kind: 'section' | 'context',
): string {
  const text = input.text
  let result = ''
  let last = 0
  for (let open = text.indexOf('{{'); open >= 0; open = text.indexOf('{{', last)) {
    const group = GROUP_AT.exec(text.slice(open))
    if (group === null) {
      // A later closing brace makes this malformed; otherwise it is literal prose.
      if (text.indexOf('}}', open + 2) >= 0) {
        throw new Error(`malformed prompt variable reference at "${text.slice(open, open + 16)}…" in ${kind} "${input.name}" (references are complete simple {{name}} groups)`)
      }
      result += text.slice(last, open + 2)
      last = open + 2
      continue
    }
    // `{{}}` yields an empty name and follows the malformed-reference path.
    const name = group[0].slice(2, -2)
    if (!VARIABLE_NAME.test(name)) {
      throw new Error(`malformed prompt variable reference "{{${name}}}" in ${kind} "${input.name}" (variable names match ${String(VARIABLE_NAME)})`)
    }
    // Do not resolve unregistered names through Object.prototype.
    if (!Object.hasOwn(variables, name)) {
      const known = Object.keys(variables)
      throw new Error(`unknown prompt variable "{{${name}}}" in ${kind} "${input.name}"; registered variables: ${known.length > 0 ? known.join(', ') : '(none)'}`)
    }
    const value = variables[name]
    if (value === undefined) {
      throw new Error(`prompt variable "{{${name}}}" has no value for this assembly (${kind} "${input.name}")`)
    }
    result += text.slice(last, open) + value
    last = open + group[0].length
  }
  return result + text.slice(last)
}

/** One tool-schema provider stored in a prompt layer. */
type ToolProvider = (context: AssembleContext) => ToolProviderResult

/** One prompt-variable provider stored in a prompt layer. */
type VariableProvider = (context: AssembleContext) => string | undefined

/** All prompt registrations owned by one global or scoped layer. */
class PromptLayer implements ScopeLayer {
  readonly sections: NamedEntries<PromptSection>
  readonly contexts: NamedEntries<PromptContext>
  readonly runtimeContextSuppressors = new AnonymousEntries<true>()
  readonly toolProviders = new AnonymousEntries<ToolProvider>()
  readonly variables: NamedEntries<VariableProvider>

  /**
   * Create one prompt layer with diagnostics specific to its ownership scope.
   * @param scope - the scoped owner, or `undefined` for global registrations.
   */
  constructor(scope: ScopeKey | undefined) {
    this.sections = new NamedEntries(name => new Error(scope === undefined
      ? `prompt section "${name}" is already registered (for a per-agent override, register through that agent's \`agent.ctx\` instead)`
      : `prompt section "${name}" is already registered in this scope`))
    this.contexts = new NamedEntries(name => new Error(scope === undefined
      ? `prompt context "${name}" is already registered (for a per-agent override, register through that agent's \`agent.ctx\` instead)`
      : `prompt context "${name}" is already registered in this scope`))
    this.variables = new NamedEntries(name => new Error(scope === undefined
      ? `prompt variable "${name}" is already registered (for a per-agent value, register through that agent's \`agent.ctx\` instead)`
      : `prompt variable "${name}" is already registered in this scope`))
  }

  /** @returns whether this layer owns no prompt registrations. */
  isEmpty(): boolean {
    return this.sections.isEmpty()
      && this.contexts.isEmpty()
      && this.runtimeContextSuppressors.isEmpty()
      && this.toolProviders.isEmpty()
      && this.variables.isEmpty()
  }
}

/** Registry service for the prompt inputs assembled before each model step. */
export class SystemPrompt extends Service {
  static inject = ['systemPrompt']
  static Config: z<Config> = z.object({
    includeHarnessIdentity: z.boolean().default(true),
    includeRuntimeContext: z.boolean().default(true),
    personaPrefix: z.string().default(''),
    personaSuffix: z.string().default(''),
    // Preserve omission because an explicit empty order lacks the rest marker.
    toolOrder: z.array(z.string()).default(undefined as unknown as string[]),
  })

  private readonly layers = new ScopedLayers(
    scope => new PromptLayer(scope),
    () => { this.ctx.emit('codexy-prompt/change') },
  )
  private readonly toolOrder: string[] | undefined
  private readonly preparations = new WeakMap<PromptPreparation, PromptPreparationState>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'codexyPrompt')
    this.toolOrder = validateToolOrder(config.toolOrder)
    // Keep harness-owned openers independent of the selected loop plugin.
    if (config.includeHarnessIdentity ?? true) {
      this.section({
        name: 'harness:identity',
        order: this.getSectionOrder('HARNESS_IDENTITY'),
        text: 'You are an AI agent powered by DeepSeek Harness.',
      })
    }
    this.section({
      name: PERSONA_PREFIX_SECTION,
      order: this.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
      // The fallback narrows the optional input type; the schema already defaults it.
      text: config.personaPrefix ?? '',
    })
    this.section({
      name: PERSONA_SUFFIX_SECTION,
      order: this.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
      text: config.personaSuffix ?? '',
    })
    if (!(config.includeRuntimeContext ?? true)) this.suppressRuntimeContext()
  }

  /**
   * Register an ordered prompt section in the calling context's scope. A scoped
   * section shadows a global section with the same name; duplicates within one
   * layer and non-finite orders throw. Registration and disposal emit
   * `codexy-prompt/change`.
   * @param section - the section to register.
   * @returns the exact Cordis effect disposer.
   */
  section(section: PromptSection): () => void {
    if (!Number.isFinite(section.order)) {
      throw new TypeError(`prompt section "${section.name}" order must be a finite number`)
    }
    return this.layers.effect(
      this.ctx,
      layer => layer.sections.insert(section.name, section),
      { label: 'systemPrompt.section()' },
    )
  }

  /**
   * Resolve the centrally owned placement of a repository prompt section.
   * @param name - stable section placement name.
   * @returns the section's numeric sort order.
   */
  getSectionOrder(name: PromptSectionOrderName): number {
    return SECTION_ORDERS[name]
  }

  /**
   * Resolve the centrally owned placement of a repository runtime context.
   * @param name - stable context placement name.
   * @returns the context's numeric sort order.
   */
  getContextOrder(name: PromptContextOrderName): number {
    return CONTEXT_ORDERS[name]
  }

  /**
   * Register ordered dynamic context in the calling context's scope. Scoped
   * entries shadow global entries with the same name.
   * @param context - the context contribution to register.
   * @returns the exact Cordis effect disposer.
   */
  context(context: PromptContext): () => void {
    if (!Number.isFinite(context.order)) {
      throw new TypeError(`prompt context "${context.name}" order must be a finite number`)
    }
    return this.layers.effect(
      this.ctx,
      layer => layer.contexts.insert(context.name, context),
      { label: 'systemPrompt.context()' },
    )
  }

  /**
   * Suppress every dynamic runtime-context contribution in the calling
   * context's scope without changing the services that own or enforce those
   * facts. Multiple suppressors remain independently disposable.
   * @returns the exact Cordis effect disposer.
   */
  suppressRuntimeContext(): () => void {
    return this.layers.effect(
      this.ctx,
      layer => layer.runtimeContextSuppressors.append(true),
      { label: 'systemPrompt.suppressRuntimeContext()' },
    )
  }

  /**
   * Register a tool-schema provider in the calling context's scope. Global and
   * matching scoped providers both contribute; returning the reserved
   * {@link TOOL_ORDER_REST} name makes assembly fail.
   * @param provider - evaluated for each assembly with its context.
   * @returns the exact Cordis effect disposer.
   */
  tools(provider: (context: AssembleContext) => ToolProviderResult | readonly ToolSchema[]): () => void {
    return this.layers.effect(
      this.ctx,
      layer => layer.toolProviders.append(context => {
        const result = provider(context)
        return 'schemas' in result ? result : { schemas: result }
      }),
      { label: 'systemPrompt.tools()' },
    )
  }

  /**
   * Register a prompt variable in the calling context's scope. Scoped values
   * shadow globals; invalid or duplicate names throw. A provider may return
   * `undefined`, but rendering a section that references that value then fails.
   * @param name - the `[a-z][a-z0-9_]*` reference name.
   * @param provider - evaluated once for each prompt preparation.
   * @returns the exact Cordis effect disposer.
   */
  variable(name: string, provider: (context: AssembleContext) => string | undefined): () => void {
    if (!VARIABLE_NAME.test(name)) {
      throw new Error(`invalid prompt variable name "${name}" (must match ${String(VARIABLE_NAME)})`)
    }
    return this.layers.effect(
      this.ctx,
      layer => layer.variables.insert(name, provider),
      { label: 'systemPrompt.variable()' },
    )
  }

  /**
   * Read the effective directory captured with the stock prompt for this request.
   * Changes during later asynchronous preparation apply to the next preparation;
   * they do not replace this request's frozen environment facts.
   * @param preparation - token returned by this registry.
   * @returns captured public cwd, or undefined when the optional service is unavailable.
   */
  preparedWorkingDirectory(preparation: PromptPreparation): string | undefined {
    const captured = this.preparations.get(preparation)
    if (captured === undefined) throw new Error('prompt preparation belongs to another service')
    return captured.workingDirectory
  }

  /**
   * Snapshot variable providers and resolve one immutable variable set.
   * The returned token belongs to this service and the captured scope. Its
   * context wrapper is frozen without copying scoped identities or signals.
   * @param context - scope and plugin-defined fields for this preparation.
   * @returns opaque frozen variables reusable by asynchronous tool preparation and assembly.
   */
  async prepare(context: AssembleContext = {}): Promise<PromptPreparation> {
    const { promptPreparation: _previousPreparation, ...preparationContext } = context
    const capturedContext = Object.freeze(preparationContext)
    capturedContext.signal?.throwIfAborted()
    const scopeLayers = this.layers.chainLayers(capturedContext.scope)
    const providers = [
      ...this.layers.global.variables.entries(),
      ...scopeLayers.flatMap(layer => [...layer.variables.entries()]),
    ]
    const variables: Record<string, string | undefined> = {}
    for (const [name, provider] of providers) variables[name] = provider(capturedContext)
    const capturedVariables = Object.freeze(variables)
    const inherited = await this.ctx.systemPrompt.assemble(capturedContext)
    const workingDirectory = captureWorkingDirectory(this.ctx, capturedContext)
    const initial = Object.freeze({ ...inherited.variables, ...capturedVariables })
    const resolved = await this.ctx.waterfall(
      scopeTarget(this, capturedContext.scope), 'codexy-prompt/prepare', initial, capturedContext,
      () => Promise.resolve(initial),
    )
    capturedContext.signal?.throwIfAborted()
    const finalVariables: FinalizablePreparationVariables = Object.freeze({ ...resolved })
    const composed = { ...finalVariables }
    for (const finalize of finalVariables[preparationFinalizers] ?? []) {
      const additions = finalize(finalVariables)
      for (const key of Reflect.ownKeys(additions)) {
        if (key === preparationFinalizers || !Object.prototype.propertyIsEnumerable.call(additions, key)) continue
        if (Object.hasOwn(composed, key) && Reflect.get(composed, key) !== Reflect.get(additions, key)) {
          throw new Error(`prompt preparation finalizer cannot replace ${String(key)}`)
        }
      }
      Object.assign(composed, additions)
    }
    const { [preparationFinalizers]: _finalizers, ...capturedValues } = composed
    const preparation = Object.freeze({ variables: Object.freeze(capturedValues) }) as PromptPreparation
    this.preparations.set(preparation, { context: capturedContext, inherited, workingDirectory })
    return preparation
  }

  /**
   * Read the public platform's direct tool presentation captured for this preparation.
   * @param preparation - token returned by this registry.
   * @returns detached schemas after platform presentation and scope restrictions.
   */
  inheritedToolSchemas(preparation: PromptPreparation): readonly ToolSchema[] {
    const captured = this.preparations.get(preparation)
    if (captured === undefined) throw new Error('prompt preparation belongs to another service')
    return structuredClone(captured.inherited.tools)
  }

  /**
   * Assemble global and scoped providers with prepared variables, detach tool
   * parameters, apply canonical ordering, then run the assembly waterfall.
   * Scoped sections and variables shadow globals. The returned value is authoritative
   * except that an effective complete section is restored afterwards as the
   * sole prompt section.
   * @param context - the optional scope and plugin-defined assembly fields.
   * @param preparation - token from this service and scope; omission prepares variables once.
   * @returns the post-waterfall assembly with any complete prompt enforced.
   */
  // Keep configuration failures on the declared asynchronous error path.
  async assemble(context: AssembleContext = {}, preparation?: PromptPreparation): Promise<PromptAssembly> {
    const prepared = preparation ?? await this.prepare(context)
    const captured = this.preparations.get(prepared)
    if (captured === undefined) throw new Error('prompt preparation belongs to another service')
    if (captured.context.scope !== context.scope) throw new Error('prompt preparation belongs to another scope')
    context = Object.freeze({ ...context, ...captured.context, promptPreparation: prepared })
    context.signal?.throwIfAborted()
    const scope = context.scope
    const scopeLayers = this.layers.chainLayers(scope)
    const runtimeContextSuppressed = !this.layers.global.runtimeContextSuppressors.isEmpty()
      || scopeLayers.some(layer => !layer.runtimeContextSuppressors.isEmpty())
    // Symbols retain preparation-local metadata without becoming prompt variables.
    const variables = Object.fromEntries(Object.entries(prepared.variables))
    // Scoped sections shadow globals before the deterministic order sort.
    const sectionByName = this.layers.merge(scope, layer => layer.sections)
    const contextByName = this.layers.merge(scope, layer => layer.contexts)
    // Validate order against pre-restriction names while collecting visible schemas.
    const providers = [
      ...this.layers.global.toolProviders.values(),
      ...scopeLayers.flatMap(layer => [...layer.toolProviders.values()]),
    ]
    const collected: ToolSchema[] = []
    const nested: ToolSchema[] = []
    const knownNames = new Set<string>()
    for (const provider of providers) {
      const result = provider(context)
      nested.push(...structuredClone(result.nestedSchemas ?? []))
      const schemas = result.schemas.map((schema): ToolSchema => {
        const { name, description, deferLoading, namespace, inputSchemaMaxBytes, outputSchema } = schema
        const common = {
          ...deferLoading === true ? { deferLoading } : {},
          ...namespace === undefined ? {} : { namespace: { ...namespace } },
          ...inputSchemaMaxBytes === undefined ? {} : { inputSchemaMaxBytes },
          ...outputSchema === undefined ? {} : { outputSchema: structuredClone(outputSchema) },
        }
        return schema.kind === 'freeform'
          ? { name, description, kind: 'freeform', format: { ...schema.format }, ...common }
          : { name, description, parameters: structuredClone(schema.parameters), ...common,
            ...schema.kind === undefined ? {} : { kind: schema.kind } }
      })
      const acceptedKnownNames = result.knownNames ?? schemas.map(tool => tool.name)
      collected.push(...schemas)
      for (const name of acceptedKnownNames) knownNames.add(name)
    }
    const sectionDefinitions = [...sectionByName.values()].sort(comparePromptSections)
    const completeSections = sectionDefinitions.filter(section => section.complete === true)
    if (completeSections.length > 1) {
      throw new Error(`multiple complete prompt sections are active: ${completeSections.map(section => JSON.stringify(section.name)).join(', ')}`)
    }
    let completeSection: AssembledSection | undefined
    const sections = sectionDefinitions
      .map((section) => {
        const assembled = {
          name: section.name,
          text: typeof section.text === 'function' ? section.text(context) : section.text,
          ...section.interpolate !== undefined ? { interpolate: section.interpolate } : {},
        }
        if (section.complete === true) completeSection = { ...assembled }
        return assembled
      })
    const assembly: PromptAssembly = {
      sections,
      contexts: runtimeContextSuppressed
        ? []
        : [...contextByName.values()]
          .sort((a, b) => a.order - b.order)
          .map(entry => ({
            name: entry.name,
            text: typeof entry.text === 'function' ? entry.text(context) : entry.text,
            ...entry.role === undefined ? {} : { role: entry.role },
            ...entry.interpolate === undefined ? {} : { interpolate: entry.interpolate },
          })),
      tools: orderTools(collected, this.toolOrder, knownNames),
      ...(nested.length === 0 ? {} : { nestedTools: nested }),
      variables,
    }
    const inherited = captured.inherited
    const ownSections = new Set(assembly.sections.map(section => section.name))
    const ownContexts = new Set(assembly.contexts.map(section => section.name))
    assembly.sections = [...inherited.sections.filter(section => !ownSections.has(section.name)), ...assembly.sections]
    assembly.contexts = [...inherited.contexts.filter(section => !ownContexts.has(section.name)), ...assembly.contexts]
    const transformed = await this.ctx.waterfall(
      scopeTarget(this, scope), 'codexy-prompt/assemble', assembly, context,
      () => Promise.resolve(assembly),
    )
    context.signal?.throwIfAborted()
    const finalAssembly = completeSection === undefined && !runtimeContextSuppressed ? transformed : {
      ...transformed,
      sections: completeSection === undefined ? transformed.sections : [completeSection],
      contexts: runtimeContextSuppressed ? [] : transformed.contexts,
    }
    const callbacks = this.ctx.events.dispatch('emit', [
      scopeTarget(this, scope), 'codexy-prompt/assembled', finalAssembly, context,
    ])
    for (const callback of callbacks) {
      try {
        const returned: unknown = callback(finalAssembly, context)
        void Promise.resolve(returned).catch((error: unknown) => {
          this.ctx.logger.warn(`codexy-prompt/assembled listener rejected: ${String(error)}`)
        })
      } catch (error: unknown) {
        this.ctx.logger.warn(`codexy-prompt/assembled listener threw: ${String(error)}`)
      }
    }
    return finalAssembly
  }
}

export default SystemPrompt

declare module '@codexydsh/runtime/ports' {
  interface CodexyPromptPort extends Pick<SystemPrompt, 'getSectionOrder' | 'getContextOrder' | 'suppressRuntimeContext' | 'inheritedToolSchemas' | 'preparedWorkingDirectory'> {}
}
