import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import CodexySandbox from '@codexydsh/sandbox'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function execute(argv: readonly string[]): Promise<{ code: number | null, stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => { resolve({ code, stderr }) })
  })
}

describe('macOS workspace metadata protection', () => {
  it.skipIf(process.platform !== 'darwin')('allows workspace writes while denying metadata writes, renames, and first-time creation', async ({ skip }) => {
    const root = await mkdtemp(join(tmpdir(), 'codexy-seatbelt-'))
    roots.push(root)
    await mkdir(join(root, '.git'))
    const canonicalRoot = await realpath(root)
    const context = new Context()
    contexts.push(context)
    await context.plugin(CodexySandbox)

    const wrapped = await context.sandbox.confine([
      'sh', '-c', [
        'printf permitted > "$1/allowed.txt"',
        'printf blocked > "$1/.git/blocked.txt"',
        'mv "$1/.git" "$1/renamed-git"',
        'mkdir "$1/.codex"',
      ].join('; '), '--', canonicalRoot,
    ], { mode: 'workspace-write', workspaceRoot: canonicalRoot })
    const result = await execute(wrapped.argv)

    if (result.stderr.includes('sandbox-exec: sandbox_apply: Operation not permitted')) {
      skip('the outer test sandbox forbids nested Seatbelt; run this integration test outside it')
    }
    expect(result.code).not.toBe(0)
    expect(result.stderr).toMatch(/operation not permitted|permission denied/iu)
    await expect(readFile(join(root, 'allowed.txt'), 'utf8')).resolves.toBe('permitted')
    await expect(access(join(root, '.git', 'blocked.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(join(root, 'renamed-git'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(join(root, '.git'))).resolves.toBeUndefined()
    await expect(access(join(root, '.codex'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.skipIf(process.platform !== 'darwin')('also denies replacing a worktree Git pointer file', async ({ skip }) => {
    const root = await mkdtemp(join(tmpdir(), 'codexy-seatbelt-'))
    roots.push(root)
    await writeFile(join(root, '.git'), 'not a gitdir pointer\n')
    const canonicalRoot = await realpath(root)
    const context = new Context()
    contexts.push(context)
    await context.plugin(CodexySandbox)

    const wrapped = await context.sandbox.confine([
      'sh', '-c', 'printf altered > "$1/.git"', '--', canonicalRoot,
    ], { mode: 'workspace-write', workspaceRoot: canonicalRoot })
    const result = await execute(wrapped.argv)

    if (result.stderr.includes('sandbox-exec: sandbox_apply: Operation not permitted')) {
      skip('the outer test sandbox forbids nested Seatbelt; run this integration test outside it')
    }
    expect(result.code).not.toBe(0)
    expect(result.stderr).toMatch(/operation not permitted|permission denied/iu)
    await expect(readFile(join(root, '.git'), 'utf8')).resolves.toBe('not a gitdir pointer\n')
  })
})
