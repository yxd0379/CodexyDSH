/** The paired Client model uses generated namespaces and Gateway stream supervision. */
import { expect, vi, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as Gateway from '@deepseek-ai/dsh-api-gateway/client'
import * as Typert from '@deepseek-ai/dsh-typert-registry/client'
import { installConnection } from '@deepseek-ai/dsh-client-connection/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteMock, ok, openStream } from '@deepseek-ai/dsh-remote-mock'
import { apply, inject } from '../src/client/index.ts'
import type { RemoteHostStatus } from '../src/types.ts'

const FOLLOW = 'remoteHosts/follow'
async function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const mock = RemoteMock.create()
  await ctx.plugin(Typert).await()
  await ctx.plugin({ apply(inner: Context) { installConnection(inner, { transport: { rpc: mock.rpc } }) } }).await()
  await ctx.plugin(Gateway).await()
  return { client: { ctx }, mock }
}
const row: RemoteHostStatus = { name: 'dev', host: 'example', profile: 'web', phase: 'disconnected', url: null, error: null }

it('shares accepted catalogs, delegates connection operations from another plugin, and joins unload', async () => {
  const { client, mock } = await fixture()
  mock.stream(FOLLOW, openStream([[row]]))
  mock.unary('remoteHosts/connect', ok({ ...row, phase: 'connected', url: 'http://127.0.0.1:3080/?token=fixture' }))
  mock.unary('remoteHosts/disconnect', ok(undefined))
  const model = client.ctx.plugin({ inject, apply })
  await model.await()
  await vi.waitFor(() => { expect(client.ctx.remoteHosts.getSnapshot()).toMatchObject({ items: [row], connected: true }) })
  const listener = vi.fn()
  const unsubscribe = client.ctx.remoteHosts.subscribe(listener)
  const caller = client.ctx.plugin({ inject: ['remoteHosts'], async apply(ctx) {
    expect(await ctx.remoteHosts.connect('dev', new AbortController().signal)).toMatchObject({ phase: 'connected' })
    await ctx.remoteHosts.disconnect('dev')
  } })
  await caller.await()
  mock.streams.push(FOLLOW, [{ ...row, phase: 'connecting' }])
  await vi.waitFor(() => { expect(listener).toHaveBeenCalled() })
  unsubscribe()
  await model.dispose()
  expect(client.ctx.get('remoteHosts')).toBeUndefined()
  expect(mock.log.streams(FOLLOW).map(value => value.state)).toEqual(['cancelled'])
}, 60_000)

it('retains its accepted catalog on a business stream failure and propagates command rejections', async () => {
  const { client, mock } = await fixture()
  mock.stream(FOLLOW, openStream([[row]]))
  const failure = new RemoteError('remote/test', 'Host refused connection')
  mock.remote.remoteHosts.connect.mockResolvedValue({ ok: false, error: failure })
  mock.remote.remoteHosts.disconnect.mockResolvedValue({ ok: false, error: failure })
  await client.ctx.plugin({ inject, apply }).await()
  await vi.waitFor(() => { expect(client.ctx.remoteHosts.getSnapshot().connected).toBe(true) })
  await expect(client.ctx.remoteHosts.connect('dev', new AbortController().signal)).rejects.toThrow('Host refused connection')
  await expect(client.ctx.remoteHosts.disconnect('dev')).rejects.toThrow('Host refused connection')
  mock.streams.fail(FOLLOW, failure)
  await vi.waitFor(() => { expect(client.ctx.remoteHosts.getSnapshot()).toMatchObject({ items: [row], connected: false, error: 'Host refused connection' }) })
}, 60_000)
