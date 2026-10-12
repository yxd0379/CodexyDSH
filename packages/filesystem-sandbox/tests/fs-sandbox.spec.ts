/**
 * Tests for the sandbox-enforcing filesystem backend: the per-call policy fence
 * on write/edit (read-only denies, workspace-write contains, danger-full-access
 * passes through), reads always passing through, the capability fact, and the
 * containment matrix — `..` traversal, absolute paths outside, and symlink
 * escapes (a symlinked directory inside the workspace pointing out, and a new
 * file created under one). The fence is exercised on a real filesystem: a
 * denied write leaves no file on disk.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { FsError, FsTargetKey } from '@codexydsh/filesystem'
import type { FsTarget } from '@codexydsh/filesystem'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { SandboxedFileSystem } from '@codexydsh/filesystem-sandbox'
import { assertWorkspaceOutsideTemp, outsideTempWorkspaceParent } from '@codexydsh/test-support/workspace'

let base: string
let workspace: string
let outside: string
let ctx: Context
let fs: SandboxedFileSystem
let fiber: Awaited<ReturnType<Context['plugin']>>

async function boot(mode: SandboxMode, protectWorkspaceMetadata = false): Promise<void> {
  ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: workspace })
  fiber = await ctx.plugin(SandboxedFileSystem, { cwd: workspace, protectWorkspaceMetadata })
  fs = ctx.codexyFs as SandboxedFileSystem
}

beforeEach(async ({ onTestFinished }) => {
  // Both siblings must be outside automatic temp grants for containment denials to be meaningful.
  const directory = await mkdtemp(join(outsideTempWorkspaceParent(), '.dsh-fssbx-'))
  onTestFinished(async () => { await rm(directory, { recursive: true, force: true }) })
  base = directory
  assertWorkspaceOutsideTemp(base)
  workspace = join(base, 'ws')
  outside = join(base, 'out')
  await mkdir(workspace)
  await mkdir(outside)
})
afterEach(async () => {
  await fiber?.dispose()
})

/** Resolve a path through the backend and return its target. */
function target(path: string): Promise<FsTarget> {
  return fs.resolve(path)
}

describe('the capability fact', () => {
  it('reports the deployment default mode (what the tool layer advertises against)', async () => {
    await boot('workspace-write')
    expect(fs.sandboxMode).toBe('workspace-write')
  })
})

describe('read-only', () => {
  beforeEach(() => boot('read-only'))

  it('denies write, leaving no file on disk', async () => {
    const path = join(workspace, 'denied.txt')
    await expect(fs.writeText(await target(path), 'x')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(path)).toBe(false)
  })

  it('denies edit of an existing file (the content is unchanged)', async () => {
    const path = join(workspace, 'file.txt')
    await writeFile(path, 'original')
    await expect(fs.editText(await target(path), { oldString: 'original', newString: 'changed', replaceAll: false }))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await readFile(path, 'utf8')).toBe('original')
  })

  it('denies deleting an existing file', async () => {
    const path = join(workspace, 'keep.txt')
    await writeFile(path, 'keep')
    await expect(fs.deleteFile(await target(path))).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await readFile(path, 'utf8')).toBe('keep')
  })

  it('allows reads (every mode permits reading)', async () => {
    const path = join(workspace, 'readable.txt')
    await writeFile(path, 'hello')
    expect(await fs.readText(await target(path))).toBe('hello')
  })
})

describe('workspace-write containment', () => {
  beforeEach(() => boot('workspace-write'))

  it('a write under the workspace lands', async () => {
    const path = join(workspace, 'nested', 'ok.txt')
    const outcome = await fs.writeText(await target(path), 'inside')
    expect(outcome.operation).toBe('create')
    expect(await readFile(path, 'utf8')).toBe('inside')
  })

  it('a write to the platform temp area lands (parity with the bash runner grant)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-fssbx-tmp-'))
    try {
      const path = join(dir, 'temp.txt')
      await fs.writeText(await target(path), 'temp')
      expect(await readFile(path, 'utf8')).toBe('temp')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('an absolute path outside the workspace is denied, no file created', async () => {
    const path = join(outside, 'escape.txt')
    await expect(fs.writeText(await target(path), 'x')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(path)).toBe(false)
  })

  it('a `..` traversal out of the workspace is denied', async () => {
    const path = join(workspace, '..', 'sibling-escape.txt')
    await expect(fs.writeText(await target(path), 'x')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(join(workspace, '..', 'sibling-escape.txt'))).toBe(false)
  })

  it('a symlinked directory inside the workspace pointing OUT is denied (canonicalized before containment)', async () => {
    // workspace/link -> outside ; writing workspace/link/f.txt would land in outside/f.txt.
    await symlink(outside, join(workspace, 'link'))
    const path = join(workspace, 'link', 'f.txt')
    await expect(fs.writeText(await target(path), 'x')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(join(outside, 'f.txt'))).toBe(false)
  })

  it('a NEW file created under a symlinked-out directory is denied (deepest-ancestor realpath)', async () => {
    await symlink(outside, join(workspace, 'link'))
    const path = join(workspace, 'link', 'newdir', 'deep.txt')
    await expect(fs.writeText(await target(path), 'x')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(join(outside, 'newdir'))).toBe(false)
  })

  it('an edit outside the workspace is denied; the original is untouched', async () => {
    const path = join(outside, 'file.txt')
    await writeFile(path, 'original')
    await expect(fs.editText(await target(path), { oldString: 'original', newString: 'x', replaceAll: false }))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await readFile(path, 'utf8')).toBe('original')
  })

  it('an edit inside the workspace lands', async () => {
    const path = join(workspace, 'edit.txt')
    await writeFile(path, 'original')
    const outcome = await fs.editText(await target(path), { oldString: 'original', newString: 'changed', replaceAll: false })
    expect(outcome.after).toBe('changed')
    expect(await readFile(path, 'utf8')).toBe('changed')
  })

  it('allows deletion inside the workspace and denies deletion outside it', async () => {
    const inside = join(workspace, 'remove.txt')
    const escaped = join(outside, 'keep.txt')
    await writeFile(inside, 'remove')
    await writeFile(escaped, 'keep')
    await fs.deleteFile(await target(inside))
    expect(existsSync(inside)).toBe(false)
    await expect(fs.deleteFile(await target(escaped))).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await readFile(escaped, 'utf8')).toBe('keep')
  })

  it('mutates the freshly checked identity, not a stale outside targetKey (TOCTOU direction)', async () => {
    // A target whose displayPath is inside the workspace but whose targetKey is
    // a STALE outside path — as if an ancestor symlink pointed out at the tool's
    // resolve() and was swapped in before the write. The fence re-resolves
    // displayPath (now inside) AND delegates with that fresh target, so the byte
    // lands inside and the stale outside path is never written.
    const insidePath = join(workspace, 'landed.txt')
    const staleTarget: FsTarget = { displayPath: insidePath, targetKey: FsTargetKey(join(outside, 'escaped.txt')) }
    await fs.writeText(staleTarget, 'inside')
    expect(await readFile(insidePath, 'utf8')).toBe('inside')
    expect(existsSync(join(outside, 'escaped.txt'))).toBe(false)
  })

  it('the workspace root itself passes the fence (path equal to a writable root), failing only on file type', async () => {
    // isUnder's path-equals-root branch: the fence allows the root, and the
    // write then fails because the root is a directory, not a regular file.
    await expect(fs.writeText(await target(workspace), 'x')).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
  })
})

describe('opt-in workspace metadata protection', () => {
  it('rejects a non-boolean protection setting at plugin load', async () => {
    const invalid = new Context()
    await invalid.plugin(SessionProjectionRegistry)
    await invalid.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workspace })
    await expect(invalid.plugin(SandboxedFileSystem, { cwd: workspace, protectWorkspaceMetadata: 'yes' as never }))
      .rejects.toThrow()
    await invalid.fiber.dispose()
  })

  it('denies writes, edits, and deletion under protected names while allowing ordinary files', async () => {
    await mkdir(join(workspace, '.git'))
    await writeFile(join(workspace, '.git', 'config'), 'original')
    await boot('workspace-write', true)

    const gitConfig = await target(join(workspace, '.git', 'config'))
    await expect(fs.writeText(gitConfig, 'changed')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await expect(fs.editText(gitConfig, { oldString: 'original', newString: 'changed', replaceAll: false }))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await expect(fs.deleteFile(gitConfig)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await readFile(join(workspace, '.git', 'config'), 'utf8')).toBe('original')

    for (const name of ['.agents', '.codex', '.aws']) {
      const path = join(workspace, name, 'new.txt')
      await expect(fs.writeText(await target(path), 'new')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      expect(existsSync(path)).toBe(false)
    }

    const ordinary = join(workspace, 'src', 'file.txt')
    await fs.writeText(await target(ordinary), 'ok')
    expect(await readFile(ordinary, 'utf8')).toBe('ok')
  })

  it.skipIf(process.platform === 'win32')('protects an alias target reached through another workspace path', async () => {
    const data = join(workspace, 'data')
    await mkdir(data)
    await writeFile(join(data, 'config'), 'original')
    await symlink(data, join(workspace, '.agents'), 'dir')
    await boot('workspace-write', true)

    await expect(fs.writeText(await target(join(data, 'config')), 'changed'))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await readFile(join(data, 'config'), 'utf8')).toBe('original')
  })

  it.each(['relative', 'absolute'] as const)('protects a worktree gitdir reached outside `.git` (%s pointer)', async (pointerKind) => {
    const gitdir = join(workspace, 'metadata', 'worktrees', 'current')
    await mkdir(gitdir, { recursive: true })
    const config = join(gitdir, 'config')
    await writeFile(config, 'original')
    await writeFile(join(workspace, '.git'), `gitdir: ${pointerKind === 'relative' ? 'metadata/worktrees/current' : gitdir}\n`)
    await boot('workspace-write', true)

    await expect(fs.writeText(await target(config), 'changed'))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await expect(fs.deleteFile(await target(config)))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await readFile(config, 'utf8')).toBe('original')
    const ordinary = join(workspace, 'metadata', 'ordinary.txt')
    await fs.writeText(await target(ordinary), 'ok')
    expect(await readFile(ordinary, 'utf8')).toBe('ok')
  })

  it('leaves the existing DSH policy unchanged when the option is disabled', async () => {
    await boot('workspace-write')
    const path = join(workspace, '.git', 'config')
    await fs.writeText(await target(path), 'allowed')
    expect(await readFile(path, 'utf8')).toBe('allowed')
  })
})

describe('workspace-write with the filesystem root as the workspace (a root ending in the path separator)', () => {
  it('grants writes anywhere on that volume', async () => {
    // A degenerate but valid config: the filesystem root containing the target.
    // It exercises the separator-suffixed-root branch on POSIX and Windows.
    const rootCtx = new Context()
    await rootCtx.plugin(SessionProjectionRegistry)
    await rootCtx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: parse(base).root })
    const rootFiber = await rootCtx.plugin(SandboxedFileSystem, { cwd: workspace })
    const rootFs = rootCtx.codexyFs as SandboxedFileSystem
    try {
      const path = join(base, 'anywhere.txt') // outside temp — allowed only via the filesystem root
      await rootFs.writeText(await rootFs.resolve(path), 'anywhere')
      expect(await readFile(path, 'utf8')).toBe('anywhere')
    } finally {
      await rootFiber.dispose()
    }
  })
})

describe('danger-full-access', () => {
  beforeEach(() => boot('danger-full-access'))

  it('writes anywhere, unfenced', async () => {
    const path = join(outside, 'free.txt')
    await fs.writeText(await target(path), 'free')
    expect(await readFile(path, 'utf8')).toBe('free')
  })
})

describe('the per-call policy override (escalation)', () => {
  it('a workspace-write stamp on a read-only default lets a contained write land for that call only', async () => {
    await boot('read-only')
    const path = join(workspace, 'escalated.txt')
    // Default read-only would deny; the per-call workspace-write policy allows it (contained).
    await fs.writeText(await target(path), 'granted', undefined, undefined, { mode: 'workspace-write', workspaceRoot: workspace })
    expect(await readFile(path, 'utf8')).toBe('granted')
    // A neighboring plain call still runs under the read-only default.
    await expect(fs.writeText(await target(join(workspace, 'plain.txt')), 'x'))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('a danger-full-access stamp bypasses the fence for that call', async () => {
    await boot('read-only')
    const path = join(outside, 'granted-full.txt')
    await fs.writeText(await target(path), 'full', undefined, undefined, { mode: 'danger-full-access', workspaceRoot: workspace })
    expect(await readFile(path, 'utf8')).toBe('full')
  })
})

describe('registration and HMR safety', () => {
  it('registers as ctx.codexyFs and unregisters cleanly from a child fiber', async () => {
    await boot('workspace-write')
    expect(ctx.codexyFs).toBeInstanceOf(SandboxedFileSystem)
    await fiber.dispose()
    expect(ctx.get('fs')).toBeUndefined()
    // Re-mount below the disposed one to prove no lingering registration.
    fiber = await ctx.plugin(SandboxedFileSystem, { cwd: workspace })
    expect(ctx.codexyFs).toBeInstanceOf(SandboxedFileSystem)
  })
})

describe('FsError identity', () => {
  it('the denial is a structured FsError distinct from a host permission error', async () => {
    await boot('read-only')
    const error = await fs.writeText(await target(join(workspace, 'x.txt')), 'x').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(FsError)
    expect((error as FsError).code).toBe('FS_SANDBOX_DENIED')
  })
})
