import { deriveMessageNodes } from '../session.ts'
/** Codexful's append-only environment and permission updates derived from Session state. */

import { createDeveloperMessage, createUserMessage } from '../llm.ts'
import type {} from '../llm.ts'
import type { DeveloperMessage, UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '../session.ts'
import type { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { CodexWorldStateProjection } from './world-state-projection.ts'
import type { RuntimeContextSource } from './runtime-context.ts'

/** Comparison fields for Codexful's single execution environment. */
export interface CodexEnvironmentSnapshot {
  readonly cwd: string
  readonly shell: string
  readonly date: string
  readonly timezone: string
  readonly network: string
  readonly filesystem: string
  readonly subagents: readonly string[]
  /** Loaded V1 children; V2 retains its path-only roster in subagents. */
  readonly legacySubagents?: readonly {
    readonly id: SessionId
    readonly nickname?: string
    readonly agentPath?: string
  }[]
}

/** Permission instructions and the bounded set usable by default exec_command calls. */
export interface CodexPermissionSnapshot {
  readonly instructions: string
  readonly prefixes: readonly (readonly string[])[]
}

/** Current state and renderer supplied by the Codexful prompt contribution. */
export interface CodexWorldStateInput {
  readonly environment: {
    readonly snapshot: CodexEnvironmentSnapshot
    readonly fullText: string
    readonly diffText: (previous: CodexEnvironmentSnapshot) => string | undefined
  }
  readonly permissions: CodexPermissionSnapshot
  /** Selected full role text; the application renders catalog and bundled variants. */
  readonly multiAgentRole?: string
}

/** Optional metadata on an existing runtime-context source; V4 readers already accept its kind. */
export type CodexWorldStateSource =
  | { readonly section: 'environment'; readonly mode: 'full' | 'delta'; readonly snapshot: CodexEnvironmentSnapshot }
  | { readonly section: 'permissions'; readonly mode: 'full' | 'delta'; readonly snapshot: CodexPermissionSnapshot }

/** Optional attribution for standalone roles and role-dependent delegation modes. */
export type CodexMultiAgentWorldStateSource =
  | { readonly section: 'multi-agent-role'; readonly mode: 'full' | 'delta'; readonly snapshot: string }
  | {
    readonly section: 'multi-agent-mode'
    readonly mode: 'full' | 'delta'
    readonly snapshot: {
      readonly body: string | null
      readonly role: string | null
    }
  }

/** One candidate message is committed only after the provider route is prepared. */
export interface CodexWorldStateUpdates {
  readonly environment?: UserMessage
  readonly permissionText?: string
  readonly permissionSource?: Extract<CodexWorldStateSource, { section: 'permissions' }>
  readonly roleText?: string
  readonly roleSource?: Extract<CodexMultiAgentWorldStateSource, { section: 'multi-agent-role' }>
  /** Present for a complete initialization; subsequent updates use delta ordering. */
  readonly contextMode?: 'full'
}

function prefixKey(prefix: readonly string[]): string {
  return JSON.stringify(prefix)
}

function prefixLines(prefixes: readonly (readonly string[])[]): string {
  return prefixes.map(prefix => `- [${prefix.map(token => JSON.stringify(token)).join(', ')}]`).join('\n')
}

/**
 * Render complete permissions including the current approved command prefixes.
 * @param input - captured policy and prefix rules.
 * @returns the complete model-visible permission fragment.
 */
export function fullCodexPermissions(input: CodexPermissionSnapshot): string {
  if (input.prefixes.length === 0) return input.instructions
  const suffix = '</permissions instructions>'
  const addition = `\n\n## Approved command prefixes\nThe following prefix rules are approved for the current default exec_command context:\n${prefixLines(input.prefixes)}\n`
  return input.instructions.endsWith(suffix)
    ? `${input.instructions.slice(0, -suffix.length)}${addition}${suffix}`
    : `${input.instructions}${addition}`
}

function addedPrefixes(current: CodexPermissionSnapshot, previous: CodexPermissionSnapshot): readonly (readonly string[])[] | undefined {
  const before = new Set(previous.prefixes.map(prefixKey))
  const after = new Set(current.prefixes.map(prefixKey))
  if ([...before].some(key => !after.has(key))) return
  return current.prefixes.filter(prefix => !before.has(prefixKey(prefix)))
}

function messageSource(message: UserMessage | DeveloperMessage): CodexWorldStateSource | CodexMultiAgentWorldStateSource | undefined {
  return message.source.kind === 'runtime-context'
    ? message.source.codexWorldState ?? message.source.codexMultiAgentWorldState : undefined
}

/**
 * Attribute one rendered fragment to its captured world-state snapshot.
 * @param codexWorldState - snapshot used to render this fragment.
 * @param text - exact model-visible fragment.
 * @returns the durable runtime-context source.
 */
export function codexWorldStateMessageSource(
  codexWorldState: CodexWorldStateSource | CodexMultiAgentWorldStateSource,
  text: string,
): RuntimeContextSource & { readonly form: 'snapshot' } {
  const name = codexWorldState.section === 'multi-agent-role' ? 'codexful-v2:multi-agent-role'
    : codexWorldState.section === 'multi-agent-mode' ? 'codexful-v2:multi-agent-mode'
      : `codexful:world-state:${codexWorldState.section}`
  return {
    kind: 'runtime-context' as const,
    form: 'snapshot' as const,
    sections: [{ name, text }],
    ...codexWorldState.section === 'multi-agent-role' || codexWorldState.section === 'multi-agent-mode'
      ? { codexMultiAgentWorldState: codexWorldState } : { codexWorldState },
  }
}

/** A stored snapshot is usable only while the model still sees a fragment from its section. */
function retained(session: Session, section: CodexWorldStateSource['section'] | CodexMultiAgentWorldStateSource['section']): boolean {
  return session.deriveMessages().some(message =>
    (message.role === 'user' || message.role === 'developer')
    && messageSource(message)?.section === section)
}

/**
 * Plan world-state messages from the projected snapshot and retained model history.
 * @param session - Session whose surface supplies retained fragments.
 * @param state - host projection folded from committed world-state messages.
 * @param input - environment and permission facts for the current step.
 * @returns messages to append before the prepared model request.
 */
export function projectCodexWorldState(
  session: Session,
  state: CodexWorldStateProjection,
  input: CodexWorldStateInput,
): CodexWorldStateUpdates {
  const previousEnvironment = retained(session, 'environment') ? state.environment ?? undefined : undefined
  const contextMode = previousEnvironment === undefined ? 'full' : 'delta'
  const environmentText = previousEnvironment === undefined
    ? input.environment.fullText : input.environment.diffText(previousEnvironment)
  const environment = environmentText === undefined ? undefined : createUserMessage({
    content: [{ type: 'text', text: environmentText }],
    source: codexWorldStateMessageSource({ section: 'environment', mode: previousEnvironment === undefined ? 'full' : 'delta',
      snapshot: input.environment.snapshot }, environmentText),
  })

  const current = input.permissions
  const previous = retained(session, 'permissions') ? state.permissions ?? undefined : undefined
  const added = previous === undefined || previous.instructions !== current.instructions
    ? undefined : addedPrefixes(current, previous)
  const full = previous === undefined || previous.instructions !== current.instructions || added === undefined
  const permissionText = full ? fullCodexPermissions(current)
    : added.length > 0
      ? `Approved command prefix saved:\n${prefixLines(added)}`
      : undefined
  const previousRole = session.deriveMessages().findLast(message =>
    (message.role === 'user' || message.role === 'developer')
    && messageSource(message)?.section === 'multi-agent-role')
  const roleSource = previousRole?.source.kind === 'runtime-context' ? previousRole.source.codexMultiAgentWorldState : undefined
  const role = input.multiAgentRole
  const roleText = role === undefined || role.length === 0
    || roleSource?.section === 'multi-agent-role' && roleSource.snapshot === role ? undefined
    : contextMode === 'delta' && !role.startsWith('<multi_agent_role>')
      ? `<multi_agent_role>${role}</multi_agent_role>` : role
  return {
    ...contextMode === 'full' ? { contextMode } : {},
    ...environment === undefined ? {} : { environment },
    ...permissionText === undefined ? {} : {
      permissionText,
      permissionSource: {
        section: 'permissions' as const,
        mode: full ? 'full' as const : 'delta' as const,
        snapshot: current,
      },
    },
    ...roleText === undefined || role === undefined ? {} : {
      roleText,
      roleSource: { section: 'multi-agent-role' as const, mode: contextMode, snapshot: role },
    },
  }
}

/** Create the prepared route's native or fallback permission message. */
export function codexPermissionMessage(
  updates: CodexWorldStateUpdates,
  native: boolean,
): DeveloperMessage | UserMessage | undefined {
  if (updates.permissionText === undefined || updates.permissionSource === undefined) return
  const data = {
    content: [{ type: 'text' as const, text: updates.permissionText }],
    source: codexWorldStateMessageSource(updates.permissionSource, updates.permissionText),
  }
  return native ? createDeveloperMessage(data) : createUserMessage(data)
}

/**
 * Create the standalone role for the prepared provider route.
 * @param updates - projected role text and captured full role.
 * @param native - whether the route accepts developer messages.
 * @returns a role message when its retained snapshot differs.
 */
export function codexMultiAgentRoleMessage(updates: CodexWorldStateUpdates, native: boolean): DeveloperMessage | UserMessage | undefined {
  if (updates.roleText === undefined || updates.roleSource === undefined) return
  const data = { content: [{ type: 'text' as const, text: updates.roleText }],
    source: codexWorldStateMessageSource(updates.roleSource, updates.roleText) }
  return native ? createDeveloperMessage(data) : createUserMessage(data)
}

/**
 * Re-role retained permissions when the provider's developer-history capability changes.
 * @param session - Session with the current model-visible surface.
 * @param native - whether the prepared route accepts developer history.
 * @returns replacements for retained permission nodes whose role differs.
 */
export function codexPermissionRoleMigrations(session: Session, native: boolean): {
  seq: SessionSeq
  message: DeveloperMessage | UserMessage
}[] {
  const migrations: { seq: SessionSeq; message: DeveloperMessage | UserMessage }[] = []
  for (const { seq, message } of deriveMessageNodes(session)) {
    if (message.role !== 'user' && message.role !== 'developer') continue
    if (native ? message.role !== 'user' : message.role !== 'developer') continue
    const section = messageSource(message)?.section
    if (section !== 'permissions' && section !== 'multi-agent-role') continue
    migrations.push({
      seq,
      message: native
        ? createDeveloperMessage({ content: message.content, source: message.source })
        : createUserMessage({ content: message.content, source: message.source }),
    })
  }
  return migrations
}
