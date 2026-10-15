/** Execute the actual public Session implementation in its own module graph. */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const source = fileURLToPath(new URL('../src/', import.meta.url))
const fixture = fileURLToPath(new URL('./fixtures/session-compat.mjs', import.meta.url))
const current = resolve(dirname(fileURLToPath(new URL('../../../package.json', import.meta.url))), 'node_modules')
const historical = process.env['CODEXY_COMPAT_DSH_NODE_MODULES']
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function verifySession(nodeModules: string, version: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'codexy-session-compat-'))
  roots.push(root)
  await symlink(resolve(nodeModules), join(root, 'node_modules'), 'dir')
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
  // A temporary product-owned build retains bare imports, so Node resolves every
  // public platform dependency from this runtime rather than Vitest's aliases.
  for (const name of ['session', 'events', 'recovery', 'fork', 'persistence-codec', 'v5-content', 'v5-validation', 'product-relationships', 'response-metadata']) {
    const input = await readFile(join(source, `${name}.ts`), 'utf8')
    const output = ts.transpileModule(input, { compilerOptions: {
      target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext, rewriteRelativeImportExtensions: true,
    }, fileName: `${name}.ts`, reportDiagnostics: true })
    expect(output.diagnostics?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)).toEqual([])
    await writeFile(join(root, `${name}.js`), output.outputText)
  }
  await writeFile(join(root, 'fixture.mjs'), await readFile(fixture))
  const result = spawnSync(process.execPath, [join(root, 'fixture.mjs')], { cwd: root, encoding: 'utf8', timeout: 15000 })
  expect(result.error, result.stderr).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  const report: unknown = JSON.parse(result.stdout)
  expect(report).toMatchObject({ version, restored: true, rejectedInvalidJson: true, modelInputUnchanged: true })
}

describe('public Session runtime compatibility', () => {
  it('preserves diagnostics and required facts on the development runtime', async () => {
    await verifySession(current, '0.2.1-alpha.2')
  })
  it.skipIf(historical === undefined)('preserves diagnostics and required facts on the historical runtime', async () => {
    await verifySession(historical!, '0.2.0-rc.2')
  })
})
