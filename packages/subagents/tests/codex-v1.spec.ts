import { requestHeaderOf } from '@codexydsh/runtime/session'
import { snapshotProductEvents } from '@codexydsh/runtime/session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@codexydsh/runtime/agent'
import { AgentLoop } from '@codexydsh/runtime'
import { mountAgentLoopTestDependencies } from '@codexydsh/runtime-testkit'
import { LlmAdapter, ToolCallId, createToolResultMessage, createUserMessage } from '@codexydsh/runtime/llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@codexydsh/runtime/llm'
import { TOOL_REQUEST_CAPTURE } from '@codexydsh/runtime/tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@codexydsh/runtime/persistence'
import SubagentRuntime, { codexV1IdentityOf } from '@codexydsh/delegation'
import * as Fork from '@codexydsh/fork'
import * as Spawn from '@codexydsh/spawn'
import ApprovalService from '@codexydsh/approval'
import { MockAdapter, textResponse } from '@codexydsh/runtime-testkit/mock-adapter'
import { TestSessionQuery } from '../../delegation/tests/test-session-query.ts'
import { parkParent } from '../../delegation/tests/park-parent.ts'
import * as CodexV1 from '../src/codex-v1.ts'
import { CODEX_V1_NICKNAMES, CodexV1NicknamePool } from '../src/codex-v1-nicknames.ts'

const roots: string[] = []
const contexts: Context[] = []
const signal = new AbortController().signal
let calls = 0

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Hold the child request until the wait call has subscribed to its settlement. */
class GatedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly entered = Promise.withResolvers<undefined>()

  constructor(private readonly release: Promise<undefined>) { super() }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    this.entered.resolve(undefined)
    const aborted = Promise.withResolvers<undefined>()
    const onAbort = (): void => { aborted.resolve(undefined) }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      options.signal?.throwIfAborted()
      await Promise.race([this.release, aborted.promise])
      options.signal?.throwIfAborted()
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
    }
    yield* textResponse('child done')
  }
}

/** Require exact model lookup so spawn validation can reject before child creation. */
class ExactModelAdapter extends MockAdapter {
  override async resolveModel(provider: string, model: string) {
    if (model !== 'mock') throw new Error(`unknown model: ${model}`)
    return super.resolveModel(provider, model)
  }
}

/** Advertise namespace support on the exact route used by one request. */
class NamespaceAdapter extends MockAdapter {
  constructor(private readonly nativeNamespaces: boolean) { super([textResponse('done')]) }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider, id: model, name: model,
      ...this.nativeNamespaces ? { toolNamespaces: 'native' as const } : {},
    })
  }
}

async function setup(adapter: LlmAdapter, config: CodexV1.Config = {}, park = true) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-codex-v1-subagent-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root, leaseStaleMs: 30_000, leaseUpdateMs: 10_000 })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(Fork, { providerName: 'fork' })
  const v1 = await ctx.plugin(CodexV1, config)
  ctx.codexyRequests.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId(`codex-v1-parent-${contexts.length}`), { provider: 'mock', model: 'mock' })
  if (park) parkParent(ctx, parent)
  return { ctx, parent, v1 }
}

function call(ctx: Context, agent: Agent, name: string, args: unknown, callSignal = signal) {
  return ctx.codexyTools.execute({
    signal: callSignal,
    callId: ToolCallId(`codex-v1-${++calls}`),
    name: `multi_agent_v1__${name}`,
    arguments: args,
    agent,
  })
}

async function idleChild(ctx: Context, id: SessionId): Promise<Agent> {
  const child = ctx.agents.get(id)
  if (child === undefined) throw new Error('expected resident child')
  await child.whenIdle()
  expect(ctx.agents.get(id)).toBe(child)
  expect(child.status).toBe('idle')
  return child
}

function text(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

function value(result: { content: readonly { type: string; text?: string }[] }): Record<string, unknown> {
  return JSON.parse(text(result)) as Record<string, unknown>
}

describe('Codex v1 subagent tools', () => {
  for (const nativeNamespaces of [true, false]) {
    it(`captures ${nativeNamespaces ? 'namespaced' : 'flat'} v1 tools once and binds their original executor`, async () => {
      const { ctx, parent } = await setup(new NamespaceAdapter(nativeNamespaces))
      const context = { agent: parent, scope: parent, signal }
      const resolve = vi.spyOn(ctx.codexyRequests, 'resolveModelInfo')
      const preparation = await ctx.codexyPrompt.prepare(context)
      const capture = await ctx.codexyTools.prepareRequest({ context, variables: preparation.variables })
      const assembly = await ctx.codexyPrompt.assemble({ ...context, [TOOL_REQUEST_CAPTURE]: capture }, preparation)
      const binding = ctx.codexyTools.bindAssembly(capture, assembly.tools)
      const schemas = ctx.codexyTools.requestSchemas(binding)
      expect(schemas).toHaveLength(5)
      expect(resolve).toHaveBeenCalledOnce()
      expect(resolve).toHaveBeenCalledWith('mock', 'mock', expect.any(AbortSignal))
      expect(schemas.every(schema => nativeNamespaces
        ? schema.namespace?.name === 'multi_agent_v1' : schema.namespace === undefined)).toBe(true)
      expect(ctx.codexyTools.schemas().every(schema => schema.namespace?.name === 'multi_agent_v1')).toBe(true)
      expect(ctx.codexyTools.requestToolName(binding,
        nativeNamespaces ? 'close_agent' : 'multi_agent_v1__close_agent',
        nativeNamespaces ? 'multi_agent_v1' : 'functions',
      )).toBe('multi_agent_v1__close_agent')
      expect(ctx.codexyTools.requestToolName(binding,
        nativeNamespaces ? 'multi_agent_v1__close_agent' : 'close_agent',
        nativeNamespaces ? 'functions' : 'multi_agent_v1',
      )).toBeUndefined()
      const result = await ctx.codexyTools.execute({
        signal, agent: parent, callId: ToolCallId(`namespace-close-${nativeNamespaces}`),
        name: 'multi_agent_v1__close_agent', arguments: { target: 'missing-child' }, requestBinding: binding,
      })
      expect(result.isError, text(result)).toBe(false)
      expect(value(result)).toEqual({ previous_status: 'not_found' })
    })

    it(`logs ${nativeNamespaces ? 'namespaced' : 'flat'} v1 schemas with the selected model request`, async () => {
      const initial = new NamespaceAdapter(!nativeNamespaces)
      const selected = new NamespaceAdapter(nativeNamespaces)
      const { ctx, parent } = await setup(initial, {}, false)
      ctx.codexyRequests.registerAdapter(['selected'], selected)
      installModelSelection(parent.ctx, {
        current: { provider: 'selected', model: 'chosen' }, assembled: undefined,
      })
      parent.followup(createUserMessage({
        content: [{ type: 'text', text: 'Use the selected route' }], source: { kind: 'user' },
      }))
      await parent.whenIdle()
      expect(initial.requests).toHaveLength(0)
      expect(selected.requests, JSON.stringify(parent.session.snapshotEvents().slice(-5))).toHaveLength(1)
      const header = requestHeaderOf(parent.session)
      expect(header?.config).toMatchObject({ provider: 'selected', model: 'chosen' })
      expect(header?.tools).toEqual(selected.requests[0]?.tools)
      expect(header?.tools).toHaveLength(5)
      expect(header?.tools?.every(schema => nativeNamespaces
        ? schema.namespace?.name === 'multi_agent_v1' : schema.namespace === undefined)).toBe(true)
    })
  }

  it('does not resolve v1 metadata when an explicit v2 request hides the v1 family', async () => {
    const { ctx, parent } = await setup(new NamespaceAdapter(false))
    const resolve = vi.spyOn(ctx.codexyRequests, 'resolveModelInfo').mockRejectedValue(new Error('hidden v1 metadata unavailable'))
    const context = { agent: parent, scope: parent, signal }
    ctx.codexyPrompt.variable('codexful_multi_agent_version', () => 'v2')
    ctx.on('codexy-prompt/assemble', async (_assembly, _context, next) => {
      const assembly = await next()
      return { ...assembly, tools: assembly.tools.filter(tool => !tool.name.startsWith('multi_agent_v1__')) }
    })
    const preparation = await ctx.codexyPrompt.prepare(context)
    const capture = await ctx.codexyTools.prepareRequest({ context, variables: preparation.variables })
    const assembly = await ctx.codexyPrompt.assemble({ ...context, [TOOL_REQUEST_CAPTURE]: capture }, preparation)
    const binding = ctx.codexyTools.bindAssembly(capture, assembly.tools)
    expect(ctx.codexyTools.requestSchemas(binding)).toEqual([])
    expect(resolve).not.toHaveBeenCalled()
  })

  it('shares a failed exact-route lookup across the five v1 definitions', async () => {
    const { ctx, parent } = await setup(new NamespaceAdapter(false))
    const resolve = vi.spyOn(ctx.codexyRequests, 'resolveModelInfo').mockRejectedValue(new Error('selected model metadata unavailable'))
    await expect(ctx.codexyTools.prepareRequest({
      context: { agent: parent, scope: parent, signal },
      variables: { provider: 'mock', model: 'unavailable' },
    })).rejects.toThrow('selected model metadata unavailable')
    expect(resolve).toHaveBeenCalledOnce()
  })

  it('registers the pinned namespace and rejects unsupported input before creating a child', async () => {
    const { ctx, parent } = await setup(new MockAdapter([]))
    const schemas = ctx.codexyTools.schemas()
    expect(schemas.filter(schema => schema.namespace?.name === 'multi_agent_v1').map(schema => schema.namespace?.toolName))
      .toEqual(expect.arrayContaining(['spawn_agent', 'send_input', 'wait_agent', 'resume_agent', 'close_agent']))
    expect(createHash('sha256').update(schemas.find(schema => schema.name === 'multi_agent_v1__spawn_agent')?.description ?? '').digest('hex'))
      .toBe('565e72f6429e3849c86e0632af0ec69b9c793b3276a2fac13998f971376835b7')
    expect(schemas.find(schema => schema.name === 'multi_agent_v1__spawn_agent')?.parameters)
      .not.toHaveProperty('properties.agent_type')
    const both = await call(ctx, parent, 'spawn_agent', { message: 'Task', items: [{ type: 'text', text: 'Other' }] })
    expect(both.isError).toBe(true)
    expect(text(both)).toContain('either message or items')
    const media = await call(ctx, parent, 'spawn_agent', { items: [{ type: 'image', image_url: 'data:image/png;base64,AA==' }] })
    expect(media.isError).toBe(true)
    expect(text(media)).toContain('unsupported')
    const role = await call(ctx, parent, 'spawn_agent', { message: 'Task', agent_type: 'explorer' })
    expect(role.isError).toBe(true)
    expect(await ctx.codexySubagents.listChildren(parent.id)).toEqual([])
  })

  it('rejects invalid child model controls before publishing a child', async () => {
    const { ctx, parent } = await setup(new ExactModelAdapter([]))
    const unknown = await call(ctx, parent, 'spawn_agent', { message: 'Task', model: 'missing' })
    expect(unknown.isError).toBe(true)
    expect(text(unknown)).toContain('unknown model: missing')
    const effort = await call(ctx, parent, 'spawn_agent', { message: 'Task', reasoning_effort: 'high' })
    expect(effort.isError).toBe(true)
    expect(text(effort)).toContain('reasoning effort "high"')
    expect(await ctx.codexySubagents.listChildren(parent.id)).toEqual([])
  })

  it('keeps completed children open until close and requires a free slot to resume', async () => {
    const adapter = new MockAdapter([
      textResponse('first answer'), textResponse('second answer'), textResponse('third answer'),
    ])
    const { ctx, parent } = await setup(adapter, {
      maxOpenAgents: 1, minWaitMs: 0, defaultWaitMs: 100, maxWaitMs: 500,
    })
    const first = await call(ctx, parent, 'spawn_agent', { message: 'First task' })
    expect(first.isError, text(first)).toBe(false)
    const id = value(first).agent_id as string
    const nickname = value(first).nickname
    expect(CODEX_V1_NICKNAMES).toContain(nickname)
    expect(CodexV1.codexV1LiveNicknames(ctx.codexySubagents, parent.id).get(SessionId(id))).toBe(nickname)
    await idleChild(ctx, SessionId(id))
    const waited = await call(ctx, parent, 'wait_agent', { targets: [id], timeout_ms: 10 })
    expect(value(waited)).toEqual({ status: { [id]: { completed: 'first answer' } }, timed_out: false })
    const full = await call(ctx, parent, 'spawn_agent', { message: 'Second task' })
    expect(full.isError).toBe(true)
    expect(text(full)).toContain('limit reached (1 open child agents)')
    const closed = await call(ctx, parent, 'close_agent', { target: id })
    expect(value(closed)).toEqual({ previous_status: { completed: 'first answer' } })
    expect(ctx.agents.get(SessionId(id))).toBeUndefined()
    const closedWait = await call(ctx, parent, 'wait_agent', { targets: [id], timeout_ms: 10 })
    expect(value(closedWait)).toEqual({ status: { [id]: 'not_found' }, timed_out: false })
    const closedAgain = await call(ctx, parent, 'close_agent', { target: id })
    expect(closedAgain.isError, text(closedAgain)).toBe(false)
    expect(value(closedAgain)).toEqual({ previous_status: 'not_found' })
    const blockedInput = await call(ctx, parent, 'send_input', { target: id, message: 'Another task' })
    expect(blockedInput.isError).toBe(true)
    expect(text(blockedInput)).toContain('call resume_agent first')
    const second = await call(ctx, parent, 'spawn_agent', { message: 'Second task' })
    expect(second.isError, text(second)).toBe(false)
    const secondId = value(second).agent_id as string
    expect(value(second).nickname).not.toBe(nickname)
    const fullResume = await call(ctx, parent, 'resume_agent', { id })
    expect(fullResume.isError).toBe(true)
    expect(text(fullResume)).toContain('limit reached')
    await idleChild(ctx, SessionId(secondId))
    await call(ctx, parent, 'close_agent', { target: secondId })
    const requestCount = adapter.requests.length
    const resumed = await call(ctx, parent, 'resume_agent', { id })
    expect(resumed.isError, text(resumed)).toBe(false)
    expect(value(resumed).status).toBe('pending_init')
    await idleChild(ctx, SessionId(id))
    expect(adapter.requests).toHaveLength(requestCount)
    const pending = await call(ctx, parent, 'wait_agent', { targets: [id], timeout_ms: 10 })
    expect(value(pending)).toEqual({ status: {}, timed_out: true })
    expect(CodexV1.codexV1LiveNicknames(ctx.codexySubagents, parent.id).get(SessionId(id))).toBe(nickname)
    const sent = await call(ctx, parent, 'send_input', { target: id, items: [{ type: 'text', text: 'Another task' }] })
    expect(sent.isError, text(sent)).toBe(false)
    expect(typeof value(sent).submission_id).toBe('string')
    await idleChild(ctx, SessionId(id))
    const after = await call(ctx, parent, 'wait_agent', { targets: [id], timeout_ms: 10 })
    expect(value(after)).toEqual({ status: { [id]: { completed: 'third answer' } }, timed_out: false })
  })

  it('waits for the first final status and leaves a timed-out target open', async () => {
    const release = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter(release.promise)
    const { ctx, parent } = await setup(adapter, { minWaitMs: 0, defaultWaitMs: 100, maxWaitMs: 500 })
    const spawned = await call(ctx, parent, 'spawn_agent', { message: 'Do the work' })
    expect(spawned.isError, text(spawned)).toBe(false)
    const id = value(spawned).agent_id as string
    await adapter.entered.promise
    const timed = await call(ctx, parent, 'wait_agent', { targets: [id], timeout_ms: 1 })
    expect(value(timed)).toEqual({ status: {}, timed_out: true })
    const waiting = call(ctx, parent, 'wait_agent', { targets: [id], timeout_ms: 400 })
    release.resolve(undefined)
    expect(value(await waiting)).toEqual({ status: { [id]: { completed: 'child done' } }, timed_out: false })
  })

  it('steers an active child without aborting its turn when interrupt is omitted', async () => {
    const release = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter(release.promise)
    const { ctx, parent } = await setup(adapter)
    const spawned = await call(ctx, parent, 'spawn_agent', { message: 'Finish old work' })
    expect(spawned.isError, text(spawned)).toBe(false)
    const id = value(spawned).agent_id as string
    await adapter.entered.promise
    const child = ctx.agents.get(SessionId(id))
    if (child === undefined) throw new Error('expected resident child')
    const sent = await call(ctx, parent, 'send_input', { target: id, message: 'Do later work' })
    expect(sent.isError, text(sent)).toBe(false)
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.signal?.aborted).toBe(false)
    expect(child.inbox.nextStep).toHaveLength(1)
    expect(child.inbox.nextTurn).toHaveLength(0)
    release.resolve(undefined)
    await idleChild(ctx, SessionId(id))
    expect(adapter.requests).toHaveLength(2)
    expect(JSON.stringify(adapter.requests[0]!.messages)).not.toContain('Do later work')
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('Do later work')
    expect(child.session.snapshotEvents().slice(child.session.inheritedEventCount)
      .filter(event => event.type === 'turn/start')).toHaveLength(1)
  })

  it('keeps waiting after an interrupted child epoch', async () => {
    const adapter = new MockAdapter(['hang'])
    const { ctx, parent } = await setup(adapter, { minWaitMs: 0, defaultWaitMs: 10, maxWaitMs: 50 })
    const spawned = await call(ctx, parent, 'spawn_agent', { message: 'Start work' })
    expect(spawned.isError, text(spawned)).toBe(false)
    const id = SessionId(value(spawned).agent_id as string)
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    ctx.codexySubagents.interrupt(id, { kind: 'ancestor', agent: parent, intent: 'tool' })
    await idleChild(ctx, id)
    const waited = await call(ctx, parent, 'wait_agent', { targets: [id], timeout_ms: 10 })
    expect(value(waited)).toEqual({ status: {}, timed_out: true })
  })

  it('retains an interrupted status on cold resume without replaying old work', async () => {
    const adapter = new MockAdapter(['hang', textResponse('continued answer')])
    const { ctx, parent } = await setup(adapter, { minWaitMs: 0, defaultWaitMs: 10, maxWaitMs: 100 })
    const spawned = await call(ctx, parent, 'spawn_agent', { message: 'Interrupt this work' })
    expect(spawned.isError, text(spawned)).toBe(false)
    const id = SessionId(value(spawned).agent_id as string)
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    ctx.codexySubagents.interrupt(id, { kind: 'ancestor', agent: parent, intent: 'tool' })
    await idleChild(ctx, id)
    expect(value(await call(ctx, parent, 'close_agent', { target: id }))).toEqual({ previous_status: 'interrupted' })
    expect(ctx.agents.get(id)).toBeUndefined()
    const resumed = await call(ctx, parent, 'resume_agent', { id })
    expect(resumed.isError, text(resumed)).toBe(false)
    expect(value(resumed)).toEqual({ status: 'interrupted' })
    await idleChild(ctx, id)
    expect(adapter.requests).toHaveLength(1)
    expect(value(await call(ctx, parent, 'wait_agent', { targets: [id], timeout_ms: 1 })))
      .toEqual({ status: {}, timed_out: true })
    const sent = await call(ctx, parent, 'send_input', { target: id, message: 'Continue now' })
    expect(sent.isError, text(sent)).toBe(false)
    await idleChild(ctx, id)
    expect(adapter.requests).toHaveLength(2)
    expect(value(await call(ctx, parent, 'wait_agent', { targets: [id], timeout_ms: 10 })))
      .toEqual({ status: { [id]: { completed: 'continued answer' } }, timed_out: false })
  })

  it('reports the recorded child error when an in-flight wait settles', async () => {
    const release = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter(release.promise)
    const { ctx, parent } = await setup(adapter, { minWaitMs: 0, defaultWaitMs: 500, maxWaitMs: 1_000 })
    const spawned = await call(ctx, parent, 'spawn_agent', { message: 'Run failing work' })
    expect(spawned.isError, text(spawned)).toBe(false)
    const id = value(spawned).agent_id as string
    await adapter.entered.promise
    const waiting = call(ctx, parent, 'wait_agent', { targets: [id], timeout_ms: 500 })
    release.reject(new Error('child failure detail'))
    const result = value(await waiting)
    expect(JSON.stringify(result.status)).toContain('child failure detail')
    expect(result.timed_out).toBe(false)
  })

  it('observes completion during the initial parent read before a stale child snapshot', async () => {
    const releaseChild = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter(releaseChild.promise)
    const { ctx, parent } = await setup(adapter, { minWaitMs: 0, defaultWaitMs: 100, maxWaitMs: 500 })
    const spawned = await call(ctx, parent, 'spawn_agent', { message: 'Race the wait read' })
    expect(spawned.isError, text(spawned)).toBe(false)
    const id = SessionId(value(spawned).agent_id as string)
    await adapter.entered.promise
    using stale = await ctx.sessionQuery.observeSession(id, { signal, projectionMode: 'none' })
    const entered = Promise.withResolvers<undefined>()
    const releaseRead = Promise.withResolvers<undefined>()
    const original = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
    let parentRead = false
    let staleRead = false
    vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation(async (target, options) => {
      if (target === parent.id && !parentRead) {
        parentRead = true
        entered.resolve(undefined)
        await releaseRead.promise
      } else if (target === id && !staleRead) {
        staleRead = true
        return stale.retain()
      }
      return original(target, options)
    })
    const waiting = call(ctx, parent, 'wait_agent', { targets: [id], timeout_ms: 100 })
    try {
      await entered.promise
      releaseChild.resolve(undefined)
      await idleChild(ctx, id)
      releaseRead.resolve(undefined)
      const waited = await waiting
      expect(waited.isError, text(waited)).toBe(false)
      expect(value(waited)).toEqual({ status: { [id]: { completed: 'child done' } }, timed_out: false })
      expect(staleRead).toBe(true)
      expect(ctx.agents.get(id)?.status).toBe('idle')
    } finally {
      releaseChild.resolve(undefined)
      releaseRead.resolve(undefined)
      await waiting
    }
  })

  it('settles an in-flight wait only after close successfully drains its child', async () => {
    const releaseChild = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter(releaseChild.promise)
    const { ctx, parent } = await setup(adapter, { minWaitMs: 0, defaultWaitMs: 100, maxWaitMs: 500 })
    const spawned = await call(ctx, parent, 'spawn_agent', { message: 'Close running work' })
    const id = SessionId(value(spawned).agent_id as string)
    await adapter.entered.promise
    const entered = Promise.withResolvers<undefined>()
    const releaseRead = Promise.withResolvers<undefined>()
    const original = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
    vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementationOnce(async (target, options) => {
      expect(target).toBe(parent.id)
      entered.resolve(undefined)
      await releaseRead.promise
      return original(target, options)
    })
    const waiting = call(ctx, parent, 'wait_agent', { targets: [id], timeout_ms: 100 })
    try {
      await entered.promise
      const closed = await call(ctx, parent, 'close_agent', { target: id })
      expect(closed.isError, text(closed)).toBe(false)
      expect(value(closed)).toEqual({ previous_status: 'running' })
      expect(ctx.agents.get(id)).toBeUndefined()
      releaseRead.resolve(undefined)
      expect(value(await waiting)).toEqual({ status: { [id]: 'shutdown' }, timed_out: false })
    } finally {
      releaseRead.resolve(undefined)
      releaseChild.resolve(undefined)
      await waiting
    }
  })

  for (const cancellation of ['caller', 'plugin'] as const) {
    it(`releases a wait's owned subscriptions on ${cancellation} cancellation`, async () => {
      const releaseChild = Promise.withResolvers<undefined>()
      const adapter = new GatedAdapter(releaseChild.promise)
      const { ctx, parent, v1 } = await setup(adapter, { minWaitMs: 0, defaultWaitMs: 100, maxWaitMs: 500 })
      const spawned = await call(ctx, parent, 'spawn_agent', { message: 'Keep running' })
      const id = SessionId(value(spawned).agent_id as string)
      await adapter.entered.promise
      const entered = Promise.withResolvers<undefined>()
      const releaseRead = Promise.withResolvers<undefined>()
      const original = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
      vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementationOnce(async (target, options) => {
        expect(target).toBe(parent.id)
        entered.resolve(undefined)
        await releaseRead.promise
        return original(target, options)
      })
      const controller = new AbortController()
      const waits = () => v1.ctx.fiber.getEffects().filter(effect => effect.label === 'codexV1.wait')
      expect(waits()).toHaveLength(0)
      const waiting = call(ctx, parent, 'wait_agent', { targets: [id], timeout_ms: 100 }, controller.signal)
      try {
        await entered.promise
        expect(waits()).toHaveLength(1)
        if (cancellation === 'caller') controller.abort(new Error('caller stopped waiting'))
        else await v1.dispose()
        releaseRead.resolve(undefined)
        const waited = await waiting
        expect(waited.isError).toBe(true)
        expect(text(waited)).toContain('session observation was aborted')
        expect(waits()).toHaveLength(0)
        expect(ctx.agents.get(id)?.status).toBe('running')
      } finally {
        releaseRead.resolve(undefined)
        releaseChild.resolve(undefined)
        await waiting
      }
    })
  }

  it('redirects a running child with interrupt=true and accepts the new input', async () => {
    const adapter = new MockAdapter(['hang', textResponse('redirected answer')])
    const { ctx, parent } = await setup(adapter)
    const spawned = await call(ctx, parent, 'spawn_agent', { message: 'Start old work' })
    expect(spawned.isError, text(spawned)).toBe(false)
    const id = value(spawned).agent_id as string
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const sent = await call(ctx, parent, 'send_input', { target: id, message: 'Do new work', interrupt: true })
    expect(sent.isError, text(sent)).toBe(false)
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('Do new work')
    await idleChild(ctx, SessionId(id))
    const waited = await call(ctx, parent, 'wait_agent', { targets: [id], timeout_ms: 10 })
    expect(value(waited)).toEqual({ status: { [id]: { completed: 'redirected answer' } }, timed_out: false })
  })

  it('consumes a nickname when child creation fails without publishing that child', async () => {
    const { ctx, parent } = await setup(new MockAdapter([textResponse('done')]))
    const reserved = vi.spyOn(CodexV1NicknamePool.prototype, 'reserve')
    vi.spyOn(ctx.codexySubagents, 'startContinuable').mockRejectedValueOnce(new Error('child creation failed'))
    const failed = await call(ctx, parent, 'spawn_agent', { message: 'Failed task' })
    expect(failed.isError).toBe(true)
    expect(text(failed)).toContain('child creation failed')
    expect(await ctx.codexySubagents.listChildren(parent.id)).toEqual([])
    expect(CodexV1.codexV1LiveNicknames(ctx.codexySubagents, parent.id).size).toBe(0)
    const next = await call(ctx, parent, 'spawn_agent', { message: 'Next task' })
    expect(next.isError, text(next)).toBe(false)
    expect(reserved).toHaveBeenCalledTimes(2)
    const failedNickname: unknown = reserved.mock.results[0]?.value
    const nextNickname: unknown = reserved.mock.results[1]?.value
    expect(typeof failedNickname).toBe('string')
    expect(value(next).nickname).toBe(nextNickname)
    expect(value(next).nickname).not.toBe(failedNickname)
  })

  it('restores committed nicknames after its tool plugin reloads', async () => {
    const { ctx, parent, v1 } = await setup(new MockAdapter([textResponse('old'), textResponse('new')]))
    const old = await call(ctx, parent, 'spawn_agent', { message: 'Old task' })
    expect(old.isError, text(old)).toBe(false)
    const id = SessionId(value(old).agent_id as string)
    const nickname = value(old).nickname
    const callId = ToolCallId('persisted-v1-nickname')
    parent.session.append('tool/call', {
      turn: 1, step: 1, callId, name: 'multi_agent_v1__spawn_agent', arguments: '{"message":"Old task"}',
    })
    parent.session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId, content: old.content, isError: false }),
    }, { surfaceOp: 'append' })
    await v1.dispose()
    expect(ctx.codexyTools.schemas().some(tool => tool.namespace?.name === 'multi_agent_v1')).toBe(false)
    expect(CodexV1.codexV1LiveNicknames(ctx.codexySubagents, parent.id).size).toBe(0)
    await ctx.plugin(CodexV1, {})
    const next = await call(ctx, parent, 'spawn_agent', { message: 'New task' })
    expect(next.isError, text(next)).toBe(false)
    expect(value(next).nickname).not.toBe(nickname)
    expect(CodexV1.codexV1LiveNicknames(ctx.codexySubagents, parent.id).get(id)).toBe(nickname)
    expect(CodexV1.codexV1NicknamesFromLog(parent.session.snapshotEvents(), parent.session.inheritedEventCount).get(id))
      .toBe(nickname)
  })

  it('restores the child-owned nickname when reload precedes its parent result', async () => {
    const { ctx, parent, v1 } = await setup(new MockAdapter([textResponse('old'), textResponse('new')]))
    const spawned = await call(ctx, parent, 'spawn_agent', { message: 'Old task' })
    expect(spawned.isError, text(spawned)).toBe(false)
    const id = SessionId(value(spawned).agent_id as string)
    const child = await idleChild(ctx, id)
    const nickname = value(spawned).nickname
    expect(codexV1IdentityOf(child.session, ctx.sessionProjections)?.nickname).toBe(nickname)
    expect(CodexV1.codexV1NicknamesFromLog(parent.session.snapshotEvents(), parent.session.inheritedEventCount).size).toBe(0)
    await v1.dispose()
    expect(CodexV1.codexV1LiveNicknames(ctx.codexySubagents, parent.id).size).toBe(0)
    await ctx.plugin(CodexV1, {})
    const next = await call(ctx, parent, 'spawn_agent', { message: 'New task' })
    expect(next.isError, text(next)).toBe(false)
    expect(value(next).nickname).not.toBe(nickname)
    expect(CodexV1.codexV1LiveNicknames(ctx.codexySubagents, parent.id).get(id)).toBe(nickname)
    expect(ctx.agents.get(id)).toBe(child)
  })

  it('rejects conflicting parent and child nicknames before publishing another child', async () => {
    const { ctx, parent } = await setup(new MockAdapter([textResponse('old')]))
    const spawned = await call(ctx, parent, 'spawn_agent', { message: 'Old task' })
    expect(spawned.isError, text(spawned)).toBe(false)
    const id = SessionId(value(spawned).agent_id as string)
    await idleChild(ctx, id)
    const callId = ToolCallId('conflicting-v1-nickname')
    parent.session.append('tool/call', {
      turn: 1, step: 1, callId, name: 'multi_agent_v1__spawn_agent', arguments: '{"message":"Old task"}',
    })
    parent.session.append('tool/result', {
      turn: 1, step: 1, message: createToolResultMessage({ callId, content: [{
        type: 'text', text: JSON.stringify({ agent_id: id, nickname: 'Conflicting nickname' }),
      }], isError: false }),
    }, { surfaceOp: 'append' })
    const started = vi.spyOn(ctx.codexySubagents, 'startContinuable')
    const next = await call(ctx, parent, 'spawn_agent', { message: 'New task' })
    expect(next.isError).toBe(true)
    expect(text(next)).toContain('Conflicting Codex v1 nickname')
    expect(started).not.toHaveBeenCalled()
    expect(await ctx.codexySubagents.listChildren(parent.id)).toHaveLength(1)
    expect(CodexV1.codexV1LiveNicknames(ctx.codexySubagents, parent.id).get(id)).toBe(value(spawned).nickname)
  })

  it('loads a legacy child before restoring its nickname without submitting a turn', async () => {
    const adapter = new MockAdapter([textResponse('legacy answer')])
    const { ctx, parent } = await setup(adapter, { minWaitMs: 0, defaultWaitMs: 10, maxWaitMs: 100 })
    const legacy = await ctx.codexySubagents.startContinuable({
      provider: 'spawn', label: 'Codex v1 agent', signal,
      request: { parent, prompt: [{ type: 'text', text: 'Legacy task' }], delegatedApprovalPolicy: 'inherit', maxDepth: 1 },
    })
    await vi.waitFor(() => { expect(ctx.agents.get(legacy.childId)).toBeUndefined() })
    expect(value(await call(ctx, parent, 'wait_agent', { targets: [legacy.childId], timeout_ms: 10 })))
      .toEqual({ status: { [legacy.childId]: 'not_found' }, timed_out: false })
    const unloadedInput = await call(ctx, parent, 'send_input', { target: legacy.childId, message: 'Do not cold load' })
    expect(unloadedInput.isError).toBe(true)
    expect(text(unloadedInput)).toContain('was not found; call resume_agent first')
    expect(ctx.agents.get(legacy.childId)).toBeUndefined()
    expect(adapter.requests).toHaveLength(1)
    const callId = ToolCallId('legacy-nickname')
    parent.session.append('tool/call', {
      turn: 1, step: 1, callId, name: 'multi_agent_v1__spawn_agent', arguments: '{"message":"Legacy task"}',
    })
    parent.session.append('tool/result', {
      turn: 1, step: 1, message: createToolResultMessage({ callId, content: [{
        type: 'text', text: JSON.stringify({ agent_id: legacy.childId, nickname: 'Euclid' }),
      }], isError: false }),
    }, { surfaceOp: 'append' })
    const resumed = await call(ctx, parent, 'resume_agent', { id: legacy.childId })
    expect(resumed.isError, text(resumed)).toBe(false)
    expect(value(resumed)).toEqual({ status: 'pending_init' })
    const child = await idleChild(ctx, legacy.childId)
    expect(adapter.requests).toHaveLength(1)
    expect(codexV1IdentityOf(child.session, ctx.sessionProjections)?.nickname).toBe('Euclid')
    const identityEvents = snapshotProductEvents(child.session).filter(event => event.type === 'subagent/codex-v1-identity')
    expect(identityEvents).toHaveLength(1)
    const warm = await call(ctx, parent, 'resume_agent', { id: legacy.childId })
    expect(value(warm)).toEqual({ status: 'pending_init' })
    expect(snapshotProductEvents(child.session).filter(event => event.type === 'subagent/codex-v1-identity')).toHaveLength(1)
  })

  it('keeps a failed cold resume closed without inventing a live child', async () => {
    const { ctx, parent } = await setup(new MockAdapter([textResponse('done')]))
    const spawned = await call(ctx, parent, 'spawn_agent', { message: 'Do work' })
    const id = SessionId(value(spawned).agent_id as string)
    await idleChild(ctx, id)
    expect(value(await call(ctx, parent, 'close_agent', { target: id }))).toEqual({ previous_status: { completed: 'done' } })
    const load = vi.spyOn(ctx.codexySubagents, 'loadContinuable').mockRejectedValueOnce(new Error('cold load failed'))
    const resumed = await call(ctx, parent, 'resume_agent', { id })
    expect(resumed.isError).toBe(true)
    expect(text(resumed)).toContain('cold load failed')
    expect(load).toHaveBeenCalledOnce()
    expect(ctx.agents.get(id)).toBeUndefined()
    expect(CodexV1.codexV1LiveRoster(ctx.codexySubagents, parent.id).get(id)).toBe('closed')
    const sent = await call(ctx, parent, 'send_input', { target: id, message: 'Must not run' })
    expect(sent.isError).toBe(true)
    expect(text(sent)).toContain('call resume_agent first')
  })

  it('keeps an actually resumed child open when reload precedes its resume result', async () => {
    const adapter = new MockAdapter([textResponse('old answer'), textResponse('new answer')])
    const config = { maxOpenAgents: 1, minWaitMs: 0, defaultWaitMs: 10, maxWaitMs: 100 }
    const { ctx, parent, v1 } = await setup(adapter, config)
    const spawned = await call(ctx, parent, 'spawn_agent', { message: 'Initial task' })
    expect(spawned.isError, text(spawned)).toBe(false)
    const id = SessionId(value(spawned).agent_id as string)
    await idleChild(ctx, id)
    const closed = await call(ctx, parent, 'close_agent', { target: id })
    expect(closed.isError, text(closed)).toBe(false)
    const callId = ToolCallId('persisted-v1-close-before-resume')
    parent.session.append('tool/call', {
      turn: 1, step: 1, callId, name: 'multi_agent_v1__close_agent', arguments: JSON.stringify({ target: id }),
    })
    parent.session.append('tool/result', {
      turn: 1, step: 1, message: createToolResultMessage({ callId, content: closed.content, isError: false }),
    }, { surfaceOp: 'append' })
    expect(CodexV1.codexV1ClosedAgentsFromLog(parent.session.snapshotEvents(), parent.session.inheritedEventCount))
      .toEqual(new Set([id]))
    const resumed = await call(ctx, parent, 'resume_agent', { id })
    expect(resumed.isError, text(resumed)).toBe(false)
    expect(value(resumed)).toEqual({ status: 'pending_init' })
    const child = await idleChild(ctx, id)
    await v1.dispose()
    expect(CodexV1.codexV1LiveRoster(ctx.codexySubagents, parent.id).size).toBe(0)
    await ctx.plugin(CodexV1, config)
    expect(ctx.agents.get(id)).toBe(child)
    expect(adapter.requests).toHaveLength(1)
    const full = await call(ctx, parent, 'spawn_agent', { message: 'Must respect the loaded child' })
    expect(full.isError).toBe(true)
    expect(text(full)).toContain('limit reached (1 open child agents)')
    expect(value(await call(ctx, parent, 'wait_agent', { targets: [id], timeout_ms: 1 })))
      .toEqual({ status: {}, timed_out: true })
    const sent = await call(ctx, parent, 'send_input', { target: id, message: 'New task' })
    expect(sent.isError, text(sent)).toBe(false)
    await idleChild(ctx, id)
    expect(adapter.requests).toHaveLength(2)
    const load = vi.spyOn(ctx.codexySubagents, 'loadContinuable')
    const warm = await call(ctx, parent, 'resume_agent', { id })
    expect(warm.isError, text(warm)).toBe(false)
    expect(value(warm)).toEqual({ status: { completed: 'new answer' } })
    expect(load).toHaveBeenCalledOnce()
    expect(ctx.agents.get(id)).toBe(child)
    expect(adapter.requests).toHaveLength(2)
    expect(value(await call(ctx, parent, 'wait_agent', { targets: [id], timeout_ms: 10 })))
      .toEqual({ status: { [id]: { completed: 'new answer' } }, timed_out: false })
  })

  it('admits a new child after an uncommitted close and plugin reload without counting cold catalog entries', async () => {
    const adapter = new MockAdapter([textResponse('old answer'), textResponse('new answer')])
    const config = { maxOpenAgents: 1 }
    const { ctx, parent, v1 } = await setup(adapter, config)
    const spawned = await call(ctx, parent, 'spawn_agent', { message: 'Old task' })
    expect(spawned.isError, text(spawned)).toBe(false)
    const oldId = SessionId(value(spawned).agent_id as string)
    await idleChild(ctx, oldId)
    const closed = await call(ctx, parent, 'close_agent', { target: oldId })
    expect(closed.isError, text(closed)).toBe(false)
    expect(ctx.agents.get(oldId)).toBeUndefined()
    await v1.dispose()
    expect(CodexV1.codexV1LiveRoster(ctx.codexySubagents, parent.id).size).toBe(0)
    expect(CodexV1.codexV1ClosedAgentsFromLog(parent.session.snapshotEvents(), parent.session.inheritedEventCount).size).toBe(0)
    await ctx.plugin(CodexV1, config)
    const next = await call(ctx, parent, 'spawn_agent', { message: 'New task' })
    expect(next.isError, text(next)).toBe(false)
    const newId = SessionId(value(next).agent_id as string)
    expect(newId).not.toBe(oldId)
    await idleChild(ctx, newId)
    expect(await ctx.codexySubagents.listChildren(parent.id)).toHaveLength(2)
    expect(ctx.agents.get(oldId)).toBeUndefined()
    const third = await call(ctx, parent, 'spawn_agent', { message: 'Must count the completed resident' })
    expect(third.isError).toBe(true)
    expect(text(third)).toContain('limit reached (1 open child agents)')
    const fullResume = await call(ctx, parent, 'resume_agent', { id: oldId })
    expect(fullResume.isError).toBe(true)
    expect(text(fullResume)).toContain('limit reached')
    expect(adapter.requests).toHaveLength(2)
  })

  it('keeps nickname allocations separate between root sessions', async () => {
    const { ctx, parent } = await setup(new MockAdapter([textResponse('first'), textResponse('second')]))
    const other = await ctx.agentLoop.create(SessionId('codex-v1-other-root'), { provider: 'mock', model: 'mock' })
    parkParent(ctx, other)
    const first = await call(ctx, parent, 'spawn_agent', { message: 'First root task' })
    const second = await call(ctx, other, 'spawn_agent', { message: 'Second root task' })
    expect(first.isError, text(first)).toBe(false)
    expect(second.isError, text(second)).toBe(false)
    expect(CodexV1.codexV1LiveNicknames(ctx.codexySubagents, parent.id))
      .toEqual(new Map([[SessionId(value(first).agent_id as string), value(first).nickname]]))
    expect(CodexV1.codexV1LiveNicknames(ctx.codexySubagents, other.id))
      .toEqual(new Map([[SessionId(value(second).agent_id as string), value(second).nickname]]))
  })

  it('uses a fresh child by default and rejects recursive v1 spawning at depth one', async () => {
    expect(() => { CodexV1.apply(new Context(), { maxDepth: 2 }) }).toThrow('maxDepth must be 0 or 1')
    const adapter = new MockAdapter(['hang'])
    const { ctx, parent } = await setup(adapter)
    const spawned = await call(ctx, parent, 'spawn_agent', { message: 'Do work' })
    expect(spawned.isError, text(spawned)).toBe(false)
    const id = value(spawned).agent_id as string
    const child = ctx.agents.get(SessionId(id))
    if (child === undefined) throw new Error('expected resident child')
    expect(child.session.header.delegationDepth).toBe(1)
    const nested = await call(ctx, child, 'spawn_agent', { message: 'Nested work' })
    expect(nested.isError).toBe(true)
    expect(text(nested)).toContain('depth limit')
    await ctx.codexySubagents.drainContinuableDescendants([parent])
  })

  it('rejects resume when the current depth limit has no child capacity', async () => {
    const { ctx, parent } = await setup(new MockAdapter([]), { maxDepth: 0 })
    const resumed = await call(ctx, parent, 'resume_agent', { id: 'prior-child' })
    expect(resumed.isError).toBe(true)
    expect(text(resumed)).toContain('depth limit')
  })
})
