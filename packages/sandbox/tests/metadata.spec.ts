import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import CodexySandbox from '@codexydsh/sandbox'
import { existingMetadataReadOnlyPaths } from '../src/metadata.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'codexy-metadata-'))
  roots.push(root)
  // metadata.ts accepts the canonical root that confine() obtains from the
  // public sandbox API. macOS tmpdir() can instead name the /var symlink.
  return realpath(root)
}
async function sandbox(protectExistingWorkspaceMetadata = true) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(CodexySandbox, { runnerCommand: ['bwrap-fixture'],
    runnerFailureSignatures: ['fixture rejected profile'], protectExistingWorkspaceMetadata })
  return ctx.sandbox as CodexySandbox
}

describe('owned workspace metadata protection over released local confinement', () => {
  it('keeps missing metadata absent and retains the released runner profile', async () => {
    const root = await workspace()
    const protectedSandbox = await sandbox()
    const base = await sandbox(false)
    const policy = { mode: 'workspace-write' as const, workspaceRoot: root }
    expect(await protectedSandbox.confine(['true'], policy)).toEqual(await base.confine(['true'], policy))
    for (const name of ['.git', '.agents', '.codex', '.aws']) expect(existsSync(join(root, name))).toBe(false)
  })

  it('mounts every existing metadata directory read-only after the writable root', async () => {
    const root = await workspace()
    const names = ['.git', '.agents', '.codex', '.aws']
    for (const name of names) await mkdir(join(root, name))
    const provider = await sandbox()
    const base = await sandbox(false)
    const policy = { mode: 'workspace-write' as const, workspaceRoot: root }
    const original = await base.confine(['true'], policy)
    const protectedResult = await provider.confine(['true'], policy)
    const separator = original.argv.length - 2
    expect(protectedResult).toEqual({ ...original, argv: [
      ...original.argv.slice(0, separator),
      ...names.flatMap(name => ['--ro-bind', join(root, name), join(root, name)]), '--', 'true',
    ] })
    expect(await provider.confine(['true'], { ...policy, mode: 'read-only' }))
      .toEqual(await base.confine(['true'], { ...policy, mode: 'read-only' }))
  })

  it('protects a worktree pointer and its existing git directory inside the workspace', async () => {
    const root = await workspace()
    await mkdir(join(root, 'gitdir'))
    await writeFile(join(root, '.git'), 'gitdir: gitdir\n')
    expect(existingMetadataReadOnlyPaths(root)).toEqual([join(root, '.git'), join(root, 'gitdir')])
  })

  it('keeps an external worktree git directory outside the writable-root mounts', async () => {
    const outer = await workspace()
    const root = join(outer, 'workspace')
    await mkdir(root)
    await mkdir(join(outer, 'gitdir'))
    await writeFile(join(root, '.git'), 'gitdir: ../gitdir\n')
    expect(existingMetadataReadOnlyPaths(root)).toEqual([join(root, '.git')])
  })

  it.skipIf(process.platform === 'win32')('canonicalizes a workspace alias without accepting a writable gitdir symlink', async () => {
    const outer = await workspace()
    const root = join(outer, 'workspace')
    const alias = join(outer, 'workspace-alias')
    await mkdir(root)
    await symlink('workspace', alias)
    await mkdir(join(root, 'gitdir'))
    await writeFile(join(root, '.git'), 'gitdir: gitdir\n')
    const provider = await sandbox()
    const policy = { mode: 'workspace-write' as const, workspaceRoot: alias }
    const result = await provider.confine(['true'], policy)
    expect(result.argv.slice(-8)).toEqual([
      '--ro-bind', join(root, '.git'), join(root, '.git'),
      '--ro-bind', join(root, 'gitdir'), join(root, 'gitdir'), '--', 'true',
    ])
    expect(result.argv).not.toContain(alias)

    await symlink('gitdir', join(root, 'gitdir-alias'))
    await writeFile(join(root, '.git'), 'gitdir: gitdir-alias\n')
    await expect(provider.confine(['true'], policy)).rejects.toThrow('crosses a symbolic link')
  })

  it.skipIf(process.platform === 'win32')('rejects a replaceable metadata symlink', async () => {
    const root = await workspace()
    await mkdir(join(root, 'target'))
    await symlink('target', join(root, '.codex'))
    await expect((await sandbox()).confine(['true'], { mode: 'workspace-write', workspaceRoot: root }))
      .rejects.toThrow(SandboxUnavailableError)
  })

  it.skipIf(process.platform === 'win32')('rejects a git directory reached through a writable symlink', async () => {
    const root = await workspace()
    await mkdir(join(root, 'gitdir'))
    await symlink('gitdir', join(root, 'alias'))
    await writeFile(join(root, '.git'), 'gitdir: alias\n')
    expect(() => existingMetadataReadOnlyPaths(root)).toThrow('crosses a symbolic link')
    await expect((await sandbox()).confine(['true'], { mode: 'workspace-write', workspaceRoot: root }))
      .rejects.toThrow('crosses a symbolic link')
  })

  it('refuses oversized git pointers and missing pointed directories', async () => {
    const root = await workspace()
    await writeFile(join(root, '.git'), 'x'.repeat(4097))
    expect(() => existingMetadataReadOnlyPaths(root)).toThrow('larger than 4096 bytes')
    await writeFile(join(root, '.git'), 'gitdir: missing\n')
    expect(() => existingMetadataReadOnlyPaths(root)).toThrow('Cannot resolve worktree gitdir')
  })

  it('refuses a selected runner that cannot protect existing metadata', async () => {
    const root = await workspace()
    await mkdir(join(root, '.git'))
    vi.spyOn(LocalSandbox.prototype, 'confine').mockResolvedValue({
      argv: ['landlock-fixture', '--', 'true'], enforcement: 'full',
      denialSignatures: [], runnerFailureRules: [],
    })
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(CodexySandbox)
    await expect(ctx.sandbox.confine(['true'], { mode: 'workspace-write', workspaceRoot: root }))
      .rejects.toThrow('cannot protect existing workspace metadata')
  })
})
