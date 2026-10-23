/** Model-suggested or explicit names over the existing conversation title service. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { deriveMessageNodes } from '@codexydsh/runtime/session'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { SessionTitleInvalidError, SessionTitleProviderId } from '@deepseek-ai/dsh-session-title'
import type { SessionTitleModelIdentity } from '@deepseek-ai/dsh-session-title'
import { generateSessionTitleFromContext, resolveSessionTitleLlmConfig } from './title-llm.ts'
import type { ResolvedSessionTitleLlmConfig, SessionTitleLlmConfig } from './title-llm.ts'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'

const USAGE = 'Enter a new title after /rename, for example: /rename My project. The title must contain visible characters.'

/** Default policy exposed through Session Controller's renameSuggestion configuration. */
export const RENAME_SUGGESTION_POLICY: SessionTitleLlmConfig = {
  targetWords: 5, targetCjkCharacters: 10, maxInputBytes: 8192, maxOutputTokens: 256, timeoutMs: 60_000,
}

async function suggestTitle(ctx: Context, agent: Agent, policy: ResolvedSessionTitleLlmConfig,
  route: SessionTitleModelIdentity | undefined, signal: AbortSignal): Promise<CommandResult> {
  if (ctx.get('llm') === undefined) return { kind: 'error', text: 'Title suggestions require a model.' }
  // Name from the same complete conversation the model sees, so a session whose
  // recent messages are all "continue" still gets a title from its real work.
  const nodes = deriveMessageNodes(agent.session)
  // Injected runtime context and agent instructions are user-role messages too,
  // but a title may cite only human `user/message` events; the session log
  // reader rejects any other source kind.
  const humanSeqs = nodes
    .filter(node => node.message.source.kind === 'user')
    .map(node => node.seq)
  if (humanSeqs.length === 0) return { kind: 'error', text: 'There is no conversation to name yet.' }
  const result = await generateSessionTitleFromContext(ctx, policy, {
    session: agent.session, signal, ...route === undefined ? {} : { route },
  }, nodes.map(node => node.message), humanSeqs,
  SessionTitleProviderId('rename-suggestion'))
  signal.throwIfAborted()
  return { kind: 'success', text: result.title }
}

/**
 * Register `/rename` suggestions and `/rename <new title>` explicit naming.
 * @param ctx - effect owner with the registry and title service.
 * @param config - auxiliary title generation limits, or deployment defaults.
 * @param routeFor - current Session-local model selection, when the application supplies it.
 */
export function registerSessionRenameCommand(ctx: Context, config: SessionTitleLlmConfig = RENAME_SUGGESTION_POLICY,
  routeFor?: (agent: Agent) => SessionTitleModelIdentity): void {
  const policy = resolveSessionTitleLlmConfig(config)
  ctx.effect(() => ctx.commands.register({
    definitionId: CommandDefinitionId('@codexydsh/api-session/rename'),
    name: 'rename',
    description: 'Rename the current conversation',
    input: { hint: '<new title>' },
    handler: async (invocation): Promise<CommandResult> => {
      invocation.signal.throwIfAborted()
      if (invocation.rawInput.trim().length === 0) {
        const questions = ctx.get('userQuestions')
        if (questions === undefined) return { kind: 'error', text: 'Title suggestions require a user question panel.' }
        const previous = invocation.agent.session.requestHeader()?.config
        const route = routeFor?.(invocation.agent) ?? (previous === undefined ? undefined
          : { provider: previous.provider, model: previous.model })
        const suggestion = await suggestTitle(ctx, invocation.agent, policy, route, invocation.signal)
        if (suggestion.kind !== 'success' || suggestion.text === undefined) return suggestion
        try {
          const response = await questions.ask({ agent: invocation.agent, signal: invocation.signal,
            questions: [{ id: 'rename', header: '/rename', question: suggestion.text,
              options: [{ label: suggestion.text }] }] })
          invocation.signal.throwIfAborted()
          const answer = response.answers.find(item => item.id === 'rename')
          const title = answer?.custom?.trim() || answer?.selected[0]
          if (title === undefined) return { kind: 'success', text: 'Conversation name unchanged.' }
          const accepted = ctx.sessionTitle.rename(invocation.agent.session, title)
          return { kind: 'success', text: `Renamed conversation to: ${accepted.title}`, sourceEventSeq: accepted.eventSeq }
        } catch (error: unknown) {
          if (error instanceof UserQuestionError && error.code === 'ASK_CANCELLED') {
            return { kind: 'success', text: 'Conversation name unchanged.' }
          }
          if (error instanceof SessionTitleInvalidError) return { kind: 'error', text: USAGE }
          throw error
        }
      }
      try {
        const accepted = ctx.sessionTitle.rename(invocation.agent.session, invocation.rawInput)
        return { kind: 'success', text: `Renamed conversation to: ${accepted.title}`, sourceEventSeq: accepted.eventSeq }
      } catch (error: unknown) {
        if (error instanceof SessionTitleInvalidError) return { kind: 'error', text: USAGE }
        throw error
      }
    },
  }), 'session-controller: rename command')
}
