import { appendProductEvent, projectProductEvents } from '@codexydsh/runtime/session'
/**
 * Codex multi_agent_v1 calls over durable, continuable child Sessions.
 * The parent Session's successful tool results record the logical open roster;
 * an in-process overlay covers calls before their results enter that log.
 * @module @codexydsh/subagents/codex-v1
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@codexydsh/runtime/llm'
import type { ContentBlock, LlmResolvedModelInfo } from '@codexydsh/runtime/llm'
import { SessionId } from '@codexydsh/runtime/session'
import type { SessionEvent } from '@codexydsh/runtime/session'
import { defineTool } from '@codexydsh/tool-schema'
import type { ToolDefinition, ToolSchemaRequest, ValueSchemaSpec } from '@codexydsh/tool-schema'
import { codexV1IdentityOf, resolveChildAgentOptions } from '@codexydsh/delegation'
import type {} from '@deepseek-ai/dsh-session-query'
import { codexV1SpawnDescription } from './codex-v1-spawn-description.ts'
import {
  acquireCodexV1NicknameRegistry,
  CODEX_V1_NICKNAMES,
  codexV1NicknamesFromLog,
} from './codex-v1-nicknames.ts'

export { codexV1ClosedAgentsFromLog, codexV1LiveNicknames, codexV1LiveRoster, codexV1NicknamesFromLog } from './codex-v1-nicknames.ts'

/** Cordis plugin name for the opt-in v1 tool family. */
export const name = 'tool-subagent-codex-v1'
/** Services required to register v1 tools and read durable child Sessions. */
export const inject = ['tools', 'codexySubagents', 'agents', 'sessionQuery', 'sessionProjections', 'codexyRequests', 'codexyTools']

/** Provider selection and v1 roster and wait limits. */
export interface Config {
  /** Explicit pinned CLI catalog wording; does not change provider/model admission. */
  spawnDescriptionWireProfile?: 'codex-0.162.1'
  /** Provider for a child without inherited history; default `spawn`. */
  spawnProvider?: string
  /** Provider for a full-history child; default `fork`. */
  forkProvider?: string
  /** Maximum child depth, `0` or `1`; default `1`. */
  maxDepth?: number
  /** Maximum logically open children of one parent; default `6`. */
  maxOpenAgents?: number
  /** Minimum wait in milliseconds; default `10000`. */
  minWaitMs?: number
  /** Maximum wait in milliseconds; default `3600000`. */
  maxWaitMs?: number
  /** Wait when omitted, in milliseconds; default `30000`. */
  defaultWaitMs?: number
}

/** Validated deployment settings for the v1 adapter. */
export const Config: z<Config> = z.object({
  spawnDescriptionWireProfile: z.union(['codex-0.162.1'] as const),
  spawnProvider: z.string().default('spawn'),
  forkProvider: z.string().default('fork'),
  maxDepth: z.natural().max(1).default(1),
  maxOpenAgents: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(6),
  minWaitMs: z.natural().max(3_600_000).default(10_000),
  maxWaitMs: z.natural().max(3_600_000).default(3_600_000),
  defaultWaitMs: z.natural().max(3_600_000).default(30_000),
})

const PREFIX = 'multi_agent_v1__'
const LABEL = 'Codex v1 agent'
const NAMESPACE_DESCRIPTION = 'Tools for spawning and managing sub-agents.'
const STATUS_SCHEMA = { oneOf: [
  { type: 'string', enum: ['pending_init', 'running', 'interrupted', 'shutdown', 'not_found'] },
  { type: 'object', additionalProperties: false, properties: { completed: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true } } },
  { type: 'object', additionalProperties: false, properties: { errored: { type: 'string', required: true } } },
] } as const satisfies ValueSchemaSpec

type V1Status =
  | 'pending_init' | 'running' | 'interrupted' | 'shutdown' | 'not_found'
  | { completed: string | null }
  | { errored: string }

/** Interrupted agents can resume; only terminal statuses settle a wait. */
function isFinalStatus(status: V1Status): boolean {
  return status !== 'pending_init' && status !== 'running' && status !== 'interrupted'
}

type InputItem = {
  type?: string
  text?: string
  image_url?: string
  audio_url?: string
  path?: string
  name?: string
}

/** Accept plain text items and reject unsupported media or mention semantics explicitly. */
function collabInput(message: string | undefined, items: InputItem[] | undefined): ContentBlock[] {
  if (message !== undefined && items !== undefined) throw new Error('Provide either message or items, but not both')
  if (message === undefined && items === undefined) throw new Error('Provide one of: message or items')
  if (message !== undefined) {
    if (message.trim().length === 0) throw new Error("Empty message can't be sent to an agent")
    return [{ type: 'text', text: message }]
  }
  if (items === undefined || items.length === 0) throw new Error("Items can't be empty")
  return items.map((item, index) => {
    if (item.type !== 'text') {
      throw new Error(`items[${index}] type ${JSON.stringify(item.type)} is unsupported by this DSH adapter`)
    }
    if (item.text === undefined) throw new Error(`items[${index}].text is required`)
    return { type: 'text', text: item.text }
  })
}

/** A model tool requires the exact live Agent that owns its child Sessions. */
function callerOf(agent: Agent | undefined, toolName: string): Agent {
  if (agent === undefined) throw new Error(`${toolName} requires a calling agent`)
  return agent
}

/** JSON text is the native v1 tool result's model-facing representation. */
function jsonText(value: object): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/** The child's own terminal turn determines its v1 status while it remains resident. */
function finalStatus(events: readonly SessionEvent[], ownEventStart: number, turn?: number): V1Status {
  const own = events.slice(ownEventStart)
  const end = own.findLast(event => event.type === 'turn/end' && (turn === undefined || event.data.turn === turn))
  if (end?.type !== 'turn/end') return 'pending_init'
  switch (end.data.reason.kind) {
    case 'completed': {
      const message = own.findLast(event => event.type === 'assistant/message' && event.data.turn === end.data.turn)
      const answer = message?.type === 'assistant/message'
        ? message.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') : ''
      return { completed: answer.length > 0 ? answer : null }
    }
    case 'aborted':
    case 'interrupted':
      return 'interrupted'
    case 'error':
      return { errored: end.data.reason.error.message }
    case 'max-tokens':
      return { errored: 'Agent reached its token limit' }
    case 'blocked':
      return { errored: 'Agent declined the task' }
    // Turn reasons are merge-extensible; an unknown terminal reason is a failure.
    default:
      return { errored: `Agent ended abnormally (${end.data.reason.kind})` }
  }
}

/** Serialize state-changing calls for one parent, including asynchronous admission. */
function parentLock() {
  const tails = new WeakMap<Agent, Promise<void>>()
  return async <T>(parent: Agent, operation: () => Promise<T>): Promise<T> => {
    const previous = tails.get(parent)
    const release = Promise.withResolvers<undefined>()
    tails.set(parent, release.promise)
    if (previous !== undefined) await previous
    try {
      return await operation()
    } finally {
      release.resolve(undefined)
      if (tails.get(parent) === release.promise) tails.delete(parent)
    }
  }
}

/**
 * Register the five pinned v1 operations in one preset-scoped tool registry.
 * @param ctx - Cordis context that owns the tool registrations.
 * @param config - provider names and limits for this composition.
 * @returns after the registrations and runtime state are installed.
 */
export function apply(ctx: Context, config: Config): void {
  const maxDepth = config.maxDepth ?? 1
  const maxOpenAgents = config.maxOpenAgents ?? 6
  const minWaitMs = config.minWaitMs ?? 10_000
  const maxWaitMs = config.maxWaitMs ?? 3_600_000
  const defaultWaitMs = config.defaultWaitMs ?? 30_000
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 1) {
    throw new Error('Codex v1 maxDepth must be 0 or 1')
  }
  if (!Number.isSafeInteger(maxOpenAgents) || maxOpenAgents < 1) throw new Error('Codex v1 maxOpenAgents must be a positive safe integer')
  if (minWaitMs < 0 || minWaitMs > defaultWaitMs || defaultWaitMs > maxWaitMs || maxWaitMs > 3_600_000) {
    throw new Error('Codex v1 wait limits must satisfy 0 <= minWaitMs <= defaultWaitMs <= maxWaitMs <= 3600000')
  }
  const locked = parentLock()
  let nicknames: ReturnType<typeof acquireCodexV1NicknameRegistry>
  ctx.effect(() => {
    nicknames = acquireCodexV1NicknameRegistry(ctx.codexySubagents)
    return nicknames.dispose
  })
  const watchers = new WeakMap<Agent, Set<(id: SessionId, state: 'open' | 'closed') => void>>()
  const models = new WeakMap<ToolSchemaRequest, Promise<LlmResolvedModelInfo>>()
  const register = (definition: ToolDefinition): (() => void) => ctx.codexyTools.register({
    ...definition,
    async resolveRequest(request) {
      if (request.variables.codexful_multi_agent_version === 'v2') return definition
      let selected = models.get(request)
      if (selected === undefined) {
        const { provider, model } = request.variables
        if (provider === undefined || model === undefined) {
          throw new Error('Codex v1 tool preparation requires provider and model variables')
        }
        selected = request.context.preparedModel === undefined
          ? ctx.codexyRequests.resolveModelInfo(provider, model, request.context.signal)
          : Promise.resolve(request.context.preparedModel.model)
        models.set(request, selected)
      }
      if ((await selected).toolNamespaces === 'native') return definition
      const { namespace: _namespace, ...flat } = definition
      return flat
    },
  })

  const roster = async (parent: Agent, signal: AbortSignal) => {
    const children = (await ctx.codexySubagents.listChildren(parent.id, signal))
      .filter(child => child.mode === 'continuable' && child.label === LABEL)
    const open = new Set(children.filter(child => ctx.codexySubagents.loadedContinuable(parent, child.id) !== undefined)
      .map(child => child.id))
    return { children, open }
  }

  const mark = (parent: Agent, id: SessionId, state: 'open' | 'closed'): void => {
    nicknames.pool(parent).mark(id, state)
    for (const watcher of watchers.get(parent) ?? []) watcher(id, state)
  }

  const restoreNicknames = async (parent: Agent, children: readonly { id: SessionId }[], signal: AbortSignal): Promise<void> => {
    using observed = await ctx.sessionQuery.observeSession(parent.id, { signal, projectionMode: 'none' })
    const legacy = codexV1NicknamesFromLog(projectProductEvents(observed.events), observed.inheritedEventCount)
    const identities = await Promise.all(children.map(async (child) => {
      using childObservation = await ctx.sessionQuery.observeSession(child.id, { signal })
      const identity = childObservation.projections?.values.codexV1Identity
      if (identity === undefined) throw new Error('Codex v1 nickname recovery requires its child identity projection')
      const previous = legacy.get(child.id)
      if (identity !== null && previous !== undefined && identity.nickname !== previous) {
        throw new Error(`Conflicting Codex v1 nickname for child ${JSON.stringify(child.id)}`)
      }
      return { id: child.id, nickname: identity?.nickname ?? previous }
    }))
    const pool = nicknames.pool(parent)
    for (const { id, nickname } of identities) {
      if (nickname !== undefined) pool.remember(id, nickname)
    }
  }

  const status = async (id: SessionId, signal: AbortSignal): Promise<V1Status> => {
    const live = ctx.agents.get(id)
    if (live?.status === 'running') return 'running'
    if (live !== undefined && (live.inbox.nextStep.length > 0 || live.inbox.nextTurn.length > 0)) return 'pending_init'
    using observed = await ctx.sessionQuery.observeSession(id, { signal, projectionMode: 'none' })
    const current = finalStatus(projectProductEvents(observed.events), Math.max(observed.inheritedEventCount, live?.session.firstLiveSeq ?? 0))
    if (live !== undefined && current === 'pending_init') {
      const previous = observed.events.slice(observed.inheritedEventCount)
        .findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
      // Cold Codex threads retain only an Interrupted status from their saved rollout.
      if (previous?.type === 'turn/end' && previous.seq < live.session.firstLiveSeq
        && (previous.data.reason.kind === 'interrupted' || previous.data.reason.kind === 'aborted')) return 'interrupted'
    }
    return current
  }

  const target = async (parent: Agent, raw: string, signal: AbortSignal) => {
    const id = SessionId(raw)
    const state = await roster(parent, signal)
    const found = state.children.some(child => child.id === id)
    return { id, found, closed: !state.open.has(id) }
  }

  const inputItemsParameter = {
    type: 'array', description: 'Structured input items. Use this to pass explicit mentions (for example app:// connector paths).', items: {
      type: 'object', properties: {
        audio_url: { type: 'string', description: 'Audio data URL when type is audio.' },
        image_url: { type: 'string', description: 'Image URL when type is image.' },
        name: { type: 'string', description: 'Display name when type is skill or mention.' },
        path: { type: 'string', description: 'Path when type is local_image/local_audio/skill, or structured mention target such as app://<connector-id> or plugin://<plugin-name>@<marketplace-name> when type is mention.' },
        text: { type: 'string', description: 'Text content when type is text.' },
        type: { type: 'string', description: 'Input item type: text, image, local_image, audio, local_audio, skill, or mention.' },
      }, additionalProperties: false,
    },
  } as const

  ctx.effect(() => register(defineTool({
    name: `${PREFIX}spawn_agent`,
    namespace: { name: 'multi_agent_v1', description: NAMESPACE_DESCRIPTION, toolName: 'spawn_agent' },
    description: codexV1SpawnDescription(config.spawnDescriptionWireProfile),
    closedParameters: true,
    parameters: {
      fork_context: { type: 'boolean', description: 'True forks the current thread history into the new agent; false or omitted starts with only the initial prompt.' },
      items: inputItemsParameter,
      message: { type: 'string', description: 'Initial plain-text task for the new agent. Use either message or items.' },
      model: { type: 'string', description: 'Model override for the new agent. Omit unless an explicit override is needed.' },
      reasoning_effort: { type: 'string', description: 'Reasoning effort override for the new agent. Omit to inherit the parent effort.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      agent_id: { type: 'string', required: true },
      nickname: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    } }, render: (_args, value) => jsonText(value), codeModeResult: (_args, value) => value },
    async execute(args, exec) {
      const parent = callerOf(exec.agent, 'spawn_agent')
      const prompt = collabInput(args.message, args.items)
      const parentDepth = parent.session.header.delegationDepth ?? 0
      if (parentDepth >= maxDepth) {
        throw new Error('Agent depth limit reached. Solve the task yourself.')
      }
      const agentOptions = args.model === undefined && args.reasoning_effort === undefined ? undefined : {
        ...args.model === undefined ? {} : { model: args.model },
        ...args.reasoning_effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(args.reasoning_effort) },
      }
      if (agentOptions !== undefined) {
        const selected = resolveChildAgentOptions(parent, agentOptions, parentDepth + 1)
        if (selected.provider === undefined || selected.model === undefined) {
          throw new Error('The child model route is unavailable')
        }
        await ctx.codexyRequests.resolveCallConfig({
          provider: selected.provider,
          model: selected.model,
          ...selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort },
        }, exec.signal)
      }
      return locked(parent, async () => {
        const { children, open } = await roster(parent, exec.signal)
        if (open.size >= maxOpenAgents) {
          throw new Error(`Agent limit reached (${maxOpenAgents} open child agents)`)
        }
        const pool = nicknames.pool(parent)
        await restoreNicknames(parent, children, exec.signal)
        const nickname = pool.reserve(CODEX_V1_NICKNAMES)
        const started = await ctx.codexySubagents.startContinuable({
          provider: args.fork_context === true ? config.forkProvider ?? 'fork' : config.spawnProvider ?? 'spawn',
          label: LABEL,
          codexV1Identity: { nickname },
          request: {
            parent,
            prompt,
            delegatedApprovalPolicy: 'inherit',
            ...agentOptions === undefined ? {} : { agentOptions },
            maxDepth,
          },
          signal: exec.signal,
        })
        pool.remember(started.childId, nickname)
        mark(parent, started.childId, 'open')
        return { agent_id: started.childId, nickname }
      })
    },
  })))

  ctx.effect(() => register(defineTool({
    name: `${PREFIX}send_input`,
    namespace: { name: 'multi_agent_v1', description: NAMESPACE_DESCRIPTION, toolName: 'send_input' },
    description: 'Send a message to an existing agent. Use interrupt=true to redirect work immediately. You should reuse the agent by send_input if you believe your assigned task is highly dependent on the context of a previous task.',
    closedParameters: true,
    parameters: {
      interrupt: { type: 'boolean', description: 'True interrupts the current task and handles this message immediately; false or omitted queues it.' },
      items: inputItemsParameter,
      message: { type: 'string', description: 'Legacy plain-text message to send to the agent. Use either message or items.' },
      target: { type: 'string', required: true, description: 'Agent id to message (from spawn_agent).' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      submission_id: { type: 'string', required: true },
    } }, render: (_args, value) => jsonText(value), codeModeResult: (_args, value) => value },
    async execute(args, exec) {
      const parent = callerOf(exec.agent, 'send_input')
      const content = collabInput(args.message, args.items)
      return locked(parent, async () => {
        const receiver = await target(parent, args.target, exec.signal)
        if (!receiver.found) throw new Error(`agent ${JSON.stringify(args.target)} was not found`)
        if (ctx.codexySubagents.loadedContinuable(parent, receiver.id) === undefined) {
          throw new Error(`agent ${JSON.stringify(args.target)} was not found; call resume_agent first`)
        }
        if (args.interrupt === true) {
          ctx.codexySubagents.interrupt(receiver.id, { kind: 'ancestor', agent: parent, intent: 'tool' })
        }
        const messageId = await ctx.codexySubagents.sendMessage(parent, receiver.id, content, {
          signal: exec.signal,
          delivery: 'steer',
          residentOnly: true,
        })
        return { submission_id: messageId }
      })
    },
  })))

  ctx.effect(() => register(defineTool({
    name: `${PREFIX}resume_agent`,
    namespace: { name: 'multi_agent_v1', description: NAMESPACE_DESCRIPTION, toolName: 'resume_agent' },
    description: 'Resume a previously closed agent by id so it can receive send_input and wait_agent calls.',
    closedParameters: true,
    parameters: { id: { type: 'string', required: true, description: 'Agent id to resume.' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      status: { ...STATUS_SCHEMA, required: true },
    } }, render: (_args, value) => jsonText(value), codeModeResult: (_args, value) => value },
    async execute(args, exec) {
      const parent = callerOf(exec.agent, 'resume_agent')
      if ((parent.session.header.delegationDepth ?? 0) >= maxDepth) {
        throw new Error('Agent depth limit reached. Solve the task yourself.')
      }
      return locked(parent, async () => {
        const state = await roster(parent, exec.signal)
        const id = SessionId(args.id)
        if (!state.children.some(child => child.id === id)) throw new Error(`agent ${JSON.stringify(args.id)} was not found`)
        if (!state.open.has(id) && state.open.size >= maxOpenAgents) {
          throw new Error(`Agent limit reached (${maxOpenAgents} open child agents)`)
        }
        await restoreNicknames(parent, state.children, exec.signal)
        await ctx.codexySubagents.loadContinuable(parent, id, exec.signal)
        const child = ctx.agents.get(id)
        if (child === undefined) throw new Error(`agent ${JSON.stringify(args.id)} was not loaded`)
        const pool = nicknames.pool(parent)
        const identity = codexV1IdentityOf(child.session, ctx.sessionProjections)
        if (identity === null) {
          const nickname = pool.snapshot().get(id) ?? pool.reserve(CODEX_V1_NICKNAMES)
          appendProductEvent(child.session, 'subagent/codex-v1-identity', { nickname })
          pool.remember(id, nickname)
        } else pool.remember(id, identity.nickname)
        const current = await status(id, exec.signal)
        exec.signal.throwIfAborted()
        mark(parent, id, 'open')
        return { status: current }
      })
    },
  })))

  ctx.effect(() => register(defineTool({
    name: `${PREFIX}close_agent`,
    namespace: { name: 'multi_agent_v1', description: NAMESPACE_DESCRIPTION, toolName: 'close_agent' },
    description: "Close an agent and any open descendants when they are no longer needed, and return the target agent's previous status before shutdown was requested. Completed agents remain open and count toward the concurrency limit until closed. Don't keep agents open for too long if they are not needed anymore.",
    closedParameters: true,
    parameters: { target: { type: 'string', required: true, description: 'Agent id to close (from spawn_agent).' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      previous_status: { ...STATUS_SCHEMA, required: true },
    } }, render: (_args, value) => jsonText(value), codeModeResult: (_args, value) => value },
    async execute(args, exec) {
      const parent = callerOf(exec.agent, 'close_agent')
      return locked(parent, async () => {
        const receiver = await target(parent, args.target, exec.signal)
        if (!receiver.found) return { previous_status: 'not_found' as V1Status }
        if (receiver.closed) return { previous_status: 'not_found' as V1Status }
        const previous = await status(receiver.id, exec.signal)
        await ctx.codexySubagents.drainContinuableChildren(parent, [receiver.id])
        mark(parent, receiver.id, 'closed')
        return { previous_status: previous }
      })
    },
  })))

  ctx.effect(() => register(defineTool({
    name: `${PREFIX}wait_agent`,
    namespace: { name: 'multi_agent_v1', description: NAMESPACE_DESCRIPTION, toolName: 'wait_agent' },
    description: "Wait for agents to reach a final status. Completed statuses may include the agent's final message. Returns empty status when timed out. Once the agent reaches a final status, a notification message will be received containing the same completed status.",
    closedParameters: true,
    parameters: {
      targets: { type: 'array', required: true, items: { type: 'string' }, description: 'Agent ids to wait on. Pass multiple ids to wait for whichever finishes first.' },
      timeout_ms: { type: 'number', description: `Timeout in milliseconds. Defaults to ${defaultWaitMs}, min ${minWaitMs}, max ${maxWaitMs}. Prefer longer waits (minutes) to avoid busy polling.` },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      status: { type: 'object', additionalProperties: true, required: true },
      timed_out: { type: 'boolean', required: true },
    } }, render: (_args, value) => jsonText(value), codeModeResult: (_args, value) => value },
    async execute(args, exec) {
      const parent = callerOf(exec.agent, 'wait_agent')
      if (args.targets.length === 0) throw new Error('targets must contain at least one agent id')
      const requested = args.timeout_ms ?? defaultWaitMs
      if (!Number.isSafeInteger(requested) || requested <= 0) throw new Error('timeout_ms must be a positive safe integer')
      const timeoutMs = Math.min(Math.max(requested, minWaitMs), maxWaitMs)
      const ids = [...new Set(args.targets)].map(SessionId)
      const statuses = new Map<SessionId, V1Status>()
      const endedTurns = new Map<SessionId, number[]>()
      const watched = new Map<SessionId, Agent | undefined>()
      const lifetime = new AbortController()
      const signal = AbortSignal.any([exec.signal, lifetime.signal])
      let notified = Promise.withResolvers<undefined>()
      const notify = (): void => { notified.resolve(undefined) }
      const disposeLifetime = ctx.effect(() => () => {
        lifetime.abort(new Error('wait_agent was disposed'))
      }, 'codexV1.wait')
      signal.addEventListener('abort', notify)
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = { expired: false }
      let parentWatchers = watchers.get(parent)
      if (parentWatchers === undefined) {
        parentWatchers = new Set()
        watchers.set(parent, parentWatchers)
      }
      const onRosterChange = (id: SessionId, next: 'open' | 'closed'): void => {
        if (next !== 'closed' || watched.get(id) === undefined) return
        statuses.set(id, 'shutdown')
        notify()
      }
      parentWatchers.add(onRosterChange)
      const off = ctx.on('session/event', (session, event) => {
        if (event.type !== 'turn/end' || !session.isOwnSeq(event.seq)
          || watched.get(session.id)?.session !== session) return
        let turns = endedTurns.get(session.id)
        if (turns === undefined) {
          turns = []
          endedTurns.set(session.id, turns)
        }
        turns.push(event.data.turn)
        notify()
      })
      const offDisposed = ctx.on('agent/disposed', ({ agent }) => {
        if (watched.get(agent.id) !== agent) return
        statuses.set(agent.id, 'shutdown')
        notify()
      })
      try {
        signal.throwIfAborted()
        for (const id of ids) watched.set(id, ctx.codexySubagents.loadedContinuable(parent, id))
        const state = await roster(parent, signal)
        const known = new Set(state.children.map(child => child.id))
        const readFinishedTurns = async (id: SessionId): Promise<void> => {
          const turns = endedTurns.get(id)
          if (turns === undefined || turns.length === 0 || statuses.has(id)) return
          const pending = turns.splice(0)
          using observed = await ctx.sessionQuery.observeSession(id, { signal, projectionMode: 'none' })
          const ownEventStart = Math.max(observed.inheritedEventCount, watched.get(id)?.session.firstLiveSeq ?? 0)
          for (const turn of pending) {
            const ended = finalStatus(projectProductEvents(observed.events), ownEventStart, turn)
            if (isFinalStatus(ended) && !statuses.has(id)) statuses.set(id, ended)
          }
        }
        const check = async (): Promise<void> => {
          await Promise.all(ids.map(async (id) => {
            if (!known.has(id) || watched.get(id) === undefined) statuses.set(id, 'not_found')
            else {
              if (statuses.has(id)) return
              await readFinishedTurns(id)
              if (statuses.has(id)) return
              const current = await status(id, signal)
              await readFinishedTurns(id)
              if (!statuses.has(id) && isFinalStatus(current)) statuses.set(id, current)
            }
          }))
        }
        while (true) {
          const notification = notified.promise
          await check()
          signal.throwIfAborted()
          if (statuses.size > 0) return { status: Object.fromEntries(statuses), timed_out: false }
          if (timeout.expired) return { status: {}, timed_out: true }
          timer ??= setTimeout(() => { timeout.expired = true; notify() }, timeoutMs)
          await notification
          notified = Promise.withResolvers<undefined>()
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        off()
        offDisposed()
        parentWatchers.delete(onRosterChange)
        signal.removeEventListener('abort', notify)
        await disposeLifetime()
      }
    },
  })))
}
