/** Durable Codexful delegation version shared by model requests and child Sessions. */

import { z } from 'zod'
import { appendProductEvent, projectProductEvent, type Session } from '@codexydsh/runtime/session'
import type SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { CodexfulMultiAgentVersion } from './prompts.ts'

declare module '@codexydsh/runtime/types' {
  interface SessionEventMap {
    /**
     * Records the Session's selected delegation version before it determines
     * model-visible tools. Child Sessions inherit the version; model changes
     * and compaction preserve it. Log-only, with no surface operation.
     */
    'codexful/multi-agent-version': {
      /** Selected Codex delegation interface. */
      version: CodexfulMultiAgentVersion
    }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Selected delegation version, or null before the first selection. */
    codexfulMultiAgentVersion: CodexfulMultiAgentVersion | null
  }
}

const versionSchema = z.enum(['v1', 'v2'])

/** Host-only projection of the latest explicit Session delegation selection. */
export const codexfulMultiAgentVersionProjection = {
  key: 'codexfulMultiAgentVersion',
  stateVersion: 1,
  stateSchema: versionSchema.nullable(),
  init: () => null,
  apply: (state, rawEvent) => {
    const event = projectProductEvent(rawEvent)
    return event.type === 'codexful/multi-agent-version'
      ? versionSchema.parse(event.data.version) : state
  },
} satisfies ProjectionDefinition<'codexfulMultiAgentVersion', CodexfulMultiAgentVersion | null>

/**
 * Read the selected delegation version from the required Session projection.
 * @param projections - registry owning the version projection.
 * @param session - Session whose selection is read.
 * @returns the selected version, or null before selection.
 */
export function codexfulMultiAgentVersion(
  projections: Pick<SessionProjectionRegistry, 'stateOf'>,
  session: Session,
): CodexfulMultiAgentVersion | null {
  const version = projections.stateOf(session, 'codexfulMultiAgentVersion')
  if (version === undefined) throw new Error('Codexful delegation requires its Session version projection')
  return version
}

/**
 * Record a delegation selection before its tool family reaches a model request.
 * @param projections - registry owning the version projection.
 * @param session - Session receiving the selection.
 * @param version - model-selected, inherited, or explicitly configured version.
 */
export function recordCodexfulMultiAgentVersion(
  projections: Pick<SessionProjectionRegistry, 'stateOf'>,
  session: Session,
  version: CodexfulMultiAgentVersion,
): void {
  if (codexfulMultiAgentVersion(projections, session) !== version) {
    appendProductEvent(session, 'codexful/multi-agent-version', { version })
  }
}
