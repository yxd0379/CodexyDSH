/** Transparent embedding transport retains the released Connection's browser trust boundary. */
import { createServer, request, type IncomingHttpHeaders } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Socket } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import { describe, expect, it, onTestFinished } from 'vitest'
import { openTunnel, type Tunnel, type TransportOptions } from '../src/transport.ts'
import { sshFixture } from './ssh-fixture.ts'

const limits: Omit<TransportOptions, 'ssh'> = {
  connectTimeoutMs: 10_000, startupTimeoutMs: 15_000, stopTimeoutMs: 1000,
  maxOutputBytes: 65_536, serverAliveSeconds: 10, serverAliveCount: 3, readinessPollMs: 10,
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'codexy-remote-browser-'))
  const ctx = new Context()
  const sockets = new Set<Socket>()
  const httpHeaders: IncomingHttpHeaders[] = []
  const upgradeHeaders: IncomingHttpHeaders[] = []
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/api/')) {
      httpHeaders.push(req.headers)
      const admission = ctx.connection.admit(req)
      res.writeHead('rejection' in admission ? admission.rejection : 200)
      res.end('rejection' in admission ? 'refused' : 'remote session')
    } else if (ctx.connection.authorizeIndex(req, res)) {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><title>Remote runtime</title>')
    }
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => { sockets.delete(socket) })
  })
  server.on('upgrade', (req, socket) => {
    upgradeHeaders.push(req.headers)
    const admission = ctx.connection.admit(req)
    if ('rejection' in admission) {
      socket.end(`HTTP/1.1 ${String(admission.rejection)} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    } else {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
      socket.on('data', chunk => { socket.write(chunk) })
    }
  })
  let ssh: Awaited<ReturnType<typeof sshFixture>> | undefined
  let tunnel: Tunnel | undefined
  onTestFinished(async () => {
    await tunnel?.close()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    await ssh?.close()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await ctx.plugin(LocalCredentials, { dshHome: root, watch: false }).await()
  await ctx.plugin(Connection).await()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Browser fixture has no TCP listener')
  const remoteUrl = new URL(ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(address.port)}/`))
  ssh = await sshFixture({ url: remoteUrl.href })
  tunnel = await openTunnel({ host: 'example', deployment: 'existing', profile: 'codexy', directory: '', node: process.execPath, dsh: 'dsh' },
    remoteUrl, { ...limits, ssh: ssh.executable }, new AbortController().signal)
  const url = new URL(tunnel.url)
  const authenticated = await fetch(url, { redirect: 'manual' })
  expect(authenticated.status).toBe(303)
  expect(authenticated.headers.get('location')).toBe('./')
  const setCookie = authenticated.headers.get('set-cookie')
  if (setCookie === null) throw new Error('Released Connection did not mint a browser cookie')
  return { url, remoteUrl, cookie: setCookie.split(';', 1)[0] ?? '', setCookie, httpHeaders, upgradeHeaders }
}

/** Observe HTTP upgrade admission using the same headers a frame-owned WebSocket sends. */
function upgrade(url: URL, headers: Record<string, string>): Promise<{ status: number; echoed?: string }> {
  return new Promise((resolve, reject) => {
    const req = request(new URL('/api/remote.mux', url), {
      headers: { connection: 'Upgrade', upgrade: 'websocket', ...headers },
    })
    req.once('error', reject)
    req.once('response', res => { res.resume(); resolve({ status: res.statusCode ?? 0 }) })
    req.once('upgrade', (res, socket) => {
      socket.once('error', reject)
      socket.once('data', chunk => { socket.destroy(); resolve({ status: res.statusCode ?? 0, echoed: chunk.toString() }) })
      socket.write('frame-owned stream')
    })
    req.end()
  })
}

describe.skipIf(process.platform === 'win32')('Embedded remote browser transport', () => {
  it('exchanges the launch token for a strict cookie bound to the tunnel authority', async () => {
    const f = await fixture()
    expect(f.url.origin).not.toBe(f.remoteUrl.origin)
    expect(f.url.hash).toBe('#codexy-remote=example')
    expect(f.setCookie).toContain('HttpOnly; SameSite=Strict')
    expect(f.setCookie).toContain('Path=/')
    const clean = new URL('/', f.url)
    expect((await fetch(clean)).status).toBe(401)
    expect((await fetch(clean, { headers: { cookie: f.cookie } })).status).toBe(200)
    expect((await fetch(new URL('/', f.remoteUrl), { headers: { cookie: f.cookie } })).status).toBe(401)
    const api = new URL('/api/session', f.url)
    const headers = { cookie: f.cookie, origin: f.url.origin, 'sec-fetch-site': 'same-origin' }
    expect((await fetch(api, { method: 'POST', headers })).status).toBe(200)
    expect(f.httpHeaders.at(-1)).toMatchObject({ host: f.url.host, ...headers })
    expect((await fetch(api, { method: 'POST', headers: { ...headers, origin: f.remoteUrl.origin } })).status).toBe(403)
    expect((await fetch(api, { method: 'POST', headers: { ...headers, 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    expect((await fetch(api, { method: 'POST', headers: { origin: f.url.origin } })).status).toBe(401)
  })

  it('passes frame-owned WebSocket headers and bytes while retaining authentication and Origin refusal', async () => {
    const f = await fixture()
    const headers = { cookie: f.cookie, origin: f.url.origin, 'sec-fetch-site': 'same-origin' }
    expect(await upgrade(f.url, headers)).toEqual({ status: 101, echoed: 'frame-owned stream' })
    expect(f.upgradeHeaders.at(-1)).toMatchObject({ host: f.url.host, ...headers })
    expect(await upgrade(f.url, { origin: f.url.origin })).toEqual({ status: 401 })
    expect(await upgrade(f.url, { ...headers, origin: 'https://untrusted.example' })).toEqual({ status: 403 })
    expect(await upgrade(f.url, { ...headers, 'sec-fetch-site': 'cross-site' })).toEqual({ status: 403 })
  })
})
