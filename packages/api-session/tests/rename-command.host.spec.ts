/** Rename commands persist user-owned titles without scheduling a model turn. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionTitleService, { SessionTitleProviderId, foldSessionTitle } from '@deepseek-ai/dsh-session-title'
import UserQuestions, { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { registerSessionRenameCommand } from '../src/rename-command.ts'

const CONFIG = { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 40 }

class RenameQuery extends SessionQueryEngine {
  async searchSessions(): Promise<never> { throw new Error('rename fixture does not search Sessions') }
  async searchEvents(): Promise<never> { throw new Error('rename fixture does not search events') }
}

class TitleAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model }
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    const text = 'Suggested project title'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function fixture(titles = true) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(UserQuestions)
  if (titles) await ctx.plugin(SessionTitleService, CONFIG)
  const fiber = ctx.plugin({ apply: (child: Context) => {
    child.inject(['commands', 'sessionTitle'], (injected: Context) => { registerSessionRenameCommand(injected) })
  } })
  await fiber.await()
  const session = ctx.sessions.create(SessionId('rename-current'))
  const agent = { id: session.id, session } as Agent
  const run = (line: string, signal = new AbortController().signal) => ctx.commands.execute(agent, line, [], signal)
  if (titles) await vi.waitFor(() => { expect(ctx.commands.find(agent, 'rename')).toBeDefined() })
  return { ctx, fiber, session, agent, run }
}

describe('/rename', () => {
  it('uses the current model and shared question panel, saving only the confirmed custom title', async () => {
    const { ctx, session, agent, fiber } = await fixture()
    await ctx.plugin(LlmRuntime)
    const adapter = new TitleAdapter()
    ctx.llm.registerAdapter(['selected'], adapter)
    await ctx.plugin(RenameQuery)
    await fiber.dispose()
    registerSessionRenameCommand(ctx, undefined, () => ({ provider: 'selected', model: 'current-model' }))
    session.append('user/message', createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'Inspect the repository and fix the build.' }] }), { surfaceOp: 'append' })
    session.append('request/header', { reason: 'initial', header: { config: { provider: 'old', model: 'old-model' } } })
    ctx.sessionTitle.rename(session, 'Keep until confirmed')
    const before = [...session.snapshotEvents()]
    const response = Promise.withResolvers<{ answers: { id: string; selected: string[]; custom: string }[] }>()
    const ask = vi.spyOn(ctx.userQuestions, 'ask').mockReturnValueOnce(response.promise)
    const signal = new AbortController().signal
    const pending = ctx.commands.execute(agent, '/rename', [], signal)
    await vi.waitFor(() => { expect(ask).toHaveBeenCalledOnce() })
    expect(ctx.sessionTitle.get(session)?.title).toBe('Keep until confirmed')
    expect(ask).toHaveBeenCalledWith({ agent, signal,
      questions: [{ id: 'rename', header: '/rename', question: 'Suggested project title', options: [{ label: 'Suggested project title' }] }] })
    response.resolve({ answers: [{ id: 'rename', selected: [], custom: ' My edited title ' }] })
    const execution = await pending
    expect(execution?.result).toMatchObject({ kind: 'success', text: 'Renamed conversation to: My edited title' })
    expect(ctx.sessionTitle.get(session)?.title).toBe('My edited title')
    expect(adapter.calls).toHaveLength(1)
    expect(adapter.calls[0]).toMatchObject({ provider: 'selected', model: 'current-model', purpose: 'session-title' })
    const content = adapter.calls[0]?.messages[0]?.content
    expect(content?.[0]?.type).toBe('text')
    if (content?.[0]?.type !== 'text') throw new Error('Expected the framed conversation')
    expect(content[0].text).toContain('Inspect the repository and fix the build.')
    const added = session.snapshotEvents().slice(before.length)
    expect(added.map(event => event.type)).toEqual(['command/run', 'session/title-llm-request', 'session/title', 'command/done'])
    expect(added[1]).toMatchObject({ data: { route: { provider: 'selected', model: 'current-model' },
      system: adapter.calls[0]?.system, messages: adapter.calls[0]?.messages } })
  })

  it('cites only human messages when injected context shares the user role', async () => {
    const { ctx, session, agent, fiber } = await fixture()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['selected'], new TitleAdapter())
    await fiber.dispose()
    registerSessionRenameCommand(ctx, undefined, () => ({ provider: 'selected', model: 'current-model' }))
    session.append('user/message', createUserMessage({ source: { kind: 'runtime-context' },
      content: [{ type: 'text', text: '<permissions instructions>Sandboxed.</permissions>' }] }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'Fix the flaky build.' }] }), { surfaceOp: 'append' })
    const ask = vi.spyOn(ctx.userQuestions, 'ask')
    ask.mockResolvedValueOnce({ answers: [{ id: 'rename', selected: ['Suggested project title'] }] })
    expect((await ctx.commands.execute(agent, '/rename', [], new AbortController().signal))?.result.kind).toBe('success')
    const request = session.snapshotEvents().find(event => event.type === 'session/title-llm-request')
    const human = session.snapshotEvents()
      .filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
      .map(event => event.seq)
    expect(human.length).toBe(1)
    expect(request?.data.messageSeqs).toEqual(human)
  })

  it.each(['selected', 'skipped', 'cancelled'] as const)('settles the shared naming question when %s', async (answer) => {
    const { ctx, session, agent, fiber } = await fixture()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['selected'], new TitleAdapter())
    await ctx.plugin(RenameQuery)
    await fiber.dispose()
    registerSessionRenameCommand(ctx, undefined, () => ({ provider: 'selected', model: 'current-model' }))
    session.append('user/message', createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'Fix the build.' }] }), { surfaceOp: 'append' })
    ctx.sessionTitle.rename(session, 'Original name')
    const ask = vi.spyOn(ctx.userQuestions, 'ask')
    if (answer === 'cancelled') ask.mockRejectedValueOnce(new UserQuestionError('Cancelled', 'ASK_CANCELLED'))
    else ask.mockResolvedValueOnce({ answers: [{ id: 'rename', selected: answer === 'selected' ? ['Suggested project title'] : [] }] })
    expect((await ctx.commands.execute(agent, '/rename', [], new AbortController().signal))?.result.kind).toBe('success')
    expect(ctx.sessionTitle.get(session)?.title).toBe(answer === 'selected' ? 'Suggested project title' : 'Original name')
  })

  it('reports a missing title model without substituting a deterministic name', async () => {
    const { ctx, session, run } = await fixture()
    ctx.sessionTitle.rename(session, 'Keep me')
    const execution = await run('/rename')
    expect(execution?.result.kind).toBe('error')
    expect(execution?.result.text).toContain('require a model')
    expect(ctx.sessionTitle.get(session)?.title).toBe('Keep me')
  })
  it('publishes a normalized title and client projection, pins it, and restores it from durable events', async () => {
    const { ctx, session, run } = await fixture()
    const generated = vi.fn(async () => ({ title: 'Automatic title', messageSeqs: [] }))
    ctx.sessionTitle.register({ id: SessionTitleProviderId('rename-test'), automatic: 'all-prompts', generate: generated })
    const accepted = await run('/rename  项目　 重构  ')
    expect(accepted?.result).toMatchObject({ kind: 'success', text: 'Renamed conversation to: 项目 重构' })
    const title = session.snapshotEvents().find(event => event.type === 'session/title')
    expect(title?.data).toEqual({ title: '项目 重构', messageSeqs: [], source: { kind: 'user' } })
    expect(accepted?.result).toHaveProperty('sourceEventSeq', title?.seq)
    expect(ctx.sessionProjections.snapshot(session).values.title).toBe('项目 重构')
    expect(session.snapshotEvents().map(event => event.type)).toEqual(['command/run', 'session/title', 'command/done'])
    expect(session.snapshotEvents()[0]?.data).toHaveProperty('args', '  项目　 重构  ')

    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'A later task' }], source: { kind: 'user' } }),
      { surfaceOp: 'append' })
    session.append('request/header', { header: { config: { provider: 'unused', model: 'unused' } }, reason: 'change' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(generated).not.toHaveBeenCalled()
    expect(ctx.sessionTitle.get(session)?.source.kind).toBe('user')

    const restoredCtx = new Context()
    onTestFinished(() => restoredCtx.fiber.dispose())
    await restoredCtx.plugin(SessionStore)
    await restoredCtx.plugin(SessionProjectionRegistry)
    await restoredCtx.plugin(SessionTitleService, CONFIG)
    const restored = restoredCtx.sessions.create(session.id, { seed: [...session.snapshotEvents()], meta: session.header })
    expect(foldSessionTitle(restored.snapshotEvents())?.title).toBe('项目 重构')
    expect(restoredCtx.sessionProjections.snapshot(restored).values.title).toBe('项目 重构')
    expect(restoredCtx.sessionTitle.get(restored)?.source.kind).toBe('user')
  })

  it.each(['/rename \u200B', '/rename \u001B[31m'])('guides an invisible title without changing it: %j', async (line) => {
    const { ctx, session, run } = await fixture()
    ctx.sessionTitle.rename(session, 'Keep me')
    const result = await run(line)
    expect(result?.result.kind).toBe('error')
    expect(result?.result.text).toContain('/rename My project')
    expect(ctx.sessionTitle.get(session)?.title).toBe('Keep me')
    expect(session.snapshotEvents().filter(event => event.type === 'session/title')).toHaveLength(1)
    expect(session.snapshotEvents().some(event => event.type === 'user/message' || event.type === 'request/header')).toBe(false)
  })

  it('advertises an argument claim only while the title service and command owner are present', async () => {
    const { ctx, agent, fiber } = await fixture(false)
    expect(ctx.commands.find(agent, 'rename')).toBeUndefined()
    const titleFiber = ctx.plugin(SessionTitleService, CONFIG)
    await titleFiber.await()
    await vi.waitFor(() => { expect(ctx.commands.find(agent, 'rename')).toBeDefined() })
    expect(ctx.commands.list(agent).find(command => command.name === 'rename')).toEqual({
      definitionId: '@codexydsh/api-session/rename', name: 'rename',
      description: 'Rename the current conversation', input: { hint: '<new title>' },
    })
    await fiber.dispose()
    expect(ctx.commands.find(agent, 'rename')).toBeUndefined()
  })

  it('does not rename after cancellation and leaves unexpected failures in the command lifecycle', async () => {
    const { ctx, session, run } = await fixture()
    const controller = new AbortController()
    controller.abort(new Error('Stopped'))
    await expect(run('/rename Cancelled', controller.signal)).rejects.toThrow('Stopped')
    expect(ctx.sessionTitle.get(session)).toBeUndefined()
    const rename = vi.spyOn(ctx.sessionTitle, 'rename').mockImplementationOnce(() => { throw new Error('Title service unavailable') })
    await expect(run('/rename Valid')).rejects.toThrow('Title service unavailable')
    expect(session.snapshotEvents().at(-1)).toMatchObject({ type: 'command/done', data: { kind: 'error', text: 'Title service unavailable' } })
    rename.mockRestore()
  })
})
