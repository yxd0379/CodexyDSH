/** The real packed Web profile survives local Remote forwarding lifetimes. */
import { createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { sshFixture, refusesConnections } from '../packages/remote/tests/ssh-fixture.ts'
import type * as Transport from '../packages/remote/src/transport.ts'

const profileHome = process.env.CODEXY_PACKED_PROFILE_HOME
const executable = process.env.CODEXY_PACKED_DSH

it.skipIf(profileHome === undefined || executable === undefined)('boots the installed product, authenticates its tunnel, reconnects, and preserves remote work', async () => {
  if (profileHome === undefined || executable === undefined) throw new Error('packed profile inputs are required')
  const transport: typeof Transport = await import(pathToFileURL(resolve('packages/remote/lib/transport.js')).href)
  const ssh = await sshFixture({ env: { DSH_HOME: profileHome } })
  const target = { host: 'packed-fixture', profile: 'codexy', directory: ssh.root, node: process.execPath, dsh: executable }
  const recordRoot = join(profileHome, 'remote-hosts', createHash('sha256').update(JSON.stringify(target)).digest('hex'))
  const options = { ssh: ssh.executable, connectTimeoutMs: 15000, startupTimeoutMs: 60000, stopTimeoutMs: 5000,
    maxOutputBytes: 65536, serverAliveSeconds: 10, serverAliveCount: 3, readinessPollMs: 25 }
  const signal = new AbortController().signal
  let tunnel: Transport.Tunnel | undefined
  try {
    const remote = await transport.launchRemote(target, options, signal)
    const record: { pid: number; url: string } = JSON.parse(await readFile(join(recordRoot, 'launch.json'), 'utf8'))
    expect(record.url).toBe(remote.href)
    expect(await readFile(join(recordRoot, 'output.log'), 'utf8')).not.toContain('entry did not activate')
    tunnel = await transport.openTunnel(target, remote, options, signal)
    const authorized = await fetch(tunnel.url, { redirect: 'manual' })
    expect(authorized.status).toBe(303)
    const cookie = authorized.headers.get('set-cookie')
    expect(cookie).toContain('HttpOnly')
    if (cookie === null) throw new Error('packed Remote did not issue its authentication cookie')
    const authenticated = await fetch(new URL('/', tunnel.url), { headers: { Cookie: cookie.split(';')[0] ?? '' } })
    expect(authenticated.ok).toBe(true)
    expect(await authenticated.text()).toMatch(/<!doctype html>/i)
    const port = Number(new URL(tunnel.url).port)
    await tunnel.close()
    expect(await refusesConnections(port)).toBe(true)
    expect((await fetch(remote.href, { redirect: 'manual' })).status).toBe(303)
    expect((await transport.launchRemote(target, options, signal)).href).toBe(remote.href)
    expect(JSON.parse(await readFile(join(recordRoot, 'launch.json'), 'utf8'))).toMatchObject({ pid: record.pid })
    expect(await ssh.calls()).toHaveLength(3)
  } finally {
    await tunnel?.close()
    try {
      const record: { pid: number } = JSON.parse(await readFile(join(recordRoot, 'launch.json'), 'utf8'))
      process.kill(record.pid, 'SIGINT')
      const deadline = Date.now() + 10000
      for (;;) {
        try { process.kill(record.pid, 0) }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') break; throw error }
        if (Date.now() >= deadline) throw new Error('owned packed Remote process did not stop')
        await delay(25)
      }
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
    await ssh.close()
    await rm(recordRoot, { recursive: true, force: true })
  }
}, 90000)
