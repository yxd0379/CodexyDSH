/** Plugin-owned delegation version shared by model requests and child sessions. */

import { z } from 'zod'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { CodexfulMultiAgentVersion } from './prompts.ts'

declare module '@codexydsh/runtime/types' {
  interface CodexySessionEventMap {
    /**
     * Legacy migration vocabulary. New selections use the prompt domain.
     */
    'codexful/multi-agent-version': {
      /** Selected Codex delegation interface. */
      version: CodexfulMultiAgentVersion
    }
  }
}

const versionSchema = z.enum(['v1', 'v2'])
/** Plugin state, not an extension of the conversation format. */
export const promptDomain = defineDomain({
  name: 'codexy_prompt', version: 1,
  tables: { delegation: domainTable(z.object({ version: versionSchema })) },
})
type Selections = KvTable<string, { version: CodexfulMultiAgentVersion }>

/**
 * Read the selected delegation version from plugin storage.
 * @param selections - plugin-owned delegation table.
 * @param session - Session whose selection is read.
 * @returns the selected version, or null before selection.
 */
export function codexfulMultiAgentVersion(
  selections: Selections,
  session: Session,
): CodexfulMultiAgentVersion | null {
  return selections.get(session.id)?.version ?? null
}

/**
 * Record a delegation selection before its tool family reaches a model request.
 * @param selections - plugin-owned delegation table.
 * @param session - Session receiving the selection.
 * @param version - model-selected, inherited, or explicitly configured version.
 */
export async function recordCodexfulMultiAgentVersion(
  selections: Selections,
  session: Session,
  version: CodexfulMultiAgentVersion,
): Promise<void> {
  if (codexfulMultiAgentVersion(selections, session) !== version) await selections.put(session.id, { version })
}
