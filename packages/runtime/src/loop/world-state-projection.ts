/** Session projection for Codexful's latest environment and permission snapshots. */

import { MessageId } from '../llm.ts'
import { SessionSeq } from '../session.ts'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type { CodexEnvironmentSnapshot, CodexPermissionSnapshot } from './codex-world-state.ts'

/** State reconstructed from accepted Codexful world-state messages. */
export interface CodexWorldStateProjection {
  readonly environment: CodexEnvironmentSnapshot | null
  readonly permissions: CodexPermissionSnapshot | null
  readonly permissionMessages: readonly { readonly seq: SessionSeq; readonly id: MessageId }[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    codexWorldState: CodexWorldStateProjection
  }
}

const stateSchema = z.object({
  environment: z.object({
    cwd: z.string(), shell: z.string(), date: z.string(), timezone: z.string(),
    network: z.string(), filesystem: z.string(), subagents: z.array(z.string()).readonly(),
  }).nullable(),
  permissions: z.object({
    instructions: z.string(), prefixes: z.array(z.array(z.string()).readonly()).readonly(),
  }).nullable(),
  permissionMessages: z.array(z.object({
    seq: z.number().int().nonnegative().transform(SessionSeq),
    id: z.string().transform(MessageId),
  })).readonly(),
})

/** Fold committed snapshots; model-history retention is checked when preparing a request. */
export const codexWorldStateProjectionDefinition = {
  key: 'codexWorldState',
  stateVersion: 1,
  stateSchema,
  init: (): CodexWorldStateProjection => ({ environment: null, permissions: null, permissionMessages: [] }),
  apply(state, event) {
    const message = event.type === 'developer/message' ? event.data.message
      : event.type === 'user/message' ? event.data : undefined
    const source = message?.source.kind === 'runtime-context' ? message.source.codexWorldState : undefined
    if (source?.section === 'environment') return { ...state, environment: source.snapshot }
    if (source?.section === 'permissions' && message !== undefined) {
      return {
        ...state,
        permissions: source.snapshot,
        permissionMessages: [...state.permissionMessages, { seq: event.seq, id: message.id }],
      }
    }
    return state
  },
} satisfies ProjectionDefinition<'codexWorldState', CodexWorldStateProjection>
