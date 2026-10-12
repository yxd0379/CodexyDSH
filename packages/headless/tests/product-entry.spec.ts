/** The shipped one-shot consumer creates a real product Agent with its selected reasoning effort. */
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import { ReasoningEffortId } from '@codexydsh/runtime/llm'
import CodexyRuntime from '@codexydsh/runtime'
import { requestHeaderOf } from '@codexydsh/runtime/session'
import { mountAgentLoopTestDependencies } from '@codexydsh/runtime-testkit'
import { MockAdapter, textResponse } from '@codexydsh/runtime-testkit/mock-adapter'
import { apply } from '../src/index.ts'
import { internals } from '../src/runner-internals.ts'

const savedIo = { ...internals }
const contexts: Context[] = []
afterEach(async () => {
  Object.assign(internals, savedIo)
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

it('runs the real headless entry through the owned preparation selector and emits a complete JSON result', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { includeHarnessIdentity: false } })
  await ctx.plugin(AgentDefaultModel, { provider: 'native', model: 'fixture', reasoningEffort: 'high' })
  await ctx.plugin(CodexyRuntime, { agents: [] })
  const adapter = new MockAdapter([textResponse('headless done')], {
    efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }, { id: ReasoningEffortId('high'), name: 'High' }],
    defaultEffort: ReasoningEffortId('low'),
  })
  adapter.developerHistory = 'native'
  ctx.codexyRequests.registerAdapter(['native'], adapter)
  let output = ''
  let errors = ''
  internals.stdout = { write: chunk => { output += chunk } }
  internals.stderr = { write: chunk => { errors += chunk } }
  const finished = new Promise<number>(resolve => { ctx.provide('appExit', resolve) })
  apply(ctx, { task: 'answer the task', json: true })
  expect(await finished).toBe(0)
  expect(errors).toBe('')
  expect(adapter.requests).toHaveLength(1)
  expect(adapter.requests[0]).toMatchObject({ provider: 'native', model: 'fixture', reasoningEffort: 'high' })
  const agent = ctx.agents.list()[0]!
  expect(requestHeaderOf(agent.session)?.config.reasoningEffort).toBe('high')
  const frames: Array<{ type: string; text?: string }> = output.trim().split('\n').map(line => JSON.parse(line))
  expect(frames.some(frame => frame.type === 'final' && frame.text === 'headless done')).toBe(true)
})
