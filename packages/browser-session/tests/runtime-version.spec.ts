/** Bridge source resolves its provider from the same unchanged runtime version. */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const historical = process.env['CODEXY_COMPAT_DSH_NODE_MODULES']
const scratch: string[] = []
afterEach(async () => { await Promise.all(scratch.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function bridge(nodeModules: string, version: string, mismatch = false): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), 'codexy-browser-session-'))
  scratch.push(temporary)
  await symlink(resolve(nodeModules), join(temporary, 'node_modules'), 'dir')
  await mkdir(join(temporary, 'product'))
  await writeFile(join(temporary, 'package.json'), JSON.stringify({ type: 'module' }))
  const source = await readFile(join(root, 'packages/browser-session/src/index.ts'), 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext,
  }, fileName: 'index.ts', reportDiagnostics: true })
  expect(output.diagnostics?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)).toEqual([])
  await writeFile(join(temporary, 'product/index.js'), output.outputText)
  await writeFile(join(temporary, 'fixture.mjs'), await readFile(new URL('./fixtures/runtime-version.mjs', import.meta.url)))
  const result = spawnSync(process.execPath, [join(temporary, 'fixture.mjs'), ...mismatch ? ['--mismatch'] : []], {
    cwd: temporary, encoding: 'utf8', timeout: 15000,
  })
  expect(result.error, result.stderr).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  const report: unknown = JSON.parse(result.stdout)
  expect(report).toMatchObject(mismatch ? { version, rejectedBeforeRegistration: true } : {
    version, actualPlatformGraph: true, actualPublishedBytes: true, initialAndLiveGraph: true, disposed: true,
  })
}

describe('published Session browser bridge version compatibility', () => {
  it('publishes and disposes the unchanged development runtime browser provider', async () => {
    await bridge(join(root, 'node_modules'), '0.2.1-alpha.2')
  })
  it.skipIf(historical === undefined)('publishes and disposes the unchanged historical runtime browser provider', async () => {
    await bridge(historical!, '0.2.0-rc.2')
  })
  it('rejects a provider from another runtime before registering a route or graph contribution', async () => {
    await bridge(join(root, 'node_modules'), '0.2.1-alpha.2', true)
  })
})
