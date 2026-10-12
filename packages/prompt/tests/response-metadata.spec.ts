/** Memory-only public Session fixtures; no model requests or files are created or removed. */
import { describe, expect, it, vi } from 'vitest'
import { compactionClientMetadata, createUserMessage } from '@codexydsh/runtime/llm'
import type { CodexClientMetadata } from '@codexydsh/runtime/llm'
import { Session, SessionId, SessionLogOffset, appendProductEvent } from '@codexydsh/runtime/session'
import { CompactionId, compactCheckpointSource } from '@codexydsh/compaction/service'
import { decodeCodexyArtifact, encodeArtifactEvents, encodeArtifactHeader } from '../../runtime/src/persistence-codec.ts'
import { captureCodexfulDeployment } from '../src/preparation.ts'
import { captureResponseMetadata } from '../src/response-metadata.ts'
import { Config as PromptConfig } from '../src/index.ts'

function session(parentSession?: string) {
  const id = SessionId(parentSession === undefined ? 'own-metadata-session' : 'own-child-session')
  return Session.create(id, undefined, { version: 4, id, createdAt: 1000, isSeeded: false,
    ...parentSession === undefined ? {} : { parentSession: SessionId(parentSession), origin: 'subagent' as const } })
}
function opened() {
  const owner = session()
  const user = owner.append('user/message', createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text: 'synthetic task' }] }), { surfaceOp: 'append' })
  const turn = owner.append('turn/start', { turn: 1 })
  owner.append('step/start', { turn: 1, step: 1 })
  return { owner, user, turn }
}
function commit(owner: Session, metadata: CodexClientMetadata) {
  appendProductEvent(owner, 'request/header', { reason: 'initial', header: {
    config: { provider: 'synthetic', model: 'qwen3.8-27b-w8a8', codexfulResponses: {
      omitDefaultMaxTokens: true, reasoningSummary: 'none', wireProfile: 'codex-0.162.1', clientMetadata: metadata,
    } },
  } })
}
const application = { installationId: 'own-profile-installation', threadSource: 'user', turnTrigger: 'exec', analyticsEnabled: false }
const policy = { sandboxMode: 'danger-full-access', autoReviewEnabled: false }
const controls = { model: 'qwen3.8-27b-w8a8', reasoningEffort: 'high' }
function canonical(metadata: CodexClientMetadata) {
  return JSON.parse(metadata['x-codex-turn-metadata']!) as Record<string, unknown>
}

describe('prepared and committed product metadata capture', () => {
  it('keeps a caller without a committed turn executable without invented facts or IDs', () => {
    const mint = vi.fn(() => 'unused')
    expect(captureResponseMetadata(session(), application, policy, controls, mint)).toBeUndefined()
    expect(mint).not.toHaveBeenCalled()
  })

  it('captures the original turn boundary and actual policies without reading an account or copying a baseline', () => {
    const { owner, turn } = opened()
    const metadata = captureResponseMetadata(owner, application, policy, controls, () => 'own-initial-window')!
    expect(canonical(metadata)).toEqual({ installation_id: application.installationId,
      session_id: owner.id, thread_id: owner.id, agent_name: '/root',
      turn_id: `${owner.id}:turn:${turn.seq}`, root_turn_id: `${owner.id}:turn:${turn.seq}`,
      window_id: `${owner.id}:0`, window_number: 0, context_window_id: 'own-initial-window',
      request_kind: 'turn', thread_source: 'user', turn_trigger: 'exec', sandbox: 'none',
      sandbox_mode: 'danger-full-access', auto_review_enabled: false,
      turn_started_at_unix_ms: turn.time, analytics_enabled: false, ...{
        model: controls.model, reasoning_effort: controls.reasoningEffort,
      } })
    expect(canonical(metadata)).not.toHaveProperty('node_repl_disabled')
    expect(canonical(metadata)).not.toHaveProperty('node_repl_auto_review_required')
  })

  it('reuses committed own installation/window identities across retry and byte-preserving restoration', () => {
    const { owner } = opened()
    let ids = 0
    const mint = vi.fn(() => `own-minted-${++ids}`)
    const first = captureResponseMetadata(owner, undefined, policy, controls, mint)!
    commit(owner, first)
    expect(mint).toHaveBeenCalledTimes(2)
    expect(captureResponseMetadata(owner, undefined, policy, controls, mint)).toEqual(first)
    expect(mint).toHaveBeenCalledTimes(2)
    const bytes = Buffer.from(encodeArtifactHeader({ kind: 'codexy-session', version: 1,
      session: owner.header, inheritedEventCount: SessionLogOffset(0) }) + encodeArtifactEvents(owner.snapshotEvents()))
    const decoded = decodeCodexyArtifact(bytes)
    const restored = Session.fromRestore(owner.id, decoded.events, decoded.metadata.session,
      decoded.metadata.inheritedEventCount, 'detached')
    expect(captureResponseMetadata(restored, undefined, policy, controls, mint)).toEqual(first)
    expect(encodeArtifactHeader(decoded.metadata) + encodeArtifactEvents(decoded.events)).toBe(bytes.toString())
    expect(mint).toHaveBeenCalledTimes(2)
  })

  it('does not advance a window for a failed attempt or arbitrary history replacement', () => {
    const { owner, user } = opened()
    const first = captureResponseMetadata(owner, application, policy, controls, () => 'own-window-0')!
    commit(owner, first)
    const failed = CompactionId('own-failed-compaction')
    owner.append('compaction/start', { compactionId: failed, turn: 1 })
    owner.append('compaction/end', { compactionId: failed, turn: 1, error: 'synthetic failure' })
    owner.append('user/message', createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'truthful replacement' }] }),
    { surfaceOp: { op: 'replace', startSeq: user.seq, endSeq: user.seq }, sourceEventSeqs: [user.seq] })
    expect(captureResponseMetadata(owner, application, policy, controls, () => 'unused')).toEqual(first)
  })

  it('advances after an actual successful committed compaction and keeps its identity after capture', () => {
    const { owner, user } = opened()
    const first = captureResponseMetadata(owner, application, policy, controls, () => 'own-window-0')!
    commit(owner, first)
    const successful = CompactionId('own-successful-compaction')
    owner.append('compaction/start', { compactionId: successful, turn: 1 })
    owner.append('compaction/summary', { compactionId: successful,
      summary: [{ type: 'text', text: 'synthetic summary' }], provider: 'synthetic', model: 'summary-fixture',
      shadowedRange: { start: user.seq, end: user.seq }, shadowedSeqs: [user.seq], shadowedTokenCount: 1 })
    owner.append('user/message', createUserMessage({ source: compactCheckpointSource(successful),
      content: [{ type: 'text', text: 'synthetic summary' }] }),
    { surfaceOp: { op: 'replace', startSeq: user.seq, endSeq: user.seq }, sourceEventSeqs: [user.seq] })
    owner.append('compaction/end', { compactionId: successful, turn: 1 })
    const after = captureResponseMetadata(owner, application, policy, controls, () => 'unused')!
    expect(canonical(after)).toMatchObject({ window_number: 1, window_id: `${owner.id}:1`,
      context_window_id: `${owner.id}:context:${successful}`, installation_id: application.installationId })
    commit(owner, after)
    expect(captureResponseMetadata(owner, application, policy, controls, () => 'unused')).toEqual(after)
  })

  it('leaves unknown confined backend and child attribution absent while preserving known facts', () => {
    const child = session('own-parent-session')
    child.append('turn/start', { turn: 1 })
    const metadata = captureResponseMetadata(child, application,
      { sandboxMode: 'workspace-write', autoReviewEnabled: true }, controls, () => 'own-child-window')!
    expect(canonical(metadata)).toMatchObject({ thread_id: child.id, sandbox_mode: 'workspace-write', auto_review_enabled: true })
    for (const key of ['sandbox', 'root_turn_id', 'agent_name', 'thread_source', 'turn_trigger']) expect(canonical(metadata)).not.toHaveProperty(key)
    expect(metadata).not.toHaveProperty('root_turn_id')
  })

  it('freezes explicit metadata facts with the deployment before asynchronous preparation', () => {
    const metadata = { ...application }
    const captured = captureCodexfulDeployment({ wireProfile: 'codex-0.162.1', metadata })
    metadata.installationId = 'later-installation'
    metadata.turnTrigger = 'later-trigger'
    metadata.analyticsEnabled = true
    expect(Object.isFrozen(captured.responseMetadata)).toBe(true)
    expect(captured.responseMetadata).toEqual(application)
    expect(captureCodexfulDeployment({}).responseMetadata).toBeUndefined()
  })

  it('captures only explicit model restrictions, without inferring Node availability or copying another client', () => {
    const { owner } = opened()
    for (const selected of [false, true]) {
      const metadata = captureResponseMetadata(owner, { ...application, modelPolicy: {
        nodeReplDisabled: selected, nodeReplAutoReviewRequired: selected,
      } }, policy, controls, () => 'own-window')!
      expect(canonical(metadata)).toMatchObject({ node_repl_disabled: selected, node_repl_auto_review_required: selected })
    }
    const partial = captureResponseMetadata(owner, { ...application, modelPolicy: { nodeReplDisabled: false } },
      policy, controls, () => 'own-window')!
    expect(canonical(partial)).toHaveProperty('node_repl_disabled', false)
    expect(canonical(partial)).not.toHaveProperty('node_repl_auto_review_required')
    const empty = captureResponseMetadata(owner, { ...application, modelPolicy: {} }, policy, controls, () => 'own-window')!
    expect(canonical(empty)).not.toHaveProperty('node_repl_disabled')
    expect(canonical(empty)).not.toHaveProperty('node_repl_auto_review_required')
  })

  it('detaches nested model restrictions and carries the same snapshot across retry, restore and compaction', () => {
    const applicationFacts = { ...application, modelPolicy: { nodeReplDisabled: false, nodeReplAutoReviewRequired: false } }
    const captured = captureCodexfulDeployment({ wireProfile: 'codex-0.162.1', metadata: applicationFacts }).responseMetadata!
    applicationFacts.modelPolicy.nodeReplDisabled = true
    applicationFacts.modelPolicy.nodeReplAutoReviewRequired = true
    expect(Object.isFrozen(captured.modelPolicy)).toBe(true)
    const { owner } = opened()
    const first = captureResponseMetadata(owner, captured, policy, controls, () => 'own-window')!
    commit(owner, first)
    expect(captureResponseMetadata(owner, captured, policy, controls, () => 'unused')).toEqual(first)
    const bytes = encodeArtifactHeader({ kind: 'codexy-session', version: 1, session: owner.header,
      inheritedEventCount: SessionLogOffset(0) }) + encodeArtifactEvents(owner.snapshotEvents())
    const decoded = decodeCodexyArtifact(Buffer.from(bytes))
    const restored = Session.fromRestore(owner.id, decoded.events, decoded.metadata.session,
      decoded.metadata.inheritedEventCount, 'detached')
    expect(captureResponseMetadata(restored, captured, policy, controls, () => 'unused')).toEqual(first)
    const compact = compactionClientMetadata(first, { trigger: 'auto', reason: 'context_limit',
      implementation: 'responses', phase: 'mid_turn', strategy: 'memento' })!
    expect(canonical(compact)).toMatchObject({ node_repl_disabled: false, node_repl_auto_review_required: false,
      request_kind: 'compaction', compaction: { trigger: 'auto', reason: 'context_limit',
        implementation: 'responses', phase: 'mid_turn', strategy: 'memento' } })
    expect(canonical(compact)).not.toHaveProperty('model')
    expect(canonical(compact)).not.toHaveProperty('reasoning_effort')
    expect(encodeArtifactHeader(decoded.metadata) + encodeArtifactEvents(decoded.events)).toBe(bytes)
  })

  it('validates explicitly configured model restrictions as booleans without inventing absent defaults', () => {
    expect(PromptConfig({ metadata: { modelPolicy: { nodeReplDisabled: false, nodeReplAutoReviewRequired: true } } }).metadata)
      .toEqual({ modelPolicy: { nodeReplDisabled: false, nodeReplAutoReviewRequired: true } })
    const omitted = PromptConfig({ metadata: {} }).metadata
    expect(omitted?.modelPolicy).not.toHaveProperty('nodeReplDisabled')
    expect(omitted?.modelPolicy).not.toHaveProperty('nodeReplAutoReviewRequired')
    for (const value of ['false', 0]) {
      expect(() => PromptConfig({ metadata: { modelPolicy: { nodeReplDisabled: value as never } } })).toThrow()
    }
  })
})
