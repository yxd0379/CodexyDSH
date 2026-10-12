/** Product provider generations, mirrored into the stock DSH provider directory. */
import z from '@deepseek-ai/schemastery'
import { diagnoseRequest } from './request-diagnostics.ts'
import { Service, type Context } from '@deepseek-ai/cordis'
import { LlmError, resolveRetryPolicy, callConfigEquals, markAgentLoopRequest as markPlatformAgentRequest, type LlmAdapter, type AdapterRegistrationHandle,
  type LlmCallConfig, type LlmResolvedModelInfo, type LlmRuntime, type GenerateOptions as PlatformGenerateOptions } from '@deepseek-ai/dsh-llm'
import { isAgentLoopRequest, markAgentLoopRequest, textOnlyImageText, type ContentBlock } from '@codexydsh/runtime/llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { GenerateOptions, StreamChunk, PreparedAdapterCall, PreparedLlmCall, PreparedLlmModel } from '@codexydsh/runtime/llm'
import type {} from '@codexydsh/runtime/ports'

/** Adapters expose native schemas while keeping the stock model directory usable. */
export interface NativeAdapter extends Omit<LlmAdapter, 'prepareCall' | 'stream'> {
  prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall>
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}
interface Registration { readonly adapter: NativeAdapter; readonly policy: ReturnType<typeof resolveRetryPolicy> }

declare module '@codexydsh/runtime/ports' {
  interface CodexyRequestPort extends Pick<LlmRuntime, 'listProviders' | 'listModels' | 'resolveModelInfo' | 'registerConfigurableProviders' | 'registerModelDiscovery' | 'resolveCallConfig'> {
    registerAdapter(providers: string[], adapter: NativeAdapter): AdapterRegistrationHandle
  }
}

/** Opt-in request metadata; prompts, credentials and output text are excluded. */
export interface Config { diagnostics?: boolean }
/** Validated provider bridge options. */
export const Config = z.object({ diagnostics: z.boolean().default(false) })

/** Freeze the provider before prompt, tool, and credential awaits. */
export class RequestProviders extends Service {
  static inject = ['llm']
  static Config = Config
  private sequence = 0
  private readonly registrations = new Map<string, Registration>()
  constructor(ctx: Context, private readonly options: Config = {}) { super(ctx, 'codexyRequests') }
  listProviders() { return this.ctx.llm.listProviders() }
  async listModels(provider: string) { return [...await this.require(provider).adapter.listModels(provider)] }
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal) { return this.require(provider).adapter.resolveModel(provider, model, signal) }
  registerConfigurableProviders(...args: Parameters<LlmRuntime['registerConfigurableProviders']>) { return this.ctx.llm.registerConfigurableProviders(...args) }
  registerModelDiscovery(...args: Parameters<LlmRuntime['registerModelDiscovery']>) { return this.ctx.llm.registerModelDiscovery(...args) }
  async resolveCallConfig(config: LlmCallConfig, signal?: AbortSignal) { return (await this.prepareCall(config, signal)).config }

  private require(provider: string): Registration {
    const entry = this.registrations.get(provider)
    if (entry === undefined) throw new LlmError(`Codexy provider ${JSON.stringify(provider)} is not registered`, 'NO_ADAPTER')
    return entry
  }
  registerAdapter(providers: string[], adapter: NativeAdapter): AdapterRegistrationHandle {
    const platform = this.ctx.llm.registerAdapter(providers, adapter)
    let active = [...providers]
    let disposed = false
    const register = (routes: readonly string[]): void => {
      for (const provider of routes) this.registrations.set(provider, { adapter, policy: adapter.providerRetryPolicy(provider) ?? resolveRetryPolicy(undefined, `providers.${provider}.retryPolicy`) })
    }
    register(active)
    const dispose = Object.assign(() => {
      if (disposed) return
      disposed = true
      for (const provider of active) if (this.registrations.get(provider)?.adapter === adapter) this.registrations.delete(provider)
      platform()
    }, { replace: (routes: string[]) => {
      if (disposed) throw new LlmError('provider registration was disposed', 'REGISTRATION_DISPOSED')
      platform.replace(routes)
      for (const provider of active) if (this.registrations.get(provider)?.adapter === adapter) this.registrations.delete(provider)
      active = [...routes]
      register(active)
    } })
    this.ctx.effect(() => dispose)
    return dispose
  }

  async prepareModel(provider: string, model: string, signal?: AbortSignal): Promise<PreparedLlmModel> {
    signal?.throwIfAborted()
    const registration = this.registrations.get(provider)
    if (registration === undefined) throw new LlmError(`Codexy provider ${JSON.stringify(provider)} is not registered`, 'NO_ADAPTER')
    const call = await registration.adapter.prepareCall(provider, model, signal)
    signal?.throwIfAborted()
    return this.bind(provider, model, registration, call)
  }
  private bind(provider: string, model: string, registration: Registration, adapterCall: PreparedAdapterCall): PreparedLlmModel {
    const info = deepFreeze(structuredClone(adapterCall.model))
    if (info.provider !== provider || info.id !== model) throw new LlmError('captured model does not match its provider route', 'INVALID_MODEL')
    const bound: PreparedLlmModel = Object.freeze({
      model: info,
      listModels: async () => [...await (adapterCall.listModels?.() ?? registration.adapter.listModels(provider))],
      resolveModelInfo: async (id: string, signal?: AbortSignal) => {
        signal?.throwIfAborted()
        const resolved = id === model ? info : await (adapterCall.resolveModel?.(id, signal) ?? registration.adapter.resolveModel(provider, id, signal))
        signal?.throwIfAborted()
        return deepFreeze(structuredClone(resolved))
      },
      withModel: async (id: string, signal?: AbortSignal) => {
        signal?.throwIfAborted()
        if (id === model) return bound
        if (adapterCall.withModel === undefined) throw new LlmError('provider cannot derive a model from its captured generation', 'UNSUPPORTED_OPTION')
        const derived = await adapterCall.withModel(id, signal)
        signal?.throwIfAborted()
        return this.bind(provider, id, registration, derived)
      },
      prepareCall: (proposed: LlmCallConfig): PreparedLlmCall => {
        if (proposed.provider !== provider || proposed.model !== model) throw new LlmError('prepared model route changed', 'INVALID_PREPARED_CALL')
        const config = resolveControls(proposed, info)
        let dispatched = false
        return Object.freeze({ config, retryPolicy: registration.policy,
          adapterDefaults: Object.freeze({
            ...proposed.reasoningEffort === undefined && config.reasoningEffort !== undefined ? { reasoningEffort: true as const } : {},
            ...proposed.maxTokens === undefined && config.maxTokens !== undefined ? { maxTokens: true as const } : {},
          }),
          ...info.context === undefined ? {} : { context: info.context },
          ...info.inputModalities === undefined ? {} : { inputModalities: info.inputModalities },
          ...info.systemPromptUpdate === undefined ? {} : { systemPromptUpdate: info.systemPromptUpdate },
          ...info.toolUpdate === undefined ? {} : { toolUpdate: info.toolUpdate },
          ...adapterCall.developerHistory === undefined ? {} : { developerHistory: adapterCall.developerHistory },
          stream: (options: GenerateOptions) => {
            if (dispatched || !sameConfig(options, config)) throw new LlmError('prepared call was reused or its controls changed', 'INVALID_PREPARED_CALL')
            dispatched = true
            const dispatch = (input: GenerateOptions) => this.ctx.waterfall(
              this, 'codexy-llm/stream', input,
              () => this.ctx.waterfall(this.ctx.llm, 'llm/stream', observerRequest(input, info, this.ctx.llm),
                () => normalizedStream(input, observed => adapterCall.stream(projectRequest(observed, info, this.ctx.llm)))),
            )
            if (this.options.diagnostics !== true) return dispatch(options)
            return diagnoseRequest(options, ++this.sequence, { wall: Date.now(), monotonic: performance.now() }, dispatch, line => {
              try { this.ctx.logger.info(line) } catch (error) { /* Diagnostic sinks cannot fail a model request. */ }
            })
          },
        })
      },
    })
    return bound
  }
  async prepareCall(config: LlmCallConfig, signal?: AbortSignal): Promise<PreparedLlmCall> {
    return (await this.prepareModel(config.provider, config.model, signal)).prepareCall(config)
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    let prepared: PreparedLlmCall
    try { prepared = await this.prepareCall(options, options.signal) }
    catch (error) { yield failureChunk(error, options.signal); return }
    const dispatch = { ...options, ...prepared.config }
    if (isAgentLoopRequest(options)) markAgentLoopRequest(dispatch)
    yield* prepared.stream(Object.isFrozen(options) ? deepFreeze(dispatch) : dispatch)
  }
}

function sameConfig(a: LlmCallConfig, b: LlmCallConfig): boolean {
  return callConfigEquals(a, b) && JSON.stringify(a.codexfulResponses) === JSON.stringify(b.codexfulResponses)
}
function resolveControls(proposed: LlmCallConfig, info: LlmResolvedModelInfo): LlmCallConfig {
  const config: LlmCallConfig = { provider: proposed.provider, model: proposed.model,
    ...proposed.reasoningEffort === undefined ? {} : { reasoningEffort: proposed.reasoningEffort },
    ...proposed.temperature === undefined ? {} : { temperature: proposed.temperature },
    ...proposed.maxTokens === undefined ? {} : { maxTokens: proposed.maxTokens },
    ...proposed.stop === undefined ? {} : { stop: proposed.stop },
    ...proposed.codexfulResponses === undefined ? {} : { codexfulResponses: proposed.codexfulResponses },
  }
  if (config.maxTokens === undefined && info.defaultMaxTokens !== undefined) config.maxTokens = info.defaultMaxTokens
  const effort = config.reasoningEffort ?? info.reasoning?.defaultEffort
  if (effort !== undefined) {
    if (!info.reasoning?.efforts.some(value => value.id === effort)) throw new LlmError(`unsupported reasoning effort ${JSON.stringify(effort)}`, 'UNSUPPORTED_REASONING_EFFORT')
    config.reasoningEffort = effort
  }
  if (config.codexfulResponses !== undefined && info.codexResponsesLite === true) config.codexfulResponses = { ...config.codexfulResponses, lite: true }
  if (config.codexfulResponses?.lite === true && info.codexResponsesLite !== true) throw new LlmError('This provider route does not support Codex Responses Lite', 'UNSUPPORTED_OPTION')
  return deepFreeze(structuredClone(config))
}
async function* normalizedStream(options: GenerateOptions, dispatch: (options: GenerateOptions) => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
  let iterator: AsyncIterator<StreamChunk>
  try { iterator = dispatch(options)[Symbol.asyncIterator]() }
  catch (error) { yield failureChunk(error, options.signal); return }
  let completed = false
  try {
    while (true) {
      let item: IteratorResult<StreamChunk>
      try { item = await iterator.next() }
      catch (error) { completed = true; yield failureChunk(error, options.signal); return }
      if (item.done) { completed = true; return }
      yield item.value
    }
  } finally {
    if (!completed) await iterator.return?.()
  }
}
function failureChunk(error: unknown, signal?: AbortSignal): StreamChunk {
  if (signal?.aborted) return { type: 'finish', reason: { kind: 'aborted', failure: new LlmError(error instanceof Error ? error.message : 'model request cancelled', 'ABORTED').failure } }
  const failure = error instanceof LlmError ? error.failure : new LlmError(error instanceof Error ? error.message : String(error), 'TRANSPORT').failure
  return { type: 'finish', reason: failure.code === 'ABORTED' ? { kind: 'aborted', failure } : { kind: 'error', failure } }
}
export default RequestProviders

/** Preserve durable file handles and declared text-only image behavior at provider dispatch. */
function projectRequest(options: GenerateOptions, model: LlmResolvedModelInfo, llm: LlmRuntime): GenerateOptions {
  const textOnly = model.inputModalities !== undefined && !model.inputModalities.includes('image')
  if (!options.messages.some(message => message.content.some(block => block.type === 'file' || textOnly && block.type === 'image'))) return options
  const messages = options.messages.map(message => ({ ...message, content: message.content.map((block): ContentBlock => {
    if (block.type === 'file') return { type: 'text', text: llm.fileRequestText(block.attachment) }
    if (textOnly && block.type === 'image') return { type: 'text', text: textOnlyImageText(block.attachment) }
    return block
  }) }))
  const projected = { ...options, messages }
  if (isAgentLoopRequest(options)) markAgentLoopRequest(projected)
  return Object.isFrozen(options) ? deepFreeze(projected) : projected
}

/** Public observers receive valid stock tool schemas while native dispatch retains its captured request. */
function observerRequest(options: GenerateOptions, model: LlmResolvedModelInfo, llm: LlmRuntime): PlatformGenerateOptions {
  const projected = projectRequest(options, model, llm)
  const tools = projected.tools?.map(tool => tool.kind === 'freeform'
    ? { name: tool.name, description: tool.description, parameters: { type: 'string' } }
    : tool)
  const { tools: _nativeTools, ...rest } = projected
  const view: PlatformGenerateOptions = deepFreeze({ ...rest, ...tools === undefined ? {} : { tools } })
  if (isAgentLoopRequest(options)) markPlatformAgentRequest(view)
  return view
}
