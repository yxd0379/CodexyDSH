/** Two live product Agents retain independent published and product prompt effects. */
import { Context } from '@deepseek-ai/cordis'
import LocalFileReferences from '@deepseek-ai/dsh-file-reference-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { AgentLoop } from '@codexydsh/runtime'
import { mountAgentLoopTestDependencies, provideWorkingDirectoryFixture } from '@codexydsh/runtime-testkit'
import { expect, it, onTestFinished } from 'vitest'

it('keeps two active Sessions scoped and removes only the disposed Agent prompt contributions', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(LocalFileReferences).await()
  await ctx.plugin(AgentLoop, { agents: [] }).await()
  const first = await ctx.agents.create({ sessionId: SessionId('prompt-scope-first'), agentOptions: {} })
  const firstPreparations: string[] = []
  first.agent.ctx.on('codexy-prompt/prepare', async (_variables, _context, next) => {
    firstPreparations.push('first')
    return next()
  })
  first.agent.ctx.codexyPrompt.section({ name: 'fixture:session-owner', order: 1, text: 'first Session' })
  const second = await ctx.agents.create({ sessionId: SessionId('prompt-scope-second'), agentOptions: {} })
  const secondPreparations: string[] = []
  second.agent.ctx.on('codexy-prompt/prepare', async (_variables, _context, next) => {
    secondPreparations.push('second')
    return next()
  })
  second.agent.ctx.codexyPrompt.section({ name: 'fixture:session-owner', order: 1, text: 'second Session' })
  expect(scopeOf(first.agent.ctx)).toBe(first.agent)
  expect(scopeOf(second.agent.ctx)).toBe(second.agent)
  expect(ctx.agents.list()).toEqual([first.agent, second.agent])
  const inspect = async (agent: typeof first.agent) => {
    const context = { scope: agent, agent }
    const stock = await ctx.systemPrompt.assemble(context)
    expect(stock.sections.filter(section => section.name === 'context:file-reference')).toHaveLength(1)
    const preparation = await ctx.codexyPrompt.prepare(context)
    return ctx.codexyPrompt.assemble(context, preparation)
  }
  expect((await inspect(first.agent)).sections.find(section => section.name === 'fixture:session-owner')?.text).toBe('first Session')
  expect((await inspect(second.agent)).sections.find(section => section.name === 'fixture:session-owner')?.text).toBe('second Session')
  expect(firstPreparations).toEqual(['first'])
  expect(secondPreparations).toEqual(['second'])
  expect((await ctx.systemPrompt.assemble()).sections.some(section => section.name === 'context:file-reference')).toBe(false)
  await first.dispose()
  expect(ctx.agents.list()).toEqual([second.agent])
  expect((await ctx.systemPrompt.assemble({ scope: first.agent, agent: first.agent })).sections.some(section => section.name === 'context:file-reference')).toBe(false)
  expect((await inspect(second.agent)).sections.find(section => section.name === 'fixture:session-owner')?.text).toBe('second Session')
  expect(firstPreparations).toEqual(['first'])
  expect(secondPreparations).toEqual(['second', 'second'])
  await second.dispose()
  const globalPreparation = await ctx.codexyPrompt.prepare({})
  expect((await ctx.codexyPrompt.assemble({}, globalPreparation)).sections.some(section => section.name === 'fixture:session-owner')).toBe(false)
  expect((await ctx.systemPrompt.assemble()).sections.some(section => section.name === 'context:file-reference')).toBe(false)
})
