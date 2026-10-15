/** Same-origin browser carrier for an operator-selected, locally owned SSH tunnel. */
import { request, type IncomingMessage, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Socket } from 'node:net'
import { promisify } from 'node:util'
import { brotliDecompress, gunzip, inflate } from 'node:zlib'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
import { transformEmbeddedIndex } from './embedding.ts'

const PREFIX = '/codexy-remote'
const MUX = '/api/remote.mux'
const INDEX_LIMIT = 8 * 1024 * 1024
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

function publicHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const omitted = new Set(HOP_HEADERS)
  for (const name of headers.connection?.split(',') ?? []) omitted.add(name.trim().toLowerCase())
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !omitted.has(name) && name !== 'set-cookie'))
}

/** Prefix URL shared by browser embedding and the local HTTP WebSocket carrier. */
export function embeddedRemotePath(name: string): string { return `${PREFIX}/${encodeURIComponent(name)}/` }

function refuse(socket: Duplex, status: number): void {
  socket.end(`HTTP/1.1 ${String(status)} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

/** Remove launch credentials without reserializing exact-match combo resource queries. */
function withoutLaunchToken(search: string): string {
  if (!search) return search
  const retained = search.slice(1).split('&').filter(parameter => {
    const key = parameter.split('=', 1)[0] ?? ''
    try { return decodeURIComponent(key.replaceAll('+', ' ')) !== 'token' }
    catch { return true }
  })
  return retained.length ? '?' + retained.join('&') : ''
}

interface Upstream {
  url: URL
  cookie: Promise<string>
}

/** Authenticate locally before forwarding into a named live tunnel; browser credentials never cross hosts. */
export class EmbeddedRemoteProxy {
  private readonly upgrades = new Map<string, () => void>()
  private readonly upstreams = new Map<string, Upstream>()
  private readonly sockets = new Set<Socket>()
  private disposed = false

  /** @param ctx - Local Web carrier and browser authentication owner.
   * @param tunnel - Lookup confined to live tunnels owned by the remote launcher.
   */
  constructor(private readonly ctx: Context, private readonly tunnel: (name: string) => string | undefined) {
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler: (req, res) => this.http(req, res) }))
    ctx.effect(() => () => {
      this.disposed = true
      for (const withdraw of this.upgrades.values()) withdraw()
      this.upgrades.clear()
      this.upstreams.clear()
      for (const socket of this.sockets) socket.destroy()
    })
  }

  /** Synchronize exact upgrade routes with the saved host allowlist. */
  update(names: readonly string[]): void {
    const retained = new Set(names)
    for (const [name, withdraw] of this.upgrades) if (!retained.has(name)) {
      withdraw(); this.upgrades.delete(name); this.invalidate(name)
    }
    for (const name of names) if (!this.upgrades.has(name)) {
      this.upgrades.set(name, this.ctx.webServer.registerUpgrade({
        path: embeddedRemotePath(name).slice(0, -1) + MUX,
        handler: (req, socket, head) => this.upgrade(name, req, socket, head),
      }))
    }
  }

  /** Discard a previous tunnel's private authentication material. */
  invalidate(name: string): void { this.upstreams.delete(name) }

  private upstream(name: string): Upstream | undefined {
    const launch = this.tunnel(name)
    if (launch === undefined || this.disposed) return undefined
    let cached = this.upstreams.get(name)
    if (cached?.url.href !== launch) {
      const url = new URL(launch)
      cached = { url, cookie: this.authenticate(url) }
      this.upstreams.set(name, cached)
      // A failed exchange is retried by the next request, without retaining a rejected promise.
      const current = cached
      void cached.cookie.catch(() => { if (this.upstreams.get(name) === current) this.upstreams.delete(name) })
    }
    return cached
  }

  private track(socket: Socket): void {
    this.sockets.add(socket)
    socket.once('close', () => { this.sockets.delete(socket) })
    if (this.disposed) socket.destroy()
  }

  private authenticate(url: URL): Promise<string> {
    return new Promise((resolve, reject) => {
      const pending = request(url, { method: 'GET', headers: { 'accept-encoding': 'identity' } }, response => {
        response.resume()
        const cookies = response.headers['set-cookie']?.filter(cookie => /^dsh-auth-[A-Za-z0-9_-]+=/u.test(cookie))
        if (response.statusCode !== 303 || !cookies?.length) reject(new Error('Remote browser authentication failed'))
        else resolve(cookies.map(cookie => cookie.split(';', 1)[0]).join('; '))
      })
      pending.on('socket', socket => { this.track(socket) })
      pending.once('error', reject)
      pending.setTimeout(20_000, () => { pending.destroy(new Error('Remote browser authentication timed out')) })
      pending.end()
    })
  }

  private headers(req: IncomingMessage, upstream: Upstream, cookie: string): IncomingHttpHeaders {
    const headers = publicHeaders(req.headers)
    for (const name of Object.keys(headers)) {
      if (name === 'host' || name === 'cookie' || name === 'authorization' || name === 'origin' || name === 'referer' || name === 'forwarded'
        || name.startsWith('x-forwarded-') || name.startsWith('sec-fetch-')) delete headers[name]
    }
    return { ...headers, host: upstream.url.host, cookie, origin: upstream.url.origin,
      'sec-fetch-site': 'same-origin', 'accept-encoding': 'identity' }
  }

  private target(upstream: Upstream, path: string, query: string): URL {
    const url = new URL(upstream.url.origin)
    url.pathname = path
    url.search = withoutLaunchToken(query)
    return url
  }

  private streamBase(name: string, authority: string): string {
    const server = this.ctx.webServer
    return `${server.protocol}//${authority}${embeddedRemotePath(name)}`
  }

  private async http(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const admission = this.ctx.connection.admit(req)
    if ('rejection' in admission) { res.writeHead(admission.rejection); res.end('Remote access refused'); return }
    const source = new URL(req.url ?? '/', 'http://local.invalid')
    const match = /^\/codexy-remote\/([A-Za-z0-9_-]+)(\/.*)?$/u.exec(source.pathname)
    const name = match?.[1]
    const upstream = name === undefined ? undefined : this.upstream(name)
    if (upstream === undefined || name === undefined) { res.writeHead(503); res.end('Remote host is disconnected'); return }
    if (match?.[2] === undefined) {
      res.writeHead(308, { location: embeddedRemotePath(name) + source.search, 'cache-control': 'no-store' }); res.end(); return
    }
    const target = this.target(upstream, match[2], source.search)
    try {
      const cookie = await upstream.cookie
      if (res.destroyed) return
      await new Promise<void>((resolve, reject) => {
        let timeout: ReturnType<typeof setTimeout> | undefined
        let awaitingHeaders = true
        const stopWaiting = (): void => { awaitingHeaders = false; clearTimeout(timeout) }
        const pending = request(target, { method: req.method, headers: this.headers(req, upstream, cookie) }, response => {
          stopWaiting()
          if (response.statusCode === 401) this.invalidate(name)
          void this.respond(name, target, response, res, req.method, req.headers.host ?? '').then(resolve, reject)
        })
        pending.once('finish', () => {
          // Uploads may remain active for longer than the response-header deadline.
          if (awaitingHeaders) timeout = setTimeout(() => { pending.destroy(new Error('Remote response timed out')) }, 20_000)
        })
        pending.on('socket', socket => { this.track(socket) })
        pending.once('error', error => { stopWaiting(); reject(error) })
        res.once('close', () => { stopWaiting(); pending.destroy() })
        req.once('aborted', () => { pending.destroy() })
        req.pipe(pending)
      })
    } catch {
      if (res.headersSent) res.destroy()
      else { res.writeHead(502, { 'cache-control': 'no-store' }); res.end('Remote host is unavailable') }
    }
  }

  private async respond(name: string, target: URL, response: IncomingMessage, res: ServerResponse,
    method: string | undefined, authority: string): Promise<void> {
    const headers = publicHeaders(response.headers)
    headers['cache-control'] = 'no-store'
    if (headers.location !== undefined) {
      const location = new URL(headers.location, target)
      if (location.origin !== target.origin) { response.resume(); throw new Error('Remote redirect leaves the owned tunnel') }
      location.search = withoutLaunchToken(location.search)
      headers.location = embeddedRemotePath(name).slice(0, -1) + location.pathname + location.search + location.hash
    }
    const index = (target.pathname === '/' || target.pathname === '/index.html') && response.headers['content-type']?.includes('text/html')
    if (index && method === 'HEAD') delete headers['content-length']
    if (index && method !== 'HEAD') {
      const chunks: Buffer[] = []
      let length = 0
      for await (const chunk of response) {
        const buffer = Buffer.from(chunk as Uint8Array)
        length += buffer.length
        if (length > INDEX_LIMIT) throw new Error('Remote index exceeds the embedding limit')
        chunks.push(buffer)
      }
      let body = Buffer.concat(chunks)
      const encoding = response.headers['content-encoding']
      if (encoding === 'gzip') body = await promisify(gunzip)(body, { maxOutputLength: INDEX_LIMIT })
      else if (encoding === 'br') body = await promisify(brotliDecompress)(body, { maxOutputLength: INDEX_LIMIT })
      else if (encoding === 'deflate') body = await promisify(inflate)(body, { maxOutputLength: INDEX_LIMIT })
      else if (encoding !== undefined && encoding !== 'identity') throw new Error('Unsupported remote index encoding')
      delete headers['content-length']; delete headers['content-encoding']; delete headers.etag
      res.writeHead(response.statusCode ?? 502, headers)
      res.end(transformEmbeddedIndex(body.toString('utf8'), this.streamBase(name, authority)))
      return
    }
    res.writeHead(response.statusCode ?? 502, headers)
    await new Promise<void>((resolve, reject) => {
      response.once('error', reject)
      response.once('end', resolve)
      res.once('close', resolve)
      response.pipe(res)
    })
  }

  private async upgrade(name: string, req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const admission = this.ctx.connection.admit(req)
    if ('rejection' in admission) { refuse(socket, admission.rejection); return }
    const upstream = this.upstream(name)
    if (upstream === undefined) { refuse(socket, 503); return }
    try {
      const cookie = await upstream.cookie
      if (socket.destroyed) return
      const pending = request(new URL(MUX, upstream.url), {
        headers: { ...this.headers(req, upstream, cookie), connection: 'Upgrade', upgrade: 'websocket' },
      })
      const timeout = setTimeout(() => { pending.destroy(new Error('Remote stream handshake timed out')) }, 20_000)
      pending.on('socket', connected => { this.track(connected) })
      socket.once('close', () => { clearTimeout(timeout); pending.destroy() })
      pending.once('error', () => { clearTimeout(timeout); if (!socket.destroyed) refuse(socket, 502) })
      pending.once('response', response => {
        clearTimeout(timeout)
        if (response.statusCode === 401) this.invalidate(name)
        response.resume(); refuse(socket, response.statusCode ?? 502)
      })
      pending.once('upgrade', (response, remote, remoteHead) => {
        clearTimeout(timeout)
        this.track(remote)
        socket.once('error', () => { remote.destroy() })
        remote.once('error', () => { socket.destroy() })
        socket.once('close', () => { remote.destroy() })
        remote.once('close', () => { socket.destroy() })
        const headers = publicHeaders(response.headers)
        headers.connection = 'Upgrade'; headers.upgrade = 'websocket'
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(headers).flatMap(([key, value]) =>
          (Array.isArray(value) ? value : [value]).filter(item => item !== undefined).map(item => `${key}: ${String(item)}\r\n`)).join('')}\r\n`)
        if (remoteHead.length) socket.write(remoteHead)
        if (head.length) remote.write(head)
        socket.pipe(remote).pipe(socket)
      })
      pending.end()
    } catch { if (!socket.destroyed) refuse(socket, 502) }
  }
}
