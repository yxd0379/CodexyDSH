/** Real Git repositories in new retained temporary directories; no old files are touched. */
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { compactionClientMetadata, createUserMessage } from '@codexydsh/runtime/llm'
import type { CodexClientMetadata } from '@codexydsh/runtime/llm'
import { Session, SessionId, SessionLogOffset, appendProductEvent, snapshotProductEvents } from '@codexydsh/runtime/session'
import LocalSubprocessRuntime from '../../processes/src/index.ts'
import { decodeCodexyArtifact, encodeArtifactEvents, encodeArtifactHeader } from '../../runtime/src/persistence-codec.ts'
import { captureResponseMetadata, captureResponseWorkspaces, ResponseWorkspaceEnrichment } from '../src/response-metadata.ts'

const application = { installationId: 'workspace-fixture-installation' }
const policy = { sandboxMode: 'danger-full-access', autoReviewEnabled: false }
const controls = { model: 'fixture-model' }

function opened() {
  const id = SessionId('workspace-metadata-fixture')
  const session = Session.create(id, undefined, { version: 4, id, createdAt: 1, isSeeded: false })
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'task' }] }),
    { surfaceOp: 'append' })
  session.append('turn/start', { turn: 1 })
  return session
}

function commit(session: Session, metadata: CodexClientMetadata) {
  appendProductEvent(session, 'request/header', { reason: 'initial', header: { config: {
    provider: 'fixture', model: controls.model, codexfulResponses: {
      omitDefaultMaxTokens: true, reasoningSummary: 'none', wireProfile: 'codex-0.162.1', clientMetadata: metadata,
    },
  } } })
}

async function fixture(directoryPath?: string) {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  const directory = await realpath(directoryPath ?? await mkdtemp(join(tmpdir(), 'codexy-workspace-metadata-')))
  const git = await ctx.subprocess.resolveExecutable('git')
  const run = async (args: readonly string[]) => {
    const handle = ctx.subprocess.spawn({ argv: [git, '-C', directory, ...args], cwd: directory, graceMs: 200,
      env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' },
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 * 1024 }, stderr: { maxBytes: 4096 } } })
    const result = await handle.done
    expect(result.exitCode, handle.collected.stderr?.readFrom(0).text).toBe(0)
    return (handle.collected.stdout?.readFrom(0).text ?? '').replace(/\n$/, '')
  }
  const commitFiles = () => run(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '--no-gpg-sign', '-m', 'owned fixture'])
  const initialize = async (content = 'initial\n') => {
    await run(['init', '--quiet'])
    await writeFile(join(directory, 'tracked.txt'), content)
    await run(['add', '--', 'tracked.txt'])
    await commitFiles()
    return run(['rev-parse', 'HEAD'])
  }
  return { ctx, directory, run, commitFiles, initialize }
}

function canonical(metadata: CodexClientMetadata | undefined) {
  if (metadata === undefined) throw new Error('missing metadata')
  return JSON.parse(metadata['x-codex-turn-metadata']!) as Record<string, unknown>
}

describe('real execution-world workspace metadata', () => {
  it('does not wait for optional Git, then durably enriches the same turn without recapturing later changes', async () => {
    const git = Promise.withResolvers<string>()
    let hash = 'a'.repeat(40)
    const subprocess = {
      resolveExecutable: vi.fn(() => git.promise),
      spawn: vi.fn((spec: SubprocessSpawnSpec) => {
        const text = spec.argv.includes('--show-toplevel') ? '/work\n' : `# branch.oid ${hash}\n# branch.head main\n`
        return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: {
          stdout: { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) },
        } }
      }),
    } as unknown as SubprocessRuntime
    const enrichment = new ResponseWorkspaceEnrichment(subprocess)
    const session = opened()
    try {
      enrichment.start(session, '/work')
      expect(enrichment.read(session)).toBeUndefined()
      const initial = captureResponseMetadata(session, application, policy, controls, () => 'window')!
      commit(session, initial)
      const originalBytes = encodeArtifactEvents(session.snapshotEvents())
      expect(canonical(initial)).not.toHaveProperty('workspaces')
      git.resolve('/execution-world/git')
      const expected = { '/work': { latest_git_commit_hash: hash, has_changes: false } }
      await vi.waitFor(() => expect(enrichment.read(session)).toEqual(expected))
      const next = captureResponseMetadata(session, application, policy,
        { ...controls, workspaces: enrichment.read(session) })!
      expect(canonical(next).workspaces).toEqual(expected)
      expect(canonical(initial)).not.toHaveProperty('workspaces')
      expect(encodeArtifactEvents(session.snapshotEvents()).startsWith(originalBytes)).toBe(true)
      commit(session, next)
      hash = 'b'.repeat(40)
      enrichment.start(session, '/another-directory')
      expect(subprocess.resolveExecutable).toHaveBeenCalledTimes(1)
      expect(enrichment.read(session)).toEqual(expected)
      const restored = Session.fromRestore(session.id, session.snapshotEvents(), session.header, SessionLogOffset(0), 'detached')
      expect(await captureResponseWorkspaces(restored, subprocess, '/work')).toEqual(expected)
      expect(canonical(captureResponseMetadata(restored, application, policy,
        { ...controls, workspaces: { '/work': { latest_git_commit_hash: hash, has_changes: true } } })).workspaces)
        .toEqual(expected)
    } finally { enrichment.dispose() }
  })

  it('cancels pending enrichment on disposal and prevents late facts from appearing', async () => {
    const git = Promise.withResolvers<string>()
    let signal: AbortSignal | undefined
    const spawn = vi.fn(() => { throw new Error('disposed enrichment must not spawn Git') })
    const subprocess = { resolveExecutable: (_name: string, _env: unknown, incoming: AbortSignal) => {
      signal = incoming
      return git.promise
    }, spawn } as unknown as SubprocessRuntime
    const enrichment = new ResponseWorkspaceEnrichment(subprocess)
    const session = opened()
    enrichment.start(session, '/work')
    expect(signal?.aborted).toBe(false)
    enrichment.dispose()
    expect(signal?.aborted).toBe(true)
    git.resolve('/execution-world/git')
    await Promise.resolve()
    expect(enrichment.read(session)).toBeUndefined()
    enrichment.start(session, '/work')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('cancels a previous turn and does not attach its late result to the new turn', async () => {
    const gates = [Promise.withResolvers<string>(), Promise.withResolvers<string>()]
    const signals: AbortSignal[] = []
    const subprocess = {
      resolveExecutable: (_name: string, _env: unknown, signal: AbortSignal) => {
        const index = signals.length
        signals.push(signal)
        return gates[index]!.promise
      },
      spawn: (spec: SubprocessSpawnSpec) => {
        const text = spec.argv.includes('--show-toplevel') ? `${spec.cwd}\n` : `# branch.oid ${'b'.repeat(40)}\n`
        return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: {
          stdout: { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) },
        } }
      },
    } as unknown as SubprocessRuntime
    const session = opened()
    const enrichment = new ResponseWorkspaceEnrichment(subprocess)
    try {
      enrichment.start(session, '/old')
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      const next = session.append('turn/start', { turn: 2 })
      enrichment.start(session, '/new')
      expect(signals[0]!.aborted).toBe(true)
      expect(enrichment.read(session)).toBeUndefined()
      gates[1]!.resolve('/execution-world/git')
      await vi.waitFor(() => expect(enrichment.read(session))
        .toEqual({ '/new': { latest_git_commit_hash: 'b'.repeat(40), has_changes: false } }))
      gates[0]!.resolve('/execution-world/git')
      await Promise.resolve()
      const ready = snapshotProductEvents(session).filter(event => event.type === 'codexful/workspace-enrichment'
        && event.data.phase === 'ready')
      expect(ready).toHaveLength(1)
      expect(ready[0]!.data).toMatchObject({ turnStartSeq: next.seq, cwd: '/new' })
    } finally { enrichment.dispose() }
  })

  it.each([true, false])('restores unresolved absence without rewriting the original header (pending fact: %s)', async pendingFact => {
    const original = opened()
    const pending = new ResponseWorkspaceEnrichment({ resolveExecutable: () => new Promise(() => {}) } as unknown as SubprocessRuntime)
    if (pendingFact) pending.start(original, '/work/pending')
    const first = captureResponseMetadata(original, application, policy, controls, () => 'window')!
    commit(original, first)
    const originalEvents = encodeArtifactEvents(original.snapshotEvents())
    const bytes = encodeArtifactHeader({ kind: 'codexy-session', version: 1, session: original.header,
      inheritedEventCount: SessionLogOffset(0) }) + originalEvents
    pending.dispose()
    const decoded = decodeCodexyArtifact(Buffer.from(bytes))
    const restored = Session.fromRestore(original.id, decoded.events, decoded.metadata.session, SessionLogOffset(0), 'detached')
    const probes: SubprocessSpawnSpec[] = []
    const subprocess = {
      resolveExecutable: async () => '/execution-world/git',
      spawn: (spec: SubprocessSpawnSpec) => {
        probes.push(spec)
        const text = spec.argv.includes('--show-toplevel') ? `${spec.cwd}\n` : `# branch.oid ${'c'.repeat(40)}\n`
        return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: {
          stdout: { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) },
        } }
      },
    } as unknown as SubprocessRuntime
    const enrichment = new ResponseWorkspaceEnrichment(subprocess)
    const directory = pendingFact ? '/work/pending' : '/work/recovered'
    try {
      enrichment.start(restored, '/work/recovered')
      expect(enrichment.read(restored)).toBeUndefined()
      const expected = { [directory]: { latest_git_commit_hash: 'c'.repeat(40), has_changes: false } }
      await vi.waitFor(() => expect(enrichment.read(restored)).toEqual(expected))
      expect(probes.every(probe => probe.cwd === directory)).toBe(true)
      expect(canonical(first)).not.toHaveProperty('workspaces')
      expect(encodeArtifactEvents(restored.snapshotEvents()).startsWith(originalEvents)).toBe(true)
      const next = captureResponseMetadata(restored, application, policy, { ...controls, workspaces: enrichment.read(restored) })!
      expect(canonical(next).workspaces).toEqual(expected)
      commit(restored, next)
      expect(() => decodeCodexyArtifact(Buffer.from(encodeArtifactHeader(decoded.metadata)
        + encodeArtifactEvents(restored.snapshotEvents())))).not.toThrow()
    } finally { enrichment.dispose() }
  })

  it('restores a completed absence without running Git again after the directory changes', async () => {
    const session = opened()
    const unavailable = { resolveExecutable: async () => { throw new Error('Git unavailable') } } as unknown as SubprocessRuntime
    const enrichment = new ResponseWorkspaceEnrichment(unavailable)
    enrichment.start(session, '/work')
    await vi.waitFor(() => expect(snapshotProductEvents(session).findLast(event => event.type === 'codexful/workspace-enrichment')?.data)
      .toMatchObject({ phase: 'ready' }))
    commit(session, captureResponseMetadata(session, application, policy, controls, () => 'window')!)
    const bytes = encodeArtifactHeader({ kind: 'codexy-session', version: 1, session: session.header,
      inheritedEventCount: SessionLogOffset(0) }) + encodeArtifactEvents(session.snapshotEvents())
    enrichment.dispose()
    const decoded = decodeCodexyArtifact(Buffer.from(bytes))
    const restored = Session.fromRestore(session.id, decoded.events, decoded.metadata.session, SessionLogOffset(0), 'detached')
    const restoredBefore = encodeArtifactEvents(restored.snapshotEvents())
    const probe = vi.fn(async () => { throw new Error('terminal absence must not be recaptured') })
    const restarted = new ResponseWorkspaceEnrichment({ resolveExecutable: probe } as unknown as SubprocessRuntime)
    try {
      restarted.start(restored, '/changed')
      expect(restarted.read(restored)).toBeUndefined()
      expect(probe).not.toHaveBeenCalled()
      expect(encodeArtifactEvents(restored.snapshotEvents())).toBe(restoredBefore)
      expect(encodeArtifactHeader(decoded.metadata) + encodeArtifactEvents(decoded.events)).toBe(bytes)
    } finally { restarted.dispose() }
  })

  it.each(['pending-with-facts', 'ready-without-pending', 'wrong-turn-reference', 'changed-cwd', 'duplicate-pending'] as const)
    ('rejects an invalid durable workspace transition: %s', scenario => {
      const session = opened()
      const start = snapshotProductEvents(session).findLast(event => event.type === 'turn/start')!
      if (scenario === 'changed-cwd' || scenario === 'duplicate-pending') {
        appendProductEvent(session, 'codexful/workspace-enrichment', { turnStartSeq: start.seq, cwd: '/work', phase: 'pending' })
      }
      appendProductEvent(session, 'codexful/workspace-enrichment', {
        turnStartSeq: scenario === 'wrong-turn-reference' ? session.snapshotEvents()[0]!.seq : start.seq,
        cwd: scenario === 'changed-cwd' ? '/changed' : '/work',
        phase: scenario === 'ready-without-pending' || scenario === 'changed-cwd' ? 'ready' : 'pending',
        ...scenario === 'pending-with-facts' ? {
          workspaces: { '/work': { latest_git_commit_hash: 'a'.repeat(40), has_changes: false } },
        } : {},
      })
      expect(() => decodeCodexyArtifact(Buffer.from(encodeArtifactHeader({ kind: 'codexy-session', version: 1,
        session: session.header, inheritedEventCount: SessionLogOffset(0) }) + encodeArtifactEvents(session.snapshotEvents()))))
        .toThrow(/workspace enrichment/)
    })

  it.each([' ', '\t'])('preserves a repository name ending with %j beside a different unpadded repository', async suffix => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), 'codexy-workspace-path-')))
    const plainDirectory = join(parent, 'repository')
    const exactDirectory = `${plainDirectory}${suffix}`
    await mkdir(plainDirectory)
    await mkdir(exactDirectory)
    const plain = await fixture(plainDirectory)
    const exact = await fixture(exactDirectory)
    try {
      const plainHash = await plain.initialize('plain repository\n')
      const exactHash = await exact.initialize('repository with trailing whitespace\n')
      expect(exactHash).not.toBe(plainHash)
      expect(await captureResponseWorkspaces(opened(), exact.ctx.subprocess, exactDirectory))
        .toEqual({ [exactDirectory]: { latest_git_commit_hash: exactHash, has_changes: false } })
      expect(await captureResponseWorkspaces(opened(), plain.ctx.subprocess, plainDirectory))
        .toEqual({ [plainDirectory]: { latest_git_commit_hash: plainHash, has_changes: false } })
    } finally { await exact.ctx.fiber.dispose(); await plain.ctx.fiber.dispose() }
  })

  it('does not advertise workspaces for a non-Git directory or an unborn repository', async () => {
    const { ctx, directory, run } = await fixture()
    try {
      const session = opened()
      for (const initialized of [false, true]) {
        if (initialized) await run(['init', '--quiet'])
        const workspaces = await captureResponseWorkspaces(session, ctx.subprocess, directory)
        expect(workspaces).toBeUndefined()
        expect(canonical(captureResponseMetadata(session, application, policy, { ...controls, workspaces })))
          .not.toHaveProperty('workspaces')
      }
    } finally { await ctx.fiber.dispose() }
  })

  it('captures a clean commit at the root of a nested cwd', async () => {
    const { ctx, directory, initialize } = await fixture()
    try {
      const hash = await initialize()
      const nested = join(directory, 'nested', 'child')
      await mkdir(nested, { recursive: true })
      const indexBefore = await readFile(join(directory, '.git', 'index'))
      const workspaces = await captureResponseWorkspaces(opened(), ctx.subprocess, nested)
      expect(workspaces).toEqual({ [directory]: { latest_git_commit_hash: hash, has_changes: false } })
      expect(Object.isFrozen(workspaces)).toBe(true)
      expect(Object.isFrozen(workspaces?.[directory])).toBe(true)
      expect(await readFile(join(directory, '.git', 'index'))).toEqual(indexBefore)
    } finally { await ctx.fiber.dispose() }
  })

  it.each(['tracked', 'untracked', 'staged'] as const)('captures actual %s changes as dirty', async change => {
    const { ctx, directory, initialize, run } = await fixture()
    try {
      const hash = await initialize()
      await writeFile(join(directory, change === 'untracked' ? 'new.txt' : 'tracked.txt'), 'changed\n')
      if (change === 'staged') await run(['add', '--', 'tracked.txt'])
      expect(await captureResponseWorkspaces(opened(), ctx.subprocess, directory))
        .toEqual({ [directory]: { latest_git_commit_hash: hash, has_changes: true } })
    } finally { await ctx.fiber.dispose() }
  })

  it('keeps same-turn facts through retry, artifact restore and compaction; captures changes next turn', async () => {
    const { ctx, directory, initialize, run, commitFiles } = await fixture()
    try {
      const hash = await initialize()
      const session = opened()
      const workspaces = await captureResponseWorkspaces(session, ctx.subprocess, directory)
      const first = captureResponseMetadata(session, application, policy, { ...controls, workspaces }, () => 'window')!
      commit(session, first)
      const bytes = encodeArtifactHeader({ kind: 'codexy-session', version: 1, session: session.header,
        inheritedEventCount: SessionLogOffset(0) }) + encodeArtifactEvents(session.snapshotEvents())
      await writeFile(join(directory, 'tracked.txt'), 'later change\n')
      await run(['add', '--', 'tracked.txt'])
      await commitFiles()
      const laterHash = await run(['rev-parse', 'HEAD'])
      expect(laterHash).not.toBe(hash)
      await writeFile(join(directory, 'new.txt'), 'later untracked change\n')
      const probe = vi.spyOn(ctx.subprocess, 'resolveExecutable')
      const retained = { [directory]: { latest_git_commit_hash: hash, has_changes: false } }
      expect(await captureResponseWorkspaces(session, ctx.subprocess, directory)).toEqual(retained)
      expect(probe).not.toHaveBeenCalled()
      expect(captureResponseMetadata(session, application, policy,
        { ...controls, workspaces: { [directory]: { latest_git_commit_hash: laterHash, has_changes: true } } })).toEqual(first)
      const decoded = decodeCodexyArtifact(Buffer.from(bytes))
      const restored = Session.fromRestore(session.id, decoded.events, decoded.metadata.session,
        decoded.metadata.inheritedEventCount, 'detached')
      const restoredBefore = encodeArtifactEvents(restored.snapshotEvents())
      expect(await captureResponseWorkspaces(restored, ctx.subprocess, directory)).toEqual(retained)
      expect(probe).not.toHaveBeenCalled()
      const compact = compactionClientMetadata(first, { trigger: 'auto', reason: 'context_limit',
        implementation: 'responses', phase: 'mid_turn', strategy: 'memento' })!
      expect(canonical(compact).workspaces).toEqual(retained)
      expect(canonical(compact).request_kind).toBe('compaction')
      expect(encodeArtifactEvents(restored.snapshotEvents())).toBe(restoredBefore)
      expect(encodeArtifactHeader(decoded.metadata) + encodeArtifactEvents(decoded.events)).toBe(bytes)
      restored.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      restored.append('turn/start', { turn: 2 })
      const nextWorkspaces = await captureResponseWorkspaces(restored, ctx.subprocess, directory)
      expect(nextWorkspaces).toEqual({ [directory]: { latest_git_commit_hash: laterHash, has_changes: true } })
      expect(probe).toHaveBeenCalledTimes(1)
      expect(canonical(captureResponseMetadata(restored, application, policy, { ...controls, workspaces: nextWorkspaces })).workspaces)
        .toEqual(nextWorkspaces)
    } finally { await ctx.fiber.dispose() }
  })

  it('retains a non-Git absence even if the directory becomes a repository later in the same turn', async () => {
    const { ctx, directory, initialize } = await fixture()
    try {
      const session = opened()
      commit(session, captureResponseMetadata(session, application, policy, controls, () => 'window')!)
      await initialize()
      const probe = vi.spyOn(ctx.subprocess, 'resolveExecutable')
      expect(await captureResponseWorkspaces(session, ctx.subprocess, directory)).toBeUndefined()
      expect(probe).not.toHaveBeenCalled()
    } finally { await ctx.fiber.dispose() }
  })

  it('leaves failed probes absent instead of inventing a hash and honors cancellation', async () => {
    const unavailable = { resolveExecutable: vi.fn(async () => { throw new Error('Git unavailable') }) } as unknown as SubprocessRuntime
    expect(await captureResponseWorkspaces(opened(), unavailable, '/work')).toBeUndefined()
    const reason = new Error('cancelled workspace preparation')
    await expect(captureResponseWorkspaces(opened(), unavailable, '/work', AbortSignal.abort(reason))).rejects.toBe(reason)
  })

  it.each([0, 1])('honors cancellation during Git probe %s even when done resolves with a null exit code', async probe => {
    const controller = new AbortController()
    const entered = Promise.withResolvers<void>()
    const outcome = Promise.withResolvers<{ exitCode: number | null; signal: NodeJS.Signals | null }>()
    const calls: SubprocessSpawnSpec[] = []
    const subprocess = {
      resolveExecutable: async () => '/execution-world/git',
      spawn: (spec: SubprocessSpawnSpec) => {
        calls.push(spec)
        if (calls.length - 1 === probe) {
          entered.resolve()
          return { done: outcome.promise, collected: {} }
        }
        return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: {
          stdout: { readFrom: () => ({ text: '/work\n', nextOffset: 6, lossy: false }) },
        } }
      },
    } as unknown as SubprocessRuntime
    const pending = captureResponseWorkspaces(opened(), subprocess, '/work', controller.signal)
    await entered.promise
    const reason = new Error('cancelled during workspace Git probe')
    controller.abort(reason)
    outcome.resolve({ exitCode: null, signal: 'SIGTERM' })
    await expect(pending).rejects.toBe(reason)
    expect(calls).toHaveLength(probe + 1)
    expect(calls.every(spec => spec.signal === controller.signal)).toBe(true)
  })
})
