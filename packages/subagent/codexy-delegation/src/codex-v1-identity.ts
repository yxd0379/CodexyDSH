import { projectProductEvent } from '@codexydsh/runtime/session'
/**
 * Child-owned Codex v1 identity events and their own-suffix projection.
 *
 * @module @codexydsh/delegation/codex-v1-identity
 */

import { z } from 'zod'
import { SessionLogOffset, SessionSeq } from '@codexydsh/runtime/session'
import type { Session, SessionHeader } from '@codexydsh/runtime/session'
import type { ProjectionDefinition, SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type { CodexV1Identity, CodexV1IdentityProjection } from './projection-types.ts'

declare module '@codexydsh/runtime/types' {
  interface CodexySessionEventMap {
    /**
     * The child-owned, log-only name and optional path of a Codex v1 agent.
     * @param data - identity used for child lookup and model-visible roster entries.
     */
    'subagent/codex-v1-identity': CodexV1Identity
  }
}

/** Host fold state retaining the durable fork cut and this child's identity. */
export interface CodexV1IdentityState {
  readonly inheritedEventCount: SessionLogOffset
  readonly identity: CodexV1IdentityProjection | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    codexV1Identity: CodexV1IdentityState
  }
}

const identitySchema: z.ZodType<CodexV1Identity> = z.object({
  nickname: z.string().min(1),
  agentPath: z.string().min(1).optional(),
}).strict().transform(({ nickname, agentPath }) => ({
  nickname,
  ...agentPath === undefined ? {} : { agentPath },
}))

const viewSchema: z.ZodType<CodexV1IdentityProjection> = z.object({
  nickname: z.string().min(1),
  agentPath: z.string().min(1).optional(),
  seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(SessionSeq),
}).strict().transform(({ nickname, agentPath, seq }) => ({
  nickname,
  ...agentPath === undefined ? {} : { agentPath },
  seq,
}))

const stateSchema: z.ZodType<CodexV1IdentityState> = z.object({
  inheritedEventCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(SessionLogOffset),
  identity: viewSchema.nullable(),
}).strict()

/** Pure Codex v1 identity projection; malformed own facts clear the wire value. */
export const codexV1IdentityProjectionDefinition = {
  key: 'codexV1Identity',
  stateVersion: 1,
  stateSchema,
  init: (_header: SessionHeader, inheritedEventCount: SessionLogOffset) => ({
    inheritedEventCount,
    identity: null,
  }),
  apply: (state, envelope) => {
    const event = projectProductEvent(envelope)
    if (event.type !== 'subagent/codex-v1-identity' || event.seq < state.inheritedEventCount) return state
    const parsed = identitySchema.safeParse(event.data)
    return { ...state, identity: parsed.success ? { ...parsed.data, seq: event.seq } : null }
  },
  wire: { viewSchema: viewSchema.nullable(), view: state => state.identity },
} satisfies ProjectionDefinition<'codexV1Identity', CodexV1IdentityState>

/**
 * Read a child's own Codex v1 identity from the registered projection.
 * @param session - loaded child Session or a detached restored Session.
 * @param projections - registry with the subagent identity projection installed.
 * @returns its own identity and event position, or null when none is valid.
 * @throws when the owning projection is not registered.
 */
export function codexV1IdentityOf(
  session: Session,
  projections: SessionProjectionRegistry,
): CodexV1IdentityProjection | null {
  const state = projections.stateOf(session, 'codexV1Identity')
  if (state === undefined) throw new Error('Codex v1 identity projection is unavailable')
  return state.identity
}
