/**
 * Codex multi-agent v2 tool names over DSH's continuable child Sessions.
 * This entry is opt-in because the pinned Codex source does not enable v2 for
 * every model and DSH's child lifecycle is not identical to Codex threads.
 * @module @codexydsh/subagents/codexful-v2
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@codexydsh/runtime/agent'
import { CODEX_EXPLICIT_MULTI_AGENT_MODE, CODEX_PROACTIVE_MULTI_AGENT_MODE } from '@codexydsh/runtime'
import type { CodexMultiAgentWorldStateSource, CodexWorldStateSource } from '@codexydsh/runtime'
import { ReasoningEffortId, createDeveloperMessage, createSystemMessage, createUserMessage } from '@codexydsh/runtime/llm'
import type { ContextFormed } from '@codexydsh/runtime/llm'
import { SessionId } from '@codexydsh/runtime/session'
import { defineTool, type ValueSchemaSpec } from '@codexydsh/tool-schema'
import type { NumberValueSchemaSpec, StringValueSchemaSpec, ToolDefinition, ToolSchemaRequest } from '@codexydsh/tool-schema'
import type {} from '@codexydsh/delegation'
import { renderCodexfulV2Role } from './codexful-v2-role.ts'
import { buildSpecs, resolveSpecOptions } from './codexful-v2-spec.ts'
import type { CatalogModel, FunctionSpec, ToolName } from './codexful-v2-spec.ts'
import { SOURCE_DEFAULTS } from './codexful-v2-source-text.ts'

export { renderCodexfulV2Role } from './codexful-v2-role.ts'
export type { CodexfulV2RoleInput } from './codexful-v2-role.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'runtime-context': {
      kind: 'runtime-context'
      readonly codexWorldState?: CodexWorldStateSource
      readonly codexMultiAgentWorldState?: CodexMultiAgentWorldStateSource
    } & ContextFormed
  }
}

export const name = 'tool-subagent-codexful-v2'
export const inject = ['tools', 'codexySubagents', 'agents', 'agentLoop', 'sessionProjections', 'codexyPrompt', 'codexyRequests', 'codexyTools']

type V2AgentStatus =
  | 'pending_init' | 'running' | 'interrupted' | 'shutdown' | 'not_found'
  | { completed: string | null }
  | { errored: string }

const STATUS_SCHEMA = { oneOf: [
  { type: 'string', enum: ['pending_init', 'running', 'interrupted', 'shutdown', 'not_found'] },
  { type: 'object', additionalProperties: false, properties: {
    completed: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
  } },
  { type: 'object', additionalProperties: false, properties: {
    errored: { type: 'string', required: true },
  } },
] } as const satisfies ValueSchemaSpec

interface ResidentAgent {
  readonly id: SessionId
  readonly path: string
  status: V2AgentStatus
  lastText: string | null
  pendingMail: boolean
}

/** Provider names and wait limits for the opt-in v2 adapter. */
export interface Config {
  /** Fresh in-process child provider (default `spawn`). */
  spawnProvider?: string
  /** Completed-history in-process child provider (default `fork`). */
  forkProvider?: string
  /** Maximum wait duration, in milliseconds. */
  maxWaitMs?: number
  /** Minimum wait duration, in milliseconds. */
  minWaitMs?: number
  /** Default wait duration, in milliseconds. */
  defaultWaitMs?: number
  /** Optional absolute child-depth limit; omission permits recursive v2 delegation. */
  maxDepth?: number
  /** Maximum resident agents in one root task tree, including the root. */
  maxConcurrentAgents?: number
  /** Expose child model and reasoning-effort overrides in the captured spawn schema. */
  exposeSpawnAgentModelOverrides?: boolean
}

export const Config: z<Config> = z.object({
  spawnProvider: z.string().default('spawn'),
  forkProvider: z.string().default('fork'),
  minWaitMs: z.natural().max(3_600_000).default(10_000),
  maxWaitMs: z.natural().max(3_600_000).default(3_600_000),
  defaultWaitMs: z.natural().max(3_600_000).default(30_000),
  maxDepth: z.natural().max(Number.MAX_SAFE_INTEGER),
  maxConcurrentAgents: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(4),
  exposeSpawnAgentModelOverrides: z.boolean().default(true),
})

/** Read a source-defined string property without weakening author-schema validation. */
function stringParameter(spec: FunctionSpec, key: string): StringValueSchemaSpec {
  const property = spec.parameters.properties[key]
  if (property?.type !== 'string') throw new Error(`missing string parameter ${spec.name}.${key}`)
  return { type: 'string', description: property.description,
    ...property.encrypted === undefined ? {} : { encrypted: property.encrypted } }
}

/** Read the wait property's source description with its declared number type. */
function timeoutParameter(spec: FunctionSpec): NumberValueSchemaSpec {
  const property = spec.parameters.properties.timeout_ms
  if (property?.type !== 'number') throw new Error('missing number parameter wait_agent.timeout_ms')
  return { type: 'number', description: property.description }
}

/** Canonical path for the calling agent, persisted as its child's catalog label. */
function agentPath(ctx: Context, agent: Agent): string {
  if (agent.session.header.parentSession === undefined) return '/root'
  const identity = ctx.sessionProjections.snapshot(agent.session, ['subagent']).values.subagent
  if (identity?.mode !== 'continuable' || !identity.label.startsWith('/root/')) {
    throw new Error('Codexful agent names require a continuable child created by spawn_agent')
  }
  return identity.label
}

/** Resolve the live root needed for the complete durable descendant listing. */
function rootAgent(ctx: Context, agent: Agent): Agent {
  let current = agent
  while (current.session.header.parentSession !== undefined) {
    const parent = ctx.agents.get(current.session.header.parentSession)
    if (parent === undefined) throw new Error('the root agent is no longer live')
    current = parent
  }
  return current
}

/** Read a named target from the root's durable task tree. */
async function resolveTarget(
  ctx: Context,
  caller: Agent,
  root: Agent,
  target: string,
  signal: AbortSignal,
): Promise<{ id: SessionId; path: string; parentId?: SessionId }> {
  if (target === root.id || target === '/root') return { id: root.id, path: '/root' }
  const entries = await ctx.codexySubagents.listDescendants(root.id, signal)
  const byId = entries.find(entry =>
    entry.kind === 'child' && entry.mode === 'continuable' && entry.id === target)
  const canonical = byId?.kind === 'child' && byId.mode === 'continuable'
    ? byId.label : resolveAgentPath(agentPath(ctx, caller), target)
  const row = byId ?? entries.find(entry =>
    entry.kind === 'child' && entry.mode === 'continuable'
    && entry.label === canonical)
  if (row === undefined || row.kind !== 'child' || row.mode !== 'continuable') {
    throw new Error(`agent ${JSON.stringify(target)} was not found in this task tree`)
  }
  return { id: row.id, path: row.label, parentId: row.parentId }
}

/** Exact live caller required by the subagent service's authorization checks. */
function callerOf(agent: Agent | undefined, toolName: string): Agent {
  if (agent === undefined) throw new Error(`${toolName} requires a calling agent`)
  return agent
}

/** Text is normalized once so blank tasks cannot create idle child Sessions. */
function nonempty(value: string, subject: string): string {
  if (value.trim().length === 0) throw new Error(`${subject} must not be empty`)
  return value
}

/** Apply the pinned Codex AgentPath segment rules before looking up a task name. */
function validateAgentName(name: string): void {
  if (name === '') throw new Error('agent_name must not be empty')
  if (name === 'root') throw new Error('agent_name `root` is reserved')
  if (name === '.' || name === '..') throw new Error(`agent_name \`${name}\` is reserved`)
  if (name.includes('/')) throw new Error('agent_name must not contain `/`')
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error('agent_name must use only lowercase letters, digits, and underscores')
  }
}

/** Resolve Codex's absolute or caller-relative task reference. */
function resolveAgentPath(current: string, reference: string): string {
  if (reference === '') throw new Error('agent path must not be empty')
  if (reference === '/root' || reference === '/morpheus') return reference
  const absolute = reference.startsWith('/')
  if (absolute && !reference.startsWith('/root/')) {
    throw new Error('absolute agent paths must start with `/root` or be `/morpheus`')
  }
  if (reference.endsWith('/')) {
    throw new Error(absolute ? 'absolute agent path must not end with `/`'
      : 'relative agent path must not end with `/`')
  }
  for (const segment of (absolute ? reference.slice('/root/'.length) : reference).split('/')) {
    validateAgentName(segment)
  }
  return absolute ? reference : `${current}/${reference}`
}

/** JSON text matches Codex's function-result presentation for nonempty outputs. */
function jsonText(value: object) {
  return [{ type: 'text' as const, text: JSON.stringify(value) }]
}

/** Select the current root or continuable child's model-owned role. */
function roleContext(ctx: Context, agent: Agent, maxConcurrency: number, model?: string): string {
  const child = agent.session.header.parentSession !== undefined
  const identity = child ? ctx.sessionProjections.snapshot(agent.session, ['subagent']).values.subagent : null
  if (child && (identity?.mode !== 'continuable' || !identity.label.startsWith('/root/'))) return ''
  return renderCodexfulV2Role({ child, model, maxConcurrency })
}

/** Remove inherited v2 role and mode fragments while retaining unrelated context. */
function clearInheritedRole(agent: Agent, turn: number, step: number, maxConcurrency: number): void {
  const session = agent.session
  if (session.header.parentSession === undefined || session.inheritedEventCount === 0) return
  for (const seq of session.surface.nodes) {
    if (seq >= session.inheritedEventCount) continue
    // oxlint-disable-next-line typescript/no-deprecated -- Inspect only the fork-inherited surface.
    const event = session.eventAt(seq)
    const message = event?.type === 'developer/message' ? event.data.message
      : event?.type === 'user/message' ? event.data : undefined
    const intent = { surfaceOp: { op: 'replace' as const, startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] }
    if (message === undefined || message.source.kind !== 'runtime-context') continue
    if (message.source.codexMultiAgentWorldState !== undefined) {
      session.append('system/message', { turn, step, message: createSystemMessage('') }, intent)
      continue
    }
    if (message.source.form === 'snapshot') {
      const sections = message.source.sections.filter(section =>
        section.name !== 'codexful-v2:multi-agent-role' && section.name !== 'codexful-v2:multi-agent-mode')
      if (sections.length === message.source.sections.length) continue
      if (sections.length === 0) {
        session.append('system/message', { turn, step, message: createSystemMessage('') }, intent)
        continue
      }
      const content = [{ type: 'text' as const, text: sections.map(section => section.text).join('\n\n') }]
      const source = { ...message.source, sections }
      if (event?.type === 'developer/message') {
        session.append('developer/message', { turn, step, message: createDeveloperMessage({ content, source }) }, intent)
      } else {
        session.append('user/message', createUserMessage({ content, source }), intent)
      }
    } else if (event?.type === 'user/message' && message.source.form === 'instructions') {
      const [block] = message.content
      if (message.content.length !== 1 || block?.type !== 'text') continue
      let remaining = block.text.replace(/<multi_agent_(role|mode)>[\s\S]*?<\/multi_agent_\1>/g, '')
      for (const child of [false, true]) {
        remaining = remaining.replaceAll(renderCodexfulV2Role({ child, maxConcurrency }), '')
      }
      if (remaining === block.text) continue
      if (remaining.trim().length === 0) {
        session.append('system/message', { turn, step, message: createSystemMessage('') }, intent)
        continue
      }
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: remaining }],
        source: { kind: 'runtime-context', form: 'instructions' },
      }), intent)
    }
  }
}

/** Attach the opt-in v2 tool family to one preset-scoped tool registry. */
export function apply(ctx: Context, config: Config): void {
  const minWaitMs = config.minWaitMs ?? 10_000
  const maxWaitMs = config.maxWaitMs ?? 3_600_000
  const defaultWaitMs = config.defaultWaitMs ?? 30_000
  if (minWaitMs > maxWaitMs || defaultWaitMs < minWaitMs || defaultWaitMs > maxWaitMs) {
    throw new Error('Codexful subagent wait limits must satisfy minWaitMs <= defaultWaitMs <= maxWaitMs')
  }
  const options = {
    exposeSpawnAgentModelOverrides: config.exposeSpawnAgentModelOverrides ?? true,
    defaultWaitTimeoutMs: defaultWaitMs, minWaitTimeoutMs: minWaitMs, maxWaitTimeoutMs: maxWaitMs,
  }
  const defaultSpecs = buildSpecs(resolveSpecOptions({ ...options, supportsNamespace: false }))
  const factories = new Map<ToolName, (spec: FunctionSpec) => ToolDefinition>()
  const registerPrepared = (name: ToolName, factory: (spec: FunctionSpec) => ToolDefinition): void => {
    factories.set(name, factory)
  }
  const preparedSpecs = new WeakMap<ToolSchemaRequest, Promise<FunctionSpec[]>>()
  const resolveSpecs = (request: ToolSchemaRequest): Promise<FunctionSpec[]> => {
    let pending = preparedSpecs.get(request)
    if (pending !== undefined) return pending
    pending = (async () => {
      const { provider, model } = request.variables
      if (provider === undefined || model === undefined) {
        throw new Error('Codexful v2 tool preparation requires resolved provider and model variables')
      }
      const signal = request.context.signal
      const captured = request.context.preparedModel
      signal?.throwIfAborted()
      const lookup = await Promise.allSettled([
        captured === undefined ? ctx.codexyRequests.resolveModelInfo(provider, model, signal) : Promise.resolve(captured.model),
        options.exposeSpawnAgentModelOverrides
          ? captured === undefined ? ctx.codexyRequests.listModels(provider) : captured.listModels() : Promise.resolve([]),
      ])
      const [selected, catalog] = lookup
      if (selected.status === 'rejected') throw selected.reason
      if (catalog.status === 'rejected') throw catalog.reason
      signal?.throwIfAborted()
      const visible = catalog.value.filter(entry => entry.showInPicker === true
        && entry.multiAgentVersion !== 'disabled').slice(0, SOURCE_DEFAULTS.maxModelOverrides)
      const metadata = await Promise.allSettled(visible.map(entry => entry.id === model
        ? Promise.resolve(selected.value) : captured === undefined
          ? ctx.codexyRequests.resolveModelInfo(provider, entry.id, signal) : captured.resolveModelInfo(entry.id, signal)))
      const models: CatalogModel[] = metadata.map((result, index) => {
        if (result.status === 'rejected') throw result.reason
        const entry = visible[index]
        if (entry === undefined) throw new Error('Codexful model catalog changed during preparation')
        return {
          model: entry.id, description: entry.description ?? result.value.description ?? '',
          showInPicker: true, multiAgentVersion: entry.multiAgentVersion ?? null,
          defaultReasoningEffort: result.value.reasoning?.defaultEffort ?? '',
          supportedReasoningEfforts: result.value.reasoning?.efforts.map(effort => effort.id) ?? [],
          serviceTiers: entry.serviceTiers ?? [],
        }
      })
      signal?.throwIfAborted()
      return buildSpecs(resolveSpecOptions({ ...options, models,
        supportsNamespace: selected.value.toolNamespaces === 'native' }))
    })()
    preparedSpecs.set(request, pending)
    return pending
  }
  const residents = new WeakMap<Agent, Map<SessionId, ResidentAgent>>()
  const known = new Map<SessionId, { root: Agent; entry: ResidentAgent }>()
  const rootAgentFor = (agent: Agent): Agent => {
    const retained = known.get(agent.id)?.root
    if (retained !== undefined && ctx.agents.get(retained.id) === retained) return retained
    const runtimeRoot = ctx.agents.roots().find(root => ctx.agents.isOwnedBy(agent.id, root))
    return runtimeRoot ?? rootAgent(ctx, agent)
  }
  const rootStatuses = new Map<SessionId, { status: V2AgentStatus; lastText: string | null }>()
  const admissionTails = new WeakMap<Agent, Promise<void>>()
  const residentMap = (root: Agent): Map<SessionId, ResidentAgent> => {
    let entries = residents.get(root)
    if (entries === undefined) {
      entries = new Map()
      residents.set(root, entries)
    }
    return entries
  }
  const remember = (root: Agent, id: SessionId, path: string, status: V2AgentStatus): ResidentAgent => {
    const entry = known.get(id)?.entry ?? { id, path, status, lastText: null, pendingMail: false }
    entry.status = status
    const entries = residentMap(root)
    entries.delete(id)
    entries.set(id, entry)
    known.set(id, { root, entry })
    return entry
  }
  const currentStatus = (root: Agent, id: SessionId): V2AgentStatus => {
    const entry = residentMap(root).get(id)
    if (entry === undefined) return 'not_found'
    const agent = ctx.agents.get(id)
    return agent?.status === 'running' ? 'running' : entry.status
  }
  const hasPendingMail = (agent: Agent): boolean =>
    agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0
  const rootStatus = (root: Agent): V2AgentStatus => root.status === 'running' ? 'running'
    : rootStatuses.get(root.id)?.status ?? 'pending_init'
  const assertLoadCapacity = async (root: Agent, path: string): Promise<void> => {
    const entries = residentMap(root)
    if ([...entries.values()].some(entry => entry.path === path)) return
    const limit = config.maxConcurrentAgents ?? 4
    while (entries.size + 2 > limit) {
      let evicted = false
      for (const candidate of entries.values()) {
        if (candidate.pendingMail || (candidate.status !== 'interrupted'
          && typeof candidate.status !== 'object')) continue
        const live = ctx.agents.get(candidate.id)
        if (live !== undefined) {
          const parentId = live.session.header.parentSession
          const owner = parentId === undefined ? root : ctx.agents.get(parentId) ?? root
          if (!await ctx.codexySubagents.tryUnloadCodexfulChild(owner, candidate.id)) continue
        }
        if (ctx.agents.get(candidate.id) !== undefined) continue
        entries.delete(candidate.id)
        evicted = true
        break
      }
      if (!evicted) throw new Error('collab spawn failed: agent thread limit reached')
    }
  }
  const withAdmission = async <T>(root: Agent, signal: AbortSignal,
    run: () => Promise<T>): Promise<T> => {
    const previous = admissionTails.get(root) ?? Promise.resolve()
    const next = Promise.withResolvers<void>()
    admissionTails.set(root, next.promise)
    await previous
    try {
      signal.throwIfAborted()
      return await run()
    } finally {
      next.resolve()
      if (admissionTails.get(root) === next.promise) admissionTails.delete(root)
    }
  }
  ctx.codexyPrompt.context({
    name: 'codexful-v2:multi-agent-role',
    order: ctx.codexyPrompt.getContextOrder('SUBAGENT_DELEGATION') + 10,
    role: 'developer',
    text: context => context.agent === undefined ? ''
      : roleContext(ctx, context.agent, config.maxConcurrentAgents ?? 4),
  })
  ctx.on('codexy-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    if (context.agent === undefined) return assembled
    const role = roleContext(ctx, context.agent, config.maxConcurrentAgents ?? 4, assembled.variables.model)
    const collaboration = defaultSpecs.flatMap(spec => assembled.tools.filter(tool => tool.name === spec.name))
    let index = 0
    const tools = assembled.tools.map((tool) => {
      if (!defaultSpecs.some(spec => spec.name === tool.name)) return tool
      const ordered = collaboration[index++]
      if (ordered === undefined) throw new Error('Codexful tool ordering changed during assembly')
      return ordered
    })
    return { ...assembled, tools, contexts: assembled.contexts.map(section =>
      section.name === 'codexful-v2:multi-agent-role' ? { ...section, text: role } : section) }
  })
  ctx.on('agent/created', ({ agent }) => {
    const parentSession = agent.session.header.parentSession
    const identity = parentSession === undefined ? null
      : ctx.sessionProjections.snapshot(agent.session, ['subagent']).values.subagent
    if (parentSession !== undefined
      && (identity?.mode !== 'continuable' || typeof identity.label !== 'string'
        || !identity.label.startsWith('/root/'))) return
    agent.ctx.effect(
      () => ctx.agentLoop.enableCodexMultiAgentMode(agent,
        (request, tools) => tools.some(tool => tool.name === 'spawn_agent')
          ? request.reasoningEffort === 'ultra' ? CODEX_PROACTIVE_MULTI_AGENT_MODE : CODEX_EXPLICIT_MULTI_AGENT_MODE
          : undefined),
      'codexful-v2.multiAgentMode',
    )
    if (parentSession === undefined || identity?.mode !== 'continuable' || typeof identity.label !== 'string') return
    const parent = ctx.agents.get(parentSession)
    remember(parent === undefined ? rootAgentFor(agent) : rootAgentFor(parent), agent.id, identity.label,
      known.get(agent.id)?.entry.status ?? 'pending_init').pendingMail = hasPendingMail(agent)
    agent.ctx.effect(
      () => ctx.agentLoop.enableDeveloperInterruptedTurnMarker(agent),
      'codexful-v2.developerInterruptedTurnMarker',
    )
  })
  const refreshPendingMail = ({ agent }: { agent: Agent }): void => {
    const entry = known.get(agent.id)?.entry
    if (entry !== undefined) entry.pendingMail = hasPendingMail(agent)
  }
  ctx.on('agent/inbox/claimed', refreshPendingMail)
  ctx.on('agent/inbox/discarded', refreshPendingMail)
  ctx.on('session/event', (session, event) => {
    const entry = known.get(session.id)?.entry ?? (session.header.parentSession === undefined
      ? rootStatuses.get(session.id) ?? { status: 'pending_init', lastText: null }
      : undefined)
    if (entry === undefined) return
    if (session.header.parentSession === undefined) rootStatuses.set(session.id, entry)
    if (event.type === 'turn/start') {
      entry.status = 'running'
      entry.lastText = null
    } else if (event.type === 'assistant/message') {
      entry.lastText = event.data.message.content
        .flatMap(block => block.type === 'text' ? [block.text] : []).join('') || null
    } else if (event.type === 'turn/end') {
      const reason = event.data.reason
      entry.status = reason.kind === 'completed' ? { completed: entry.lastText }
        : reason.kind === 'aborted' ? 'interrupted'
          : reason.kind === 'error' ? { errored: reason.error.message }
            : { errored: reason.kind }
    }
  })
  ctx.on('subagent/end', (info) => {
    const entry = known.get(info.id)?.entry
    if (entry === undefined) return
    entry.pendingMail = false
    if (info.stopReason === 'completed') {
      const text = info.lastAssistantMessage?.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
      entry.status = { completed: text || null }
    } else if (info.stopReason === 'aborted') {
      entry.status = 'interrupted'
    } else if (info.stopReason === 'error' && (typeof entry.status !== 'object'
      || !('errored' in entry.status))) {
      entry.status = { errored: 'subagent failed' }
    } else if (info.stopReason !== 'error') {
      entry.status = { errored: info.stopReason }
    }
  })
  ctx.on('agent/disposed', ({ agent }) => {
    if (agent.session.header.parentSession !== undefined) {
      const registered = known.get(agent.id)
      if (registered?.entry.status === 'pending_init') {
        residentMap(registered.root).delete(agent.id)
        known.delete(agent.id)
      }
      return
    }
    for (const [id, value] of known) {
      if (value.root === agent) known.delete(id)
    }
    residents.delete(agent)
    rootStatuses.delete(agent.id)
  })
  ctx.on('codexy-agent/request', async ({ agent, turn, step }, next) => {
    clearInheritedRole(agent, turn, step, config.maxConcurrentAgents ?? 4)
    return next()
  })

  registerPrepared('spawn_agent', spec => defineTool({
    name: 'spawn_agent',
    description: spec.description,
    ...spec.namespace === undefined ? {} : { namespace: spec.namespace },
    closedParameters: true,
    requiredOrder: ['task_name', 'message'],
    parameters: {
      fork_turns: stringParameter(spec, 'fork_turns'),
      message: { ...stringParameter(spec, 'message'), required: true },
      ...Object.hasOwn(spec.parameters.properties, 'model') ? {
        model: stringParameter(spec, 'model'),
        reasoning_effort: stringParameter(spec, 'reasoning_effort'),
      } : {},
      task_name: { ...stringParameter(spec, 'task_name'), required: true },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        task_name: { type: 'string', required: true },
      } },
      render: (_args, value) => jsonText(value),
      codeModeResult: (_args, value) => value,
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = callerOf(exec.agent, 'spawn_agent')
      validateAgentName(args.task_name)
      nonempty(args.message, 'message')
      const forkTurns = args.fork_turns?.trim().toLowerCase() || 'all'
      const lastNTurns = forkTurns === 'all' || forkTurns === 'none' ? undefined : Number(forkTurns)
      if (lastNTurns !== undefined && (!/^\+?\d+$/.test(forkTurns)
        || !Number.isSafeInteger(lastNTurns) || lastNTurns <= 0)) {
        throw new Error('fork_turns must be `none`, `all`, or a positive integer string')
      }
      if (forkTurns === 'all' && (args.model !== undefined || args.reasoning_effort !== undefined)) {
        throw new Error('full-history forks inherit the parent model and reasoning effort; use fork_turns `none` for overrides')
      }
      const taskName = `${agentPath(ctx, parent)}/${args.task_name}`
      const root = rootAgentFor(parent)
      return withAdmission(root, exec.signal, async () => {
        const entries = await ctx.codexySubagents.listDescendants(root.id, exec.signal)
        const continuable = entries.filter(entry => entry.kind === 'child' && entry.mode === 'continuable')
        if (continuable.some(child => child.label === taskName)) {
          throw new Error(`agent ${taskName} already exists`)
        }
        await assertLoadCapacity(root, taskName)
        const provider = forkTurns === 'none' ? config.spawnProvider ?? 'spawn' : config.forkProvider ?? 'fork'
        const maxDepth = config.maxDepth
        await ctx.codexySubagents.startContinuable({
          provider,
          label: taskName,
          codexfulTask: true,
          request: {
            parent,
            prompt: [{ type: 'text', text: args.message }],
            delegatedApprovalPolicy: 'inherit',
            ...lastNTurns === undefined ? {} : { forkTurns: lastNTurns },
            ...args.model === undefined && args.reasoning_effort === undefined ? {} : {
              agentOptions: {
                ...args.model === undefined ? {} : { model: args.model },
                ...args.reasoning_effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(args.reasoning_effort) },
              },
            },
            ...maxDepth === undefined ? {} : { maxDepth },
          },
          signal: exec.signal,
        })
        return { task_name: taskName }
      })
    },
  }))

  const registerMessageTool = (toolName: 'send_message' | 'followup_task', delivery: 'queue-only' | 'steer'): void => {
    registerPrepared(toolName, spec => defineTool({
      name: toolName,
      description: spec.description,
      ...spec.namespace === undefined ? {} : { namespace: spec.namespace },
      closedParameters: true,
      requiredOrder: ['target', 'message'],
      parameters: {
        message: { ...stringParameter(spec, 'message'), required: true },
        target: { ...stringParameter(spec, 'target'), required: true },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: {} },
        render: () => [{ type: 'text', text: '' }],
        codeModeResult: (_args, value) => value,
      },
      async execute(args, exec) {
        const caller = callerOf(exec.agent, toolName)
        nonempty(args.message, 'message')
        const root = rootAgentFor(caller)
        const target = await resolveTarget(ctx, caller, root, args.target, exec.signal)
        if (delivery === 'steer' && target.path === '/root') {
          throw new Error("follow-up tasks can't target the root agent")
        }
        const deliver = async (): Promise<Record<string, never>> => {
          if (target.path !== '/root') await assertLoadCapacity(root, target.path)
          await ctx.codexySubagents.sendMessage(caller, target.id, [{ type: 'text', text: args.message }], {
            signal: exec.signal,
            delivery,
            routing: 'codexful-task-tree',
          })
          if (target.path !== '/root') {
            const previous = known.get(target.id)?.entry.status ?? 'pending_init'
            const live = ctx.agents.get(target.id)
            remember(root, target.id, target.path, previous).pendingMail = live === undefined
              ? delivery === 'queue-only' : hasPendingMail(live)
          }
          return {}
        }
        return target.path === '/root' ? deliver() : withAdmission(root, exec.signal, deliver)
      },
    }))
  }
  registerMessageTool('send_message', 'queue-only')
  registerMessageTool('followup_task', 'steer')

  registerPrepared('interrupt_agent', spec => defineTool({
    name: 'interrupt_agent',
    description: spec.description,
    ...spec.namespace === undefined ? {} : { namespace: spec.namespace },
    closedParameters: true,
    parameters: { target: { ...stringParameter(spec, 'target'), required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        previous_status: { ...STATUS_SCHEMA, required: true },
      } },
      render: (_args, value) => jsonText(value),
      codeModeResult: (_args, value) => value,
    },
    async execute(args, exec) {
      const caller = callerOf(exec.agent, 'interrupt_agent')
      const root = rootAgentFor(caller)
      const target = await resolveTarget(ctx, caller, root, args.target, exec.signal)
      if (target.path === '/root') throw new Error('root is not a spawned agent')
      if (target.id === caller.id) throw new Error('an agent cannot interrupt itself')
      const previous = currentStatus(root, target.id)
      // resolveTarget already checked the same root tree; the live root is an
      // actual ancestor of every resident target and owns cancellation there.
      ctx.codexySubagents.interrupt(target.id, { kind: 'ancestor', agent: root, intent: 'tool' })
      return { previous_status: previous }
    },
  }))

  registerPrepared('list_agents', spec => defineTool({
    name: 'list_agents',
    description: spec.description,
    ...spec.namespace === undefined ? {} : { namespace: spec.namespace },
    closedParameters: true,
    parameters: { path_prefix: stringParameter(spec, 'path_prefix') },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        agents: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          agent_name: { type: 'string', required: true },
          agent_status: { ...STATUS_SCHEMA, required: true },
        } } },
      } },
      render: (_args, value) => jsonText(value),
      codeModeResult: (_args, value) => value,
    },
    execute(args, exec) {
      const caller = callerOf(exec.agent, 'list_agents')
      const root = rootAgentFor(caller)
      const prefix = args.path_prefix === undefined ? undefined
        : resolveAgentPath(agentPath(ctx, caller), args.path_prefix)
      const matches = (path: string): boolean => prefix === undefined
        || path === prefix || path.startsWith(`${prefix}/`)
      const agents = [
        ...matches('/root') ? [{ agent_name: '/root', agent_status: rootStatus(root) }] : [],
        ...[...residentMap(root).values()].filter(entry => matches(entry.path))
          .map(entry => ({ agent_name: entry.path, agent_status: currentStatus(root, entry.id) })),
      ]
      agents.sort((left, right) => left.agent_name < right.agent_name ? -1
        : left.agent_name > right.agent_name ? 1 : 0)
      return Promise.resolve({ agents })
    },
  }))

  registerPrepared('wait_agent', spec => defineTool({
    name: 'wait_agent',
    description: spec.description,
    ...spec.namespace === undefined ? {} : { namespace: spec.namespace },
    closedParameters: true,
    parameters: { timeout_ms: timeoutParameter(spec) },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        message: { type: 'string', required: true },
        timed_out: { type: 'boolean', required: true },
      } },
      render: (_args, value) => jsonText(value),
      codeModeResult: (_args, value) => value,
    },
    async execute(args, exec) {
      const caller = callerOf(exec.agent, 'wait_agent')
      const requested = args.timeout_ms
      if (requested !== undefined && (!Number.isSafeInteger(requested) || requested > maxWaitMs)) {
        throw new Error(`timeout_ms must be a safe integer at most ${maxWaitMs}`)
      }
      const timeoutMs = requested === undefined ? defaultWaitMs : Math.max(requested, minWaitMs)
      const classify = (kind: string | undefined): 'message' | 'steered' | undefined => {
        if (kind === 'agent-message' || kind === 'subagent-settled') return 'message'
        if (kind === 'user') return 'steered'
        return undefined
      }
      const outcome = await new Promise<'message' | 'steered' | 'timeout'>((resolve, reject) => {
        let settled = false
        let off = (): void => {}
        const timer = setTimeout(() => { finish('timeout') }, timeoutMs)
        const finish = (value: 'message' | 'steered' | 'timeout'): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          off()
          exec.signal.removeEventListener('abort', onAbort)
          resolve(value)
        }
        const onAbort = (): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          off()
          reject(new Error('wait_agent was aborted'))
        }
        off = ctx.on('agent/inbox/inserted', ({ agent, message }) => {
          if (agent !== caller) return
          const kind = classify(message.source.kind)
          if (kind !== undefined) finish(kind)
        })
        exec.signal.addEventListener('abort', onAbort, { once: true })
        if (exec.signal.aborted) onAbort()
        const pending = [...caller.inbox.nextStep, ...caller.inbox.nextTurn]
          .map(message => classify(message.source.kind)).find(kind => kind !== undefined)
        if (pending !== undefined) finish(pending)
      })
      const message = outcome === 'timeout' ? 'Wait timed out.'
        : outcome === 'steered' ? 'Wait interrupted by new input.' : 'Wait completed.'
      const clamped = requested !== undefined && requested < timeoutMs
        ? `\n\nRequested timeout of ${requested}ms was clamped to the minimum of ${timeoutMs}ms.` : ''
      return { message: `${message}${clamped}`, timed_out: outcome === 'timeout' }
    },
  }))
  for (const spec of defaultSpecs) {
    const factory = factories.get(spec.name)
    if (factory === undefined) throw new Error(`missing Codexful tool factory ${spec.name}`)
    const definition = factory(spec)
    definition.resolveRequest = async (request) => {
      if (request.variables.codexful_multi_agent_version === 'v1') return definition
      const resolved = (await resolveSpecs(request)).find(item => item.name === spec.name)
      if (resolved === undefined) throw new Error(`missing captured Codexful tool ${spec.name}`)
      return factory(resolved)
    }
    ctx.codexyTools.register(definition)
  }

}
