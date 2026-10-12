/** Every fixture is new and deliberately retained. Never run a successful pack here. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const execute = promisify(execFile)
const pack = fileURLToPath(new URL('../scripts/pack.ts', import.meta.url))

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'codexy-pack-safety-'))
  const existing = join(root, 'existing-output')
  await mkdir(existing)
  await writeFile(join(existing, 'sentinel.txt'), 'owned fixture: must remain byte-identical\n', { flag: 'wx' })
  return { root, existing }
}

async function rejected(root: string, args: string[]) {
  try {
    await execute(process.execPath, [pack, ...args], { cwd: root, timeout: 10_000, maxBuffer: 128 * 1024 })
    throw new Error('pack unexpectedly accepted a forbidden destination')
  } catch (error) {
    expect(error).toMatchObject({ code: 1 })
    return error as Error & { stdout: string; stderr: string }
  }
}

it.each([{ flags: [] }, { flags: ['--keep-work'] }])('rejects an existing custom output without replacing any entry (%j)', async ({ flags }) => {
  const { root, existing } = await fixture()
  const result = await rejected(root, ['--output', existing, ...flags])
  expect(result.stderr).toMatch(/EEXIST|already exists/iu)
  expect(result.stdout).not.toContain('Packed')
  expect(await readdir(existing)).toEqual(['sentinel.txt'])
  expect(await readFile(join(existing, 'sentinel.txt'), 'utf8')).toBe('owned fixture: must remain byte-identical\n')
})

it('rejects an existing regular file as output and leaves its bytes unchanged', async () => {
  const { root } = await fixture(), output = join(root, 'file-output')
  await writeFile(output, 'not a release directory\n', { flag: 'wx' })
  const result = await rejected(root, ['--output', output])
  expect(result.stderr).toMatch(/EEXIST|already exists/iu)
  expect(await readFile(output, 'utf8')).toBe('not a release directory\n')
})

it('rejects an output symlink without following it or changing its target', async () => {
  const { root, existing } = await fixture(), output = join(root, 'linked-output')
  await symlink(existing, output, 'dir')
  const result = await rejected(root, ['--output', output, '--keep-work'])
  expect(result.stderr).toMatch(/EEXIST|already exists/iu)
  expect((await lstat(output)).isSymbolicLink()).toBe(true)
  expect(await readdir(existing)).toEqual(['sentinel.txt'])
  expect(await readFile(join(existing, 'sentinel.txt'), 'utf8')).toBe('owned fixture: must remain byte-identical\n')
})

it('refuses a duplicate output option instead of silently choosing the last path', async () => {
  const { root, existing } = await fixture(), second = join(root, 'second-existing')
  // Both destinations already exist, so even a parser regression cannot start a pack.
  await mkdir(second)
  const result = await rejected(root, ['--output', existing, '--output', second])
  expect(result.stderr).toMatch(/usage|duplicate|once/iu)
  expect(await readdir(second)).toEqual([])
  expect(await readdir(existing)).toEqual(['sentinel.txt'])
})

it('does not interpret another flag as the output directory', async () => {
  const { root } = await fixture()
  // Seed this misleading filename: a parser regression must fail before any pack/cleanup.
  await mkdir(join(root, '--keep-work'))
  const result = await rejected(root, ['--output', '--keep-work'])
  expect(result.stderr).toMatch(/usage|missing|directory/iu)
  expect(await readdir(join(root, '--keep-work'))).toEqual([])
})

it('refuses an empty output argument before creating or packaging anything', async () => {
  const { root, existing } = await fixture()
  const result = await rejected(root, ['--output', ''])
  expect(result.stderr).toMatch(/usage|missing|empty/iu)
  expect(await readdir(root)).toEqual(['existing-output'])
  expect(await readdir(existing)).toEqual(['sentinel.txt'])
})

it('rejects unknown arguments before touching the declared output', async () => {
  const { root, existing } = await fixture()
  const result = await rejected(root, ['--output', existing, '--unsafe-overwrite'])
  expect(result.stderr).toMatch(/usage|unknown/iu)
  expect(await readdir(root)).toEqual(['existing-output'])
  expect(await readFile(join(existing, 'sentinel.txt'), 'utf8')).toBe('owned fixture: must remain byte-identical\n')
})
