/** Managed deployment transports only verified release files through bounded, owned SSH children. */
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { discoverDeploymentRelease } from '../src/deployment-release.ts'
import { launchRemote, type TransportOptions } from '../src/transport.ts'
import type { RemoteHostConfig } from '../src/types.ts'
import { sshFixture } from './ssh-fixture.ts'

vi.mock('../src/deployment-release.ts', () => ({ discoverDeploymentRelease: vi.fn() }))

const limits: Omit<TransportOptions, 'ssh'> = {
  connectTimeoutMs: 5000, startupTimeoutMs: 5000, deployTimeoutMs: 5000, stopTimeoutMs: 500,
  maxOutputBytes: 65_536, serverAliveSeconds: 10, serverAliveCount: 3, readinessPollMs: 10,
}
const target: RemoteHostConfig = { host: 'example', profile: 'codexy', directory: '', node: 'node', dsh: 'dsh' }
const url = 'http://127.0.0.1:12345/?token=remote-secret'
const ready = `DSH_REMOTE_READY ${JSON.stringify({ url })}\n`

function provision(installed: boolean, os = 'Linux', arch = 'aarch64'): string {
  return `DSH_REMOTE_PROVISION\nos=${os}\narch=${arch}\nlibc=glibc 2.36\ninstalled=${installed ? '1' : '0'}\nnode=/home/remote/.dsh/runtime/node/bin/node\ndsh=/home/remote/.dsh/runtime/launch-dsh\nprofile=codexy\nDSH_REMOTE_PROVISION_END\n`
}

async function release(bytes: Uint8Array = Buffer.from('verified product package')) {
  const directory = await mkdtemp(join(tmpdir(), 'codexy-remote-release-test-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const file = 'product.tgz'
  await writeFile(join(directory, file), bytes)
  // An unrelated local file must never enter the upload.
  await writeFile(join(directory, 'private.txt'), 'local credential')
  vi.mocked(discoverDeploymentRelease).mockResolvedValue({ key: 'a'.repeat(64), directory, platformVersion: '0.2.1-alpha.2',
    manifest: { format: 1, platform: { package: '@deepseek-ai/dsh', version: '0.2.1-alpha.2' }, packages: [], deploymentFiles: [] },
    files: [{ file, path: join(directory, file), sha256: createHash('sha256').update(bytes).digest('hex') }],
  })
}

async function fixture(responses: Parameters<typeof sshFixture>[0] = {}) {
  const ssh = await sshFixture(responses)
  onTestFinished(() => ssh.close())
  return { ssh, options: { ...limits, ssh: ssh.executable } }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false; throw error }
}

describe.skipIf(process.platform === 'win32')('Automatic remote SSH deployment', () => {
  it('uploads only verified release files through stdin, then launches the installed runtime', async () => {
    await release()
    const { ssh, options } = await fixture({ responses: [
      { output: provision(false) }, { input: true, output: provision(true) }, { output: ready },
    ] })
    expect((await launchRemote(target, options, new AbortController().signal)).href).toBe(url)
    const calls = await ssh.calls()
    expect(calls).toHaveLength(3)
    const archive = await readFile(join(ssh.root, 'upload-1.tar.gz'))
    expect(execFileSync('tar', ['-tzf', '-'], { input: archive, encoding: 'utf8' }).trim().split('\n')).toEqual(['product.tgz'])
    expect(calls[1]?.at(-1)).toContain(createHash('sha256').update(archive).digest('hex'))
    expect(calls[2]?.at(-1)).toContain("'/home/remote/.dsh/runtime/node/bin/node'")
    expect(calls[2]?.at(-1)).toContain('/home/remote/.dsh/runtime/launch-dsh')
    for (const args of calls) {
      expect(args).toContain('BatchMode=yes')
      expect(args).toContain('StrictHostKeyChecking=yes')
      expect(args).toContain('ForwardAgent=no')
      expect(args).toContain('ClearAllForwardings=yes')
    }
  })

  it('rediscovers an installed release without uploading it again', async () => {
    await release()
    const { ssh, options } = await fixture({ responses: [{ output: provision(true) }, { output: ready }] })
    expect((await launchRemote({ ...target, deployment: 'auto' }, options, new AbortController().signal)).href).toBe(url)
    expect(await ssh.calls()).toHaveLength(2)
    await expect(readFile(join(ssh.root, 'upload-1.tar.gz'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('leaves explicit existing Node, dsh, and profile configuration intact', async () => {
    vi.mocked(discoverDeploymentRelease).mockClear()
    const { ssh, options } = await fixture({ url })
    const spec = { ...target, deployment: 'existing' as const, node: '/custom path/node', dsh: '/custom path/dsh', profile: 'custom' }
    await launchRemote(spec, options, new AbortController().signal)
    expect(discoverDeploymentRelease).not.toHaveBeenCalled()
    const calls = await ssh.calls()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.at(-1)).toContain("'/custom path/node'")
    expect(calls[0]?.at(-1)).toContain('/custom path/dsh')
    expect(calls[0]?.at(-1)).toContain('custom')
  })

  it.each([['Darwin', 'arm64'], ['Linux', 'x86_64']])('refuses unsupported %s/%s before uploading or launching', async (os, arch) => {
    await release()
    const { ssh, options } = await fixture({ responses: [{ output: provision(false, os, arch) }] })
    await expect(launchRemote(target, options, new AbortController().signal)).rejects.toThrow(/Linux|ARM64|aarch64|unsupported/iu)
    expect(await ssh.calls()).toHaveLength(1)
  })

  it('joins cancellation of a blocked stdin upload and releases its SSH process', async () => {
    await release(randomBytes(2 * 1024 * 1024))
    const { ssh, options } = await fixture({ responses: [{ output: provision(false) }, { pending: true }] })
    const controller = new AbortController()
    const launched = launchRemote(target, options, controller.signal)
    const rejected = expect(launched).rejects.toThrow('cancel upload')
    let pid = 0
    await vi.waitFor(async () => { pid = Number(await readFile(join(ssh.root, 'pending'), 'utf8')); expect(pid).toBeGreaterThan(0) })
    controller.abort(new Error('cancel upload'))
    await rejected
    expect(alive(pid)).toBe(false)
    expect(await ssh.calls()).toHaveLength(2)
  })

  it('enforces the deployment deadline and redacts failed upload diagnostics', async () => {
    await release()
    const timed = await fixture({ responses: [{ pending: true }] })
    await expect(launchRemote(target, { ...timed.options, deployTimeoutMs: 1000 }, new AbortController().signal)).rejects.toThrow(/timeout/iu)
    const pid = Number(await readFile(join(timed.ssh.root, 'pending'), 'utf8'))
    expect(alive(pid)).toBe(false)
    const failed = await fixture({ responses: [{ output: provision(false) },
      { input: true, error: 'Install failed http://127.0.0.1:1/?token=private-token', code: 1 }] })
    await expect(launchRemote(target, failed.options, new AbortController().signal)).rejects.toThrow('token=[redacted]')
    expect(await failed.ssh.calls()).toHaveLength(2)
  })
})
