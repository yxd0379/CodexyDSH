import { Context } from '@deepseek-ai/cordis'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import type { Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { EmbeddedRemoteProxy } from '../src/proxy.ts'

type Handler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

async function listen(handler: Handler) {
  const server = createServer(handler)
  const sockets = new Set<Socket>()
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => { sockets.delete(socket) }) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => { server.close(() => { resolve() }) })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Test listener has no TCP port')
  return { server, url: new URL(`http://127.0.0.1:${String(address.port)}/`) }
}

async function proxyServer(upstream: URL) {
  const owner = new Context()
  cleanups.push(async () => { await owner.fiber.dispose() })
  const peer = new Peer(owner, { principal: { kind: 'owner' } })
  let route: WebRoute | undefined
  const upgrades = new Map<string, WebUpgradeRoute>()
  const host: ConstructorParameters<typeof EmbeddedRemoteProxy>[0] = {
    effect: owner.effect.bind(owner), logger: { error: () => undefined },
    connection: { admit: () => ({ peer }) },
    webServer: {
      register: value => { route = value; return () => { route = undefined } },
      registerUpgrade: value => { upgrades.set(value.path, value); return () => { upgrades.delete(value.path) } },
    },
  }
  const proxy = new EmbeddedRemoteProxy(host, name => name === 'ascend' ? upstream.href : undefined)
  proxy.update(['ascend'])
  const local = await listen((request, response) => {
    if (route === undefined) throw new Error('Proxy route was not registered')
    return route.handler(request, response)
  })
  local.server.on('upgrade', (request, socket, head) => {
    const upgrade = upgrades.get(new URL(request.url ?? '/', local.url).pathname)
    if (upgrade === undefined) { socket.end(); return }
    void upgrade.handler(request, socket, head)
  })
  return { ...local, dispose: () => owner.fiber.dispose(), upgrades }
}

describe('Remote HTTP and mux transport', () => {
  it('forwards binary uploads and file responses with remote authentication, not local cookies', async () => {
    const upstream = await listen(async (request, response) => {
      if (request.url?.includes('token=')) { response.writeHead(303, { 'set-cookie': 'dsh-auth-test=remote; Path=/; HttpOnly' }).end(); return }
      expect(request.headers.cookie).toBe('dsh-auth-test=remote')
      expect(request.headers.authorization).toBeUndefined()
      if (request.method === 'POST') {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'x-upstream-path': request.url }).end(Buffer.concat(chunks))
      } else response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(Buffer.from([255, 0, 128]))
    })
    upstream.url.searchParams.set('token', 'private')
    const local = await proxyServer(upstream.url)
    const bytes = new Uint8Array([0, 255, 1, 128, 10])
    const response = await fetch(new URL('/codexy-remote/ascend/api/session/uploadFileBinary?sessionId=remote&name=a%20b.png', local.url), {
      method: 'POST', headers: { 'content-type': 'application/octet-stream', cookie: 'local=must-not-cross', authorization: 'local-secret' }, body: bytes,
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('x-upstream-path')).toBe('/api/session/uploadFileBinary?sessionId=remote&name=a%20b.png')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
    const file = await fetch(new URL('/codexy-remote/ascend/api/workspaceFiles/readBytes', local.url))
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([255, 0, 128]))
  })

  it('keeps the native Gateway mux bidirectional for terminal output and input, then releases its route', async () => {
    const upstream = await listen((request, response) => {
      if (request.url?.includes('token=')) response.writeHead(303, { 'set-cookie': 'dsh-auth-test=remote; Path=/' }).end()
      else response.writeHead(404).end()
    })
    upstream.server.on('upgrade', (request, socket, head) => {
      expect(request.url).toBe('/api/remote.mux')
      expect(request.headers.cookie).toBe('dsh-auth-test=remote')
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
      if (head.length) socket.write(head)
      socket.on('data', chunk => { socket.write(chunk) })
    })
    upstream.url.searchParams.set('token', 'private')
    const local = await proxyServer(upstream.url)
    await new Promise<void>((resolve, reject) => {
      const pending = request(new URL('/codexy-remote/ascend/api/remote.mux', local.url), { headers: { connection: 'Upgrade', upgrade: 'websocket' } })
      pending.once('error', reject)
      pending.once('upgrade', (_response, socket) => {
        socket.once('error', reject)
        socket.once('data', chunk => { expect(chunk.toString()).toBe('terminal input/output'); socket.destroy(); resolve() })
        socket.write('terminal input/output')
      })
      pending.end()
    })
    await local.dispose()
    expect(local.upgrades.size).toBe(0)
  })
})
