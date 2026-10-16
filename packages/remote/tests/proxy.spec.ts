import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { EmbeddedRemoteProxy } from '../src/proxy.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => server.close(() => resolve()))))
})

async function listen(handler: Handler): Promise<{ server: ReturnType<typeof createServer>; url: URL }> {
  const server = createServer(handler)
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server did not bind TCP')
  return { server, url: new URL(`http://127.0.0.1:${String(address.port)}/`) }
}

describe('EmbeddedRemoteProxy', () => {
  it('forwards native Client API traffic through an authenticated tunnel', async () => {
    const upstream = await listen((req, res) => {
      if (req.url?.includes('token=')) {
        res.writeHead(303, { 'set-cookie': 'dsh-auth-test=ok; Path=/; HttpOnly', location: '/' })
        res.end()
        return
      }
      if (req.headers.cookie !== 'dsh-auth-test=ok') {
        res.writeHead(401)
        res.end()
        return
      }
      if (req.method === 'POST') {
        return (async () => {
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ path: req.url, bytes: [...Buffer.concat(chunks)] }))
        })()
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ path: req.url, origin: req.headers.origin }))
    })

    let route: Handler | undefined
    const ctx = {
      connection: { admit: () => ({ peer: {} }) },
      effect: (activate: () => unknown) => { activate() },
      logger: { error: () => undefined },
      webServer: {
        register: ({ handler }: { handler: Handler }) => { route = handler; return () => undefined },
        registerUpgrade: () => () => undefined,
      },
    } as unknown as Context
    const launch = new URL(upstream.url)
    launch.searchParams.set('token', 'private')
    const proxy = new EmbeddedRemoteProxy(ctx, name => name === 'ascend' ? launch.href : undefined)
    proxy.update(['ascend'])

    const local = await listen((req, res) => {
      if (route === undefined) throw new Error('proxy route was not registered')
      return route(req, res)
    })
    const response = await fetch(new URL('/codexy-remote/ascend/api/probe', local.url))
    const body = await response.json() as { path: string; origin: string }

    expect(response.status).toBe(200)
    expect(body.path).toBe('/api/probe')
    expect(body.origin).toBe(upstream.url.origin)

    const bytes = new Uint8Array([0, 255, 1, 128, 10])
    const upload = await fetch(new URL('/codexy-remote/ascend/api/session/uploadFileBinary?sessionId=remote-session&name=sample.bin', local.url), {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes,
    })
    expect(await upload.json()).toEqual({ path: '/api/session/uploadFileBinary?sessionId=remote-session&name=sample.bin', bytes: [...bytes] })
  })
})
