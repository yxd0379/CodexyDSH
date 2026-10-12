/** Client-safe managed MCP catalog and session connection observations. */

/** A server available to the receiving Session. */
export interface McpServerStatus {
  /** Stable local tool namespace. */
  serverName: string
  /** Configured transport. */
  transport: 'stdio' | 'streamable-http'
  /** Whether the receiving Session has selected this server. */
  enabled: boolean
  /** Current transport state; disabled servers have no transport. */
  phase: 'disabled' | 'connecting' | 'connected' | 'retrying' | 'failed' | 'closed'
  /** Number of tools registered for this Session. */
  toolCount: number
}
