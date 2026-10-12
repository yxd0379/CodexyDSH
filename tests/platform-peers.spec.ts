/** Product plugins share the platform modules supplied by the running DSH installation. */
import { createRequire } from 'node:module'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createRuntimeResolution, evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot'

it('resolves every public platform peer from the fixed DSH installation without product-owned copies', async () => {
  const require = createRequire(import.meta.url)
  const resolution = await createRuntimeResolution({ installAnchor: require.resolve('@deepseek-ai/dsh/package.json') })
  const available = new Map(resolution.entries.map(entry => [entry.name, entry]))
  for (const directory of await readdir('packages')) {
    const path = join('packages', directory, 'package.json')
    const manifest = JSON.parse(await readFile(path, 'utf8'))
    if (manifest.private === true) continue
    for (const field of ['dependencies', 'optionalDependencies']) {
      expect(Object.keys(manifest[field] ?? {}).filter(name => name.startsWith('@deepseek-ai/')), path).toEqual([])
    }
    for (const [name, version] of Object.entries(manifest.peerDependencies ?? {})) {
      if (!name.startsWith('@deepseek-ai/')) continue
      expect(available.get(name), path + ': ' + name).toMatchObject({ scope: 'installation' })
      expect(String(version).split(' || '), path + ': ' + name).toContain(available.get(name)?.version)
    }
    expect(evaluatePluginCompatibility(manifest), path).toBeUndefined()
  }
})

it('declares only the exact platform versions included in the validation matrix', async () => {
  const platform = JSON.parse(await readFile('platform.json', 'utf8'))
  const versions: string[] = platform.compatibility.map((entry: { version: string }) => entry.version)
  for (const directory of await readdir('packages')) {
    const manifest = JSON.parse(await readFile(join('packages', directory, 'package.json'), 'utf8'))
    if (manifest.private === true) continue
    for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
      expect(String(range).split(' || ').sort(), manifest.name + ': ' + name).toEqual([...versions].sort())
    }
    for (const version of versions) expect(evaluatePluginCompatibility(manifest, {}, version), manifest.name).toBeUndefined()
  }
})
