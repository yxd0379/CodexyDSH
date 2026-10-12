import { deriveMessageNodes } from '../session.ts'
/** Append-only Codexful v2 delegation mode selected after request preparation. */

import { createDeveloperMessage, createUserMessage } from '../llm.ts'
import type { DeveloperMessage, Message, UserMessage } from '../llm.ts'
import type { Session, SessionSeq } from '../session.ts'
import { codexWorldStateMessageSource } from './codex-world-state.ts'

const SECTION = 'codexful-v2:multi-agent-mode'

/** Pinned explicit delegation policy, also used when proactive delegation is disabled. */
export const CODEX_EXPLICIT_MULTI_AGENT_MODE = 'Any earlier instruction enabling proactive multi-agent delegation no longer applies. Do not spawn sub-agents unless the user or applicable AGENTS.md/skill instructions explicitly ask for sub-agents, delegation, or parallel agent work.'

/** Pinned proactive delegation policy. */
export const CODEX_PROACTIVE_MULTI_AGENT_MODE = 'Proactive multi-agent delegation is active. Any earlier developer instruction requiring an explicit user request before spawning sub-agents no longer applies. This mode remains active until a later multi-agent mode developer message changes it. User requests override this hint.\n\nIf at any point you can parallelize work by delegating tasks to another agent (no matter if you are root or subagent), you should do so using collaboration tools if it could save time or improve quality.'

/** Identify the mode fragment without claiming other runtime-context messages. */
export function isCodexMultiAgentModeSource(source: Message['source']): boolean {
  return source.kind === 'runtime-context' && source.form === 'snapshot'
    && source.sections.some(section => section.name === SECTION)
}

/**
 * Append the current mode only when no retained mode fragment already says the same thing.
 * @param session - model-visible Session history after any role migrations.
 * @param body - effective mode text, or undefined when delegation mode is disabled.
 * @param native - whether the prepared route supports developer history.
 * @param role - full role text whose snapshot controls mode reinjection.
 * @param contextMode - whether this is full initialization or a steady update.
 * @returns the next logged mode message, if the mode changed or compaction removed it.
 */
export function codexMultiAgentModeMessage(
  session: Session,
  body: string | undefined,
  native: boolean,
  role?: string,
  contextMode: 'full' | 'delta' = 'delta',
): DeveloperMessage | UserMessage | undefined {
  const retained = session.deriveMessages().findLast(message => isCodexMultiAgentModeSource(message.source))
  const source = retained?.source.kind === 'runtime-context' ? retained.source.codexMultiAgentWorldState : undefined
  const previous = source?.section === 'multi-agent-mode' ? source.snapshot : undefined
  if (body !== undefined && previous?.body === body && previous.role === (role ?? null)) return
  const rendered = body ?? (retained !== undefined
    && (previous === undefined || previous.body === CODEX_PROACTIVE_MULTI_AGENT_MODE)
    ? CODEX_EXPLICIT_MULTI_AGENT_MODE : undefined)
  if (rendered === undefined) return
  const text = `<multi_agent_mode>${rendered}</multi_agent_mode>`
  const input = {
    content: [{ type: 'text' as const, text }],
    source: codexWorldStateMessageSource({ section: 'multi-agent-mode', mode: contextMode,
      snapshot: { body: body ?? null, role: role ?? null } }, text),
  }
  return native ? createDeveloperMessage(input) : createUserMessage(input)
}

/**
 * Re-role retained mode fragments when the selected route changes developer-history support.
 * @param session - Session whose visible nodes may use the old route role.
 * @param native - whether the current route supports developer history.
 * @returns retained nodes and their replacement messages in surface order.
 */
export function codexMultiAgentModeRoleMigrations(
  session: Session,
  native: boolean,
): { seq: SessionSeq; message: DeveloperMessage | UserMessage }[] {
  const migrations: { seq: SessionSeq; message: DeveloperMessage | UserMessage }[] = []
  for (const { seq, message } of deriveMessageNodes(session)) {
    if (!isCodexMultiAgentModeSource(message.source)
      || (native ? message.role !== 'user' : message.role !== 'developer')) continue
    const input = { content: message.content, source: message.source }
    migrations.push({ seq, message: native ? createDeveloperMessage(input) : createUserMessage(input) })
  }
  return migrations
}
