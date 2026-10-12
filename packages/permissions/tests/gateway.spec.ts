/** The owned permission catalog is callable through the released Host dispatcher. */
import { Context } from '@deepseek-ai/cordis'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import ApprovalService from '@codexydsh/approval'
import { expect, it, onTestFinished } from 'vitest'
import PermissionPresets from '../src/index.ts'
import { TYPERT } from '../src/typert.ts'

it('reads the current owned preset catalog and rejects extra wire arguments', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(TypertRegistry).await()
  await ctx.plugin(Gateway).await()
  await ctx.plugin(SessionStore).await()
  await ctx.plugin(SessionProjections).await()
  await ctx.plugin(ApprovalService).await()
  ctx.provide('shell', {
    sandboxMode: 'workspace-write',
    resolve() { throw new Error('catalog lookup does not execute shell commands') },
    run() { throw new Error('catalog lookup does not execute shell commands') },
    start() { throw new Error('catalog lookup does not execute shell commands') },
  })
  await ctx.plugin(PermissionPresets).await()
  ctx.typert.register(TYPERT)
  await expect(ctx.typertGateway.invoke({ namespace: 'permissionPresets', method: 'catalog', args: {} })).resolves.toEqual(ctx.codexyPermissions.catalog())
  await expect(ctx.typertGateway.invoke({ namespace: 'permissionPresets', method: 'catalog', args: { preset: 'danger-full-access' } })).rejects.toMatchObject({ code: 'gateway/arguments-invalid' })
})
