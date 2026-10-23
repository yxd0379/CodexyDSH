import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildRemoteBootstrapCommand, remoteBootstrap } from '../src/bootstrap.ts'
import { discoverServerArchive, resolveServerArchive } from '../src/deployment-release.ts'
import { buildProvisionInstall, buildProvisionProbe, parseProvisionProbe } from '../src/provision.ts'
import { remoteNetworkEnvironment } from '../src/network.ts'

const temporary: string[] = []
afterEach(async () => { for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true }) })

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'codexy-remote-test-'))
  temporary.push(path)
  return path
}

describe('standalone Remote provisioning', () => {
  it('selects the bundled server archive unless an absolute override is supplied', () => {
    expect(resolveServerArchive('', '/product/remote/lib')).toBe('/product/remote/server/linux-arm64.tar.gz')
    expect(resolveServerArchive('/build/server.tar.gz', '/product/remote/lib')).toBe('/build/server.tar.gz')
    expect(() => resolveServerArchive('relative.tar.gz', '/product/remote/lib')).toThrow('absolute path')
  })
  it('identifies the exact local archive without unpacking or modifying it', async () => {
    const root = await directory()
    const path = join(root, 'server.tar.gz')
    const bytes = Buffer.from('archive bytes')
    await writeFile(path, bytes)
    expect(await discoverServerArchive(path)).toEqual({ path, key: createHash('sha256').update(bytes).digest('hex') })
    expect(await readFile(path)).toEqual(bytes)
    await expect(discoverServerArchive('')).rejects.toThrow('absolute serverArchive path')
  })

  it('quotes an independent home and produces valid POSIX probe and installation programs', () => {
    const home = "/mnt/user's files/codexydsh"
    for (const command of [buildProvisionProbe('a'.repeat(64), 'web', home), buildProvisionInstall({ releaseId: 'a'.repeat(64), profile: 'web', home })]) {
      expect(spawnSync('/bin/sh', ['-n', '-c', command], { encoding: 'utf8' }).status).toBe(0)
      expect(command).not.toContain('npm install')
      expect(command).not.toContain('/.dsh')
    }
  })

  it('rejects unsupported machines before writing an installation home', async () => {
    if (process.platform === 'linux' && process.arch === 'arm64') return
    const home = join(await directory(), 'untouched')
    const result = spawnSync('/bin/sh', ['-c', buildProvisionInstall({ releaseId: 'b'.repeat(64), profile: 'web', home })], { encoding: 'utf8' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Linux ARM64 only')
    await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reads a completed cache record while ignoring unrelated shell output', () => {
    expect(parseProvisionProbe('shell banner\nCODEXY_REMOTE_PROVISION\ninstalled=1\nnode=/home/me/runtime/node/bin/node\ndsh=/home/me/runtime/bin/codexydsh\nhome=/home/me/.codexydsh\nCODEXY_REMOTE_PROVISION_END\n')).toEqual({
      installed: true, node: '/home/me/runtime/node/bin/node', dsh: '/home/me/runtime/bin/codexydsh', home: '/home/me/.codexydsh',
    })
    expect(() => parseProvisionProbe('still installing')).toThrow('did not report')
  })

  it('installs one archive and reuses its completed cache even when a later upload contains no archive', async () => {
    const root = await directory()
    const tools = join(root, 'tools')
    const source = join(root, 'source')
    await Promise.all(['node/bin', 'bin', 'dsh/lib'].map(path => mkdir(join(source, path), { recursive: true })))
    await mkdir(tools)
    await writeFile(join(tools, 'uname'), '#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo aarch64;; esac\n', { mode: 0o700 })
    await writeFile(join(tools, 'getconf'), '#!/bin/sh\necho "glibc 2.35"\n', { mode: 0o700 })
    // Cache ownership is tested here; Linux supplies the actual flock implementation.
    await writeFile(join(tools, 'flock'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    await writeFile(join(tools, 'sha256sum'), '#!/bin/sh\nexec /usr/bin/shasum -a 256 "$@"\n', { mode: 0o700 })
    await writeFile(join(source, 'node/bin/node'), '#!/bin/sh\necho v22.22.3\n', { mode: 0o700 })
    await writeFile(join(source, 'bin/codexydsh'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    await writeFile(join(source, 'dsh/lib/bin.js'), '// isolated archive fixture\n')
    const archive = join(root, 'server.tar.gz')
    expect(spawnSync('tar', ['-czf', archive, '-C', source, 'node', 'bin', 'dsh']).status).toBe(0)
    const bytes = await readFile(archive)
    const digest = createHash('sha256').update(bytes).digest('hex')
    const home = join(root, "independent user's home")
    const env = { ...process.env, PATH: tools + ':' + process.env.PATH }
    const command = buildProvisionInstall({ releaseId: digest, profile: 'web', home })
    const first = spawnSync('/bin/sh', ['-c', command], { env, input: bytes, encoding: 'utf8' })
    expect(first.stderr).toBe('')
    expect(first.status).toBe(0)
    const installed = parseProvisionProbe(first.stdout)
    expect(installed.installed).toBe(true)
    expect(installed.home).toBe(home)
    const second = spawnSync('/bin/sh', ['-c', command], { env, input: 'no archive needed', encoding: 'utf8' })
    expect(second.status).toBe(0)
    expect(parseProvisionProbe(second.stdout)).toEqual(installed)
    const probed = spawnSync('/bin/sh', ['-c', buildProvisionProbe(digest, 'web', home)], { env, encoding: 'utf8' })
    expect(parseProvisionProbe(probed.stdout)).toEqual(installed)
  })

  it('keeps the detached bootstrap parseable after standalone entry adaptation', () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: remoteBootstrap, encoding: 'utf8' })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  it('serializes launches with a stable kernel lock and leaves legacy PID locks untouched', () => {
    const command = buildRemoteBootstrapCommand({
      target: { host: 'ascend', profile: 'web', directory: '', node: '/runtime/node/bin/node', dsh: '/runtime/bin/codexydsh', home: "/mnt/user's files/codexydsh" },
      networkEnv: {}, timeoutMs: 60_000, maxOutputBytes: 65_536, readinessPollMs: 100, probeTimeoutMs: 20_000,
    })
    expect(spawnSync('/bin/sh', ['-n', '-c', command], { encoding: 'utf8' }).status).toBe(0)
    expect(command).toContain('exec flock -F -w 60 "$root/launch.flock"')
    expect(command).not.toContain('launch.lock')
  })

  it('sets proxy policy on the remote Host and always bypasses its loopback API', () => {
    const host = { host: 'ascend', profile: 'web', directory: '', node: 'node', dsh: 'codexydsh' }
    expect(remoteNetworkEnvironment(host)).toEqual({})
    expect(remoteNetworkEnvironment({ ...host, proxyMode: 'custom', proxyUrl: 'http://127.0.0.1:7890' })).toMatchObject({ HTTP_PROXY: 'http://127.0.0.1:7890/', NO_PROXY: 'localhost,127.0.0.1,::1,[::1]' })
    expect(remoteNetworkEnvironment({ ...host, proxyMode: 'direct' })).toMatchObject({ HTTP_PROXY: '', HTTPS_PROXY: '', NO_PROXY: '*' })
  })
})
