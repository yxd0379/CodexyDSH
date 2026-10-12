/** One auxiliary rewrite of a composer draft; the result replaces the draft and never enters the conversation. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import z from '@deepseek-ai/schemastery'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'codexy-prompt-optimizer': { kind: 'codexy-prompt-optimizer' } & ContextFormed
  }
}

/** Deployment bounds for one draft rewrite. */
export interface PromptOptimizePolicy {
  /** Wall-clock deadline for the auxiliary call. */
  timeoutMs?: number
  /** Output-token cap for the rewrite. */
  maxOutputTokens?: number
}

/** Validated deadline and output allowance. */
export const PromptOptimizePolicySchema: z<PromptOptimizePolicy> = z.object({
  timeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(90_000),
  maxOutputTokens: z.number().min(1).max(Number.MAX_SAFE_INTEGER).step(1).default(2_048),
})

const SYSTEM = [
  'Rewrite the user\'s draft into a clearer, more actionable prompt for a coding agent.',
  'Keep the user\'s intent, language, and every technical specific; never add requirements the draft does not imply.',
  'Make the goal, the constraints, and the expected evidence explicit when the draft already contains them.',
  'Return only the rewritten prompt as plain text: no preamble, no explanation, no Markdown fences, no quotes.',
].join('\n')

/** Route recorded by the Session's latest request, or its selected defaults. */
function routeOf(agent: Agent): { provider: string; model: string } {
  const header = agent.session.requestHeader()?.config
  const provider = header?.provider ?? agent.options.provider
  const model = header?.model ?? agent.options.model
  if (provider === undefined || model === undefined) {
    throw new Error('Select a provider and model before rewriting the draft')
  }
  return { provider, model }
}

/**
 * Rewrite one draft with the Session's selected model.
 * @param ctx - Host carrying the LLM service.
 * @param agent - Session whose model performs the rewrite and owns cancellation.
 * @param text - exact draft text to rewrite.
 * @param signal - caller cancellation.
 * @param policy - validated deadline and output allowance.
 * @returns the replacement draft text.
 */
export async function optimizePromptDraft(
  ctx: Context,
  agent: Agent,
  text: string,
  signal: AbortSignal,
  policy: PromptOptimizePolicy = {},
): Promise<string> {
  const draft = text.trim()
  if (draft === '') throw new Error('There is no draft to rewrite')
  const { provider, model } = routeOf(agent)
  const timeoutMs = policy.timeoutMs ?? 90_000
  const maxOutputTokens = policy.maxOutputTokens ?? 2_048
  using duration = deadline(signal, timeoutMs, 'PROMPT_OPTIMIZE_TIMEOUT')
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: draft }],
    source: { kind: 'codexy-prompt-optimizer' },
  })]
  const options: GenerateOptions = {
    provider,
    model,
    system: SYSTEM,
    messages,
    temperature: 0,
    maxTokens: maxOutputTokens,
    sessionId: agent.session.id,
    signal: duration.signal,
  }
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) {
    duration.signal.throwIfAborted()
    assembler.push(chunk)
  }
  duration.signal.throwIfAborted()
  const finish = assembler.finish
  if (finish.kind !== 'stop') {
    throw finish.kind === 'error' ? new Error(finish.failure.message) : new Error(`The rewrite ended with ${finish.kind}`)
  }
  const blocks = assembler.blocks()
  if (blocks.some(block => block.type !== 'text' && block.type !== 'reasoning')) {
    throw new Error('The rewrite must contain text only')
  }
  const rewritten = blocks
    .filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim()
  if (rewritten === '') throw new Error('The rewrite produced no text')
  return rewritten
}
