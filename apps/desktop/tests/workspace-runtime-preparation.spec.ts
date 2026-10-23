import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { materializeDesktopWorkspaceRuntime } from '../scripts/prepare-dsh.ts'
import { DESKTOP_HOST_RUNTIME_FILES } from '../src/core-package-set.ts'
import { verifyDesktopRuntime, writeDesktopRuntime } from '../src/runtime-tree.ts'
import { runtimeFixture, writePackage } from './runtime-fixture.ts'

it('materializes private product packages beside the deployed Host and keeps their own versions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codexydsh-workspace-runtime-'))
  const source = join(root, 'deployed')
  const output = join(root, 'resources')
  try {
    const initial = runtimeFixture(source)
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-desktop-host', version: '1.0.0', type: 'module' }))
    for (const file of DESKTOP_HOST_RUNTIME_FILES) {
      mkdirSync(join(source, file, '..'), { recursive: true })
      writeFileSync(join(source, file), `// deployed Host ${file}\n`)
    }
    const product = writePackage(join(source, 'node_modules'), '@codexydsh/base', { version: '0.1.0', private: true })
    writeFileSync(join(product, 'index.d.ts'), 'export declare const identity: object\n')
    materializeDesktopWorkspaceRuntime(source, output, process, 'darwin-arm64')
    expect(existsSync(join(output, 'node_modules', '@codexydsh/base', 'index.d.ts'))).toBe(false)
    expect(readFileSync(join(output, 'node_modules', '@codexydsh/base', 'index.js'), 'utf8')).toContain('identity')
    expect(readFileSync(join(output, 'node_modules', '@deepseek-ai/dsh-desktop-host', 'lib/index.js'), 'utf8')).toContain('deployed Host')
    writeFileSync(join(output, 'package.json'), '{"type":"module"}\n')
    const descriptor = writeDesktopRuntime(output, initial.release, [...initial.sharedPackages.map(entry => entry.name), '@codexydsh/base'])
    expect(descriptor.sharedPackages.find(entry => entry.name === '@codexydsh/base')?.version).toBe('0.1.0')
    await expect(verifyDesktopRuntime(output, initial.release.version)).resolves.toEqual(descriptor)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
