/**
 * Generic pi-ai-backed implementation of the Harness LLM seam.
 *
 * Each resolution produces one **immutable** snapshot — the profiles plus a
 * `Models` collection holding the `Provider` each route built — and an
 * operation captures a whole snapshot before its first `await`. A
 * configuration change builds a *new* collection rather than mutating the one
 * in use, because `Models.streamSimple()` is lazy: it resolves the provider
 * when the stream is first consumed, which is after the credential await, so a
 * mutated collection would let a request that started under one configuration
 * finish under another — or fail with a provider that no longer exists. This is
 * what makes the seam's per-step model capture (`llm.prepareModel()`) hold all
 * the way down: tool preparation and dispatch share that snapshot, and a
 * configuration change takes effect on the next capture.
 *
 * A route naming a credential reference still resolves it through the harness
 * seam and passes it as the request's `apiKey` option, which pi-ai treats as
 * the highest-priority auth override — that is what keeps the fail-loud
 * reference semantics. Everything that override does not cover reaches pi-ai
 * through the collection's own auth: the credential store holds the records a
 * login wrote and a refresh rotates, and the auth context answers the ambient
 * questions a provider asks while resolving. Both are stable across snapshots,
 * so a configuration change rebuilds the collection without forgetting who is
 * signed in.
 *
 * @module dsh-llm-pi-ai/adapter
 */

import type {
  Api,
  AuthContext,
  Context as PiContext,
  CredentialStore,
  Model,
  Models,
  ModelThinkingLevel,
  MutableModels,
  SimpleStreamOptions,
  ThinkingLevel,
} from '@earendil-works/pi-ai'
import {
  attributionHeaders,
  contentHasImage,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from '@codexydsh/runtime/llm'
import type {
  GenerateOptions,
  ImageAttachmentAccess,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  ReasoningEffortId as ReasoningEffortIdType,
  ResolvedRetryPolicy,
  RequestMessage,
  StreamChunk,
} from '@codexydsh/runtime/llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { ResolvedPiAiProviderProfile } from './config.ts'
import { toPiContext } from './context.ts'
import { nativeViewImagePayload } from './native-image.ts'
import { prepareDeveloperHistory, restoreDeveloperInput } from './developer-history.ts'
import { createModels, getSupportedThinkingLevels } from './models.ts'
import { responseItemIdBase } from './response-item-id.ts'
import { orderCodex01621Tools } from './codex-01621-tool-order.ts'
import { ordinaryNamespaceToolsPayload, responsesLitePayload, supportsCodexResponsesLite } from './responses-lite.ts'
import { groupStrictCodexfulInput } from './strict-input.ts'
import { codexfulAgentMessageInput } from './agent-message-input.ts'
import { toStreamChunks } from './stream.ts'
import { HostedResponsesCapture, hostedResponsesPayload, restoreHostedOriginals } from './hosted-responses.ts'
import { timedFetch } from './request-timing.ts'
import { nativeResponseFetch } from './native-response-stream.ts'

/** One resolution's frozen view: the profiles and the collection built from them. */
interface PiAiSnapshot {
  /** The resolved profiles this collection was built from, used as its identity. */
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /** Providers for exactly those profiles; never mutated once published. */
  models: Models
}

/** Constructor options for {@link PiAiAdapter}: the two resolution hooks the plugin owns. */
export interface PiAiAdapterOptions {
  /** Current validated profiles by provider route; called once per operation. */
  profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /**
   * Resolve the credential for one already-resolved profile; called once per
   * stream call and frozen for that call. `undefined` defers to the route's own
   * pi-ai auth, which for an installed catalog route is its provider-native
   * ambient discovery; the plugin allows that only for a profile naming no
   * credential at all, because a named reference that misses throws `LlmError`
   * `MISSING_CREDENTIAL` rather than falling back.
   */
  resolveApiKey: (provider: string, profile: ResolvedPiAiProviderProfile) => Promise<string | undefined>
  /**
   * How every collection this adapter builds resolves auth the request-level
   * `apiKey` override does not cover. Required rather than optional: a
   * collection built without them gets pi-ai's in-memory default store, which
   * is empty at every boot and discarded on every configuration change, so a
   * route whose only method is a login would report itself unconfigured on
   * every request no matter how often the human signed in.
   */
  auth: PiAiAuthInjection
  /** Resolve the optional durable attachment service at request time. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Bridge one attachment reference into the current model-tool execution world. */
  resolveImageAccess?: (attachments: AttachmentStore, ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined
  /**
   * Observe one assistant history message degrading to provider-neutral
   * conversion because its stored replay state is unusable by this build.
   */
  onReplayDegrade?: (detail: { provider: string; model: string; reason: string }) => void
}

/** The two auth injectables a pi-ai collection is built with. */
export interface PiAiAuthInjection {
  /** Durable storage for credentials pi-ai itself writes: logins, and the refreshes it runs under its own lock. */
  credentials: CredentialStore
  /** Ambient lookups a provider performs while resolving its own auth. */
  authContext: AuthContext
}

/** Copy profile stream knobs into pi-ai's common option vocabulary. */
function profileOptions(
  profile: ResolvedPiAiProviderProfile,
  reasoning: ModelThinkingLevel | undefined,
  apiKey: string | undefined,
): SimpleStreamOptions {
  const enabledReasoning: ThinkingLevel | undefined = reasoning === 'off' ? undefined : reasoning
  return {
    ...apiKey === undefined ? {} : { apiKey },
    ...enabledReasoning === undefined ? {} : { reasoning: enabledReasoning },
    ...profile.thinkingBudgets === undefined ? {} : { thinkingBudgets: profile.thinkingBudgets },
    ...profile.cacheRetention === undefined ? {} : { cacheRetention: profile.cacheRetention },
    ...profile.transport === undefined ? {} : { transport: profile.transport },
    ...profile.timeoutMs === undefined ? {} : { timeoutMs: profile.timeoutMs },
    ...profile.websocketConnectTimeoutMs === undefined ? {} : { websocketConnectTimeoutMs: profile.websocketConnectTimeoutMs },
    // The agent recovery layer owns visible attempts; one adapter call is one SDK attempt.
    maxRetries: 0,
  }
}

/** Check pi-ai payload objects before inspecting their fields. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether the Responses descriptor and its compatibility options admit native developer messages. */
function supportsNativeDeveloperRole(model: Model<Api>): boolean {
  return model.api === 'openai-responses'
    && (!model.compat || !('supportsDeveloperRole' in model.compat) || (model.compat.supportsDeveloperRole ?? true))
}

/** Attach persisted identities to the pi-ai messages the pinned Responses converter expands. */
function codexfulResponseHistory(context: PiContext, options: GenerateOptions): PiContext {
  const history: readonly RequestMessage[] = options.system === undefined && options.messages[0]?.role === 'system'
    ? options.messages.slice(1) : options.messages
  if (context.messages.length !== history.length) {
    throw new LlmError('pi-ai changed Codexful Responses history count', 'UNSUPPORTED_CONTENT')
  }
  return {
    ...context,
    messages: context.messages.map((message, index) => {
      const source = history[index]
      if (source === undefined) throw new LlmError('pi-ai omitted Codexful Responses history', 'UNSUPPORTED_CONTENT')
      const expectedRole = source.role === 'assistant' ? 'assistant'
        : source.role === 'tool' ? 'toolResult' : 'user'
      if (message.role !== expectedRole) {
        throw new LlmError('pi-ai changed Codexful Responses history roles', 'UNSUPPORTED_CONTENT')
      }
      // Developer placeholders are restored from their private marker, using
      // the original developer ID rather than the temporary pi-ai user role.
      if (source.role === 'developer' || source.id === undefined) return message
      return { ...message, __dshCodexfulResponseItemIdBase: responseItemIdBase(source.id) }
    }),
  }
}

/** Project a Responses item through the pinned typed input semantics, never its stored provider facts. */
function codexfulResponseInputItem(item: unknown, pinnedModelItem = false): unknown {
  if (!isRecord(item)) return item
  const modelItem = item['type'] === 'reasoning' || item['type'] === 'function_call'
    || item['type'] === 'custom_tool_call' || item['type'] === 'message' && item['role'] === 'assistant'
  // The final native projection must not reshape client inputs or opaque
  // backend tool items. Only typed model output is projected here.
  if (pinnedModelItem && !modelItem) return item
  const wireItem: Record<string, unknown> = item['role'] === 'user' && item['type'] === undefined
    && Array.isArray(item['content']) ? { type: 'message', ...item } : { ...item }
  if (modelItem) delete wireItem['status']
  if ('id' in wireItem) {
    const id = wireItem['id']
    if (id === undefined || id === null) delete wireItem['id']
    else {
      if (typeof id !== 'string') {
        throw new LlmError('pi-ai produced a non-string Responses item id', 'UNSUPPORTED_OPTION')
      }
      const underscore = id.indexOf('_')
      if (underscore === 0 || underscore === id.length - 1 || underscore < 0) delete wireItem['id']
    }
  }
  if (wireItem['type'] === 'reasoning') {
    const content = wireItem['content']
    // The pinned ResponseItem serializer writes null for None and skips arrays without reasoning_text.
    const omitReasoningContent = Array.isArray(content)
      && !content.some(piece => isRecord(piece) && piece['type'] === 'reasoning_text')
    return {
      type: 'reasoning',
      ...wireItem['id'] === undefined ? {} : { id: wireItem['id'] },
      summary: wireItem['summary'] ?? [],
      ...omitReasoningContent ? {} : { content: content ?? null },
      encrypted_content: wireItem['encrypted_content'] ?? null,
    }
  }
  if (pinnedModelItem) {
    if (wireItem['type'] === 'function_call' || wireItem['type'] === 'custom_tool_call') {
      for (const field of ['namespace', 'caller']) {
        if (wireItem[field] === undefined || wireItem[field] === null) delete wireItem[field]
      }
    } else if (wireItem['type'] === 'message') {
      // Summary belongs to Reasoning, not Message. The optional assistant
      // phase represents None by absence; its non-null value is preserved.
      delete wireItem['summary']
      if (wireItem['phase'] === undefined || wireItem['phase'] === null) delete wireItem['phase']
      if (Array.isArray(wireItem['content'])) wireItem['content'] = wireItem['content'].map((block: unknown) =>
        isRecord(block) && block['type'] === 'output_text' && typeof block['text'] === 'string'
          ? { type: 'output_text', text: block['text'] } : block)
    }
  }
  return wireItem
}

/** Match Codex's standard Responses request fields without changing other protocols or presets. */
function codexfulResponsesPayload(
  payload: unknown,
  omitDefaultMaxTokens: boolean,
  reasoningSummary: 'auto' | 'none',
  isCompaction: boolean,
  sessionId: string | undefined,
  systemPrompt: string | undefined,
  systemRole: 'system' | 'developer',
): Record<string, unknown> {
  if (!isRecord(payload)) {
    throw new LlmError('pi-ai produced an invalid OpenAI Responses request body', 'UNSUPPORTED_OPTION')
  }
  const request: Record<string, unknown> = { ...payload }
  if ('instructions' in request || !Array.isArray(request['input'])) {
    throw new LlmError('pi-ai changed the Codexful Responses instructions placement', 'UNSUPPORTED_OPTION')
  }
  const input: unknown[] = request['input']
  if (systemPrompt !== undefined) {
    const first = input[0]
    if (!isRecord(first)
      || first['role'] !== systemRole || first['content'] !== systemPrompt) {
      throw new LlmError('pi-ai changed the Codexful Responses system prompt', 'UNSUPPORTED_OPTION')
    }
  }
  request['instructions'] = systemPrompt ?? ''
  const history = systemPrompt === undefined ? input : input.slice(1)
  if (history.some(item => isRecord(item) && item['role'] === 'system')) {
    throw new LlmError('pi-ai produced more than one Codexful Responses system item', 'UNSUPPORTED_OPTION')
  }
  if (history.some(item => isRecord(item) && '__dshCodexfulResponseItemIdBase' in item)) {
    throw new LlmError('pi-ai leaked a Codexful Responses identity marker', 'UNSUPPORTED_OPTION')
  }
  request['input'] = history.map(item => codexfulResponseInputItem(item))
  const existingReasoning = request['reasoning']
  request['tool_choice'] = 'auto'
  request['parallel_tool_calls'] = !isCompaction
  const reasoning: Record<string, unknown> = {
    ...typeof existingReasoning === 'object' && existingReasoning !== null && !Array.isArray(existingReasoning)
      ? existingReasoning
      : {},
  }
  if (reasoningSummary === 'auto') reasoning['summary'] = 'auto'
  else delete reasoning['summary']
  request['reasoning'] = reasoning
  request['include'] = ['reasoning.encrypted_content']
  if (Array.isArray(request['tools'])) {
    request['tools'] = request['tools'].map((tool: unknown) => {
      if (!isRecord(tool) || tool['type'] !== 'function') return tool
      const ordered = { ...tool }
      const parameters = ordered['parameters']
      delete ordered['parameters']
      delete ordered['strict']
      return { ...ordered, strict: false, parameters }
    })
  }
  if (omitDefaultMaxTokens) delete request['max_output_tokens']
  const generatedSessionId = sessionId === undefined
    ? undefined
    : /(?:^|-)session-([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/i.exec(sessionId)?.[1]
  if (generatedSessionId !== undefined && typeof request['prompt_cache_key'] === 'string') {
    request['prompt_cache_key'] = generatedSessionId
  }
  return request
}

/**
 * Carry base instructions as a native developer message for the explicit
 * Codex 0.162.1 wire profile. The Session's original system message remains the
 * durable source of its text and identity; this is only a request projection.
 * Client metadata, when supplied, is copied from the captured request facts.
 * @param request - the existing ordinary or Lite Responses projection.
 * @param systemPrompt - text selected by the ordinary context conversion.
 * @param options - captured request history and optional one-shot override.
 * @returns a detached payload with no top-level instructions field.
 */
function codex01621BaseInput(
  request: Record<string, unknown>,
  systemPrompt: string | undefined,
  options: GenerateOptions,
): Record<string, unknown> {
  const { instructions: _instructions, ...existing } = orderCodex01621Tools(request, 'codex-0.162.1')
  const metadata = options.codexfulResponses?.clientMetadata
  const capturedSessionId = metadata?.['session_id']
  const projected = {
    ...existing,
    ...metadata === undefined ? {} : { client_metadata: { ...metadata } },
    // Codex 0.162.1's default cache affinity is its captured logical session.
    // Only project an existing cache key: an explicit disabled cache stays off.
    ...capturedSessionId !== undefined && capturedSessionId.length > 0
      && typeof request['prompt_cache_key'] === 'string'
      ? { prompt_cache_key: capturedSessionId } : {},
  }
  const input = Array.isArray(request['input']) ? request['input'] : []
  // Lite already supplied a base prefix. Replace that projection rather than
  // duplicating it; retain its protocol-specific metadata and other prefixes.
  const liteBase = input.find((item: unknown) => isRecord(item)
    && isRecord(item['internal_chat_message_metadata_passthrough'])
    && Array.isArray(item['internal_chat_message_metadata_passthrough']['content_item_kinds'])
    && item['internal_chat_message_metadata_passthrough']['content_item_kinds'].includes('model.base_instructions'))
  const history = liteBase === undefined ? input : input.filter((item: unknown) => item !== liteBase)
  if (systemPrompt === undefined || systemPrompt.length === 0) return { ...projected, input: history }
  const first = options.messages[0]
  const source = options.system === undefined && first?.role === 'system' ? first : undefined
  const texts = source === undefined ? [systemPrompt]
    : source.content.flatMap(block => block.type === 'text' ? [block.text] : [])
  const base: Record<string, unknown> = {
    ...isRecord(liteBase) ? liteBase : {},
    type: 'message',
    role: 'developer',
    content: texts.map(text => ({ type: 'input_text', text })),
  }
  if (source !== undefined) base['id'] = `msg_${responseItemIdBase(source.id)}`
  else delete base['id'] // One-shot overrides have no durable message identity.
  return { ...projected, input: [base, ...history] }
}

/**
 * The profile default this exact model can actually take, for DESCRIBING it.
 * A configured level the model does not support yields none rather than
 * throwing: `resolveModel` builds the model catalog, and a catalog that fails
 * takes its whole provider out of every picker — so one mis-set profile field
 * would hide every model on the route, including the ones that support the
 * level. The request path still refuses, which is where a bad configuration
 * belongs: describing what a model can do must not fail because a deployment
 * asked it for something it cannot.
 * @param model - the resolved model descriptor.
 * @param effort - the profile's configured level, if any.
 * @returns the level when this model supports it, otherwise undefined.
 */
function describableReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  return getSupportedThinkingLevels(model).some(level => level === effort)
    ? effort as ModelThinkingLevel
    : undefined
}

/** Validate an explicit Harness/profile effort without invoking pi-ai's clamp. */
function resolveReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  const supported = getSupportedThinkingLevels(model)
  if (supported.some(level => level === effort)) return effort as ModelThinkingLevel
  throw new LlmError(
    `pi-ai provider "${model.provider}" model "${model.id}" does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/**
 * Selectable reasoning efforts for one model, or nothing at all.
 *
 * A model that carries no reasoning metadata — every hand-declared one, and
 * every catalog model pi-ai marks as non-reasoning — is reported by pi-ai as
 * supporting the single level `off`. Passing that through would offer a control
 * that cannot do what it says: `off` is translated to *omitting* the reasoning
 * option, which for such a model is byte-for-byte the same request as naming no
 * effort — so a provider whose own default is to think would keep thinking with
 * `off` selected. Omitting `reasoning` entirely is the seam's way of saying the
 * capability is unavailable, which leaves the surface offering only the
 * provider's default.
 * @param model - the resolved model descriptor.
 * @param defaultLevel - the profile's configured effort, already validated.
 * @returns the `reasoning` field, or an empty object when none can be offered.
 */
function reasoningInfo(
  model: Model<Api>,
  defaultLevel: ModelThinkingLevel | undefined,
): Pick<LlmResolvedModelInfo, 'reasoning'> | Record<string, never> {
  if (!model.reasoning) return {}
  const levels = getSupportedThinkingLevels(model)
  return {
    reasoning: {
      efforts: levels.map(level => ({
        id: ReasoningEffortId(level),
        name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
      })),
      ...defaultLevel === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultLevel) },
    },
  }
}

/** Merge deployment headers while removing case-insensitive attribution collisions. */
function requestHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const attribution = attributionHeaders()
  const reserved = new Set(Object.keys(attribution).map(name => name.toLowerCase()))
  return {
    ...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase()))),
    ...attribution,
  }
}

/** Add the Lite transport header only for a logged and route-supported Lite request. */
function responsesHeaders(headers: Readonly<Record<string, string>> | undefined, lite: boolean): Record<string, string> {
  const result = requestHeaders(headers)
  return lite ? {
    ...Object.fromEntries(Object.entries(result).filter(([name]) =>
      name.toLowerCase() !== 'x-openai-internal-codex-responses-lite')),
    'x-openai-internal-codex-responses-lite': 'true',
  } : result
}

/**
 * pi-ai-backed multi-provider adapter. Each operation reads the current
 * profiles, so a configuration change reaches the next request without a
 * restart; model descriptors come from the collection those profiles built.
 */
export class PiAiAdapter extends LlmAdapter {
  private snapshot: PiAiSnapshot | undefined

  constructor(private readonly config: PiAiAdapterOptions) {
    super()
  }

  /**
   * The snapshot for the current profiles. Resolution memoizes its result, so
   * an unchanged configuration is recognized by identity; a changed one gets a
   * brand-new collection, leaving any snapshot an operation already captured
   * untouched for as long as that operation holds it.
   */
  private current(): PiAiSnapshot {
    const profiles = this.config.profiles()
    if (this.snapshot?.profiles === profiles) return this.snapshot
    const models: MutableModels = createModels(this.config.auth)
    for (const profile of profiles.values()) {
      if (profile.piProvider !== undefined) models.setProvider(profile.piProvider)
    }
    this.snapshot = { profiles, models }
    return this.snapshot
  }

  /** The profile for one route within one snapshot, or the not-owned failure. */
  private profileOf(snapshot: PiAiSnapshot, provider: string): ResolvedPiAiProviderProfile {
    const profile = snapshot.profiles.get(provider)
    if (profile === undefined) {
      throw new LlmError(`pi-ai adapter does not own provider "${provider}"`, 'NO_ADAPTER')
    }
    return profile
  }

  /** The configured descriptor for one exact route/model pair within one snapshot. */
  private modelOf(snapshot: PiAiSnapshot, provider: string, model: string): Model<Api> {
    const profile = this.profileOf(snapshot, provider)
    const failure = profile.modelErrors.get(model)
      ?? (profile.piProvider === undefined ? profile.catalogError : undefined)
    if (failure !== undefined) throw new LlmError(failure, 'INVALID_CONFIG')
    const resolved = snapshot.models.getModel(provider, model)
    if (resolved === undefined) {
      throw new LlmError(`pi-ai provider "${provider}" has no configured model "${model}"`, 'UNKNOWN_MODEL')
    }
    return resolved
  }

  override providerInfo(provider: string): LlmProviderInfo {
    // The configured name, not the route key: `displayName` exists so a
    // deployment can label a route, and a label only the configuration surface
    // reads would leave every selector showing the raw key.
    return { id: provider, name: this.current().profiles.get(provider)?.displayName ?? provider }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.current().profiles.get(provider)?.retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve().then(() => this.modelsInfo(this.current(), provider))
  }

  private modelsInfo(snapshot: PiAiSnapshot, provider: string): readonly LlmModelInfo[] {
    const profile = this.profileOf(snapshot, provider)
    return snapshot.models.getModels(provider).map(model => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: [...model.input],
      ...this.catalogMetadata(profile, model.id),
    }))
  }

  /** Detach explicit catalog policy without inventing fields the installed catalog omits. */
  private catalogMetadata(
    profile: ResolvedPiAiProviderProfile,
    model: string,
  ): Pick<LlmModelInfo, 'showInPicker' | 'multiAgentVersion' | 'serviceTiers'> {
    const metadata = profile.modelMetadata.get(model)
    return metadata === undefined ? {} : {
      ...metadata,
      ...metadata.serviceTiers === undefined ? {} : { serviceTiers: [...metadata.serviceTiers] },
    }
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve().then(() => {
      const snapshot = this.current()
      return this.modelInfo(snapshot, provider, model)
    })
  }

  private modelInfo(snapshot: PiAiSnapshot, provider: string, model: string): LlmResolvedModelInfo {
    const profile = this.profileOf(snapshot, provider)
    const resolvedModel = this.modelOf(snapshot, provider, model)
    const defaultLevel = describableReasoningLevel(resolvedModel, profile.reasoning)
    // Only a cap the deployment configured is a request default; the
    // catalog's `maxTokens` sizes the model and stops there.
    const configuredMaxTokens = profile.configuredMaxTokens.get(model)
    const responsesLite = supportsCodexResponsesLite(profile.codexResponsesLite, resolvedModel)
      && resolvedModel.reasoning && supportsNativeDeveloperRole(resolvedModel)
    return {
      provider,
      id: model,
      name: resolvedModel.name,
      inputModalities: [...resolvedModel.input],
      ...this.catalogMetadata(profile, model),
      context: { contextWindow: resolvedModel.contextWindow },
      ...configuredMaxTokens === undefined ? {} : { defaultMaxTokens: configuredMaxTokens },
      ...responsesLite ? { codexResponsesLite: true as const } : {},
      ...resolvedModel.api === 'openai-responses'
        && (!responsesLite || profile.codexResponsesLite === 'namespaced')
        ? { toolNamespaces: 'native' as const } : {},
      ...reasoningInfo(resolvedModel, defaultLevel),
    }
  }

  override prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return Promise.resolve(this.prepareWithSnapshot(this.current(), provider, model))
  }

  /** Recompute model-specific wire capabilities without reading a newer profile snapshot. */
  private prepareWithSnapshot(snapshot: PiAiSnapshot, provider: string, model: string): PreparedAdapterCall {
    const descriptor = this.modelOf(snapshot, provider, model)
    return {
      model: this.modelInfo(snapshot, provider, model),
      ...supportsNativeDeveloperRole(descriptor)
        ? { developerHistory: 'native' as const }
        : {},
      listModels: () => Promise.resolve().then(() => this.modelsInfo(snapshot, provider)),
      resolveModel: lookup => Promise.resolve().then(() => this.modelInfo(snapshot, provider, lookup)),
      withModel: (lookup, signal) => Promise.resolve().then(() => {
        signal?.throwIfAborted()
        return this.prepareWithSnapshot(snapshot, provider, lookup)
      }),
      stream: options => this.streamWithSnapshot(options, snapshot),
    }
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamWithSnapshot(options, this.current())
  }

  private async * streamWithSnapshot(
    options: GenerateOptions,
    snapshot: PiAiSnapshot,
  ): AsyncIterable<StreamChunk> {
    const timing = (phase: Parameters<NonNullable<GenerateOptions['onRequestTiming']>>[0]['phase']): void => {
      options.onRequestTiming?.({ phase, time: Date.now() })
    }
    timing('adapter-start')
    if (options.stop !== undefined) {
      throw new LlmError('llm-pi-ai does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    }
    // One capture per stream call, taken before any await: the profile, the
    // model descriptor, and the collection all come from the same immutable
    // snapshot, and the credential freezes with them. A configuration change
    // mid-request builds a separate snapshot, so this request finishes under
    // the one it started with and the next call picks up the new one.
    const profile = this.profileOf(snapshot, options.provider)
    const model = this.modelOf(snapshot, options.provider, options.model)
    const reasoning = resolveReasoningLevel(
      model,
      options.reasoningEffort ?? profile.reasoning,
    )
    const apiKey = await this.config.resolveApiKey(options.provider, profile)
    timing('credentials-ready')

    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    const streamIdleTimeoutMs = profile.streamIdleTimeoutMs
    using watchdog = idleWatchdog(upstream, streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')

    try {
      const freeformInput = options.tools?.some(tool => tool.kind === 'freeform') === true
        || options.messages.some(message => message.role === 'tool' && message.source.toolKind === 'freeform'
          || message.content.some(block => block.type === 'tool-call' && block.kind === 'freeform'))
      if (freeformInput && (!['openai-responses', 'azure-openai-responses', 'openai-codex-responses'].includes(model.api)
        || model.compat === undefined || !('supportsOpenAIGrammarTools' in model.compat)
        || !model.compat.supportsOpenAIGrammarTools)) {
        throw new LlmError('This provider route does not support native freeform grammar tools', 'UNSUPPORTED_OPTION')
      }
      const containsImage = options.messages.some(message => contentHasImage(message.content))
      if (containsImage && !model.input.includes('image')) {
        throw new LlmError(`pi-ai model "${model.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
      }
      const attachments = containsImage ? this.config.resolveAttachments?.() : undefined
      if (containsImage && attachments === undefined) {
        throw new LlmError('pi-ai image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
      }
      const onReplayDegrade = (reason: string): void => {
        this.config.onReplayDegrade?.({ provider: options.provider, model: options.model, reason })
      }
      const hosted = profile.backendHostedTools?.includes('web_search') === true
        ? new HostedResponsesCapture(options.provider, model.id) : undefined
      if (hosted !== undefined && model.api !== 'openai-responses') {
        throw new LlmError('Backend-hosted web_search requires openai-responses', 'UNSUPPORTED_OPTION')
      }
      for (const message of options.messages) {
        if (message.role === 'assistant' && message.content.some(block => block.type === 'provider-output')
          && (hosted === undefined || message.source.provider !== options.provider || message.source.model !== model.id)) {
          onReplayDegrade('backend-hosted output is retained durably but cannot be replayed on this different or non-hosted route')
        }
      }
      const nativeDeveloperHistory = supportsNativeDeveloperRole(model)
      const developerHistory = prepareDeveloperHistory(options.messages, nativeDeveloperHistory)
      const contextOptions = developerHistory.replacements.length === 0
        ? options
        : { ...options, messages: developerHistory.messages }
      const context = attachments === undefined
        ? toPiContext(contextOptions, undefined, onReplayDegrade)
        : await toPiContext({ ...contextOptions, signal: watchdog.signal }, {
          attachments,
          resolveImageAccess: ref => this.config.resolveImageAccess?.(attachments, ref),
          maxRequestImageBytes: profile.maxRequestImageBytes,
          requestImagePolicy: {
            maxPixels: profile.requestImagePixelBudget,
            maxBytes: profile.requestImageMaxBytes,
          },
        }, onReplayDegrade)
      timing('images-ready')
      const codexfulResponses = options.codexfulResponses
      const routeSupportsLite = supportsCodexResponsesLite(profile.codexResponsesLite, model)
        && model.reasoning && supportsNativeDeveloperRole(model)
      if (codexfulResponses?.lite === true && !routeSupportsLite) {
        throw new LlmError('This provider route does not support Codex Responses Lite', 'UNSUPPORTED_OPTION')
      }
      const namespacedTools = options.tools?.some(tool => tool.namespace !== undefined) ?? false
      if (namespacedTools && (codexfulResponses === undefined || model.api !== 'openai-responses'
        || (codexfulResponses.lite === true && profile.codexResponsesLite !== 'namespaced'))) {
        throw new LlmError('This provider route does not support namespaced tools', 'UNSUPPORTED_OPTION')
      }
      const requestContext = codexfulResponses !== undefined && model.api === 'openai-responses'
        ? codexfulResponseHistory(context, options) : context
      const onPayload = (payload: unknown): Record<string, unknown> => {
        const native = hosted !== undefined && model.api === 'openai-responses'
          ? hostedResponsesPayload(payload, requestContext, model, options.purpose !== 'compaction') : undefined
        if (native !== undefined && options.purpose !== 'compaction' && profile.backendWebSearchExternalAccess !== undefined) {
          const tools = native.payload['tools']
          if (Array.isArray(tools)) native.payload = { ...native.payload, tools: tools.map((tool: unknown) =>
            isRecord(tool) && tool['type'] === 'web_search'
              ? { ...tool, external_web_access: profile.backendWebSearchExternalAccess } : tool) }
        }
        const developerPayload = restoreDeveloperInput(
          native?.payload ?? payload, developerHistory.replacements,
          codexfulResponses !== undefined && model.api === 'openai-responses',
        )
        if (codexfulResponses === undefined) return native === undefined ? developerPayload
          : restoreHostedOriginals(developerPayload, native.originals)
        const standard = codexfulResponsesPayload(
          developerPayload, codexfulResponses.omitDefaultMaxTokens,
          codexfulResponses.reasoningSummary, options.purpose === 'compaction', options.sessionId,
          context.systemPrompt, model.reasoning && nativeDeveloperHistory
            ? 'developer'
            : 'system',
        )
        const strict = codexfulResponses.strictModelInput === true
          ? groupStrictCodexfulInput(standard, options.messages)
          : standard
        const agentInput = codexfulAgentMessageInput(strict, options.messages)
        const projected = codexfulResponses.lite === true
          ? responsesLitePayload(agentInput, context.systemPrompt, options.sessionId,
            options.tools ?? [], profile.codexResponsesLite === 'namespaced' ? 'namespaced' : 'flat')
          : namespacedTools ? ordinaryNamespaceToolsPayload(agentInput, options.tools ?? []) : agentInput
        const result = codexfulResponses.wireProfile === 'codex-0.162.1'
          ? codex01621BaseInput(projected, context.systemPrompt, options)
          : projected
        const restored = native === undefined ? result : restoreHostedOriginals(result, native.originals)
        // Restoration owns provider facts; projection owns this explicit wire
        // representation. Project after restoration too, so valid provider IDs
        // cannot accidentally reintroduce nullable or non-Message fields.
        const wire = codexfulResponses.wireProfile === 'codex-0.162.1' && Array.isArray(restored['input'])
          ? { ...restored, input: restored['input'].map(item => codexfulResponseInputItem(item, true)) }
          : restored
        return nativeViewImagePayload(wire, options)
      }
      const timed = options.onRequestTiming !== undefined
        && ['openai-completions', 'openai-responses', 'anthropic-messages'].includes(model.api)
        ? timedFetch(options.onRequestTiming) : undefined
      const nativeFetch = codexfulResponses?.wireProfile === 'codex-0.162.1' && model.api === 'openai-responses'
        ? nativeResponseFetch(timed ?? globalThis.fetch) : timed
      const fetch = hosted === undefined ? nativeFetch : hosted.fetch(nativeFetch ?? globalThis.fetch)
      const events = snapshot.models.streamSimple(model, requestContext, {
        ...profileOptions(profile, reasoning, apiKey),
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
        ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
        onPayload: (payload) => {
          const prepared = model.api === 'openai-responses'
            && (hosted !== undefined || codexfulResponses !== undefined || developerHistory.replacements.length > 0)
            ? onPayload(payload) : undefined
          timing('body-ready')
          return prepared
        },
        ...fetch === undefined ? { onResponse: () => { timing('response-ready') } } : { fetch },
        signal: watchdog.signal,
        // Profile headers are deployment-owned; attribution names are
        // Harness-owned and therefore win collisions.
        headers: responsesHeaders(profile.headers, codexfulResponses?.lite === true),
      })
      const chunks = toStreamChunks(events, model.contextWindow, options.signal, model.id)
      const iterator = (hosted === undefined ? chunks : hosted.merge(chunks, () => consumer.abort('hosted stream consumer stopped')))[Symbol.asyncIterator]()
      let exhausted = false
      try {
        while (true) {
          const result = await watchdog.next(iterator)
          const timeout = timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT')
          if (timeout !== undefined) throw timeout
          if (result.done) {
            exhausted = true
            return
          }
          yield result.value
        }
      } finally {
        if (!exhausted) {
          consumer.abort('pi-ai stream consumer stopped')
          try {
            await iterator.return(undefined)
          } catch (_abortedSdkTeardown) {
            // The stable signal already owns SDK termination; return-time abort cannot add an outcome.
          }
        }
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined) {
        throw new LlmError(`pi-ai stream idle timeout after ${streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error })
      }
      if (options.signal?.aborted) {
        throw new LlmError('pi-ai request aborted by caller', 'ABORTED', { cause: error })
      }
      throw error
    } finally {
      consumer.abort('pi-ai stream consumer stopped')
    }
  }
}
