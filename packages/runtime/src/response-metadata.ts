/** Product-owned facts projected through Codex 0.162.1's Responses metadata shape. */

/** Dispatch-time facts, not the outcome of a summarization attempt. */
export interface CodexCompactionMetadataFacts {
  readonly trigger: 'manual' | 'auto'
  readonly reason: 'user_requested' | 'context_limit' | 'model_downshift' | 'comp_hash_changed'
  readonly implementation: 'responses' | 'responses_compaction_v2'
  readonly phase: 'standalone_turn' | 'pre_turn' | 'mid_turn' | 'post_turn'
  readonly strategy: 'memento' | 'prefix_compaction'
}

/** Git facts captured for a real workspace at this turn's preparation boundary. */
export interface CodexWorkspaceMetadata {
  readonly latest_git_commit_hash: string
  readonly has_changes: boolean
}

export type CodexWorkspacesMetadata = Readonly<Record<string, CodexWorkspaceMetadata>>

/** Values captured by the request owner; omission means the fact is not known. */
export interface CodexResponseMetadataFacts {
  readonly installationId: string
  readonly sessionId: string
  readonly threadId: string
  readonly turnId: string
  readonly contextWindowId: string
  readonly windowNumber: number
  readonly requestKind: 'turn' | 'compaction'
  readonly rootTurnId?: string
  readonly agentName?: string
  readonly threadSource?: string
  readonly turnTrigger?: string
  readonly sandbox?: string
  readonly sandboxMode?: string
  readonly autoReviewEnabled?: boolean
  /** Captured model computer-use review requirement, independent of the registered tool inventory. */
  readonly nodeReplAutoReviewRequired?: boolean
  /** Captured model restriction on Node REPL, not proof of an available Node runtime. */
  readonly nodeReplDisabled?: boolean
  readonly turnStartedAtUnixMs?: number
  readonly analyticsEnabled?: boolean
  readonly workspaces?: CodexWorkspacesMetadata
  readonly model?: string
  readonly reasoningEffort?: string
  readonly compaction?: CodexCompactionMetadataFacts
}

/** Native Responses client_metadata consists of string values, including its canonical JSON. */
export type CodexClientMetadata = Readonly<Record<string, string>>

/** Preserve Codex's ASCII JSON encoding, including UTF-16 surrogate pairs. */
type MetadataValue = string | number | boolean | undefined | CodexCompactionMetadataFacts | CodexWorkspacesMetadata
function asciiJson(value: Readonly<Record<string, MetadataValue>>): string {
  return JSON.stringify(value).replace(/[\u0080-\uffff]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** Pin the structured field order while detaching the caller's operation facts. */
function compactionValue(facts: CodexCompactionMetadataFacts): CodexCompactionMetadataFacts {
  return { trigger: facts.trigger, reason: facts.reason, implementation: facts.implementation,
    phase: facts.phase, strategy: facts.strategy }
}

/**
 * Project one captured snapshot; this function reads no runtime, clock, or randomness.
 * The canonical ordering follows the explicit 0.162.1 wire profile. Identity aliases
 * all come from this same snapshot, while capabilities remain independently supplied facts.
 */
export function encodeCodexClientMetadata(facts: CodexResponseMetadataFacts): CodexClientMetadata {
  const windowId = `${facts.threadId}:${facts.windowNumber}`
  const canonical = asciiJson({
    installation_id: facts.installationId,
    session_id: facts.sessionId,
    thread_id: facts.threadId,
    agent_name: facts.agentName,
    turn_id: facts.turnId,
    window_id: windowId,
    window_number: facts.windowNumber,
    context_window_id: facts.contextWindowId,
    request_kind: facts.requestKind,
    root_turn_id: facts.rootTurnId,
    thread_source: facts.threadSource,
    turn_trigger: facts.turnTrigger,
    sandbox: facts.sandbox,
    sandbox_mode: facts.sandboxMode,
    auto_review_enabled: facts.autoReviewEnabled,
    node_repl_auto_review_required: facts.nodeReplAutoReviewRequired,
    node_repl_disabled: facts.nodeReplDisabled,
    workspaces: facts.workspaces,
    turn_started_at_unix_ms: facts.turnStartedAtUnixMs,
    analytics_enabled: facts.analyticsEnabled,
    ...facts.requestKind === 'compaction'
      ? { compaction: facts.compaction === undefined ? undefined : compactionValue(facts.compaction) }
      : { model: facts.model, reasoning_effort: facts.reasoningEffort },
  })
  return Object.freeze({
    'x-codex-window-id': windowId,
    'x-codex-turn-metadata': canonical,
    thread_id: facts.threadId,
    ...facts.rootTurnId === undefined ? {} : { root_turn_id: facts.rootTurnId },
    turn_id: facts.turnId,
    'x-codex-installation-id': facts.installationId,
    session_id: facts.sessionId,
  })
}

/**
 * Reuse a committed product snapshot for an actual prepared compaction call.
 * Purpose and captured compaction facts replace turn-only model controls. No identity
 * or clock is minted. Unknown operation facts stay absent, not inferred from a prompt.
 * A foreign canonical format is left unavailable, without blocking the call.
 */
export function compactionClientMetadata(
  snapshot: CodexClientMetadata | undefined,
  compaction?: CodexCompactionMetadataFacts,
): CodexClientMetadata | undefined {
  if (snapshot === undefined) return
  let parsed: unknown
  try {
    parsed = JSON.parse(snapshot['x-codex-turn-metadata'] ?? 'null')
  } catch {
    return
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
  const canonical: Record<string, MetadataValue> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (key === 'compaction' && isCompactionMetadata(value)) continue
    if (key === 'workspaces') {
      if (!isCodexWorkspacesMetadata(value)) return
      canonical[key] = value
      continue
    }
    if (typeof value !== 'string' && typeof value !== 'boolean'
      && (typeof value !== 'number' || !Number.isSafeInteger(value))) return
    canonical[key] = value
  }
  canonical['request_kind'] = 'compaction'
  delete canonical['model']
  delete canonical['reasoning_effort']
  if (compaction !== undefined) canonical['compaction'] = compactionValue(compaction)
  return Object.freeze({ ...snapshot, 'x-codex-turn-metadata': asciiJson(canonical) })
}

/** Admit the known pinned workspace shape when restoring a committed snapshot. */
export function isCodexWorkspacesMetadata(value: unknown): value is CodexWorkspacesMetadata {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value).every(workspace => {
    if (workspace === null || typeof workspace !== 'object' || Array.isArray(workspace)) return false
    const fields = workspace as Record<string, unknown>
    return Object.keys(fields).length === 2 && typeof fields['latest_git_commit_hash'] === 'string'
      && typeof fields['has_changes'] === 'boolean'
  })
}

/** Admit only the pinned structured field when reusing an already captured snapshot. */
function isCompactionMetadata(value: unknown): value is CodexCompactionMetadataFacts {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const fields = value as Record<string, unknown>
  return Object.keys(fields).length === 5
    && (fields['trigger'] === 'auto' || fields['trigger'] === 'manual')
    && ['user_requested', 'context_limit', 'model_downshift', 'comp_hash_changed'].includes(String(fields['reason']))
    && ['responses', 'responses_compaction_v2'].includes(String(fields['implementation']))
    && ['standalone_turn', 'pre_turn', 'mid_turn', 'post_turn'].includes(String(fields['phase']))
    && ['memento', 'prefix_compaction'].includes(String(fields['strategy']))
}
