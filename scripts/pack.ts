/** Package the independent plugins and pin their complete local release graph. */
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, mkdir, cp, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { build } from 'tsdown'

const root = fileURLToPath(new URL('../', import.meta.url))
const packArguments = process.argv.slice(2)
let output = resolve(root, '.artifacts')
let customOutput = false
let retainWork = false
for (let index = 0; index < packArguments.length; index++) {
  const argument = packArguments[index]
  if (argument === '--keep-work') { retainWork = true; continue }
  const destination = packArguments[index + 1]
  if (argument !== '--output' || customOutput || destination === undefined || destination.trim() === '' || destination.startsWith('--')) throw new Error('usage: pack.ts [--output NEW_DIRECTORY] [--keep-work]')
  output = resolve(destination)
  index++
  customOutput = true
  retainWork = true
}
if (retainWork || customOutput) await mkdir(output) // A custom destination can never replace existing data.
else {
  await rm(output, { recursive: true, force: true })
  await mkdir(output, { recursive: true })
}
const platform = JSON.parse(await readFile(join(root, 'platform.json'), 'utf8'))
const packages: { name: string; version: string; file: string; sha256: string; installScript?: { file: string; sha256: string } }[] = []
for (const directory of (await readdir(join(root, 'packages'))).sort()) {
  if (directory === 'test-support') continue
  const source = join(root, 'packages', directory)
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  if (manifest.private === true) continue
  await access(join(source, 'lib'))
  const staging = await mkdtemp(join(tmpdir(), 'codexy-pack-'))
  try {
    const packed = join(staging, 'package')
    await mkdir(packed)
    for (const path of manifest.files ?? ['lib']) await cp(join(source, path), join(packed, path), { recursive: true })
    await cp(join(root, 'LICENSE'), join(packed, 'LICENSE'))
    for (const path of ['README.md', ...((await readdir(source)).filter(path => /^(?:LICENSE|NOTICE)(?:[.-]|$)/.test(path)))]) {
      try { await cp(join(source, path), join(packed, path)) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [name, version] of Object.entries(manifest[field] ?? {})) {
        if (typeof version === 'string' && version.startsWith('workspace:')) manifest[field][name] = manifest.version
      }
    }
    delete manifest.devDependencies
    if (directory !== 'processes') delete manifest.scripts
    delete manifest.exports?.['./src/*']
    await writeFile(join(packed, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
    const file = `${manifest.name.replace(/^@/, '').replace('/', '-')}-${manifest.version}.tgz`
    execFileSync('tar', ['-czf', join(output, file), '-C', staging, 'package'])
    packages.push({ name: manifest.name, version: manifest.version, file,
      sha256: createHash('sha256').update(await readFile(join(output, file))).digest('hex'),
      ...(directory === 'processes' ? { installScript: {
        file: 'scripts/ensure-spawn-helper.mjs',
        sha256: createHash('sha256').update(await readFile(join(source, 'scripts/ensure-spawn-helper.mjs'))).digest('hex'),
      } } : {}),
    })
  } finally {
    if (!retainWork) await rm(staging, { recursive: true, force: true })
  }
}
const providerPatchFile = 'patches/pi-ai-0.85.1.patch'
await mkdir(join(output, 'patches'), { recursive: true })
await cp(join(root, providerPatchFile), join(output, providerPatchFile))
const providerPatches = [{ name: '@earendil-works/pi-ai@0.85.1', file: providerPatchFile,
  sha256: createHash('sha256').update(await readFile(join(root, providerPatchFile))).digest('hex') }]
await writeFile(join(output, 'release.json'), JSON.stringify({ format: 1, platform, packages, providerPatches }, null, 2) + '\n')
await build({ cwd: root, entry: { install: join(root, 'scripts/install.mjs') },
  outDir: output, format: 'esm', clean: false, dts: false, sourcemap: false, platform: 'node',
  deps: { alwaysBundle: ['yaml'], onlyBundle: false }, outputOptions: { entryFileNames: 'install.mjs' },
})
await cp(join(root, 'profiles'), join(output, 'profiles'), { recursive: true })
await cp(join(root, 'install.sh'), join(output, 'install.sh'))
for (const file of ['README.md', 'LICENSE']) {
  await cp(join(root, file), join(output, file))
}
process.stdout.write(`Packed ${packages.length} plugins in ${output}\n`)
execFileSync('tar', ['-czf', join(output, 'codexydsh-0.1.0.tar.gz'), '-C', output, ...await readdir(output)]);
