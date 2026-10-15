/** Exercise the real POSIX provisioning program without touching an SSH server. */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it, onTestFinished } from 'vitest'
import { buildProvisionInstall, buildProvisionProbe, parseProvisionProbe, provisionNode } from '../src/provision.ts'

const releaseId = 'a'.repeat(64)
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'codexy-provision-test-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  const bin = join(root, 'bin')
  const home = join(root, "user data's $literal")
  await mkdir(bin)
  await writeFile(join(bin, 'uname'), '#!/bin/sh\ncase "$1" in -s) printf "%s\\n" "$TEST_OS";; -m) printf "%s\\n" "$TEST_ARCH";; esac\n', { mode: 0o700 })
  await writeFile(join(bin, 'getconf'), '#!/bin/sh\nprintf "%s\\n" "$TEST_LIBC"\n', { mode: 0o700 })
  // macOS's sha256sum has a different -c interface; model GNU's Linux check format.
  await writeFile(join(bin, 'sha256sum'), `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs');
const crypto = require('node:crypto');
const line = fs.readFileSync(0, 'utf8').trimEnd();
const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
if (!match || crypto.createHash('sha256').update(fs.readFileSync(match[2])).digest('hex') !== match[1]) process.exit(1);
`, { mode: 0o700 })
  await writeFile(join(bin, 'curl'), `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs');
fs.writeFileSync(process.env.TEST_CURL_RECORD, 'called');
const args = process.argv.slice(2);
if (process.env.TEST_CURL_WAIT) {
  fs.writeFileSync(process.env.TEST_CURL_RECORD + '.pid', String(process.pid));
  process.once('SIGTERM', () => { fs.writeFileSync(process.env.TEST_CURL_RECORD + '.stopped', 'stopped'); process.exit(0); });
  setInterval(() => {}, 1000);
} else fs.writeFileSync(args[args.indexOf('--output') + 1], 'untrusted runtime bytes');
`, { mode: 0o700 })
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: root, DSH_HOME: home,
    TEST_OS: 'Linux', TEST_ARCH: 'aarch64', TEST_LIBC: 'glibc 2.38', TEST_CURL_RECORD: join(root, 'curl-called') }
  const run = (command: string, input?: Buffer, override: Record<string, string> = {}) => spawnSync('/bin/sh', ['-c', command], {
    encoding: 'utf8', input, env: { ...env, ...override }, timeout: 5000,
  })
  return { root, bin, home, env, run }
}

describe.skipIf(process.platform === 'win32')('automatic remote provisioning', () => {
  it('probes a clean ARM64 server without requiring Node or creating the data root', async () => {
    const f = await fixture()
    const result = f.run(buildProvisionProbe(releaseId, 'my_profile'))
    expect(result.status, result.stderr).toBe(0)
    expect(parseProvisionProbe(result.stdout)).toEqual({ installed: false, node: '', dsh: '', profile: 'my_profile' })
    expect((await readdir(f.root)).sort()).toEqual(['bin'])
  })

  it.each([
    [{ TEST_OS: 'Darwin' }, 'OS is unsupported'],
    [{ TEST_ARCH: 'x86_64' }, 'architecture is unsupported'],
    [{ TEST_LIBC: 'musl 1.2.5' }, 'glibc'],
    [{ TEST_LIBC: 'glibc 2.27' }, 'glibc 2.28'],
    [{ TEST_LIBC: 'glibc invalid' }, 'glibc version'],
  ])('fails before writing for an unsupported host %j', async (override, message) => {
    const f = await fixture()
    const result = f.run(buildProvisionInstall({ releaseId, sha256: 'b'.repeat(64), dshVersion: '0.2.1-alpha.2' }), Buffer.from('anything'), override)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(message)
    expect(await readdir(f.root)).toEqual(['bin'])
  })

  it('rejects a corrupted upload before download or execution and preserves existing data', async () => {
    const f = await fixture()
    const sessions = join(f.home, 'sessions')
    await mkdir(sessions, { recursive: true })
    const session = join(sessions, 'saved.jsonl')
    await writeFile(session, 'original session\n')
    const result = f.run(buildProvisionInstall({ releaseId, sha256: digest('expected'), dshVersion: '0.2.1-alpha.2' }), Buffer.from('corrupted'))
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Uploaded remote release checksum mismatch')
    expect(await readFile(session, 'utf8')).toBe('original session\n')
    expect(await readdir(f.root)).not.toContain('curl-called')
    const attempts = await readdir(join(f.home, 'products/codexy/remote-runtimes'))
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).not.toMatch(/\.ready|\.lock/u)
  })

  it('rejects unverified downloaded Node bytes before running any downloaded code', async () => {
    const f = await fixture()
    const payload = join(f.root, 'payload')
    const archive = join(f.root, 'release.tar.gz')
    await mkdir(payload)
    await writeFile(join(payload, 'release.json'), '{}')
    const tar = spawnSync('tar', ['-czf', archive, '-C', payload, 'release.json'])
    expect(tar.status, tar.stderr.toString()).toBe(0)
    const bytes = await readFile(archive)
    const result = f.run(buildProvisionInstall({ releaseId, sha256: digest(bytes), dshVersion: '0.2.1-alpha.2' }), bytes)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Downloaded Node runtime checksum mismatch')
    expect(await readFile(f.env.TEST_CURL_RECORD, 'utf8')).toBe('called')
    const attempts = await readdir(join(f.home, 'products/codexy/remote-runtimes'))
    expect(attempts).toHaveLength(1)
    expect(await readdir(join(f.home, 'products/codexy/remote-runtimes', attempts[0]!, 'node'))).toEqual([])
  })

  it('reuses a completed version and profile without changing sessions or older runtimes', async () => {
    const f = await fixture()
    const release = { format: 1, platform: { version: '0.2.1-alpha.2' }, packages: ['remote', 'bundle', 'web'].map(name => ({ name: `@codexydsh/${name}`, file: `codexydsh-${name}.tgz` })) }
    const key = digest(JSON.stringify(release))
    const identity = digest(`${key}\ncodexy\n${provisionNode.version}\n11.7.0`)
    const base = join(f.home, 'products/codexy/remote-runtimes', identity)
    const runtime = `${base}.AbCd1234`
    await mkdir(join(runtime, 'node/bin'), { recursive: true })
    await mkdir(join(runtime, 'release'))
    await writeFile(join(runtime, 'release/release.json'), JSON.stringify(release))
    for (const [name, version] of [['@deepseek-ai/dsh', release.platform.version], ['pnpm', '11.7.0']]) {
      await mkdir(join(runtime, 'lib/node_modules', name!), { recursive: true })
      await writeFile(join(runtime, 'lib/node_modules', name!, 'package.json'), JSON.stringify({ version }))
    }
    await mkdir(join(f.home, 'profiles/codexy/node_modules'), { recursive: true })
    const manifest = JSON.stringify({ user: 'preserved', dependencies: Object.fromEntries(release.packages.map(item => [item.name, 'file:' + join(f.home, 'products/codexy/releases', key, item.file)])) })
    await writeFile(join(f.home, 'profiles/codexy/package.json'), manifest)
    await writeFile(join(runtime, 'node/bin/node'), `#!/bin/sh\nif [ "$1" = --version ]; then printf '%s\\n' 'v${provisionNode.version}'; else exec '${process.execPath}' "$@"; fi\n`, { mode: 0o700 })
    await writeFile(join(runtime, 'launch-dsh'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    await writeFile(`${base}.ready`, runtime + '\n')
    const prior = await stat(`${base}.ready`)
    const result = f.run(buildProvisionInstall({ releaseId: key, sha256: 'b'.repeat(64), dshVersion: '0.2.1-alpha.2' }), Buffer.from('drained unused upload'))
    expect(result.status, result.stderr).toBe(0)
    expect(parseProvisionProbe(result.stdout)).toEqual({ installed: true, node: join(runtime, 'node/bin/node'), dsh: join(runtime, 'launch-dsh'), profile: 'codexy' })
    expect((await stat(`${base}.ready`)).mtimeMs).toBe(prior.mtimeMs)
    expect(await readFile(join(f.home, 'profiles/codexy/package.json'), 'utf8')).toBe(manifest)
    expect(await readdir(f.root)).not.toContain('curl-called')
    const other = f.run(buildProvisionProbe(key, 'another_profile'))
    expect(parseProvisionProbe(other.stdout).installed).toBe(false)
    await writeFile(join(f.home, 'profiles/codexy/package.json'), manifest.replaceAll(key, 'b'.repeat(64)))
    const stale = f.run(buildProvisionProbe(key))
    expect(parseProvisionProbe(stale.stdout).installed).toBe(false)
  })

  it('joins its own download process and releases the profile lock on cancellation', async () => {
    const f = await fixture()
    const payload = join(f.root, 'payload')
    const archive = join(f.root, 'release.tar.gz')
    await mkdir(payload)
    await writeFile(join(payload, 'release.json'), '{}')
    expect(spawnSync('tar', ['-czf', archive, '-C', payload, 'release.json']).status).toBe(0)
    const bytes = await readFile(archive)
    const child = spawn('/bin/sh', ['-c', buildProvisionInstall({ releaseId, sha256: digest(bytes), dshVersion: '0.2.1-alpha.2' })], {
      env: { ...f.env, TEST_CURL_WAIT: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
    })
    onTestFinished(() => { child.kill('SIGTERM') })
    const done = new Promise<number | null>((resolve) => { child.once('close', resolve) })
    child.stdin.end(bytes)
    let pid: number | undefined
    for (let attempt = 0; attempt < 200; attempt++) {
      try { pid = Number(await readFile(f.env.TEST_CURL_RECORD + '.pid', 'utf8')); break }
      catch { await delay(10) }
    }
    expect(pid).toBeGreaterThan(0)
    child.kill('SIGTERM')
    expect(await done).toBe(143)
    expect(await readFile(f.env.TEST_CURL_RECORD + '.stopped', 'utf8')).toBe('stopped')
    expect(() => process.kill(pid!, 0)).toThrow()
    expect((await readdir(join(f.home, 'products/codexy/remote-runtimes'))).some(name => name.endsWith('.lock'))).toBe(false)
  })

  it('rejects malformed frames, unsafe identities, and mismatched executable roots', () => {
    const output = 'DSH_REMOTE_PROVISION\nos=Linux\narch=aarch64\nlibc=glibc 2.38\ninstalled=1\nnode=/private/managed/node/bin/node\ndsh=/private/managed/launch-dsh\nprofile=codexy\nDSH_REMOTE_PROVISION_END\n'
    expect(parseProvisionProbe(output).installed).toBe(true)
    for (const value of [output.replace('aarch64', 'x86_64'), output.replace('glibc 2.38', 'glibc 2.27'), output.replace('os=Linux', 'os=Linux\nos=Linux'), output + output, output.replace('/managed/launch-dsh', '/other/launch-dsh')]) {
      expect(() => parseProvisionProbe(value)).toThrow()
    }
    expect(() => buildProvisionProbe('../unsafe')).toThrow('identity')
    expect(() => buildProvisionProbe(releaseId, 'profile; touch /tmp/bad')).toThrow('profile')
    expect(() => buildProvisionInstall({ releaseId, sha256: 'x', dshVersion: '0.2.1-alpha.2' })).toThrow('identity')
  })
})
