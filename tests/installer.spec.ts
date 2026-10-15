/** Installation preserves user patches and pins a verified immutable release. */
import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, access, symlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'
import { installProduct, installerOptions, runProfileInstall } from '../scripts/install.mjs'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(version = '0.2.1-alpha.2', includeProcesses = false, corruptRepair = false, includeProviderPatch = false) {
  const root = await mkdtemp(join(tmpdir(), 'codexy-installer-')); roots.push(root)
  const release = join(root, 'release'), home = join(root, 'home'), dsh = join(root, 'dsh')
  await mkdir(release)
  const packages = []
  const repair = "import { writeFile } from 'node:fs/promises'; import { join } from 'node:path'; await writeFile(join(process.cwd(), 'spawn-helper-repaired'), 'repaired');\n"
  for (const name of ['bundle', 'web', 'headless', ...(includeProcesses ? ['processes'] : [])]) {
    const file = `codexydsh-${name}-0.1.0.tgz`, bytes = Buffer.from(`artifact:${name}`)
    await writeFile(join(release, file), bytes)
    packages.push({ name: `@codexydsh/${name}`, version: '0.1.0', file, sha256: createHash('sha256').update(bytes).digest('hex'),
      ...(name === 'processes' ? { installScript: { file: 'scripts/ensure-spawn-helper.mjs', sha256: createHash('sha256').update(repair).digest('hex') } } : {}) })
  }
  const providerPatches = []
  if (includeProviderPatch) {
    const file = 'patches/pi-ai-0.85.1.patch', bytes = Buffer.from('verified Pi SDK patch\n')
    await mkdir(join(release, 'patches')); await writeFile(join(release, file), bytes)
    providerPatches.push({ name: '@earendil-works/pi-ai@0.85.1', file, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  await writeFile(join(release, 'release.json'), JSON.stringify({ format: 1, platform: { version: '0.2.1-alpha.2' }, packages, providerPatches }))
  for (const profile of ['codexy', 'codexy-headless']) {
    const dir = join(release, 'profiles', profile); await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-bundle-base', profile === 'codexy' ? '@deepseek-ai/dsh-bundle-web-app' : '@deepseek-ai/dsh-bundle-headless'] } } }))
  }
  await writeFile(dsh, `#!/usr/bin/env node
const fs=require('node:fs');const path=require('node:path');const args=process.argv.slice(2);if(args[0]==='--version'){console.log('dsh ${version}')}else{fs.appendFileSync(path.join(process.env.DSH_HOME,'calls.jsonl'),JSON.stringify(args)+'\\n');
${includeProcesses ? `const dir=path.join(process.env.DSH_HOME,'profiles',args[args.indexOf('--profile')+1],'node_modules/@codexydsh/processes');fs.mkdirSync(path.join(dir,'scripts'),{recursive:true});fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name:'@codexydsh/processes',version:'0.1.0',type:'module',exports:{'./package.json':'./package.json'}}));fs.writeFileSync(path.join(dir,'scripts/ensure-spawn-helper.mjs'),${JSON.stringify(corruptRepair ? 'throw new Error("unverified repair ran");\n' : repair)});` : ''}}
`, { mode: 0o755 })
  return { release, home, dsh, desktop: false, desktopApp: undefined as string | undefined, standardProfiles: false, plan: false }
}

async function compatibleRelease(options: Awaited<ReturnType<typeof fixture>>, oldStatus = 'verified', surfaces = ['web', 'headless', 'desktop']) {
  const path = join(options.release, 'release.json'), release = JSON.parse(await readFile(path, 'utf8'))
  release.platform.compatibility = [
    { version: '0.2.0-rc.2', status: oldStatus, surfaces },
    { version: '0.2.1-alpha.2', status: 'verified', surfaces: ['web', 'headless'] },
  ]
  await writeFile(path, JSON.stringify(release))
}

async function desktopFixture(options: Awaited<ReturnType<typeof fixture>>, version = '0.2.0-rc.2', carrierVersion = version) {
  const app = join(dirname(options.release), 'DeepSeek Harness.app'), resources = join(app, 'Contents/Resources'), carrier = join(resources, 'runtime/cli/bin/dsh')
  await mkdir(dirname(carrier), { recursive: true })
  await writeFile(carrier, (await readFile(options.dsh, 'utf8')).replace(/dsh [0-9A-Za-z.-]+/u, `dsh ${carrierVersion}`), { mode: 0o755 })
  const bytes = Buffer.from(JSON.stringify({ name: '@deepseek-ai/dsh', version }))
  const header = Buffer.from(JSON.stringify({ files: { dsh: { files: { node_modules: { files: { '@deepseek-ai': { files: { dsh: { files: { 'package.json': { size: bytes.length, offset: '0' } } } } } } } } } } }))
  const prefix = Buffer.alloc(16); prefix.writeUInt32LE(header.length + 8, 4); prefix.writeUInt32LE(header.length, 12)
  await writeFile(join(resources, 'app.asar'), Buffer.concat([prefix, header, bytes]))
  const dir = join(options.home, 'profiles/desktop'); await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ private: true, userField: 'preserved', dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }))
  options.desktop = true; options.desktopApp = app
  return { app, carrier, dir }
}

describe('product profile installer', () => {
  it('installs only the requested remote Web profile', async () => {
    const fixtureOptions = await fixture()
    const options = installerOptions(['--web', '--managed-profile', 'remote-test', '--release', fixtureOptions.release, '--home', fixtureOptions.home, '--dsh', fixtureOptions.dsh], { platform: 'linux', desktopApps: [] })
    await installProduct(options)
    expect(await readdir(join(options.home, 'profiles'))).toEqual(['remote-test'])
    const manifest = JSON.parse(await readFile(join(options.home, 'profiles/remote-test/package.json'), 'utf8'))
    expect(manifest.dsh.profile.bundles).toContain('@codexydsh/web')
    expect(() => installerOptions(['--web', '--managed-profile', '../outside'])).toThrow('Web profile name')
    expect(() => installerOptions(['--managed-profile', 'desktop'])).toThrow('Web profile name')
  })
  it('retains the verified deployment payload in the installed release cache', async () => {
    const options = await fixture()
    await writeFile(join(options.release, 'install.mjs'), '// bundled installer fixture\n')
    const manifest = JSON.parse(await readFile(join(options.release, 'release.json'), 'utf8'))
    manifest.deploymentFiles = await Promise.all(['install.mjs', 'profiles/codexy/package.json', 'profiles/codexy-headless/package.json'].map(async file => ({ file, sha256: createHash('sha256').update(await readFile(join(options.release, file))).digest('hex') })))
    await writeFile(join(options.release, 'release.json'), JSON.stringify(manifest))
    await installProduct(options)
    const key = createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
    for (const item of manifest.deploymentFiles) expect(await readFile(join(options.home, 'products/codexy/releases', key, item.file))).toEqual(await readFile(join(options.release, item.file)))
    await writeFile(join(options.release, 'install.mjs'), '// corrupted\n')
    await expect(installProduct(options)).rejects.toThrow('deployment checksum mismatch')
  })
  it('runs the source installer through a symbolic or macOS canonicalized entry path', async () => {
    const options = await fixture(), entry = join(dirname(options.release), 'linked-installer.mjs')
    await symlink(resolve('scripts/install.mjs'), entry)
    const result = spawnSync(process.execPath, [entry, '--release', options.release, '--home', options.home, '--web', '--plan'], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).map((plan: { profile: string }) => plan.profile)).toEqual(['codexy', 'codexy-headless'])
    await expect(access(options.home)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('does not execute installation when imported with a missing or absent script argument', () => {
    for (const argument of ['undefined', JSON.stringify('/does/not/exist')]) {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `process.argv[1]=${argument};await import(${JSON.stringify(pathToFileURL(resolve('scripts/install.mjs')).href)})`], { encoding: 'utf8' })
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe('')
    }
  })
  it('times out and cleans only its own installation process group, including a child that ignores termination', async () => {
    if (process.platform === 'win32') return
    const options = await fixture(), root = dirname(options.release), childPidFile = join(root, 'package-manager.pid')
    await writeFile(options.dsh, `#!/usr/bin/env node
const fs=require('node:fs'),child=require('node:child_process');
const worker=child.spawn(process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(childPidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`)}],{stdio:'ignore'});
// The CLI exits on TERM while its PNPM-like child deliberately stays alive.
setInterval(()=>{},1000);
`, { mode: 0o755 })
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
    const intListeners = process.listenerCount('SIGINT'), termListeners = process.listenerCount('SIGTERM')
    let childPid: number | undefined
    try {
      const started = Date.now(), result = await runProfileInstall(options.dsh, 'codexy', options.home, { timeoutMs: 800, killGraceMs: 200 })
      expect(result.error?.message).toContain('timed out after 800ms')
      expect(result.status).not.toBe(0)
      expect(Date.now() - started).toBeLessThan(3500)
      childPid = Number(await readFile(childPidFile, 'utf8'))
      let alive = true
      for (let attempt = 0; alive && attempt < 30; attempt++) {
        try { process.kill(childPid, 0); await new Promise(resolve => setTimeout(resolve, 30)) }
        catch (error) { expect(error).toMatchObject({ code: 'ESRCH' }); alive = false }
      }
      expect(alive).toBe(false)
      expect(() => process.kill(unrelated.pid!, 0)).not.toThrow()
      expect(process.listenerCount('SIGINT')).toBe(intListeners)
      expect(process.listenerCount('SIGTERM')).toBe(termListeners)
    } finally {
      unrelated.kill('SIGKILL')
      if (childPid !== undefined) { try { process.kill(childPid, 'SIGKILL') } catch {} }
    }
  })
  it('requires exit zero even after Done output and removes the installation lock on failure', async () => {
    const options = await fixture(), dir = join(options.home, 'profiles/codexy')
    const previous = JSON.stringify({ private: true, dependencies: {}, userField: 'preserved' })
    await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'package.json'), previous)
    await writeFile(options.dsh, "#!/usr/bin/env node\nif(process.argv[2]==='--version'){console.log('dsh 0.2.1-alpha.2')}else{console.log('Done in 1ms');process.exit(7)}\n", { mode: 0o755 })
    await expect(installProduct(options)).rejects.toThrow('profile codexy installation failed')
    const backup = (await readdir(dir)).find(file => file.startsWith('package.json.codexy-backup-'))!
    expect(await readFile(join(dir, backup), 'utf8')).toBe(previous)
    await expect(access(join(options.home, 'products/codexy/install.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('plans web and headless without creating the DSH home or invoking a CLI', async () => {
    const options = await fixture(); options.dsh = '/does/not/exist'; options.plan = true
    const plans = await installProduct(options)
    expect(plans.map(plan => plan.profile)).toEqual(['codexy', 'codexy-headless'])
    await expect(access(options.home)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('refuses a corrupted release before modifying profiles', async () => {
    const options = await fixture(); await writeFile(join(options.release, 'codexydsh-web-0.1.0.tgz'), 'corrupted')
    await expect(installProduct(options)).rejects.toThrow('checksum mismatch')
    await expect(access(options.home)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('refuses a release without the product headless runner before modifying profiles', async () => {
    const options = await fixture()
    const releasePath = join(options.release, 'release.json')
    const release = JSON.parse(await readFile(releasePath, 'utf8'))
    release.packages = release.packages.filter((entry: { name: string }) => entry.name !== '@codexydsh/headless')
    await writeFile(releasePath, JSON.stringify(release))
    await expect(installProduct(options)).rejects.toThrow('release is missing @codexydsh/headless')
    await expect(access(options.home)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('places the product headless runner after its runtime bundle when reinstalling', async () => {
    const options = await fixture(), dir = join(options.home, 'profiles/codexy-headless')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      private: true, dependencies: {}, dsh: { profile: { bundles: [
        '@codexydsh/headless', '@codexydsh/bundle', 'custom-bundle', '@codexydsh/headless', '@codexydsh/web',
      ] } },
    }))
    await installProduct(options)
    const installed = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    expect(installed.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-bundle-base', '@deepseek-ai/dsh-bundle-headless', 'custom-bundle', '@codexydsh/bundle', '@codexydsh/headless',
    ])
  })
  it('retains custom profile fields and patches while adding the required product bundles', async () => {
    const options = await fixture(), dir = join(options.home, 'profiles/codexy')
    await mkdir(dir, { recursive: true })
    const prior = { private: true, userField: { retained: 7 }, dependencies: { custom: '1.0.0' }, dsh: { profile: { bundles: ['custom-bundle'] } } }
    const patch = '# user override\n- id: custom\n  disabled: true\n'
    await writeFile(join(dir, 'package.json'), JSON.stringify(prior)); await writeFile(join(dir, 'cordis.patch.yml'), patch)
    await installProduct(options)
    const installed = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    expect(installed.userField).toEqual(prior.userField)
    expect(installed.dependencies.custom).toBe('1.0.0')
    expect(installed.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-bundle-base', '@deepseek-ai/dsh-bundle-web-app', 'custom-bundle', '@codexydsh/bundle', '@codexydsh/web'])
    expect(await readFile(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(patch)
    const backup = (await readdir(dir)).find(file => file.startsWith('package.json.codexy-backup-'))!
    expect(JSON.parse(await readFile(join(dir, backup), 'utf8'))).toEqual(prior)
    for (const name of ['@codexydsh/bundle', '@codexydsh/web']) {
      const archive = installed.dependencies[name].slice('file:'.length)
      expect(archive.startsWith(join(options.home, 'products/codexy/releases'))).toBe(true)
      await access(archive)
      const workspace = parse(await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8'))
      expect(workspace.overrides[name]).toBe(installed.dependencies[name])
      expect(workspace.strictDepBuilds).toBe(false)
      expect(workspace.autoInstallPeers).toBe(false)
      expect(workspace.allowBuilds).toBeUndefined()
    }
    const calls = (await readFile(join(options.home, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(calls).toEqual([['plugin', '--profile', 'codexy', 'install', '--ignore-scripts'], ['plugin', '--profile', 'codexy-headless', 'install', '--ignore-scripts']])
    await expect(access(join(options.home, 'products/codexy/install.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('merges cached release pins into the PNPM workspace while retaining settings, comments, and exact backups', async () => {
    const options = await fixture('0.2.1-alpha.2', true), dir = join(options.home, 'profiles/codexy')
    await mkdir(dir, { recursive: true })
    const source = '# custom profile\npackages:\n  - .\n  - plugins/*\nnodeLinker: isolated # chosen by user\nautoInstallPeers: true\nregistry: https://registry.npmjs.org/\nstrictDepBuilds: true # chosen build check\noverrides:\n  custom: 1.0.0 # custom pin\n  "@codexydsh/bundle": file:/old/bundle.tgz # product pin\nallowBuilds:\n  custom-native: false # custom policy\n'
    await writeFile(join(dir, 'pnpm-workspace.yaml'), source)
    await installProduct(options)
    const text = await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8'), workspace = parse(text)
    expect(workspace).toMatchObject({ packages: ['.', 'plugins/*'], nodeLinker: 'isolated', autoInstallPeers: false,
      registry: 'https://registry.npmjs.org/', strictDepBuilds: false, overrides: { custom: '1.0.0' },
      allowBuilds: { 'custom-native': false } })
    expect(Object.keys(workspace.allowBuilds)).toEqual(['custom-native'])
    for (const profile of ['codexy', 'codexy-headless']) expect(await readFile(join(options.home, 'profiles', profile, 'spawn-helper-repaired'), 'utf8')).toBe('repaired')
    for (const comment of ['# custom profile', '# chosen by user', '# chosen build check', '# custom pin', '# product pin', '# custom policy']) expect(text).toContain(comment)
    const installed = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    for (const name of ['bundle', 'web', 'processes']) {
      const dependency = installed.dependencies[`@codexydsh/${name}`]
      expect(workspace.overrides[`@codexydsh/${name}`]).toBe(dependency)
      expect(dependency.startsWith(`file:${join(options.home, 'products/codexy/releases')}`)).toBe(true)
    }
    const files = await readdir(dir), backup = files.find(file => file.startsWith('pnpm-workspace.yaml.codexy-backup-'))!
    expect(await readFile(join(dir, backup), 'utf8')).toBe(source)
    expect(files.some(file => file.includes('.codexy-next-'))).toBe(false)
  })
  it('refuses installed repair bytes that differ from the verified release before running them', async () => {
    const options = await fixture('0.2.1-alpha.2', true, true)
    await expect(installProduct(options)).rejects.toThrow('processes repair checksum mismatch')
    await expect(access(join(options.home, 'profiles/codexy/spawn-helper-repaired'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(join(options.home, 'products/codexy/install.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('runs actual PNPM 11 offline with ignored scripts while retaining user build approvals', async () => {
    const options = await fixture(), root = dirname(options.release), native = join(root, 'native-fixture')
    await mkdir(native)
    await writeFile(join(native, 'package.json'), JSON.stringify({ name: 'native-fixture', version: '1.0.0', scripts: { postinstall: 'node postinstall.mjs' } }))
    await writeFile(join(native, 'postinstall.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(join(root, 'unwanted-script-ran'))}, 'ran');\n`)
    const pnpm = join(dirname(createRequire(import.meta.url).resolve('pnpm')), 'bin/pnpm.mjs')
    const archive = join(root, 'native-fixture.tgz')
    const packed = spawnSync('tar', ['-czf', archive, '-C', root, 'native-fixture'], { encoding: 'utf8' })
    if (packed.error !== undefined) throw packed.error
    expect(packed.status, packed.stderr).toBe(0)
    const strict = join(root, 'strict-negative-control')
    await mkdir(strict)
    await writeFile(join(strict, 'package.json'), JSON.stringify({ private: true, dependencies: { 'native-fixture': 'file:' + archive } }))
    await writeFile(join(strict, 'pnpm-workspace.yaml'), 'packages:\n  - .\nstrictDepBuilds: true\n')
    const rejected = spawnSync(process.execPath, [pnpm, 'install', '--offline', '--store-dir', join(root, 'pnpm-store'), '--config.manage-package-manager-versions=false'], { cwd: strict, encoding: 'utf8', env: { ...process.env, CI: 'true' }, timeout: 15000 })
    if (rejected.error !== undefined) throw rejected.error
    expect(rejected.status).not.toBe(0)
    expect(rejected.stdout + rejected.stderr).toContain('ERR_PNPM_IGNORED_BUILDS')
    await writeFile(options.dsh, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),child=require('node:child_process');const args=process.argv.slice(2);
if(args[0]==='--version'){console.log('dsh 0.2.1-alpha.2')}else{
 const dir=path.join(process.env.DSH_HOME,'profiles',args[args.indexOf('--profile')+1]),manifestPath=path.join(dir,'package.json'),prior=fs.readFileSync(manifestPath,'utf8');
 const manifest=JSON.parse(prior);manifest.dependencies={'native-fixture':${JSON.stringify('file:' + archive)}};delete manifest.pnpm;
 fs.writeFileSync(manifestPath,JSON.stringify(manifest));
 const result=child.spawnSync(process.execPath,[${JSON.stringify(pnpm)},'install','--offline',...args.filter(value=>value==='--ignore-scripts'),'--store-dir',${JSON.stringify(join(root, 'pnpm-store'))},'--config.manage-package-manager-versions=false'],{cwd:dir,env:process.env,stdio:'inherit',timeout:15000});
 fs.writeFileSync(manifestPath,prior);if(result.error)throw result.error;process.exit(result.status??1);
}
`, { mode: 0o755 })
    const dir = join(options.home, 'profiles/codexy'), source = 'allowBuilds:\n  user-approved@1.0.0: true # keep approval\n  user-denied: false # keep denial\n'
    await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'pnpm-workspace.yaml'), source)
    await installProduct(options)
    const text = await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8'), workspace = parse(text)
    expect(workspace.strictDepBuilds).toBe(false)
    expect(workspace.allowBuilds).toEqual({ 'user-approved@1.0.0': true, 'user-denied': false })
    expect(text).toContain('# keep approval'); expect(text).toContain('# keep denial')
    await expect(access(join(root, 'unwanted-script-ran'))).rejects.toMatchObject({ code: 'ENOENT' })
    const emptyPolicy = parse(await readFile(join(options.home, 'profiles/codexy-headless/pnpm-workspace.yaml'), 'utf8'))
    expect(emptyPolicy.allowBuilds).toBeUndefined()
  })
  it('passes noninteractive installation policy to actual PNPM 11 while updating existing lockfile release overrides', async () => {
    const options = await fixture(), root = dirname(options.release)
    const dependency = join(root, 'native-fixture')
    await mkdir(dependency)
    await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: 'native-fixture', version: '1.0.0' }))
    const pnpm = join(dirname(createRequire(import.meta.url).resolve('pnpm')), 'bin/pnpm.mjs')
    const pnpmArgs = [pnpm, 'install', '--offline', '--ignore-scripts', '--store-dir', join(root, 'pnpm-store'), '--config.manage-package-manager-versions=false']
    for (const profile of ['codexy', 'codexy-headless']) {
      const dir = join(options.home, 'profiles', profile)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'package.json'), JSON.stringify({ private: true, dependencies: { 'native-fixture': 'file:' + dependency } }))
      await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\noverrides:\n  "@codexydsh/bundle": file:/old-product-release.tgz\n')
      const seeded = spawnSync(process.execPath, pnpmArgs, { cwd: dir, encoding: 'utf8', timeout: 15000,
        env: { ...process.env, CI: 'true', pnpm_config_frozen_lockfile: 'false', PNPM_CONFIG_FROZEN_LOCKFILE: 'false' } })
      if (seeded.error !== undefined) throw seeded.error
      expect(seeded.status, seeded.stdout + seeded.stderr).toBe(0)
      expect(parse(await readFile(join(dir, 'pnpm-lock.yaml'), 'utf8')).overrides['@codexydsh/bundle']).toBe('file:/old-product-release.tgz')
    }
    await writeFile(options.dsh, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),child=require('node:child_process');const args=process.argv.slice(2);
if(args[0]==='--version'){console.log('dsh 0.2.1-alpha.2')}else{
 const profile=args[args.indexOf('--profile')+1],dir=path.join(process.env.DSH_HOME,'profiles',profile),manifestPath=path.join(dir,'package.json'),prior=fs.readFileSync(manifestPath,'utf8');
 // This fixture isolates lockfile/configuration behavior; packed plugin loading is tested separately.
 const manifest=JSON.parse(prior);manifest.dependencies={'native-fixture':${JSON.stringify('file:' + dependency)}};delete manifest.pnpm;fs.writeFileSync(manifestPath,JSON.stringify(manifest));
 const legacyEnv={...process.env,npm_config_frozen_lockfile:'false'};delete legacyEnv.pnpm_config_frozen_lockfile;delete legacyEnv.PNPM_CONFIG_FROZEN_LOCKFILE;
 const negative=child.spawnSync(process.execPath,${JSON.stringify(pnpmArgs)},{cwd:dir,env:legacyEnv,encoding:'utf8',timeout:15000});
 fs.appendFileSync(path.join(process.env.DSH_HOME,'pnpm-policy.jsonl'),JSON.stringify({profile,ci:process.env.CI,frozen:process.env.pnpm_config_frozen_lockfile,negativeStatus:negative.status,negativeOutput:negative.stdout+negative.stderr})+'\\n');
 const result=child.spawnSync(process.execPath,${JSON.stringify(pnpmArgs)},{cwd:dir,env:process.env,stdio:'inherit',timeout:15000});
 fs.writeFileSync(manifestPath,prior);if(result.error)throw result.error;process.exit(result.status??1);
}
`, { mode: 0o755 })
    await installProduct(options)
    const policy = (await readFile(join(options.home, 'pnpm-policy.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(policy).toHaveLength(2)
    for (const result of policy) {
      expect(result).toMatchObject({ ci: 'true', frozen: 'false' })
      expect(result.negativeStatus).not.toBe(0)
      expect(result.negativeOutput).toContain('ERR_PNPM_LOCKFILE_CONFIG_MISMATCH')
      const dir = join(options.home, 'profiles', result.profile)
      expect(parse(await readFile(join(dir, 'pnpm-lock.yaml'), 'utf8')).overrides).toEqual(parse(await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8')).overrides)
    }
  })
  it('caches the verified Pi SDK patch while retaining other user patches and supports reinstalling it', async () => {
    const options = await fixture('0.2.1-alpha.2', false, false, true), dir = join(options.home, 'profiles/codexy')
    await mkdir(dir, { recursive: true })
    const source = '# user patches\npatchedDependencies:\n  custom@1.0.0: patches/custom.patch # custom patch\n'
    await writeFile(join(dir, 'pnpm-workspace.yaml'), source)
    await installProduct(options)
    const workspace = parse(await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8'))
    expect(workspace.patchedDependencies['custom@1.0.0']).toBe('patches/custom.patch')
    const patch = resolve(dir, workspace.patchedDependencies['@earendil-works/pi-ai@0.85.1'])
    expect(patch.startsWith(join(options.home, 'products/codexy/releases'))).toBe(true)
    expect(await readFile(patch, 'utf8')).toBe('verified Pi SDK patch\n')
    const backup = (await readdir(dir)).find(file => file.startsWith('pnpm-workspace.yaml.codexy-backup-'))!
    expect(await readFile(join(dir, backup), 'utf8')).toBe(source)
    await installProduct(options)
    const text = await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8'), next = parse(text)
    expect(next.patchedDependencies).toEqual(workspace.patchedDependencies)
    expect(text).toContain('# custom patch')
  })
  it.each(['workspace', 'manifest'])('retains a conflicting %s Pi SDK patch and refuses installation before changing any profile', async location => {
    const options = await fixture('0.2.1-alpha.2', false, false, true), dir = join(options.home, 'profiles/codexy')
    await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'custom.patch'), 'different user patch\n')
    const source = location === 'workspace' ? 'patchedDependencies:\n  "@earendil-works/pi-ai@0.85.1": custom.patch # keep it\n' : '# unchanged YAML\n'
    const manifest = JSON.stringify({ private: true, pnpm: location === 'manifest' ? { patchedDependencies: { '@earendil-works/pi-ai@0.85.1': 'custom.patch' } } : {} })
    await writeFile(join(dir, 'pnpm-workspace.yaml'), source); await writeFile(join(dir, 'package.json'), manifest)
    await expect(installProduct(options)).rejects.toThrow('conflicting provider patch')
    expect(await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toBe(source)
    expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe(manifest)
    await expect(access(join(options.home, 'products'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(join(options.home, 'calls.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it.each(['../pi.patch', 'patches/other.patch'])('rejects an unsupported provider patch path: %s', async file => {
    const options = await fixture('0.2.1-alpha.2', false, false, true), path = join(options.release, 'release.json')
    const release = JSON.parse(await readFile(path, 'utf8')); release.providerPatches[0].file = file
    await writeFile(path, JSON.stringify(release))
    await expect(installProduct(options)).rejects.toThrow('unsupported release provider patch')
    await expect(access(options.home)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('refuses a changed provider patch before creating the DSH home', async () => {
    const options = await fixture('0.2.1-alpha.2', false, false, true)
    await writeFile(join(options.release, 'patches/pi-ai-0.85.1.patch'), 'changed patch\n')
    await expect(installProduct(options)).rejects.toThrow('release provider patch checksum mismatch')
    await expect(access(options.home)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it.each(['overrides: []\n', 'allowBuilds: []\n', 'packages: [\n', 'invalid-root\n'])('rejects an invalid PNPM workspace before modifying any profile: %s', async source => {
    const options = await fixture('0.2.1-alpha.2', true), dir = join(options.home, 'profiles/codexy')
    await mkdir(dir, { recursive: true })
    const manifest = '{"private":true,"dsh":{"profile":{"bundles":[]}}}\n'
    await writeFile(join(dir, 'package.json'), manifest)
    await writeFile(join(dir, 'pnpm-workspace.yaml'), source)
    await expect(installProduct(options)).rejects.toThrow(/PNPM workspace|must be a YAML mapping/u)
    expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe(manifest)
    expect(await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toBe(source)
    await expect(access(join(options.home, 'products'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(join(options.home, 'calls.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('requires the Desktop profile to be initialized before any installation', async () => {
    const options = await fixture(); options.desktop = true
    await expect(installProduct(options)).rejects.toThrow('Open DSH Desktop once')
    await expect(access(options.home)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('checks the exact platform version before creating a product cache', async () => {
    const options = await fixture('9.0.2.1-alpha.2')
    await expect(installProduct(options)).rejects.toThrow('cannot read the exact DSH CLI version')
    await expect(access(options.home)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('accepts only the verified exact old runtime for standalone profiles', async () => {
    const options = await fixture('0.2.0-rc.2'); await compatibleRelease(options)
    await installProduct(options)
    expect(await readFile(join(options.home, 'calls.jsonl'), 'utf8')).toContain('codexy-headless')
  })
  it('refuses a pending matrix entry before changing any profiles', async () => {
    const options = await fixture('0.2.0-rc.2'); await compatibleRelease(options, 'pending')
    await expect(installProduct(options)).rejects.toThrow('unsupported DSH 0.2.0-rc.2')
    await expect(access(options.home)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('uses the actual desktop runtime and its public CLI carrier instead of an explicitly newer CLI', async () => {
    const options = await fixture(); await compatibleRelease(options)
    const { dir } = await desktopFixture(options), prior = await readFile(join(dir, 'package.json'), 'utf8')
    options.dsh = '/a/newer/cli/that/must/not/run'
    await installProduct(options)
    const calls = (await readFile(join(options.home, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(calls).toEqual([['plugin', '--profile', 'desktop', 'install', '--ignore-scripts']])
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    expect(manifest.userField).toBe('preserved')
    expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@codexydsh/bundle', '@codexydsh/web'])
    const backup = (await readdir(dir)).find(file => file.startsWith('package.json.codexy-backup-'))!
    expect(await readFile(join(dir, backup), 'utf8')).toBe(prior)
    await expect(access(join(options.home, 'profiles/codexy'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('plans an initialized desktop read-only, without executing either CLI', async () => {
    const options = await fixture(); await compatibleRelease(options)
    const { carrier, dir } = await desktopFixture(options), prior = await readFile(join(dir, 'package.json'), 'utf8')
    await writeFile(carrier, '#!/bin/sh\nexit 99\n', { mode: 0o755 }); options.dsh = '/does/not/exist'; options.plan = true
    expect(await installProduct(options)).toEqual([{ profile: 'desktop', dir, bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@codexydsh/bundle', '@codexydsh/web'], runtime: '0.2.0-rc.2', dsh: carrier }])
    expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe(prior)
    await expect(access(join(options.home, 'products'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(join(options.home, 'calls.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it.each(['pending', 'unsupported surface', 'runtime mismatch'])('refuses desktop %s before modifying initialized user data', async reason => {
    const options = await fixture(); await compatibleRelease(options, reason === 'pending' ? 'pending' : 'verified', reason === 'unsupported surface' ? ['web', 'headless'] : ['desktop'])
    const { dir } = await desktopFixture(options, '0.2.0-rc.2', reason === 'runtime mismatch' ? '0.2.1-alpha.2' : '0.2.0-rc.2'), prior = await readFile(join(dir, 'package.json'), 'utf8')
    await expect(installProduct(options)).rejects.toThrow(reason === 'runtime mismatch' ? 'does not match its installed CLI' : 'unsupported DSH')
    expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe(prior)
    await expect(access(join(options.home, 'products'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(join(options.home, 'calls.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('does not infer desktop validation from a legacy CLI-only release', async () => {
    const options = await fixture(); await desktopFixture(options, '0.2.1-alpha.2')
    await expect(installProduct(options)).rejects.toThrow('no verified runtime for this surface')
    await expect(access(join(options.home, 'products'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('selects desktop by default only for an initialized macOS installation, with an explicit web opt-out', async () => {
    const options = await fixture(), { app } = await desktopFixture(options)
    const args = ['--home', options.home, '--release', options.release], environment = { platform: 'darwin', desktopApps: [app] }
    expect(installerOptions(args, environment)).toMatchObject({ desktop: true, desktopApp: app, standardProfiles: true })
    expect(installerOptions([...args, '--all'], environment)).toMatchObject({ desktop: true, standardProfiles: true })
    expect(installerOptions([...args, '--web'], environment)).toMatchObject({ desktop: false, standardProfiles: false })
    expect(installerOptions(args, { platform: 'linux', desktopApps: [app] }).desktop).toBe(false)
    expect(installerOptions(['--home', join(dirname(options.home), 'uninitialized')], environment).desktop).toBe(false)
    expect(installerOptions(['--home', options.home, '--desktop-app', app], { platform: 'linux', desktopApps: [] })).toMatchObject({ desktop: true, desktopApp: app })
  })
  it('prepares all standard macOS entry profiles and aliases through the installed carrier, retaining custom profiles unchanged', async () => {
    const fixtureOptions = await fixture(); await compatibleRelease(fixtureOptions)
    const { app } = await desktopFixture(fixtureOptions)
    const custom = join(fixtureOptions.home, 'profiles/my-custom'), web = join(fixtureOptions.home, 'profiles/web')
    await mkdir(custom, { recursive: true }); await mkdir(web, { recursive: true })
    const customManifest = '{"private":true,"userOwned":true,"dsh":{"profile":{"bundles":["my-bundle"]}}}\n'
    const webManifest = '{"private":true,"userField":"web-retained","dependencies":{"custom":"1.0.0"},"dsh":{"profile":{"bundles":["user-web-bundle"]}}}\n'
    const patch = '# user web patch\n[]\n'
    await writeFile(join(custom, 'package.json'), customManifest)
    await writeFile(join(web, 'package.json'), webManifest); await writeFile(join(web, 'cordis.patch.yml'), patch)
    const options = installerOptions(['--home', fixtureOptions.home, '--release', fixtureOptions.release, '--dsh', '/must/not/replace/the/carrier'], { platform: 'darwin', desktopApps: [app] })
    await installProduct(options)
    const calls = (await readFile(join(options.home, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(calls.map(call => call[2])).toEqual(['web', 'headless', 'codexy', 'codexy-headless', 'desktop'])
    expect(await readFile(join(custom, 'package.json'), 'utf8')).toBe(customManifest)
    expect(await readdir(custom)).toEqual(['package.json'])
    expect(await readFile(join(web, 'cordis.patch.yml'), 'utf8')).toBe(patch)
    const installedWeb = JSON.parse(await readFile(join(web, 'package.json'), 'utf8'))
    expect(installedWeb).toMatchObject({ userField: 'web-retained', dependencies: { custom: '1.0.0' } })
    expect(installedWeb.dsh.profile.bundles).toContain('user-web-bundle')
    expect(installedWeb.dsh.profile.bundles.slice(-2)).toEqual(['@codexydsh/bundle', '@codexydsh/web'])
    const installedHeadless = JSON.parse(await readFile(join(options.home, 'profiles/headless/package.json'), 'utf8'))
    expect(installedHeadless.name).toBe('dsh-profile-headless')
    expect(installedHeadless.dsh.profile.bundles.slice(-2)).toEqual(['@codexydsh/bundle', '@codexydsh/headless'])
    expect(installedHeadless.dsh.profile.bundles).not.toContain('@codexydsh/web')
  })
  it('plans the standard Web/headless entry profiles and aliases when no desktop installation is detected', async () => {
    const fixtureOptions = await fixture()
    const options = installerOptions(['--all', '--plan', '--home', fixtureOptions.home, '--release', fixtureOptions.release, '--dsh', '/does/not/exist'], { platform: 'linux', desktopApps: [] })
    expect((await installProduct(options)).map(plan => plan.profile)).toEqual(['web', 'headless', 'codexy', 'codexy-headless'])
    await expect(access(options.home)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('checks every selected standard surface before changing any initialized profile', async () => {
    const options = await fixture(); await compatibleRelease(options, 'verified', ['desktop'])
    const { dir } = await desktopFixture(options), prior = await readFile(join(dir, 'package.json'), 'utf8')
    options.standardProfiles = true
    await expect(installProduct(options)).rejects.toThrow('unsupported DSH 0.2.0-rc.2 for web/headless/desktop')
    expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe(prior)
    await expect(access(join(options.home, 'profiles/web'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(join(options.home, 'products'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it.each([
    [{ version: '>=0.2.0', status: 'verified', surfaces: ['desktop'] }],
    [{ version: '0.2.0-rc.2', status: 'unverified', surfaces: ['desktop'] }],
    [{ version: '0.2.0-rc.2', status: 'verified', surfaces: ['unknown'] }],
    [{ version: '0.2.0-rc.2', status: 'verified', surfaces: ['desktop'] }, { version: '0.2.0-rc.2', status: 'verified', surfaces: ['web'] }],
  ].map(compatibility => [compatibility]))('rejects invalid compatibility metadata before any mutation: %j', async compatibility => {
    const options = await fixture(), path = join(options.release, 'release.json'), release = JSON.parse(await readFile(path, 'utf8'))
    release.platform.compatibility = compatibility
    await writeFile(path, JSON.stringify(release))
    await expect(installProduct(options)).rejects.toThrow('invalid release compatibility matrix')
    await expect(access(options.home)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('validates unsupported installer arguments before work starts', () => {
    expect(() => installerOptions(['--unknown'])).toThrow('unknown installer option')
    expect(() => installerOptions(['--home', '--desktop'])).toThrow('requires a value')
    expect(() => installerOptions(['--web', '--desktop'])).toThrow('mutually exclusive')
    expect(() => installerOptions(['--all', '--desktop'])).toThrow('mutually exclusive')
    expect(() => installerOptions(['--desktop-app', '/some/app', '--web'])).toThrow('mutually exclusive')
  })
})
