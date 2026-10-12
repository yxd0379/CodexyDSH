/** Generated configs have correct source/output roots and no import-time writes. */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import ts from 'typescript'
import { generateCompilerConfigs, packagePaths } from '../scripts/configure.mjs'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'codexy-compiler-config-'))
  roots.push(root)
  const files: Record<string, string> = {
    'tsconfig.json': '{"files":[],"editor":"preserve me"}\n',
    'packages/core/package.json': JSON.stringify({ name: '@codexydsh/core', exports: {
      '.': { types: './lib/types/index.d.ts' }, './extra': { types: './lib/types/extra.d.ts' },
      './source': './src/source.ts', './missing': './lib/missing.js', './package.json': './package.json', './assets.yml': './lib/assets.yml',
    } }),
    'packages/core/src/index.ts': 'export const host = true\n',
    'packages/core/src/extra.tsx': 'export const jsx = true\n',
    'packages/core/src/source.ts': 'export const source = true\n',
    'packages/core/src/client/index.ts': 'export const client = true\n',
    'packages/ui-example/package.json': JSON.stringify({ name: '@codexydsh/ui-example', exports: { '.': './lib/index.js' } }),
    'packages/ui-example/src/index.ts': 'export const host = true\n',
    'packages/ui-example/src/client/index.ts': 'export const client = true\n',
    'packages/test-support/package.json': JSON.stringify({ name: '@codexydsh/test-support', private: true }),
    'packages/test-support/src/index.ts': 'export const testOnly = true\n',
    'types/ambient.d.ts': 'declare const ambient: string\n',
  }
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  return root
}
function parsed(root: string, name: string): ts.ParsedCommandLine {
  const configPath = join(root, '.build/config', name)
  const read = ts.readConfigFile(configPath, path => readFileSync(path, 'utf8'))
  expect(read.error).toBeUndefined()
  const config = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath), undefined, configPath)
  expect(config.errors).toEqual([])
  return config
}
describe('product compiler configuration', () => {
  it('maps public exports including TSX without generating files', async () => {
    const root = await project()
    expect(await packagePaths(root)).toEqual({
      '@codexydsh/core': ['./packages/core/src/index.ts'],
      '@codexydsh/core/extra': ['./packages/core/src/extra.tsx'],
      '@codexydsh/core/source': ['./packages/core/src/source.ts'],
      '@codexydsh/ui-example': ['./packages/ui-example/src/index.ts'],
    })
    expect(await readdir(root)).toEqual(['packages', 'tsconfig.json', 'types'])
  })
  it('generates only build-owned files and retains host/client boundaries', async () => {
    const root = await project()
    const original = await readFile(join(root, 'tsconfig.json'))
    const configRoot = await generateCompilerConfigs(root)
    expect(configRoot).toBe(join(root, '.build/config'))
    expect((await readdir(configRoot)).sort()).toEqual([
      'tsconfig.base.json', 'tsconfig.client.json', 'tsconfig.declarations.client.json',
      'tsconfig.declarations.host.json', 'tsconfig.host.json',
    ])
    expect(await readFile(join(root, 'tsconfig.json'))).toEqual(original)
    const host = parsed(root, 'tsconfig.host.json')
    const client = parsed(root, 'tsconfig.client.json')
    expect(host.options.strict).toBe(true)
    expect(host.options.noEmit).toBe(true)
    expect(host.fileNames.map(path => relative(root, path))).toEqual(expect.arrayContaining([
      'packages/core/src/index.ts', 'packages/core/src/extra.tsx', 'packages/ui-example/src/index.ts', 'types/ambient.d.ts',
    ]))
    expect(host.fileNames.some(path => path.includes('/src/client/'))).toBe(false)
    expect(client.fileNames.map(path => relative(root, path)).sort()).toEqual([
      'packages/core/src/client/index.ts', 'packages/ui-example/src/client/index.ts', 'types/ambient.d.ts',
    ])
    expect(resolve(configRoot, host.options.paths!['@codexydsh/core']![0]!)).toBe(join(root, 'packages/core/src/index.ts'))
    for (const face of ['host', 'client']) {
      const emitted = parsed(root, `tsconfig.declarations.${face}.json`)
      expect(emitted.options.rootDir).toBe(join(root, 'packages'))
      expect(emitted.options.outDir).toBe(join(root, `.build/types-${face}`))
      expect(emitted.options.declaration).toBe(true)
      expect(emitted.options.noEmit).toBe(false)
      expect(emitted.options.rewriteRelativeImportExtensions).toBe(true)
      expect(emitted.fileNames.some(path => path.includes('/packages/test-support/'))).toBe(false)
    }
  })
  it('does not generate configuration when imported by Vitest or another consumer', async () => {
    const root = await project()
    const script = join(root, 'scripts/configure.mjs')
    await mkdir(dirname(script))
    await writeFile(script, await readFile(fileURLToPath(new URL('../scripts/configure.mjs', import.meta.url))))
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(script).href)})`], { cwd: root, encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(await readdir(root)).toEqual(['packages', 'scripts', 'tsconfig.json', 'types'])
    const direct = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' })
    expect(direct.status, direct.stderr).toBe(0)
    expect(await readdir(join(root, '.build/config'))).toHaveLength(5)
    expect(await readFile(join(root, 'tsconfig.json'), 'utf8')).toBe('{"files":[],"editor":"preserve me"}\n')
  })
})
