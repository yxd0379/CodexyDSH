/** Automatic deployment uploads the installed release, never working-tree artifacts. */
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { discoverDeploymentRelease, type DeploymentManifest } from '../src/deployment-release.ts'

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')

async function fixture(change?: (manifest: DeploymentManifest) => void) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'codexy-release-')))
  onTestFinished(() => rm(home, { recursive: true, force: true }))
  const contents = new Map<string, string>()
  const manifest: DeploymentManifest = {
    format: 1, platform: { package: '@deepseek-ai/dsh', version: '0.2.1-alpha.2',
      compatibility: [{ version: '0.2.1-alpha.2', status: 'verified', surfaces: ['web', 'headless'] }] },
    packages: ['bundle', 'web', 'headless', 'remote'].map(name => {
      const file = `codexydsh-${name}-0.1.0.tgz`
      contents.set(file, `packed ${name}`)
      return { name: `@codexydsh/${name}`, version: '0.1.0', file, sha256: hash(contents.get(file)!) }
    }),
    providerPatches: [{ name: '@earendil-works/pi-ai@0.85.1', file: 'patches/pi-ai-0.85.1.patch', sha256: hash('provider patch') }],
    deploymentFiles: ['install.mjs', 'profiles/codexy/package.json', 'profiles/codexy-headless/package.json'].map(file => {
      contents.set(file, `deployment ${file}`)
      return { file, sha256: hash(contents.get(file)!) }
    }),
  }
  contents.set('patches/pi-ai-0.85.1.patch', 'provider patch')
  change?.(manifest)
  const key = hash(JSON.stringify(manifest))
  const directory = join(home, 'products/codexy/releases', key)
  await mkdir(directory, { recursive: true })
  for (const [file, value] of contents) {
    await mkdir(dirname(join(directory, file)), { recursive: true })
    await writeFile(join(directory, file), value)
  }
  await writeFile(join(directory, 'release.json'), JSON.stringify(manifest, null, 2) + '\n')
  const profile = join(home, 'profiles/desktop')
  await mkdir(profile, { recursive: true })
  const installed = { dependencies: { '@codexydsh/remote': `file:${join(directory, 'codexydsh-remote-0.1.0.tgz')}` } }
  await writeFile(join(profile, 'package.json'), JSON.stringify(installed))
  return { home, key, directory, manifest, profile, installed }
}

it('returns every verified installed file and its exact platform version without changing user configuration', async () => {
  const f = await fixture()
  const previous = await readFile(join(f.profile, 'package.json'), 'utf8')
  const release = await discoverDeploymentRelease({ home: f.home })
  expect(release).toMatchObject({ key: f.key, directory: f.directory, platformVersion: '0.2.1-alpha.2', manifest: f.manifest })
  expect(release.files.map(file => file.file)).toEqual(['release.json', ...f.manifest.packages.map(item => item.file),
    'patches/pi-ai-0.85.1.patch', ...f.manifest.deploymentFiles.map(item => item.file)])
  for (const file of release.files) expect(file.sha256).toBe(hash(await readFile(file.path, 'utf8')))
  expect(await readFile(join(f.profile, 'package.json'), 'utf8')).toBe(previous)
})

it('discovers the active installed profile from the module location', async () => {
  const f = await fixture()
  await mkdir(join(f.home, 'profiles/custom'), { recursive: true })
  await writeFile(join(f.home, 'profiles/custom/package.json'), JSON.stringify(f.installed))
  await writeFile(join(f.profile, 'package.json'), '{}')
  expect((await discoverDeploymentRelease({ home: f.home, modulePath: join(f.home, 'profiles/custom/node_modules/@codexydsh/remote/lib/index.js') })).key).toBe(f.key)
  await expect(discoverDeploymentRelease({ home: f.home, profile: 'desktop' })).rejects.toThrow('no pinned Codexy release')
})

it('requires an updated installed release instead of falling back to development artifacts', async () => {
  const f = await fixture(manifest => { delete (manifest as Partial<DeploymentManifest>).deploymentFiles })
  await expect(discoverDeploymentRelease({ home: f.home })).rejects.toThrow('Rebuild and reinstall')
})

it.each(['codexydsh-web-0.1.0.tgz', 'patches/pi-ai-0.85.1.patch', 'install.mjs'])('rejects changed release bytes: %s', async file => {
  const f = await fixture()
  await writeFile(join(f.directory, file), 'changed')
  await expect(discoverDeploymentRelease({ home: f.home })).rejects.toThrow(`checksum mismatch: ${file}`)
})

it('rejects a modified manifest even when individual file hashes remain valid', async () => {
  const f = await fixture()
  await writeFile(join(f.directory, 'release.json'), JSON.stringify({ ...f.manifest, unexpected: true }))
  await expect(discoverDeploymentRelease({ home: f.home })).rejects.toThrow('does not match its cache key')
})

it('rejects dependency paths outside the owned release cache', async () => {
  const f = await fixture()
  f.installed.dependencies['@codexydsh/remote'] = `file:${join(f.home, 'profiles/desktop/codexydsh-remote-0.1.0.tgz')}`
  await writeFile(join(f.profile, 'package.json'), JSON.stringify(f.installed))
  await expect(discoverDeploymentRelease({ home: f.home })).rejects.toThrow('outside its owned release cache')
})

it('rejects release file symlinks escaping its directory', async () => {
  const f = await fixture()
  const file = 'codexydsh-web-0.1.0.tgz'
  await writeFile(join(f.home, 'outside.tgz'), 'packed web')
  await rm(join(f.directory, file))
  await symlink(join(f.home, 'outside.tgz'), join(f.directory, file))
  await expect(discoverDeploymentRelease({ home: f.home })).rejects.toThrow('escapes its directory')
})

it('rejects unverified runtime versions and unexpected executable payload paths', async () => {
  const unverified = await fixture(manifest => { manifest.platform.compatibility![0]!.status = 'pending' })
  await expect(discoverDeploymentRelease({ home: unverified.home })).rejects.toThrow('no verified Web runtime')
  const unexpected = await fixture(manifest => { manifest.deploymentFiles.push({ file: '../secret', sha256: hash('secret') }) })
  await expect(discoverDeploymentRelease({ home: unexpected.home })).rejects.toThrow('Invalid automatic deployment file')
})
