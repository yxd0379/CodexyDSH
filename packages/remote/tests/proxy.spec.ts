/** Exercise the embedding proxy over real HTTP and WebSocket admission boundaries. */
import { request, type IncomingHttpHeaders } from 'node:http'
import type { Socket } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { expect, it, onTestFinished, vi } from 'vitest'
import { EmbeddedRemoteProxy, embeddedRemotePath } from '../src/proxy.ts'

async function host() {
  const ctx = new Context()
  // Keep only credential persistence in memory; the released Connection owns all auth logic.
  const records = new Map<string, CredentialRecord>()
  ctx.provide('credentials', { async modifyRecord(key: string, mutate: (record: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
    const value = await mutate(records.get(key))
    if (value !== undefined) records.set(key, value)
    return records.get(key)
  } } as never)
  await ctx.plugin(Connection).await()
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
  onTestFinished(() => ctx.fiber.dispose())
  const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
  ctx.webServer.register({ kind: 'exact', path: '/', handler(req, res) {
    if (ctx.connection.authorizeIndex(req, res)) { res.writeHead(200); res.end('host') }
  } })
  const launch = ctx.connection.authenticatedUrl(`${origin}/`)
  const login = await fetch(launch, { redirect: 'manual' })
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0]
  if (login.status !== 303 || cookie === undefined) throw new Error('Fixture authentication did not mint a cookie')
  return { ctx, origin, cookie, launch }
}

async function fixture() {
  const remote = await host()
  const local = await host()
  const httpHeaders: IncomingHttpHeaders[] = []
  const upgradeHeaders: IncomingHttpHeaders[] = []
  const sockets = new Set<Socket>()
  onTestFinished(() => { for (const socket of sockets) socket.destroy() })
  remote.ctx.webServer.register({ kind: 'prefix', path: '/api-test', handler(req, res) {
    httpHeaders.push(req.headers)
    const admission = remote.ctx.connection.requestRejection(req)
    if (admission !== undefined) { res.writeHead(admission); res.end(); return }
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'remote-only=private; HttpOnly; SameSite=Strict' })
    res.end(JSON.stringify({ url: req.url }))
  } })
  remote.ctx.webServer.register({ kind: 'exact', path: '/index.html', handler(req, res) {
    httpHeaders.push(req.headers)
    const admission = remote.ctx.connection.requestRejection(req)
    if (admission !== undefined) { res.writeHead(admission); res.end(); return }
    res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'remote-only=private; HttpOnly; SameSite=Strict' })
    res.end('<!doctype html><head><base href="./"><script>remoteBootstrap()</script><script src="./plugins/remote.js"></script></head><body>remote project</body>')
  } })
  remote.ctx.webServer.register({ kind: 'prefix', path: '/redirect', handler(req, res) {
    res.writeHead(302, { location: req.url === '/redirect/away' ? 'https://unowned.example/' : `${remote.origin}/api-test/read?token=hidden&keep=yes` })
    res.end()
  } })
  remote.ctx.webServer.registerUpgrade({ path: '/api/remote.mux', handler(req, socket, head) {
    upgradeHeaders.push(req.headers)
    const admission = remote.ctx.connection.requestRejection(req)
    if (admission !== undefined) { socket.end(`HTTP/1.1 ${String(admission)} Refused\r\nContent-Length: 0\r\n\r\n`); return }
    const tracked = socket as Socket
    sockets.add(tracked); socket.once('close', () => { sockets.delete(tracked) })
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSet-Cookie: remote-only=private\r\n\r\n')
    if (head.length) socket.write(head)
    socket.on('data', data => { socket.write(data) })
  } })
  const tunnels = new Map([['dev', remote.launch]])
  const proxy = new EmbeddedRemoteProxy(local.ctx, name => tunnels.get(name))
  proxy.update(['dev', 'disconnected'])
  const prefix = embeddedRemotePath('dev')
  const headers = { cookie: local.cookie, origin: local.origin, 'sec-fetch-site': 'same-origin' }
  return { remote, local, proxy, tunnels, prefix, headers, httpHeaders, upgradeHeaders }
}

function upgrade(url: string, headers: Record<string, string>): Promise<{ status: number; echoed?: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const pending = request(url, { headers: { connection: 'Upgrade', upgrade: 'websocket', ...headers } })
    pending.once('error', reject)
    pending.setTimeout(3000, () => { pending.destroy(new Error('Upgrade fixture timed out')) })
    pending.once('response', response => { response.resume(); resolve({ status: response.statusCode ?? 0, headers: response.headers }) })
    pending.once('upgrade', (response, socket) => {
      socket.once('error', reject)
      socket.once('data', data => { socket.destroy(); resolve({ status: response.statusCode ?? 0, headers: response.headers, echoed: data.toString() }) })
      socket.write('remote stream bytes')
    })
    pending.end()
  })
}

it('requires local operator admission and keeps upstream authentication private while forwarding HTTP', async () => {
  const f = await fixture()
  const url = `${f.local.origin}${f.prefix}api-test/read?token=discard&keep=yes`
  expect((await fetch(url)).status).toBe(401)
  expect((await fetch(url, { headers: { ...f.headers, origin: 'https://unowned.example' } })).status).toBe(403)
  expect((await fetch(url, { headers: { ...f.headers, 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
  expect(f.httpHeaders).toHaveLength(0)
  const response = await fetch(url, { headers: { ...f.headers, authorization: 'Bearer local-only-secret',
    'proxy-authorization': 'Basic local-proxy-secret', referer: 'https://private.local/secret', 'x-forwarded-for': 'unowned' } })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ url: '/api-test/read?keep=yes' })
  expect(response.headers.get('set-cookie')).toBeNull()
  expect(response.headers.get('cache-control')).toBe('no-store')
  const upstream = f.httpHeaders.at(-1)
  expect(upstream).toMatchObject({ host: new URL(f.remote.origin).host, origin: f.remote.origin, 'sec-fetch-site': 'same-origin' })
  expect(upstream?.cookie).not.toBe(f.local.cookie)
  expect(upstream?.cookie?.split('=', 1)[0]).toBe(f.remote.cookie.split('=', 1)[0])
  expect(f.remote.ctx.connection.requestRejection({ headers: upstream ?? {} })).toBeUndefined()
  expect(upstream?.referer).toBeUndefined()
  expect(upstream?.authorization).toBeUndefined()
  expect(upstream?.['proxy-authorization']).toBeUndefined()
  expect(upstream?.['x-forwarded-for']).toBeUndefined()
})

it('serves remote HTML and redirects under the local prefix without exposing launch tokens or remote cookies', async () => {
  const f = await fixture()
  const page = await fetch(`${f.local.origin}${f.prefix}index.html`, { headers: f.headers })
  expect(page.status).toBe(200)
  const html = await page.text()
  expect(html).toContain(`streamBaseUrl:"${f.local.origin}${f.prefix}"`)
  expect(html.indexOf('streamBaseUrl')).toBeLessThan(html.indexOf('remoteBootstrap()'))
  expect(html).toContain('<base href="./">')
  expect(html).toContain('src="./plugins/remote.js"')
  expect(html).not.toContain(new URL(f.remote.launch).searchParams.get('token'))
  expect(page.headers.get('set-cookie')).toBeNull()
  const head = await fetch(`${f.local.origin}${f.prefix}index.html`, { method: 'HEAD', headers: f.headers })
  expect(head.status).toBe(200)
  expect(await head.text()).toBe('')
  expect(head.headers.get('set-cookie')).toBeNull()
  const redirect = await fetch(`${f.local.origin}${f.prefix}redirect/owned`, { headers: f.headers, redirect: 'manual' })
  expect(redirect.headers.get('location')).toBe(`${f.prefix}api-test/read?keep=yes`)
  const refused = await fetch(`${f.local.origin}${f.prefix}redirect/away`, { headers: f.headers, redirect: 'manual' })
  expect(refused.status).toBe(502)
  const missing = await fetch(`${f.local.origin}${embeddedRemotePath('disconnected')}`, { headers: f.headers })
  expect(missing.status).toBe(503)
  f.tunnels.delete('dev'); f.proxy.invalidate('dev')
  expect((await fetch(`${f.local.origin}${f.prefix}api-test/read`, { headers: f.headers })).status).toBe(503)
})

it('authenticates WebSocket upgrades locally, rewrites upstream authority, and forwards bytes', async () => {
  const f = await fixture()
  const url = `${f.local.origin}${f.prefix}api/remote.mux`
  expect((await upgrade(url, { origin: f.local.origin })).status).toBe(401)
  expect((await upgrade(url, { ...f.headers, origin: 'https://unowned.example' })).status).toBe(403)
  expect(f.upgradeHeaders).toHaveLength(0)
  const accepted = await upgrade(url, f.headers)
  expect(accepted.status).toBe(101)
  expect(accepted.echoed).toBe('remote stream bytes')
  expect(accepted.headers['set-cookie']).toBeUndefined()
  const upstream = f.upgradeHeaders.at(-1)
  expect(upstream).toMatchObject({ host: new URL(f.remote.origin).host, origin: f.remote.origin })
  expect(upstream?.cookie).not.toBe(f.local.cookie)
  expect(f.remote.ctx.connection.requestRejection({ headers: upstream ?? {} })).toBeUndefined()
  f.tunnels.delete('dev')
  expect((await upgrade(url, f.headers)).status).toBe(503)
})

it('allows uploads beyond the response deadline and still times out missing headers after upload completion', async () => {
  const f = await fixture()
  // Establish private upstream authentication before advancing the response clock.
  const primed = await fetch(`${f.local.origin}${f.prefix}api-test/read`, { headers: f.headers })
  expect(primed.status).toBe(200)
  await primed.arrayBuffer()
  const firstChunk = Promise.withResolvers<void>()
  const stalledUpload = Promise.withResolvers<void>()
  f.remote.ctx.webServer.register({ kind: 'prefix', path: '/upload', async handler(req, res) {
    const admission = f.remote.ctx.connection.requestRejection(req)
    if (admission !== undefined) { res.writeHead(admission); res.end(); return }
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk as Uint8Array))
      firstChunk.resolve()
    }
    if (req.url === '/upload/stalled') { stalledUpload.resolve(); return }
    res.writeHead(200)
    res.end(Buffer.concat(chunks))
  } })
  const uploading = (path: string) => {
    const response = Promise.withResolvers<{ status: number; body: string }>()
    const pending = request(`${f.local.origin}${f.prefix}upload/${path}`, { method: 'POST', headers: f.headers }, incoming => {
      const chunks: Buffer[] = []
      incoming.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      incoming.once('error', response.reject)
      incoming.once('end', () => { response.resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString() }) })
    })
    pending.once('error', response.reject)
    return { pending, response: response.promise }
  }
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const slow = uploading('slow')
    slow.pending.write('first chunk; ')
    await firstChunk.promise
    await vi.advanceTimersByTimeAsync(25_000)
    slow.pending.end('final chunk')
    expect(await slow.response).toEqual({ status: 200, body: 'first chunk; final chunk' })

    const stalled = uploading('stalled')
    stalled.pending.end('complete upload')
    await stalledUpload.promise
    await vi.advanceTimersByTimeAsync(20_001)
    expect(await stalled.response).toEqual({ status: 502, body: 'Remote host is unavailable' })
  } finally { vi.useRealTimers() }
})

it('preserves exact module combo queries and redirect queries while removing launch tokens', async () => {
  const f = await fixture()
  const combo = '/plugins/??@deepseek-ai/dsh-client-modules/client.js,@codexydsh/remote/client.js&rev=build-1'
  const script = 'window.__ModuleLoader__.load({id:"@deepseek-ai/dsh-client-modules",factory(){}})'
  const requested: string[] = []
  f.remote.ctx.webServer.register({ kind: 'prefix', path: '/plugins', handler(req, res) {
    requested.push(req.url ?? '')
    res.writeHead(req.url === combo ? 200 : 404, { 'content-type': 'application/javascript' })
    res.end(req.url === combo ? script : 'Unknown module combo')
  } })
  f.remote.ctx.webServer.register({ kind: 'prefix', path: '/combo-redirect', handler(req, res) {
    res.writeHead(302, { location: req.url === '/combo-redirect/clean' ? combo : `${combo}&token=private-launch` }); res.end()
  } })
  for (const suffix of ['', '&token=private-launch', '&%74oken=encoded-launch&token=second-launch']) {
    const response = await fetch(`${f.local.origin}${f.prefix.slice(0, -1)}${combo}${suffix}`, { headers: f.headers })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(script)
    expect(requested.at(-1)).toBe(combo)
  }
  for (const path of ['clean', 'token']) {
    const redirect = await fetch(`${f.local.origin}${f.prefix}combo-redirect/${path}`, { headers: f.headers, redirect: 'manual' })
    expect(redirect.status).toBe(302)
    expect(redirect.headers.get('location')).toBe(f.prefix.slice(0, -1) + combo)
  }
})
