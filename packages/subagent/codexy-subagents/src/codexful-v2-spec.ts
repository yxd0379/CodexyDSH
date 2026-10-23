/** Pure Codex 8f195c93 multi-agent V2 descriptions and input schemas. */
import type { ToolSchema } from '@codexydsh/runtime/llm'
import { SOURCE_DEFAULTS, TEXT } from './codexful-v2-source-text.ts'

/** Model catalog fields consumed by Codex's spawn description formatter. */
export interface CatalogModel {
  readonly model: string
  readonly description: string
  readonly showInPicker: boolean
  readonly multiAgentVersion: 'disabled' | 'v1' | 'v2' | null
  readonly defaultReasoningEffort: string
  readonly supportedReasoningEfforts: readonly string[]
  readonly serviceTiers: readonly string[]
}

/** The six V2 dispatch names, independent of their wire namespace. */
export type ToolName = 'spawn_agent' | 'send_message' | 'followup_task'
  | 'wait_agent' | 'interrupt_agent' | 'list_agents'

/** Scalar parameter fields emitted by the pinned V2 schemas. */
export type ScalarSchema = {
  type: 'string' | 'number'
  description: string
  encrypted?: true
}

/** Closed parameter object with source-defined property and required order. */
export type ParameterSchema = {
  type: 'object'
  properties: Record<string, ScalarSchema>
  required?: string[]
  additionalProperties: false
}

/** Source function declaration plus DSH's existing namespace metadata. */
export interface FunctionSpec {
  readonly type: 'function'
  readonly name: ToolName
  readonly description: string
  readonly strict: false
  readonly parameters: ParameterSchema
  readonly namespace?: ToolSchema['namespace']
}

/** Inputs selected by the application before resolving one capture's specs. */
export interface SpecOverrides {
  readonly models?: readonly CatalogModel[]
  readonly agentTypesConfigured?: boolean
  readonly agentTypeDescription?: string
  readonly hideSpawnAgentMetadata?: boolean
  readonly exposeSpawnAgentModelOverrides?: boolean
  readonly usageHintText?: string | null
  readonly descriptionOverrides?: Readonly<Partial<Record<ToolName, string>>>
  readonly supportsNamespace?: boolean
  readonly toolNamespace?: string | null
  readonly waitAgentEnabled?: boolean
  readonly disableDirectMessage?: boolean
  readonly defaultWaitTimeoutMs?: number
  readonly minWaitTimeoutMs?: number
  readonly maxWaitTimeoutMs?: number
}

/** Fully resolved tool-description inputs; build functions do not add defaults. */
export interface ResolvedSpecOptions {
  readonly models: readonly CatalogModel[]
  readonly exposeAgentType: boolean
  readonly agentTypeDescription: string
  readonly hideSpawnAgentMetadata: boolean
  readonly exposeSpawnAgentModelOverrides: boolean
  readonly usageHintText: string | null
  readonly descriptionOverrides: Readonly<Partial<Record<ToolName, string>>>
  readonly toolNamespace: string | null
  readonly waitAgentEnabled: boolean
  readonly disableDirectMessage: boolean
  readonly waitTimeout: { readonly defaultMs: number; readonly minMs: number; readonly maxMs: number }
}

/**
 * Resolve effective V2 application defaults, rather than SpawnAgentToolOptions::default().
 * @param input - application configuration and the captured catalog generation.
 * @returns resolved values used by one tool capture.
 */
export function resolveSpecOptions(input: SpecOverrides = {}): ResolvedSpecOptions {
  return {
    models: input.models ?? [],
    exposeAgentType: input.agentTypesConfigured ?? false,
    agentTypeDescription: input.agentTypeDescription ?? '',
    hideSpawnAgentMetadata: input.hideSpawnAgentMetadata ?? SOURCE_DEFAULTS.hideSpawnAgentMetadata,
    exposeSpawnAgentModelOverrides: input.exposeSpawnAgentModelOverrides ?? SOURCE_DEFAULTS.exposeSpawnAgentModelOverrides,
    usageHintText: input.usageHintText ?? null,
    descriptionOverrides: input.descriptionOverrides ?? {},
    toolNamespace: input.supportsNamespace === false ? null
      : input.toolNamespace === undefined ? SOURCE_DEFAULTS.toolNamespace : input.toolNamespace,
    waitAgentEnabled: input.waitAgentEnabled ?? SOURCE_DEFAULTS.waitAgentEnabled,
    disableDirectMessage: input.disableDirectMessage ?? SOURCE_DEFAULTS.disableDirectMessage,
    waitTimeout: {
      defaultMs: input.defaultWaitTimeoutMs ?? SOURCE_DEFAULTS.defaultWaitTimeoutMs,
      minMs: input.minWaitTimeoutMs ?? SOURCE_DEFAULTS.minWaitTimeoutMs,
      maxMs: input.maxWaitTimeoutMs ?? SOURCE_DEFAULTS.maxWaitTimeoutMs,
    },
  }
}

/**
 * Render the first five eligible models in registry order using the pinned strings.
 * @param models - detached catalog entries from the invoking provider.
 * @returns optional-override guidance, including the source's empty-catalog sentence.
 */
export function renderModelCatalog(models: readonly CatalogModel[]): string {
  const visible = models.filter(model => model.showInPicker && model.multiAgentVersion !== 'disabled')
    .slice(0, SOURCE_DEFAULTS.maxModelOverrides)
  if (visible.length === 0) return TEXT.emptyCatalog
  const lines = visible.map((model) => {
    const efforts = model.supportedReasoningEfforts.map((effort) => {
      const shown = [...effort].slice(0, SOURCE_DEFAULTS.maxEffortCharacters).join('')
      return effort === model.defaultReasoningEffort ? `${shown} (default)` : shown
    }).join(', ')
    const tiers = model.serviceTiers.join(', ')
    return interpolate(TEXT.modelLine, {
      model_slug: model.model,
      description: model.description,
      reasoning_efforts_suffix: efforts.length === 0 ? '' : interpolate(TEXT.effortSuffix, { efforts }),
      service_tiers_suffix: tiers.length === 0 ? '' : interpolate(TEXT.tierSuffix, { service_tiers: tiers }),
    })
  }).join('\n')
  return interpolate(TEXT.catalogTemplate, { model_descriptions: lines })
}

function interpolate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([a-z_]+)\}/g, (token: string, name: string) => {
    const value = values[name]
    if (value === undefined) throw new Error(`missing source-template value ${token}`)
    return value
  })
}

function stringParameter(description: string, encrypted = false): ScalarSchema {
  return { type: 'string', description, ...encrypted ? { encrypted: true as const } : {} }
}

function parameterObject(entries: readonly (readonly [string, ScalarSchema])[], required?: readonly string[]): ParameterSchema {
  const sorted = [...entries].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  return {
    type: 'object',
    properties: Object.fromEntries(sorted),
    ...required === undefined ? {} : { required: [...required] },
    additionalProperties: false,
  }
}

function spawnDescription(options: ResolvedSpecOptions): string {
  const catalog = options.exposeSpawnAgentModelOverrides ? renderModelCatalog(options.models) : ''
  const inherited = options.exposeSpawnAgentModelOverrides && !options.hideSpawnAgentMetadata
    ? TEXT.inheritedModelGuidance : ''
  const override = options.descriptionOverrides.spawn_agent
  const description = override === undefined
    ? interpolate(TEXT.spawnTemplate, { agent_role_guidance: catalog, inherited_model_guidance: inherited })
    : interpolate(TEXT.spawnOverrideTemplate, {
      agent_role_guidance: catalog, description: override, inherited_model_guidance: inherited,
    })
  return options.usageHintText === null ? description
    : interpolate(TEXT.spawnUsageTemplate, { tool_description: description, usage_hint_text: options.usageHintText })
}

function spawnParameters(options: ResolvedSpecOptions): ParameterSchema {
  const entries: [string, ScalarSchema][] = [
    ['message', stringParameter(TEXT.spawnMessage, true)],
    ['fork_turns', stringParameter(TEXT.forkTurns)],
    ['task_name', stringParameter(TEXT.taskName)],
  ]
  if (options.exposeAgentType) entries.push(['agent_type', stringParameter(interpolate(TEXT.agentType, {
    agent_type_description: options.agentTypeDescription,
  }))])
  if (options.exposeSpawnAgentModelOverrides) entries.push(
    ['model', stringParameter(TEXT.modelOverride)],
    ['reasoning_effort', stringParameter(TEXT.reasoningEffort)],
  )
  return parameterObject(entries, ['task_name', 'message'])
}

/**
 * Build detached, source-ordered function specs for one captured V2 configuration.
 * @param options - fully resolved application inputs.
 * @returns specs in Codex's registration order, with optional collaboration grouping.
 */
export function buildSpecs(options: ResolvedSpecOptions): FunctionSpec[] {
  const specs: FunctionSpec[] = []
  const add = (name: ToolName, description: string, parameters: ParameterSchema): void => {
    specs.push({
      type: 'function', name,
      description: name === 'spawn_agent' ? description : options.descriptionOverrides[name] ?? description,
      strict: false, parameters,
      ...options.toolNamespace === null ? {} : {
        namespace: { name: options.toolNamespace, description: TEXT.namespaceDescription, toolName: name },
      },
    })
  }
  add('spawn_agent', spawnDescription(options), spawnParameters(options))
  if (!options.disableDirectMessage) {
    add('send_message', TEXT.sendDescription, parameterObject([
      ['target', stringParameter(TEXT.sendTarget)], ['message', stringParameter(TEXT.sendMessage, true)],
    ], ['target', 'message']))
    add('followup_task', TEXT.followupDescription, parameterObject([
      ['target', stringParameter(TEXT.followupTarget)], ['message', stringParameter(TEXT.followupMessage, true)],
    ], ['target', 'message']))
  }
  if (options.waitAgentEnabled) add('wait_agent', TEXT.waitDescription, parameterObject([
    ['timeout_ms', { type: 'number', description: interpolate(TEXT.waitTimeout, {
      default: String(options.waitTimeout.defaultMs), min: String(options.waitTimeout.minMs), max: String(options.waitTimeout.maxMs),
    }) }],
  ]))
  add('interrupt_agent', TEXT.interruptDescription, parameterObject([
    ['target', stringParameter(TEXT.interruptTarget)],
  ], ['target']))
  add('list_agents', TEXT.listDescription, parameterObject([
    ['path_prefix', stringParameter(TEXT.pathPrefix)],
  ]))
  return specs
}
