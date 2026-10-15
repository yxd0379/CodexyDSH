/** The public Gateway preserves Remote SSH status streaming and strict definitions. */
import { Context } from '@deepseek-ai/cordis'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { expect, it, onTestFinished } from 'vitest'
import RemoteLauncher from '../src/index.ts'
import { TYPERT } from '../src/typert.ts'

it('lists, streams, and disconnects configured hosts through the published Gateway', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(TypertRegistry).await()
  await ctx.plugin(Gateway).await()
  await ctx.plugin(RemoteLauncher, { hosts: { example: {
    host: 'example', profile: 'codexy', directory: '', node: 'node', dsh: 'dsh',
  } } }).await()
  const withdraw = ctx.typert.register(TYPERT)
  const request = { namespace: 'remoteHosts', method: 'list', args: {} }
  const expected = ctx.remoteLauncher.list()
  await expect(ctx.typertGateway.invoke(request)).resolves.toEqual(expected)
  const controller = new AbortController()
  const frames = await ctx.typertGateway.stream({ namespace: 'remoteHosts', method: 'follow', args: {}, signal: controller.signal })
  const iterator = frames[Symbol.asyncIterator]()
  expect((await iterator.next()).value).toEqual(expected)
  controller.abort()
  await iterator.return?.()
  await expect(ctx.typertGateway.invoke({ namespace: 'remoteHosts', method: 'disconnect', args: { name: 'example' } })).resolves.toBeUndefined()
  await expect(ctx.typertGateway.invoke({ namespace: 'remoteHosts', method: 'connect', args: { name: 3 } })).rejects.toMatchObject({ code: 'gateway/input-invalid' })
  await expect(ctx.typertGateway.invoke({ namespace: 'remoteHosts', method: 'respondAuthentication', args: { name: 'example', challengeId: 'old', response: 3 } })).rejects.toMatchObject({ code: 'gateway/input-invalid' })
  await expect(ctx.typertGateway.invoke({ namespace: 'remoteHosts', method: 'respondAuthentication', args: { name: 'example', challengeId: 'old', response: 'unsafe\nresponse' } })).rejects.toMatchObject({ code: 'gateway/input-invalid' })
  await expect(ctx.typertGateway.invoke({ namespace: 'remoteHosts', method: 'respondAuthentication', args: { name: 'example', challengeId: 'old', response: null } })).rejects.toMatchObject({ message: 'SSH authentication request is no longer active' })
  withdraw()
  await expect(ctx.typertGateway.invoke(request)).rejects.toMatchObject({ code: 'gateway/definition-unavailable' })
})
