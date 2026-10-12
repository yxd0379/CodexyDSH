/** Pure synthetic facts: no account, filesystem mutation, or model execution. */
import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { compactionClientMetadata, encodeCodexClientMetadata } from '../src/response-metadata.ts'
import type { CodexClientMetadata, CodexCompactionMetadataFacts, CodexResponseMetadataFacts } from '../src/response-metadata.ts'

const operation: CodexCompactionMetadataFacts = { trigger: 'auto', reason: 'context_limit',
  implementation: 'responses', phase: 'mid_turn', strategy: 'memento' }

const facts: CodexResponseMetadataFacts = {
  installationId: 'own-installation', sessionId: 'own-session', threadId: 'own-thread',
  turnId: 'own-turn-1', rootTurnId: 'own-turn-1', agentName: '/root',
  contextWindowId: 'own-window-0', windowNumber: 0, requestKind: 'turn',
  threadSource: 'user', turnTrigger: 'exec', sandbox: 'none', sandboxMode: 'danger-full-access',
  autoReviewEnabled: false, nodeReplAutoReviewRequired: false, nodeReplDisabled: true,
  turnStartedAtUnixMs: 1700000000000, analyticsEnabled: false,
  model: 'qwen3.8-27b-w8a8', reasoningEffort: 'high',
}
const nativeCassettePath = process.env.CODEXY_NATIVE_ANKO_CASSETTE

describe('own Codex Responses metadata snapshot', () => {
  it('projects all aliases from one canonical snapshot in pinned field order', () => {
    const metadata = encodeCodexClientMetadata(facts)
    const canonical: Record<string, unknown> = JSON.parse(metadata['x-codex-turn-metadata']!)
    expect(Object.keys(metadata)).toEqual(['x-codex-window-id', 'x-codex-turn-metadata', 'thread_id',
      'root_turn_id', 'turn_id', 'x-codex-installation-id', 'session_id'])
    expect(Object.keys(canonical)).toEqual(['installation_id', 'session_id', 'thread_id', 'agent_name',
      'turn_id', 'window_id', 'window_number', 'context_window_id', 'request_kind', 'root_turn_id',
      'thread_source', 'turn_trigger', 'sandbox', 'sandbox_mode', 'auto_review_enabled',
      'node_repl_auto_review_required', 'node_repl_disabled', 'turn_started_at_unix_ms',
      'analytics_enabled', 'model', 'reasoning_effort'])
    for (const key of ['thread_id', 'session_id', 'turn_id', 'root_turn_id']) expect(metadata[key]).toBe(canonical[key])
    expect(metadata['x-codex-installation-id']).toBe(canonical['installation_id'])
    expect(metadata['x-codex-window-id']).toBe(canonical['window_id'])
    expect(canonical['window_id']).toBe('own-thread:0')
    expect(canonical['node_repl_disabled']).toBe(true)
    expect(canonical['analytics_enabled']).toBe(false)
  })

  it('omits unknown capability, policy, source and clock fields rather than inventing defaults', () => {
    const metadata = encodeCodexClientMetadata({ installationId: 'i', sessionId: 's', threadId: 't',
      turnId: 'turn', contextWindowId: 'window', windowNumber: 0, requestKind: 'turn' })
    expect(JSON.parse(metadata['x-codex-turn-metadata']!)).toEqual({ installation_id: 'i', session_id: 's',
      thread_id: 't', turn_id: 'turn', window_id: 't:0', window_number: 0,
      context_window_id: 'window', request_kind: 'turn' })
    expect(metadata).not.toHaveProperty('root_turn_id')
  })

  it('retains false values and does not mutate or retain the caller-owned facts', () => {
    const mutable = { ...facts }
    const metadata = encodeCodexClientMetadata(mutable)
    mutable.threadId = 'later-thread'
    mutable.analyticsEnabled = true
    expect(Object.isFrozen(metadata)).toBe(true)
    expect(metadata.thread_id).toBe('own-thread')
    expect(JSON.parse(metadata['x-codex-turn-metadata']!).analytics_enabled).toBe(false)
    expect(encodeCodexClientMetadata(facts)).toEqual(metadata)
  })

  it('keeps a retry stable, advances only the supplied successful window, and captures real changes', () => {
    const original = encodeCodexClientMetadata(facts)
    expect(encodeCodexClientMetadata({ ...facts })).toEqual(original)
    const next = encodeCodexClientMetadata({ ...facts, turnId: 'own-turn-2', rootTurnId: 'own-turn-2',
      turnStartedAtUnixMs: 1700000000010, windowNumber: 1, contextWindowId: 'own-checkpoint-1',
      sandbox: 'seatbelt', sandboxMode: 'workspace-write', autoReviewEnabled: true })
    const canonical = JSON.parse(next['x-codex-turn-metadata']!)
    expect(next['x-codex-window-id']).toBe('own-thread:1')
    expect(canonical).toMatchObject({ context_window_id: 'own-checkpoint-1', turn_id: 'own-turn-2',
      sandbox: 'seatbelt', sandbox_mode: 'workspace-write', auto_review_enabled: true })
    expect(original).toEqual(encodeCodexClientMetadata(facts))
  })

  it('records actual compaction facts without turn-only model controls', () => {
    const metadata = encodeCodexClientMetadata({ ...facts, requestKind: 'compaction',
      model: 'actual-summary-model', reasoningEffort: 'low', compaction: operation })
    expect(JSON.parse(metadata['x-codex-turn-metadata']!)).toMatchObject({ request_kind: 'compaction',
      compaction: operation, turn_id: 'own-turn-1' })
    expect(JSON.parse(metadata['x-codex-turn-metadata']!)).not.toHaveProperty('model')
    expect(JSON.parse(metadata['x-codex-turn-metadata']!)).not.toHaveProperty('reasoning_effort')
  })

  it('preserves non-ASCII names losslessly with the pinned ASCII canonical encoding', () => {
    const metadata = encodeCodexClientMetadata({ ...facts, agentName: '/root/工具😀' })
    expect(metadata['x-codex-turn-metadata']).toContain('"agent_name":"/root/\\u5de5\\u5177\\ud83d\\ude00"')
    expect(JSON.parse(metadata['x-codex-turn-metadata']!).agent_name).toBe('/root/工具😀')
    expect(metadata['x-codex-turn-metadata']).toMatch(/^[\x00-\x7f]*$/)
  })

  it('retains a detached workspace snapshot including false across compaction', () => {
    const workspaces = { '/own/仓库': { latest_git_commit_hash: 'a'.repeat(40), has_changes: false } }
    const original = encodeCodexClientMetadata({ ...facts, workspaces })
    workspaces['/own/仓库'].latest_git_commit_hash = 'b'.repeat(40)
    workspaces['/own/仓库'].has_changes = true
    const expected = { '/own/仓库': { latest_git_commit_hash: 'a'.repeat(40), has_changes: false } }
    expect(JSON.parse(original['x-codex-turn-metadata']!).workspaces).toEqual(expected)
    const compact = compactionClientMetadata(original, operation)!
    expect(JSON.parse(compact['x-codex-turn-metadata']!).workspaces).toEqual(expected)
    expect(compactionClientMetadata(compact, operation)).toEqual(compact)
    expect(compact['x-codex-turn-metadata']).toMatch(/^[\x00-\x7f]*$/)
    expect(original).not.toHaveProperty('workspaces')
    const keys = Object.keys(JSON.parse(original['x-codex-turn-metadata']!))
    expect(keys.slice(keys.indexOf('node_repl_disabled'), keys.indexOf('model')))
      .toEqual(['node_repl_disabled', 'workspaces', 'turn_started_at_unix_ms', 'analytics_enabled'])
  })

  it('matches the retained native TX0 canonical field order using independently supplied synthetic values', {
    skip: nativeCassettePath === undefined,
  }, async () => {
    if (nativeCassettePath === undefined) throw new Error('explicit native Anko cassette path required')
    const rows = (await readFile(nativeCassettePath, 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line) as { type: string; id?: number; request?: { body: string } })
    const first = rows.find(row => row.type === 'request' && row.id === 0)
    if (first?.request === undefined) throw new Error('missing retained native TX0 request')
    const request = JSON.parse(Buffer.from(first.request.body, 'base64').toString()) as {
      client_metadata: { 'x-codex-turn-metadata': string }
    }
    const original = JSON.parse(request.client_metadata['x-codex-turn-metadata']) as Record<string, unknown>
    // Only the native serialization order is the fixture oracle. All values
    // are this unit's synthetic facts, not copied model input or identities.
    const encoded = encodeCodexClientMetadata({ ...facts,
      workspaces: { '/own/workspace': { latest_git_commit_hash: 'a'.repeat(40), has_changes: false } },
    })['x-codex-turn-metadata']!
    const own = JSON.parse(encoded) as Record<string, unknown>
    expect(Object.keys(own)).toEqual(Object.keys(original))
    expect(encoded).toBe(JSON.stringify(Object.fromEntries(Object.keys(original).map(key => [key, own[key]]))))
    const nativeWorkspace = Object.values(original['workspaces'] as Record<string, unknown>)[0] as Record<string, unknown>
    expect(Object.keys((own['workspaces'] as Record<string, Record<string, unknown>>)['/own/workspace']!))
      .toEqual(Object.keys(nativeWorkspace))
  })

  it('projects captured compaction facts while retaining committed aliases, policy and clock', () => {
    const original = encodeCodexClientMetadata(facts)
    const compact = compactionClientMetadata(original, operation)!
    const { model: _model, reasoning_effort: _effort, ...retained } = JSON.parse(original['x-codex-turn-metadata']!)
    expect(Object.isFrozen(compact)).toBe(true)
    expect(JSON.parse(compact['x-codex-turn-metadata']!)).toEqual({
      ...retained, request_kind: 'compaction', compaction: operation,
    })
    for (const key of Object.keys(original).filter(key => key !== 'x-codex-turn-metadata')) expect(compact[key]).toBe(original[key])
    expect(compactionClientMetadata(original)?.['x-codex-turn-metadata'])
      .not.toContain('reasoning_effort')
    expect(JSON.parse(compactionClientMetadata(original)!['x-codex-turn-metadata']!)).not.toHaveProperty('compaction')
    expect(compactionClientMetadata(compact, operation)).toEqual(compact)
    expect(encodeCodexClientMetadata(facts)).toEqual(original)
  })

  it.each(['pre_turn', 'mid_turn', 'post_turn', 'standalone_turn'] as const)('uses only the supplied operation phase=%s', phase => {
    const mutable = { ...operation, phase }
    const metadata = compactionClientMetadata(encodeCodexClientMetadata(facts), mutable)!
    mutable.phase = 'mid_turn'
    expect(JSON.parse(metadata['x-codex-turn-metadata']!).compaction).toEqual({ ...operation, phase })
  })

  it.each([false, 'unexpected', 1])('rejects scalar workspaces %j rather than retaining them as generic metadata', workspaces => {
    expect(compactionClientMetadata({ 'x-codex-turn-metadata': JSON.stringify({ workspaces }) }, operation)).toBeUndefined()
  })

  it('leaves absent or foreign compaction snapshots optional instead of blocking model execution', () => {
    const snapshots: readonly (CodexClientMetadata | undefined)[] = [undefined, {}, { 'x-codex-turn-metadata': '{' },
      { 'x-codex-turn-metadata': '[]' }, { 'x-codex-turn-metadata': '{"clock":9007199254740992}' },
      { 'x-codex-turn-metadata': '{"compaction":{"phase":"unknown"}}' },
      { 'x-codex-turn-metadata': '{"workspaces":{"/own":{"latest_git_commit_hash":"unknown","has_changes":"false"}}}' }]
    for (const snapshot of snapshots) {
      expect(compactionClientMetadata(snapshot, operation)).toBeUndefined()
    }
  })
})
