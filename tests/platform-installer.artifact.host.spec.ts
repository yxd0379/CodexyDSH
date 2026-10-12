/** The bundled installer plans a moved release without project dependencies. */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { access, copyFile, mkdir, mkdtemp, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'

it('finds its colocated release manifest after unpacking into an arbitrary directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codexy-standalone-installer-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const release = join(root, 'moved-product-release'), home = join(root, 'unused-home')
  await mkdir(release)
  await copyFile(resolve(dirname(fileURLToPath(import.meta.url)), '../.artifacts/install.mjs'), join(release, 'install.mjs'))
  const packages = []
  for (const name of ['bundle', 'web', 'headless']) {
    const file = `codexydsh-${name}-0.1.0.tgz`, bytes = Buffer.from('standalone plan fixture: ' + name)
    await writeFile(join(release, file), bytes)
    packages.push({ name: '@codexydsh/' + name, version: '0.1.0', file, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  await writeFile(join(release, 'release.json'), JSON.stringify({ format: 1, platform: { version: '0.2.1-alpha.2' }, packages }))
  for (const profile of ['codexy', 'codexy-headless']) {
    await mkdir(join(release, 'profiles', profile), { recursive: true })
    await writeFile(join(release, 'profiles', profile, 'package.json'), JSON.stringify({ private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }))
  }
  const expected = [
    { profile: 'codexy', dir: join(home, 'profiles/codexy'), bundles: ['@codexydsh/bundle', '@codexydsh/web'] },
    { profile: 'codexy-headless', dir: join(home, 'profiles/codexy-headless'), bundles: ['@codexydsh/bundle', '@codexydsh/headless'] },
  ]
  const linked = join(root, 'linked-installer.mjs')
  await symlink(join(release, 'install.mjs'), linked)
  for (const entry of [join(release, 'install.mjs'), linked]) {
    const result = spawnSync(process.execPath, [entry, '--web', '--plan', '--home', home, '--dsh', '/no-dsh-needed-for-plan'], { cwd: root, encoding: 'utf8' })
    if (result.error !== undefined) throw result.error
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(expected)
  }
  await expect(access(home)).rejects.toMatchObject({ code: 'ENOENT' })
})
