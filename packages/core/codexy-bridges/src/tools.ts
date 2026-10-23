/** Bind native tool implementations to a request while retaining DSH policy execution. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { Service, type Context } from '@deepseek-ai/cordis'
import { ToolRuntime, ToolOutputError, type ToolDefinition as PlatformDefinition, type ToolExecutionInput as PlatformInput,
  type ToolRunContext, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import { deepFreeze, snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { TOOL_REQUEST_CAPTURE, TOOL_RUNTIME_SCHEDULER,
  type ToolDefinition, type ToolRequestCapture, type ToolRequestBinding, type ToolExecutionInput,
  type CodexyToolScheduler } from '@codexydsh/runtime/tools'
import type { ToolSchema } from '@codexydsh/runtime/llm'
import type { AssembleContext } from '@codexydsh/runtime/prompt'
import type {} from '@codexydsh/runtime/ports'

interface Capture { readonly binding?: ToolRequestBinding; readonly owner: ScopeKey | undefined; readonly definitions: ReadonlyMap<string, ToolDefinition> }
const captures = new WeakMap<ToolRequestCapture, Capture>()
const bindings = new WeakMap<ToolRequestBinding, Capture>()
const natives = new WeakMap<PlatformDefinition, ToolDefinition>()
const activeRequest = new AsyncLocalStorage<Capture>()

/** Public virtual lookup chooses the captured implementation throughout the stock pipeline. */
export class NativeToolRuntime extends ToolRuntime {
  /** Keep program values separate from the canonical model-facing result. */
  override async execute(input: PlatformInput): Promise<ToolExecutionResult> {
    const projection = input.parent === undefined ? undefined : this.get(input.name, input.agent)?.output.codeModeResult
    const result = await super.execute(input)
    if (result.isError || projection === undefined) return result
    try {
      const value = snapshotJsonValue(projection(input.arguments, result.value, result.content))
      if (value === undefined) throw new ToolOutputError(input.name, ['output.codeModeResult returned non-lossless JSON'])
      return deepFreeze({ ...result, codeModeValue: value })
    } catch (error) {
      const failure = error instanceof ToolOutputError ? error : new ToolOutputError(input.name,
        ['output.codeModeResult failed: ' + (error instanceof Error ? error.message : String(error))])
      return deepFreeze({ isError: true, error: { message: failure.message, info: { name: failure.name, code: failure.code } },
        content: [{ type: 'text', text: 'Error: ' + failure.message }] })
    }
  }

  override get(name: string, scope?: ScopeKey): PlatformDefinition | undefined {
    const captured = activeRequest.getStore()
    if (captured !== undefined && captured.owner === scope) {
      const definition = captured.definitions.get(name)
      return definition === undefined ? undefined : platformDefinition(definition)
    }
    return super.get(name, scope)
  }
}

function platformDefinition(definition: ToolDefinition): PlatformDefinition {
  return { ...definition, parameters: definition.kind === 'freeform' ? { type: 'string' } : definition.parameters }
}
function nativeSchema(definition: ToolDefinition): ToolSchema {
  const common = { name: definition.name, description: definition.description,
    ...definition.namespace === undefined ? {} : { namespace: structuredClone(definition.namespace) },
    ...definition.deferLoading === undefined ? {} : { deferLoading: definition.deferLoading },
    ...definition.inputSchemaMaxBytes === undefined ? {} : { inputSchemaMaxBytes: definition.inputSchemaMaxBytes },
    ...definition.outputSchema === undefined ? {} : { outputSchema: structuredClone(definition.outputSchema) },
  }
  return deepFreeze(definition.kind === 'freeform'
    ? { ...common, kind: 'freeform', format: structuredClone(definition.format) }
    : { ...common, parameters: structuredClone(definition.parameters) })
}

/** Product tool registration and schema capture over the public stock registry. */
export class NativeTools extends Service {
  static inject = ['tools', 'codexyPrompt']
  readonly [TOOL_RUNTIME_SCHEDULER]: CodexyToolScheduler
  private readonly preparedInputs = new WeakMap<ToolRunContext, ToolExecutionInput>()
  constructor(ctx: Context) {
    super(ctx, 'codexyTools')
    ctx.effect(() => ctx.codexyPrompt.tools(context => {
      const capture = context[TOOL_REQUEST_CAPTURE]
      if (context.promptPreparation === undefined) throw new Error('tool presentation requires prepared prompt inputs')
      const native = capture === undefined ? this.schemas(context.scope) : capture.schemas
      const inherited = ctx.codexyPrompt.inheritedToolSchemas(context.promptPreparation)
      const directNames = new Set(inherited.map(schema => schema.name))
      return {
        schemas: native.filter(schema => directNames.has(schema.name)),
        nestedSchemas: native.filter(schema => !directNames.has(schema.name)),
        knownNames: [...directNames],
      }
    }))
    // Public execute assigns tokens and performs policy once at dispatch.
    this[TOOL_RUNTIME_SCHEDULER] = {
      prepare: async input => {
        const exec: ToolRunContext = { ...platformInput(input),
          token: Symbol('codexy-tool') as ToolRunContext['token'],
          rootCallId: input.rootCallId ?? input.callId,
          deferContext: () => { throw new Error('contexts are deferred by the dispatched tool execution') },
          concludeTurn: () => { throw new Error('turn completion belongs to the dispatched tool execution') },
        }
        this.preparedInputs.set(exec, input)
        return { kind: 'dispatch', exec }
      },
      dispatch: async exec => {
        const input = this.preparedInputs.get(exec)
        if (input === undefined) throw new Error('tool dispatch belongs to another scheduler')
        this.preparedInputs.delete(exec)
        return { kind: 'final-result', result: await this.execute(input) }
      },
      finalize: async (_exec, result) => result,
      finish: (_exec, result) => result,
    }
  }
  register(definition: ToolDefinition): () => void { return this.registerNative(definition) }
  registerNative(definition: ToolDefinition): () => void {
    const mounted = platformDefinition(definition)
    natives.set(mounted, definition)
    const dispose = this.ctx.tools.register(mounted)
    return () => { dispose(); natives.delete(mounted) }
  }
  get(name: string, scope?: ScopeKey): ToolDefinition | undefined {
    const definition = this.ctx.tools.get(name, scope)
    return definition === undefined ? undefined : natives.get(definition) ?? definition
  }
  schemas(scope?: ScopeKey): ToolSchema[] {
    return this.ctx.tools.schemas(scope).flatMap(schema => {
      const definition = this.get(schema.name, scope)
      return definition === undefined ? [] : [nativeSchema(definition)]
    })
  }
  ownSchemas(scope?: ScopeKey): ToolSchema[] { return this.schemas(scope) }
  restrict(...args: Parameters<ToolRuntime['restrict']>) { return this.ctx.tools.restrict(...args) }
  guard(...args: Parameters<ToolRuntime['guard']>) { return this.ctx.tools.guard(...args) }
  presentAs(...args: Parameters<ToolRuntime['presentAs']>) { return this.ctx.tools.presentAs(...args) }
  executionMode(input: ToolExecutionInput) {
    const capture = input.requestBinding === undefined ? undefined : bindings.get(input.requestBinding)
    return capture === undefined ? this.ctx.tools.executionMode(platformInput(input))
      : activeRequest.run(capture, () => this.ctx.tools.executionMode(platformInput(input)))
  }
  async prepareRequest(request: { context: AssembleContext; variables: Readonly<Record<string, string | undefined>> }): Promise<ToolRequestCapture> {
    request.context.signal?.throwIfAborted()
    const definitions = new Map<string, ToolDefinition>()
    const initial = this.schemas(request.context.scope).map(schema => this.get(schema.name, request.context.scope))
    const resolved = await Promise.all(initial.map(async definition => {
      if (definition === undefined) throw new Error('tool registration changed while capturing request')
      const prepared = await definition.resolveRequest?.(request) ?? definition
      if (prepared.name !== definition.name) throw new Error('prepared tool changed its registration name')
      return prepared
    }))
    request.context.signal?.throwIfAborted()
    const catalog = deepFreeze(resolved.map(nativeSchema))
    for (const definition of resolved) {
      const derived = definition.deriveRequest?.(request, catalog) ?? definition
      if (derived.name !== definition.name) throw new Error('derived tool changed its registration name')
      definitions.set(derived.name, Object.freeze({ ...derived, output: Object.freeze({ ...derived.output, schema: deepFreeze(structuredClone(derived.output.schema)) }) }))
    }
    const capture = Object.freeze({ schemas: Object.freeze([...definitions.values()].map(nativeSchema)) })
    captures.set(capture, { owner: request.context.scope, definitions })
    return capture
  }
  bindAssembly(capture: ToolRequestCapture, direct: readonly ToolSchema[], nested: readonly ToolSchema[] = []): ToolRequestBinding {
    const state = captures.get(capture)
    if (state === undefined) throw new Error('tool capture belongs to another provider')
    const definitions = new Map<string, ToolDefinition>()
    for (const schema of [...direct, ...nested]) {
      const definition = state.definitions.get(schema.name)
      if (definition === undefined) throw new Error(`assembled tool ${schema.name} was not captured`)
      const { parameters: _parameters, ...implementation } = platformDefinition(definition)
      definitions.set(schema.name, { ...implementation, ...deepFreeze(structuredClone(schema)) })
    }
    const binding = Object.freeze({ schemas: deepFreeze(structuredClone([...direct])), nestedSchemas: deepFreeze(structuredClone([...nested])) })
    bindings.set(binding, { owner: state.owner, definitions })
    return binding
  }
  requestSchemas(binding: ToolRequestBinding) { return binding.schemas }
  requestToolName(binding: ToolRequestBinding, name: string, namespace?: string): string | undefined {
    const schema = [...binding.schemas, ...binding.nestedSchemas].find(schema => schema.namespace === undefined
      ? (namespace === undefined || namespace === 'functions') && schema.name === name
      : schema.namespace.name === namespace && schema.namespace.toolName === name)
    return schema?.name
  }
  requestToolKind(binding: ToolRequestBinding, name: string, namespace?: string): 'function' | 'freeform' | undefined {
    const selected = this.requestToolName(binding, name, namespace)
    const schema = [...binding.schemas, ...binding.nestedSchemas].find(schema => schema.name === selected)
    return schema === undefined ? undefined : schema.kind ?? 'function'
  }
  execute(input: ToolExecutionInput): Promise<ToolExecutionResult> {
    if (input.requestBinding === undefined) return this.ctx.tools.execute(platformInput(input))
    const capture = bindings.get(input.requestBinding)
    if (capture === undefined || capture.owner !== input.agent) throw new Error('tool binding belongs to another scope or provider')
    return activeRequest.run({ ...capture, binding: input.requestBinding }, () => this.ctx.tools.execute(platformInput(input)))
  }
}
function platformInput(input: ToolExecutionInput): PlatformInput {
  const { requestBinding: _binding, schema, ...rest } = input
  return { ...rest, ...schema === undefined ? {} : { schema: schema.kind === 'freeform'
    ? { name: schema.name, description: schema.description, parameters: { type: 'string' } }
    : schema } }
}
export default NativeToolRuntime

/** Return the request binding active in the stock tool pipeline.
 * @returns Current binding, or undefined outside a captured tool dispatch.
 */
export function currentToolRequestBinding(): ToolRequestBinding | undefined { return activeRequest.getStore()?.binding }
