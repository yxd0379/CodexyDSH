/** Real Git repositories in new retained temporary directories; no old files are touched. */
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { compactionClientMetadata, createUserMessage } from '@codexydsh/runtime/llm'
import type { CodexClientMetadata } from '@codexydsh/runtime/llm'
import { Session, SessionId, SessionLogOffset, appendProductEvent } from '@codexydsh/runtime/session'
import LocalSubprocessRuntime from '../../processes/src/index.ts'
import { decodeCodexyArtifact, encodeArtifactEvents, encodeArtifactHeader } from '../../runtime/src/persistence-codec.ts'
import { captureResponseMetadata, captureResponseWorkspaces } from '../src/response-metadata.ts'

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
