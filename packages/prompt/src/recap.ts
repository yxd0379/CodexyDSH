import { deriveProductMessages } from '@codexydsh/runtime/session'
import { deriveMessageNodes } from '@codexydsh/runtime/session'
import { requestHeaderOf } from '@codexydsh/runtime/session'
/** Independent task recap command; auxiliary requests never alter the conversation surface. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as jsonSchema } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandId, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { BlockAssembler, ReasoningEffortId } from '@codexydsh/runtime/llm'
import type { GenerateOptions, LlmCallConfig, RequestMessage } from '@codexydsh/runtime/llm'
import { SessionSeq } from '@codexydsh/runtime/session'
import type { SessionEvent, SessionSeqCursor } from '@codexydsh/runtime/session'
import type {} from '@codexydsh/runtime/prompt'
import { deadline, MAX_TIMER_DELAY_MS, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { RECAP_CONTEXT_INSTRUCTION } from './recap-prompt.ts'

/** Cordis plugin name for the independent command. */
export const name = 'codexful-recap'
/** Services used for command discovery and current model selection. */
export const inject = ['commands', 'llm', 'codexyPrompt', 'codexyRequests']

/** Deployment bounds for one auxiliary task summary. */
export interface Config {
  /** Wall-clock deadline, including preparation and provider streaming. */
  timeoutMs?: number
  /** Output-token cap for the selected model, including any reasoning it generates. */
  maxOutputTokens?: number
}

/** Validated command deadline and output allowance. */
export const Config: z<Config> = z.object({
  timeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(120_000),
  maxOutputTokens: z.number().min(1).max(Number.MAX_SAFE_INTEGER).step(1).default(4_096),
})

/** Exact auxiliary request, independently reconstructable from the Session log. */
export interface RecapRequest {
  readonly commandId: CommandId
  readonly sourceEventSeqs: readonly SessionSeq[]
  readonly sourceThroughSeq: SessionSeqCursor
  readonly config: LlmCallConfig
  readonly messages: RequestMessage[]
  readonly tools: []
}

/** Terminal auxiliary outcome; only a fresh successful request publishes a summary. */
export type RecapResult =
  | { readonly commandId: CommandId; readonly outcome: 'completed'; readonly summary: string; readonly nextAction: string | null }
  | { readonly commandId: CommandId; readonly outcome: 'cancelled' | 'stale' | 'failed'; readonly error: string }

declare module '@codexydsh/runtime/types' {
  interface SessionEventMap {
    /** Exact task-recap input and registration-bound model configuration; not conversation history. */
    'recap/request': RecapRequest
    /** Terminal task-recap result correlated with the human command. */
    'recap/result': RecapResult
  }
}

const resultSchema = jsonSchema.object({
  summary: jsonSchema.string().transform(text => text.trim())
    .refine(text => text !== '' && Array.from(text).length <= 700, 'summary must contain 1–700 characters'),
  next_action: jsonSchema.string().nullable().transform(text => text?.trim() || null)
    .refine(text => text === null || Array.from(text).length <= 200, 'next_action must contain at most 200 characters'),
}).strict()

class StaleRecap extends Error {
  override name = 'StaleRecap'
  constructor() { super('The conversation advanced while the recap was being generated. Run /recap again.') }
}

/** Visible conversation changes invalidate an auxiliary summary; metadata and reconstruction do not. */
function advancesConversation(event: SessionEvent): boolean {
  switch (event.type) {
    case 'turn/start':
    case 'turn/end': return true
    case 'user/message': return event.surfaceOp === 'append' && event.data.source.kind === 'user' && event.sourceEventSeqs === undefined
    case 'assistant/message': return event.surfaceOp === 'append' && event.data.message.content.some(block => block.type === 'text' && block.text.trim() !== '')
    case 'agent/inbox/spliced': return event.data.inserted.some(message => message.source.kind === 'user')
    default: return false // Merge-extensible log-only producers do not alter visible task history.
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Resolve deployment defaults once, before admitting a command. */
function resolveConfig(config: Config): Required<Config> {
  return { timeoutMs: config.timeoutMs ?? 120_000, maxOutputTokens: config.maxOutputTokens ?? 4_096 }
}

/** Capture the selected model without running loop-only request hooks or assembling its main prompt. */
async function selectedConfig(ctx: Context, agent: Agent, config: Required<Config>, signal: AbortSignal): Promise<LlmCallConfig> {
  const preparation = await ctx.codexyPrompt.prepare({ agent, scope: agent, signal })
  const previous = requestHeaderOf(agent.session)?.config
  const provider = preparation.variables.provider ?? previous?.provider ?? agent.options.provider
  const model = preparation.variables.model ?? previous?.model ?? agent.options.model
  if (provider === undefined || model === undefined || provider === '' || model === '') {
    throw new Error('Select a provider and model before running /recap.')
  }
  const effort = preparation.variables.reasoning_effort
  const inherited = previous?.provider === provider && previous.model === model ? previous.reasoningEffort
    : agent.options.provider === provider && agent.options.model === model ? agent.options.reasoningEffort : undefined
  const reasoningEffort = effort === undefined ? inherited : effort === '' ? undefined : ReasoningEffortId(effort)
  return { provider, model, temperature: 0, maxTokens: config.maxOutputTokens,
    ...reasoningEffort === undefined ? {} : { reasoningEffort } }
}

/**
 * Register the task recap command and await every owned request during plugin disposal.
 * @param ctx - Cordis effect owner with the declared services.
 * @param config - command deadline and auxiliary response allowance.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const active = new Map<Agent, { controller: AbortController; work: Promise<CommandResult> }>()
  ctx.on('session/event', (session, event) => {
    if (!advancesConversation(event)) return
    for (const [agent, operation] of active) {
      if (agent.session === session) operation.controller.abort(new StaleRecap())
    }
  })
  ctx.on('agent/cancelled', ({ agent }) => {
    active.get(agent)?.controller.abort(new Error('Task recap cancelled.'))
  })
  ctx.on('session/disposed', (session) => {
    for (const [agent, operation] of active) {
      if (agent.session === session) operation.controller.abort(new Error('Task recap session closed.'))
    }
  })
  ctx.effect(() => () => {
    for (const operation of active.values()) operation.controller.abort(new Error('Task recap plugin disposed.'))
    return Promise.allSettled([...active.values()].map(operation => operation.work)).then(() => {})
  }, 'codexful-recap.requests')

  async function generate(invocation: CommandInvocation, controller: AbortController): Promise<CommandResult> {
    const { agent, commandId } = invocation
    const session = agent.session
    using duration = deadline(AbortSignal.any([invocation.signal, controller.signal]), resolved.timeoutMs, 'RECAP_TIMEOUT')
    let dispatched = false
    try {
      duration.signal.throwIfAborted()
      if (deriveProductMessages(session).length === 0) return { kind: 'error', text: 'There is no conversation history to recap.' }
      const proposed = await selectedConfig(ctx, agent, resolved, duration.signal)
      const prepared = await ctx.codexyRequests.prepareCall(proposed, duration.signal)
      const history = deriveMessageNodes(session)
      const sourceThroughSeq: SessionSeqCursor = session.seq === 0 ? -1 : SessionSeq(session.seq - 1)
      const messages: RequestMessage[] = [...history.map(node => node.message),
        { role: 'user', content: [{ type: 'text', text: RECAP_CONTEXT_INSTRUCTION }] }]
      const options: GenerateOptions = { ...prepared.config, messages, tools: [], sessionId: session.id, signal: duration.signal }
      duration.signal.throwIfAborted()
      ctx.logger.debug('recap/request %o', { commandId, sourceThroughSeq })
      dispatched = true
      const assembler = new BlockAssembler()
      let terminal = false
      for await (const chunk of prepared.stream(options)) {
        duration.signal.throwIfAborted()
        assembler.push(chunk)
        if (chunk.type === 'finish') terminal = true
      }
      duration.signal.throwIfAborted()
      if (!terminal || assembler.finish.kind !== 'stop') {
        const finish = assembler.finish
        throw new Error(finish.kind === 'error' ? finish.failure.message : 'Task recap did not finish successfully.')
      }
      const blocks = assembler.blocks()
      if (blocks.some(block => block.type !== 'text' && block.type !== 'reasoning')) throw new Error('Task recap must return text without tools or attachments.')
      const output = blocks.filter(block => block.type === 'text').map(block => block.text).join('')
      const parsed = resultSchema.parse(JSON.parse(output))
      duration.signal.throwIfAborted()
      // Commands persist this result through native command/done.
      return { kind: 'success', text: parsed.summary + (parsed.next_action === null ? '' : '\n\n' + parsed.next_action) }
    } catch (error: unknown) {
      const reason: unknown = duration.signal.reason
      const outcome = reason instanceof StaleRecap ? 'stale'
        : duration.signal.aborted && timeoutOf(duration.signal, 'RECAP_TIMEOUT') === undefined ? 'cancelled' : 'failed'
      const text = errorText(duration.signal.aborted ? reason : error)
      if (dispatched) ctx.logger.debug('recap/result %o', { commandId, outcome, error: text })
      return { kind: 'error', text }
    }
  }

  ctx.effect(() => ctx.commands.register({
    definitionId: CommandDefinitionId('@codexydsh/prompt/recap'),
    name: 'recap', description: 'Summarize current task progress, conclusions, and next steps',
    handler: (invocation) => {
      if (invocation.rawInput.trim() !== '') return { kind: 'error', text: '/recap does not accept arguments.' }
      if (active.has(invocation.agent)) return { kind: 'error', text: 'A recap is already being generated.' }
      const controller = new AbortController()
      const work = Promise.resolve().then(() => generate(invocation, controller))
      active.set(invocation.agent, { controller, work })
      return work.finally(() => { active.delete(invocation.agent) })
    },
  }), 'codexful-recap.command')
}
