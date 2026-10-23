/** Incremental reconstruction of successful MCP command selections. */
import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

/** Parsed persistent command arguments. */
export interface McpSelection { enabled: boolean; serverName: string }

/** Host-only checkpoint state; unfinished commands do not change selection. */
export interface McpSelectionState {
  overrides: Record<string, boolean>
  pending: Record<string, McpSelection>
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { /** Session-local choices from successful command pairs. */ mcpSelection: McpSelectionState }
}

/** Parse the stable on/off command grammar.
 * @param input - Command arguments including separator whitespace.
 * @returns Selected server and desired state, or undefined for invalid arguments.
 */
export function parseMcpSelection(input: string): McpSelection | undefined {
  const match = /^\s*(on|off)\s+([A-Za-z0-9_-]{1,32})\s*$/u.exec(input)
  const serverName = match?.[2]
  return serverName === undefined ? undefined : { enabled: match?.[1] === 'on', serverName }
}

/** Pure fold retaining only settled Session selection and outstanding command pairs. */
export const mcpSelectionProjection: ProjectionDefinition<'mcpSelection'> = {
  key: 'mcpSelection', stateVersion: 1,
  stateSchema: z.object({
    overrides: z.record(z.string(), z.boolean()),
    pending: z.record(z.string(), z.object({ enabled: z.boolean(), serverName: z.string() })),
  }),
  init: () => ({ overrides: {}, pending: {} }),
  apply(state, event) {
    if (event.type === 'command/run' && event.data.name === 'mcp') {
      const parsed = parseMcpSelection(event.data.args ?? '')
      return parsed ? { ...state, pending: { ...state.pending, [event.data.commandId]: parsed } } : state
    }
    if (event.type !== 'command/done' || !Object.hasOwn(state.pending, event.data.commandId)) return state
    const parsed = state.pending[event.data.commandId] as McpSelection
    const pending = Object.fromEntries(Object.entries(state.pending).filter(([id]) => id !== event.data.commandId))
    return { pending, overrides: event.data.kind === 'success'
      ? { ...state.overrides, [parsed.serverName]: parsed.enabled } : state.overrides }
  },
}
