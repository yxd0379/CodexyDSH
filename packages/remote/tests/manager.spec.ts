/** SSH subprocess, real bootstrap, tunnel, and manager disposal behavior. */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { updateVolatile } from '@deepseek-ai/cosmokit'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import RemoteLauncher, { type Config } from '../src/index.ts'
import { launchRemote, openTunnel, type TransportOptions } from '../src/transport.ts'
import type { RemoteHostConfig } from '../src/types.ts'
import { fakeRemoteDsh, refusesConnections, sshFixture } from './ssh-fixture.ts'

const limits: Omit<TransportOptions, 'ssh'> = {
  connectTimeoutMs: 10_000, startupTimeoutMs: 15_000, stopTimeoutMs: 1000,
  maxOutputBytes: 65_536, serverAliveSeconds: 10, serverAliveCount: 3, readinessPollMs: 10,
}
const target: RemoteHostConfig = { host: 'example', profile: 'codexy', directory: '', node: process.execPath, dsh: 'dsh' }

async function fixture(url = 'http://127.0.0.1:1/?token=example') {
  const ssh = await sshFixture({ url })
  onTestFinished(() => ssh.close())
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(TypertRegistry).await()
  const fiber = ctx.plugin(RemoteLauncher, { ...limits, ssh: ssh.executable, hosts: { example: target } })
  await fiber.await()
  const config = fiber.config as Config
  const hosts = { set(value: Record<string, RemoteHostConfig | null>) {
    updateVolatile(config.hosts, RemoteLauncher.Config({ hosts: value }).hosts)
  } }
  return { ctx, ssh, config, hosts, fiber }
}

describe.skipIf(process.platform === 'win32')('Remote SSH', () => {
  it('launches the selected profile, proxies HTTP, leaves it alive on disconnect, and rediscovers it', async () => {
    const remote = await fakeRemoteDsh()
    onTestFinished(() => remote.close())
    const ssh = await sshFixture({ env: remote.env })
    onTestFinished(() => ssh.close())
    const options = { ...limits, ssh: ssh.executable }
    const spec = { ...target, directory: remote.root, dsh: remote.executable }
    const signal = new AbortController().signal
    const url = await launchRemote(spec, options, signal)
    expect(JSON.parse(await readFile(join(remote.root, 'argv.json'), 'utf8'))).toEqual(['--profile', 'codexy', '--no-open', '--host', '127.0.0.1', '--port', '0'])
    expect(await readFile(join(remote.root, 'cwd.txt'), 'utf8')).toBe(remote.root)
    const tunnel = await openTunnel(spec, url, options, signal)
    onTestFinished(() => tunnel.close())
    expect(await (await fetch(new URL('/', tunnel.url))).text()).toBe('remote files and sessions')
    const port = Number(new URL(tunnel.url).port)
    await tunnel.close()
    expect(await refusesConnections(port)).toBe(true)
    expect(await (await fetch(new URL('/', url))).text()).toBe('remote files and sessions')
    expect((await launchRemote(spec, options, signal)).href).toBe(url.href)
    const records = await readdir(join(remote.env.DSH_HOME, 'remote-hosts'))
    expect(records).toHaveLength(1)
    expect(await readdir(join(remote.env.DSH_HOME, 'remote-hosts', records[0] ?? ''))).not.toContain('launch.lock')
    expect(await ssh.calls()).toHaveLength(3)
  })

  it('reports SSH diagnostics without exposing launch tokens and refuses unknown hosts', async () => {
    const f = await fixture()
    await expect(f.ctx.remoteLauncher.connect('missing', new AbortController().signal)).rejects.toThrow('Unknown remote host')
    f.hosts.set({ example: { ...target, host: 'unreachable' } })
    await expect(f.ctx.remoteLauncher.connect('example', new AbortController().signal)).rejects.toThrow('[redacted]')
    expect(f.ctx.remoteLauncher.list()).toMatchObject([{ phase: 'failed', url: null }])
    expect(f.ctx.remoteLauncher.list()[0]?.error).not.toContain('private-token')
    await f.ctx.remoteLauncher.disconnect('missing')
    await f.ctx.remoteLauncher.disconnect('example')
    expect(f.ctx.remoteLauncher.list()).toMatchObject([{ phase: 'disconnected' }])
  })

  it('shares one connection attempt, reports a dropped tunnel, and reconnects without restarting remote dsh', async () => {
    const remote = await fakeRemoteDsh()
    onTestFinished(() => remote.close())
    const bootstrap = await sshFixture({ env: remote.env })
    onTestFinished(() => bootstrap.close())
    const url = await launchRemote({ ...target, directory: remote.root, dsh: remote.executable },
      { ...limits, ssh: bootstrap.executable }, new AbortController().signal)
    const f = await fixture(url.href)
    const signal = new AbortController().signal
    const first = f.ctx.remoteLauncher.connect('example', signal)
    const second = f.ctx.remoteLauncher.connect('example', signal)
    const connected = await first
    expect(await second).toEqual(connected)
    expect(await f.ctx.remoteLauncher.connect('example', signal)).toEqual(connected)
    expect(await f.ssh.calls()).toHaveLength(2)
    const pid = Number(await readFile(join(f.ssh.root, 'forward'), 'utf8'))
    process.kill(pid, 'SIGTERM')
    await vi.waitFor(() => { expect(f.ctx.remoteLauncher.list()).toMatchObject([{ phase: 'failed', url: null }]) })
    expect(await refusesConnections(Number(new URL(connected.url ?? '').port))).toBe(true)
    expect(await f.ctx.remoteLauncher.connect('example', signal)).toMatchObject({ phase: 'connected' })
    await f.ctx.remoteLauncher.disconnect('example')
    expect(await fetch(new URL('/', url)).then(response => response.text())).toBe('remote files and sessions')
    expect(await bootstrap.calls()).toHaveLength(1)
  })

  it('joins pending startup cancellation, coalesces status frames, and removes observation on unload', async () => {
    const f = await fixture()
    f.hosts.set({ example: { ...target, host: 'pending' } })
    const observing = new AbortController()
    const frames = f.ctx.remoteLauncher.follow(observing.signal)[Symbol.asyncIterator]()
    expect((await frames.next()).value).toMatchObject([{ phase: 'disconnected' }])
    const connecting = f.ctx.remoteLauncher.connect('example', new AbortController().signal)
    const rejected = expect(connecting).rejects.toThrow('Remote connection closed')
    await vi.waitFor(async () => { expect(await readFile(join(f.ssh.root, 'pending'), 'utf8')).toMatch(/^\d+$/u) })
    expect((await frames.next()).value).toMatchObject([{ phase: 'connecting' }])
    await f.ctx.remoteLauncher.disconnect('example')
    await rejected
    expect((await frames.next()).value).toMatchObject([{ phase: 'disconnected' }])
    const waiting = frames.next()
    const manager = f.ctx.remoteLauncher
    await f.fiber.dispose()
    expect(await waiting).toMatchObject({ done: true })
    observing.abort()
    await expect(manager.connect('example', new AbortController().signal)).rejects.toThrow('closed')
  })

  it('rejects invalid host, profile, path, executable, and timing configuration', () => {
    for (const hosts of [
      { '-option': target }, { example: { ...target, host: '-oProxyCommand=evil' } },
      { example: { ...target, profile: 'profile name' } }, { example: { ...target, directory: 'relative' } },
      { example: { ...target, node: '' } }, { example: { ...target, dsh: 'node\ncommand' } },
    ]) expect(() => RemoteLauncher.Config({ hosts })).toThrow()
    expect(() => RemoteLauncher.Config({ connectTimeoutMs: 0 })).toThrow()
    expect(RemoteLauncher.Config({}).hosts.get()).toEqual({})
  })
})
