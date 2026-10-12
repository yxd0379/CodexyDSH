/** The published Gateway dispatches the owned delegation controls and codecs. */
import { Context } from '@deepseek-ai/cordis'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { expect, it, onTestFinished } from 'vitest'
import SubagentRuntime from '../src/index.ts'
import { TYPERT } from '../src/typert.ts'

it('dispatches continuable controls through the owned service and rejects malformed wire input', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(TypertRegistry).await()
  await ctx.plugin(Gateway).await()
  await ctx.plugin(SubagentRuntime).await()
  ctx.typert.register(TYPERT)

  await expect(ctx.typertGateway.invoke({ namespace: 'subagents', method: 'interruptByParent', args: {
    childSessionId: 'absent-child', parentSessionId: 'parent', mode: 'continuable',
  } })).resolves.toEqual({ accepted: true })
  await expect(ctx.typertGateway.invoke({ namespace: 'subagents', method: 'interruptByParent', args: {
    childSessionId: 'child', parentSessionId: 'parent', mode: 'one-shot',
  } })).rejects.toMatchObject({ code: 'gateway/input-invalid' })
  await expect(ctx.typertGateway.invoke({ namespace: 'subagents', method: 'prompt', args: { request: {
    requestId: 'request', parentSessionId: 'parent', childSessionId: 'child', mode: 'continuable',
    delivery: 'queue', content: [{ type: 'text', text: 'continue' }],
  } } })).rejects.toMatchObject({ code: 'subagent/parent-unavailable' })
  await expect(ctx.typertGateway.invoke({ namespace: 'subagents', method: 'prompt', args: { request: {
    requestId: 'request', parentSessionId: 'parent', childSessionId: 'child', mode: 'continuable',
    delivery: 'queue', content: [{ type: 'image', mediaType: 'image/svg+xml', data: 'value' }],
  } } })).rejects.toMatchObject({ code: 'gateway/input-invalid' })
})
