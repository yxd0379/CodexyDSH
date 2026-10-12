import { assemblePrompt } from '@codexydsh/test-support/host-tools'
import { requestHeaderOf } from '@codexydsh/runtime/session'
import { snapshotProductEvents, deriveMessageNodes, appendProductEvent } from '@codexydsh/runtime/session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@codexydsh/runtime/agent'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@codexydsh/runtime'
import { mountAgentLoopTestDependencies } from '@codexydsh/runtime-testkit'
import { LlmAdapter, ReasoningEffortId, ToolCallId, createDeveloperMessage, createSystemMessage, createUserMessage } from '@codexydsh/runtime/llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk, ToolSchema } from '@codexydsh/runtime/llm'
import { TOOL_REQUEST_CAPTURE } from '@codexydsh/runtime/tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@codexydsh/runtime/persistence'
import SubagentRuntime from '@codexydsh/delegation'
import * as Fork from '@codexydsh/fork'
import * as Spawn from '@codexydsh/spawn'
import ApprovalService from '@codexydsh/approval'
import { MockAdapter, textResponse, toolCallResponse } from '@codexydsh/runtime-testkit/mock-adapter'
import { TestSessionQuery } from '../../delegation/tests/test-session-query.ts'
import { parkParent } from '../../delegation/tests/park-parent.ts'
import * as CodexfulV2 from '../src/codexful-v2.ts'
import type { CatalogModel } from '../src/codexful-v2-spec.ts'
import { SCENARIOS } from './codexful-v2-source-scenarios.ts'

const roots: string[] = []
const contexts: Context[] = []
const signal = new AbortController().signal
let calls = 0

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Hold a child turn open so queue-only delivery can be observed before settlement. */
class GatedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly release: Promise<undefined>) { super() }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    await this.release
    yield* textResponse('child done')
  }
}

/** Keep the first child running while a nested child settles. */
class FirstRequestGatedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly release: Promise<undefined>) { super() }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) await this.release
    yield* textResponse('done')
  }
}

/** Hold selected child requests independently to observe parent completion before descendant disposal. */
class RequestGatedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly releases: readonly Promise<undefined>[]) { super() }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const index = this.requests.push(options) - 1
    await this.releases[index]
    yield* textResponse('done')
  }
}

/** Advertise catalog policy separately from the selected route's namespace capability. */
class CatalogAdapter extends MockAdapter {
  readonly catalogProviders: string[] = []
  readonly resolvedModels: { provider: string; model: string }[] = []

  constructor(private readonly nativeNamespaces: boolean, private readonly models: readonly CatalogModel[] = []) {
    super([textResponse('done')])
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    this.catalogProviders.push(provider)
    return Promise.resolve(this.models.map(model => ({
      provider, id: model.model, name: model.model, description: model.description,
      showInPicker: model.showInPicker,
      ...model.multiAgentVersion === null ? {} : { multiAgentVersion: model.multiAgentVersion },
      serviceTiers: model.serviceTiers,
    })))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    this.resolvedModels.push({ provider, model })
    const entry = this.models.find(item => item.model === model)
    return Promise.resolve({
      provider, id: model, name: model,
      ...model === 'mock' && this.nativeNamespaces ? { toolNamespaces: 'native' as const } : {},
      ...entry === undefined ? {} : {
        reasoning: {
          efforts: entry.supportedReasoningEfforts.map(id => ({ id: ReasoningEffortId(id), name: id })),
          ...entry.defaultReasoningEffort === '' ? {} : { defaultEffort: ReasoningEffortId(entry.defaultReasoningEffort) },
        },
      },
    })
  }
}

function sourceTools(name: string): ToolSchema[] {
  return (JSON.parse(readFileSync(new URL(
    `./fixtures/codexful-v2-source/${name}.json`, import.meta.url,
  ), 'utf8')) as { dshTools: ToolSchema[] }).dshTools
}

async function setup(adapter: LlmAdapter, config: CodexfulV2.Config = {}, park = true, forkHistory = false) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-codexful-v2-subagent-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root, leaseStaleMs: 30_000, leaseUpdateMs: 10_000 })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(Fork, { providerName: 'fork', codexfulHistory: forkHistory })
  await ctx.plugin(CodexfulV2, config)
  ctx.codexyRequests.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  if (park) parkParent(ctx, parent)
  return { ctx, parent }
}

function call(ctx: Context, agent: Agent, name: string, args: unknown) {
  return ctx.codexyTools.execute({
    signal,
    callId: ToolCallId(`codexful-v2-${++calls}`),
    name,
    arguments: args,
    agent,
  })
}

function text(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('Codexful v2 subagent tools', () => {
  it('does not resolve a hidden v2 catalog for a prepared v1 request', async () => {
    const adapter = new CatalogAdapter(false)
    const directory = vi.spyOn(adapter, 'listModels').mockRejectedValue(new Error('v2 catalog unavailable'))
    const { ctx, parent } = await setup(adapter, {}, false)
    ctx.on('codexy-prompt/prepare', async (_variables, _context, next) => ({
      ...await next(), codexful_multi_agent_version: 'v1',
    }))
    ctx.on('codexy-prompt/assemble', async (_assembly, _context, next) => ({
      ...await next(), tools: [],
    }))
    parent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Use the active v1 group' }], source: { kind: 'user' },
    }))
    await parent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.tools).toBeUndefined()
    expect(directory).not.toHaveBeenCalled()
  })

  for (const nativeNamespaces of [false, true]) {
    it(`sends the pinned six schemas in a ${nativeNamespaces ? 'namespaced' : 'flat'} model request`, async () => {
      const adapter = new CatalogAdapter(nativeNamespaces)
      const { parent, ctx } = await setup(adapter, {}, false)
      ctx.on('codexy-agent/request', async (_request, next) => ({ ...await next(), codexfulResponses: {
        omitDefaultMaxTokens: true, reasoningSummary: 'auto',
      } }))
      parent.followup(createUserMessage({
        content: [{ type: 'text', text: 'Inspect the tools' }], source: { kind: 'user' },
      }))
      await parent.whenIdle()

      const expected = sourceTools(nativeNamespaces ? 'effective-default-empty-catalog' : 'namespace-not-supported')
      expect(adapter.requests, JSON.stringify(parent.session.snapshotEvents().slice(-5))).toHaveLength(1)
      expect(JSON.stringify(adapter.requests[0]?.tools)).toBe(JSON.stringify(expected))
      expect(adapter.requests[0]?.codexfulResponses).toEqual({ omitDefaultMaxTokens: true, reasoningSummary: 'auto' })
      expect(adapter.catalogProviders).toEqual(['mock'])
      const header = requestHeaderOf(parent.session)
      expect(header?.tools).toEqual(expected)
    })
  }

  it('resolves one same-provider catalog for all six tools with the pinned five-model limit', async () => {
    const models = SCENARIOS.find(scenario => scenario.name === 'catalog-limit-unicode-and-empty-suffixes')!.input.models!
    const adapter = new CatalogAdapter(true, models)
    const { ctx, parent } = await setup(adapter, {}, false)
    ctx.codexyRequests.registerAdapter(['other-provider'], new CatalogAdapter(true, models))
    parent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Inspect model overrides' }], source: { kind: 'user' },
    }))
    await parent.whenIdle()

    expect(adapter.requests, JSON.stringify(parent.session.snapshotEvents().slice(-5))).toHaveLength(1)
    expect(JSON.stringify(adapter.requests[0]?.tools)).toBe(JSON.stringify(sourceTools('catalog-limit-unicode-and-empty-suffixes')))
    expect(adapter.catalogProviders).toEqual(['mock'])
    expect(adapter.resolvedModels.every(entry => entry.provider === 'mock')).toBe(true)
    const resolvedCatalog = adapter.resolvedModels.filter(entry => entry.model !== 'mock').map(entry => entry.model)
    expect(resolvedCatalog).toEqual(models.filter(model => model.showInPicker && model.multiAgentVersion !== 'disabled')
      .slice(0, 5).map(model => model.model))
  })

  it('binds override-disabled schemas to matching validation before executing a spawn', async () => {
    const adapter = new CatalogAdapter(false)
    const { ctx, parent } = await setup(adapter, { exposeSpawnAgentModelOverrides: false })
    const context = { agent: parent, scope: parent, signal }
    const preparation = await ctx.codexyPrompt.prepare(context)
    const capture = await ctx.codexyTools.prepareRequest({ context, variables: preparation.variables })
    const assembly = await ctx.codexyPrompt.assemble({ ...context, [TOOL_REQUEST_CAPTURE]: capture }, preparation)
    const binding = ctx.codexyTools.bindAssembly(capture, assembly.tools)
    const expected = sourceTools('overrides-disabled').map(({ namespace: _namespace, ...tool }) => tool)
    expect(JSON.stringify(ctx.codexyTools.requestSchemas(binding))).toBe(JSON.stringify(expected))

    const result = await ctx.codexyTools.execute({
      signal, agent: parent, name: 'spawn_agent', callId: ToolCallId('overrides-disabled'),
      requestBinding: binding,
      arguments: { task_name: 'reader', message: 'Read', fork_turns: 'none', model: 'other' },
    })
    expect(result.error?.info?.code).toBe('INVALID_ARGS')
    expect(text(result)).toContain('model')
    expect(await ctx.codexySubagents.listDescendants(parent.id, signal)).toEqual([])
    expect(adapter.catalogProviders).toEqual([])
  })

  it('omits the mode until spawn_agent is visible in the bound request', async () => {
    const adapter = new MockAdapter([textResponse('first'), textResponse('second')])
    const { ctx, parent } = await setup(adapter, {}, false)
    const hideSpawn = ctx.on('codexy-prompt/assemble', async (_assembly, _context, next) => {
      const assembled = await next()
      return { ...assembled, tools: assembled.tools.filter(tool => tool.name !== 'spawn_agent') }
    })
    const run = async (count: number): Promise<void> => {
      parent.followup(createUserMessage({
        content: [{ type: 'text', text: 'Continue' }], source: { kind: 'user' },
      }))
      await vi.waitFor(() => { expect(adapter.requests).toHaveLength(count) })
      await parent.whenIdle()
    }
    await run(1)
    expect(adapter.requests[0]?.tools?.some(tool => tool.name === 'spawn_agent')).toBe(false)
    expect(adapter.requests[0]?.messages.some(message => message.content.some(block =>
      block.type === 'text' && block.text.startsWith('<multi_agent_mode>')))).toBe(false)
    hideSpawn()
    await run(2)
    expect(adapter.requests[1]?.tools?.some(tool => tool.name === 'spawn_agent')).toBe(true)
    expect(adapter.requests[1]?.messages.some(message => message.content.some(block =>
      block.type === 'text' && block.text.startsWith('<multi_agent_mode>')))).toBe(true)
  })

  it('appends a separate mode from the current prepared effort and reuses unchanged history', async () => {
    const adapter = new MockAdapter(Array.from({ length: 4 }, () => textResponse('done')), {
      efforts: [
        { id: ReasoningEffortId('low'), name: 'Low' },
        { id: ReasoningEffortId('ultra'), name: 'Ultra' },
      ],
    })
    const { ctx, parent } = await setup(adapter, {}, false)
    let effort = 'low'
    ctx.on('codexy-agent/request', async (_request, next) => ({
      ...await next(), reasoningEffort: ReasoningEffortId(effort),
    }))
    const run = async (): Promise<string[]> => {
      const expectedRequests = adapter.requests.length + 1
      parent.followup(createUserMessage({
        content: [{ type: 'text', text: 'Continue' }], source: { kind: 'user' },
      }))
      await vi.waitFor(() => {
        expect(adapter.requests, JSON.stringify(parent.session.snapshotEvents().slice(-6))).toHaveLength(expectedRequests)
      })
      await parent.whenIdle()
      return adapter.requests.at(-1)!.messages.flatMap(message => message.content.flatMap(block =>
        block.type === 'text' && block.text.startsWith('<multi_agent_mode>') ? [block.text] : []))
    }
    const first = await run()
    expect(first).toHaveLength(1)
    expect(first[0]).toContain('Do not spawn sub-agents unless')
    effort = 'ultra'
    const second = await run()
    expect(second).toHaveLength(2)
    expect(second[1]).toContain('Proactive multi-agent delegation is active')
    expect(await run()).toEqual(second)
    effort = 'low'
    const fourth = await run()
    expect(fourth).toHaveLength(3)
    expect(fourth[2]).toBe(first[0])
    const role = adapter.requests[0]!.messages.flatMap(message => message.content.flatMap(block =>
      block.type === 'text' && block.text.startsWith('You are `/root`') ? [block.text] : []))
    expect(role).toHaveLength(1)
    expect(role[0]).not.toContain('<multi_agent_mode>')
    expect(snapshotProductEvents(parent.session).filter(event => event.type === 'developer/message'
      || event.type === 'user/message').some((event) => {
      const message = event.type === 'developer/message' ? event.data.message : event.data
      return message.source.kind === 'runtime-context' && message.source.form === 'snapshot'
        && message.source.sections.some(section => section.name === 'codexful-v2:multi-agent-mode')
    })).toBe(true)
  })

  it('re-roles the retained mode when developer-history support changes', async () => {
    const adapter = new MockAdapter(Array.from({ length: 3 }, () => textResponse('done')))
    adapter.developerHistory = 'native'
    const { parent } = await setup(adapter, {}, false)
    const run = async (): Promise<{ role: string; text: string }[]> => {
      const expectedRequests = adapter.requests.length + 1
      parent.followup(createUserMessage({
        content: [{ type: 'text', text: 'Continue' }], source: { kind: 'user' },
      }))
      await vi.waitFor(() => { expect(adapter.requests).toHaveLength(expectedRequests) })
      await parent.whenIdle()
      return adapter.requests.at(-1)!.messages.flatMap(message => message.content.flatMap(block =>
        block.type === 'text' && block.text.startsWith('<multi_agent_mode>')
          ? [{ role: message.role, text: block.text }] : []))
    }
    const expectRole = async (role: string): Promise<void> => {
      const modes = await run()
      expect(modes).toHaveLength(1)
      expect(modes[0]?.role).toBe(role)
      expect(modes[0]?.text).toContain('Do not spawn sub-agents')
    }
    await expectRole('developer')
    adapter.developerHistory = undefined
    await expectRole('user')
    adapter.developerHistory = 'native'
    await expectRole('developer')
  })

  it('supplies the pinned root role and mailbox envelope in the model request', async () => {
    const adapter = new MockAdapter([textResponse('done')])
    const { parent } = await setup(adapter, {}, false)
    parent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Inspect the request' }], source: { kind: 'user' },
    }))
    await parent.whenIdle()
    const input = JSON.stringify(adapter.requests[0]!.messages)
    expect(input).toContain('You are `/root`, the primary agent')
    expect(input).toContain('Message Type: MESSAGE | FINAL_ANSWER')
    expect(input).toContain('Task name: <recipient>')
    expect(input).toContain('All agents have access to the same container and filesystem as you.')
    expect(input).toContain('Note that collaboration tools cannot be called from inside `functions.exec`')
    expect(input).not.toContain('<multi_agent_role>')
  })

  it('selects role text from the current assembled route across model changes', async () => {
    const adapter = new MockAdapter([textResponse('first'), textResponse('second')])
    const { ctx, parent } = await setup(adapter, {}, false)
    const selection: ModelSelectionRef = {
      current: { provider: 'mock', model: 'gpt-6-sol' }, assembled: undefined,
    }
    parent.ctx.effect(() => installModelSelection(parent.ctx, selection))
    const assemblyRole = async (): Promise<string | undefined> => {
      const assembled = await assemblePrompt(ctx, { agent: parent, scope: parent })
      return assembled.contexts.find(section => section.name === 'codexful-v2:multi-agent-role')?.text
    }
    expect(parent.options.model).toBe('mock')
    expect(await assemblyRole()).toBe(CodexfulV2.renderCodexfulV2Role({
      model: 'gpt-6-sol', child: false, maxConcurrency: 4,
    }))
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    expect(adapter.requests[0]?.model).toBe('gpt-6-sol')
    expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('`send_message` calls may be read by a human')

    selection.current = { provider: 'mock', model: 'gpt-5.6-sol' }
    expect(await assemblyRole()).toBe(CodexfulV2.renderCodexfulV2Role({
      model: 'gpt-5.6-sol', child: false, maxConcurrency: 4,
    }))
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue again' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    expect(adapter.requests[1]?.model).toBe('gpt-5.6-sol')
  })

  it('exposes the v2 names, rejects invalid fork counts, and leaves no child', async () => {
    const { ctx, parent } = await setup(new MockAdapter([]))
    expect(ctx.codexyTools.schemas().map(schema => schema.name)).toEqual(expect.arrayContaining([
      'spawn_agent', 'send_message', 'followup_task', 'wait_agent', 'interrupt_agent', 'list_agents',
    ]))
    const result = await call(ctx, parent, 'spawn_agent', {
      task_name: 'research', message: 'Read the files', fork_turns: '0',
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('fork_turns must be `none`, `all`, or a positive integer string')
    const unsupported = await call(ctx, parent, 'spawn_agent', {
      task_name: 'research', message: 'Read the files', fork_turns: '1',
    })
    expect(unsupported.isError).toBe(true)
    expect(text(unsupported)).toContain('does not support forkTurns')
    const inheritedOverride = await call(ctx, parent, 'spawn_agent', {
      task_name: 'research', message: 'Read the files', fork_turns: 'all', model: 'another',
    })
    expect(inheritedOverride.isError).toBe(true)
    expect(text(inheritedOverride)).toContain('full-history forks inherit')
    expect(await ctx.codexySubagents.listChildren(parent.id)).toEqual([])
  })

  it('rejects reserved names and malformed task-path references as tool feedback', async () => {
    const { ctx, parent } = await setup(new MockAdapter([]))
    const reserved = await call(ctx, parent, 'spawn_agent', {
      task_name: 'root', message: 'Work', fork_turns: 'none',
    })
    expect(reserved.isError).toBe(true)
    expect(text(reserved)).toContain('agent_name `root` is reserved')
    const relative = await call(ctx, parent, 'list_agents', { path_prefix: '../sibling' })
    expect(relative.isError).toBe(true)
    expect(text(relative)).toContain('agent_name `..` is reserved')
    const absolute = await call(ctx, parent, 'list_agents', { path_prefix: '/root/worker/' })
    expect(absolute.isError).toBe(true)
    expect(text(absolute)).toContain('absolute agent path must not end with `/`')
    const target = await call(ctx, parent, 'send_message', { target: '/other/worker', message: 'Work' })
    expect(target.isError).toBe(true)
    expect(text(target)).toContain('absolute agent paths must start with `/root`')
    expect(await ctx.codexySubagents.listChildren(parent.id)).toEqual([])
  })

  it('forks only the selected recent parent turn and replays the child input', async () => {
    const adapter = new MockAdapter([
      textResponse('first answer'), textResponse('second answer'), textResponse('child answer'),
    ])
    const { ctx, parent } = await setup(adapter, {}, false, true)
    parent.followup(createUserMessage({
      content: [{ type: 'text', text: 'first parent task' }], source: { kind: 'user' },
    }))
    await parent.whenIdle()
    parent.followup(createUserMessage({
      content: [{ type: 'text', text: 'second parent task' }], source: { kind: 'user' },
    }))
    await parent.whenIdle()
    const oldNodes = parent.session.surface.nodes
    const oldUser = oldNodes.find(seq => parent.session.eventAt(seq)?.type === 'user/message')!
    const oldAnswer = oldNodes.find(seq => parent.session.eventAt(seq)?.type === 'assistant/message')!
    parent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'earlier summary' }],
      source: { kind: 'runtime-context', form: 'instructions' },
    }), {
      surfaceOp: { op: 'replace', startSeq: oldUser, endSeq: oldAnswer },
      sourceEventSeqs: oldNodes.slice(oldNodes.indexOf(oldUser), oldNodes.indexOf(oldAnswer) + 1),
    })

    const spawned = await call(ctx, parent, 'spawn_agent', {
      task_name: 'recent', message: 'child task', fork_turns: '1',
    })
    expect(spawned.isError, text(spawned)).not.toBe(true)
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(3) })
    const child = (await ctx.codexySubagents.listChildren(parent.id)).find(entry => entry.label === '/root/recent')
    expect(child).toBeDefined()
    const session = ctx.agents.get(child!.id)!.session
    const received = adapter.requests[2]!.messages
      .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text))
    expect(received).not.toContain('first parent task')
    expect(received).not.toContain('first answer')
    expect(received).not.toContain('earlier summary')
    expect(received).toContain('second parent task')
    expect(received).toContain('second answer')
    expect(received.some(text => text.includes('child task'))).toBe(true)
    expect(snapshotProductEvents(session).some(event => event.type === 'subagent/fork-window'
      && event.data.lastNTurns === 1)).toBe(true)
    const restored = Session.create(session.id, session.snapshotEvents(), session.header,
      session.inheritedEventCount)
    expect(restored.deriveMessages()).toEqual(session.deriveMessages())
  })

  it('persists canonical task names and the inherited approval policy in a fresh child', async () => {
    const { ctx, parent } = await setup(new MockAdapter([textResponse('child done')]))
    const result = await call(ctx, parent, 'spawn_agent', {
      task_name: 'research', message: 'Read the files', fork_turns: 'none',
    })
    expect(result.isError).toBe(false)
    expect(JSON.parse(text(result))).toEqual({ task_name: '/root/research' })
    const children = await ctx.codexySubagents.listChildren(parent.id)
    expect(children).toHaveLength(1)
    expect(children[0]).toMatchObject({ label: '/root/research', mode: 'continuable' })
    const child = ctx.agents.get(children[0]!.id)
    expect(child === undefined ? undefined : snapshotProductEvents(child.session)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'approval/policy', data: { policy: 'ask', source: 'delegation' } }),
    ]))
    const duplicate = await call(ctx, parent, 'spawn_agent', {
      task_name: 'research', message: 'Read the files again', fork_turns: 'none',
    })
    expect(duplicate.isError).toBe(true)
    expect(text(duplicate)).toContain('already exists')
  })

  it('uses the parent Session override when it inherits child approval', async () => {
    const { ctx, parent } = await setup(new MockAdapter([textResponse('child done')]))
    appendProductEvent(parent.session, 'approval/policy', { policy: 'never' })
    const result = await call(ctx, parent, 'spawn_agent', {
      task_name: 'worker', message: 'Inspect', fork_turns: 'none',
    })
    expect(result.isError).toBe(false)
    const [entry] = await ctx.codexySubagents.listChildren(parent.id)
    const child = ctx.agents.get(entry!.id)
    expect(child === undefined ? undefined : snapshotProductEvents(child.session)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'approval/policy', data: { policy: 'never', source: 'delegation' } }),
    ]))
  })

  it.each(['native', 'fallback'] as const)(
    'replaces a completed parent turn\'s root role before a forked child request (%s)',
    async (developerHistory) => {
      const adapter = new MockAdapter([
        textResponse('parent done'), textResponse('child done'), textResponse('settlement noted'),
      ])
      adapter.developerHistory = developerHistory === 'native' ? 'native' : undefined
      const { ctx, parent } = await setup(adapter, {}, false)
      ctx.codexyPrompt.context({ name: 'fixture:retained', order: 0, role: 'developer', text: 'Retain this unrelated instruction.' })
      parent.followup(createUserMessage({
        content: [{ type: 'text', text: 'Delegate after this turn' }],
        source: { kind: 'user' },
      }))
      await parent.whenIdle()
      expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('You are `/root`')
      const inheritedRole = {
        content: [{ type: 'text' as const, text: 'Inherited metadata-only root role.' }],
        source: {
          kind: 'runtime-context' as const, form: 'snapshot' as const,
          sections: [{ name: 'fixture:metadata-role', text: 'Inherited metadata-only root role.' }],
          codexMultiAgentWorldState: { section: 'multi-agent-role' as const, mode: 'full' as const, snapshot: 'Inherited metadata-only root role.' },
        },
      }
      if (developerHistory === 'native') {
        parent.session.append('developer/message', { turn: 1, step: 1, message: createDeveloperMessage(inheritedRole) }, { surfaceOp: 'append' })
      } else {
        parent.session.append('user/message', createUserMessage(inheritedRole), { surfaceOp: 'append' })
      }
      const spawned = await call(ctx, parent, 'spawn_agent', {
        task_name: 'worker', message: 'Continue the work', fork_turns: 'all',
      })
      expect(spawned.isError).toBe(false)
      await vi.waitFor(() => { expect(adapter.requests.length).toBeGreaterThanOrEqual(2) })
      const childInput = JSON.stringify(adapter.requests[1]!.messages)
      expect(childInput).toContain('You are an agent in a team of agents')
      expect(childInput).not.toContain('You are `/root`')
      expect(childInput).not.toContain('Inherited metadata-only root role.')
      expect(childInput).toContain('Retain this unrelated instruction.')
      const child = (await ctx.codexySubagents.listChildren(parent.id))[0]
      if (child === undefined) throw new Error('expected forked child')
      const session = ctx.agents.get(child.id)?.session
      if (session === undefined) throw new Error('expected live forked child')
      const modeNodes = deriveMessageNodes(session).filter(({ message }) =>
        message.source.kind === 'runtime-context' && message.source.form === 'snapshot'
        && message.source.sections.some(section => section.name === 'codexful-v2:multi-agent-mode'))
      expect(modeNodes).toHaveLength(1)
      expect(modeNodes[0]!.seq).toBeGreaterThanOrEqual(Number(session.inheritedEventCount))
    },
  )

  it('queues send_message without waking an idle parent and lets wait_agent observe the mailbox', async () => {
    const release = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter(release.promise)
    const { ctx, parent } = await setup(adapter, {
      minWaitMs: 0, defaultWaitMs: 200, maxWaitMs: 500,
    })
    const started = await call(ctx, parent, 'spawn_agent', {
      task_name: 'worker', message: 'Work until released', fork_turns: 'none',
    })
    expect(started.isError).toBe(false)
    const [entry] = await ctx.codexySubagents.listChildren(parent.id)
    const child = ctx.agents.get(entry!.id)
    if (child === undefined) throw new Error('expected live child')
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    expect(JSON.stringify(adapter.requests[0]!.messages)).not.toContain('<multi_agent_role>')
    expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('Message Type: NEW_TASK | MESSAGE | FINAL_ANSWER')
    expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('You may also see them addressed as to=/root/...')
    const initialTask = adapter.requests[0]!.messages.flatMap(message => message.content.flatMap(block =>
      block.type === 'text' && block.text.startsWith('Message Type: NEW_TASK') ? [block.text] : []))
    expect(initialTask).toEqual([
      'Message Type: NEW_TASK\nTask name: /root/worker\nSender: /root\nPayload:\nWork until released',
    ])
    expect(JSON.stringify(adapter.requests[0]!.messages)).not.toContain('Your parent agent id')
    expect(snapshotProductEvents(child.session).some(event => event.type === 'user/message'
      && event.data.source.kind === 'agent-message'
      && event.data.source.senderSessionId === parent.id
      && event.data.content[0]?.type === 'text'
      && event.data.content[0].text === initialTask[0])).toBe(true)
    const wait = call(ctx, parent, 'wait_agent', { timeout_ms: 200 })
    const sent = await call(ctx, child, 'send_message', { target: '/root', message: 'Found the file' })
    expect(sent.isError, text(sent)).toBe(false)
    expect(parent.status).toBe('idle')
    expect(parent.inbox.nextTurn.some(message => message.source.kind === 'agent-message')).toBe(true)
    expect(parent.inbox.nextTurn.flatMap(message => message.content.flatMap(block =>
      block.type === 'text' ? [block.text] : []))).toContain(
      'Message Type: MESSAGE\nTask name: /root\nSender: /root/worker\nPayload:\nFound the file',
    )
    expect(JSON.parse(text(await wait))).toMatchObject({ message: 'Wait completed.', timed_out: false })
    release.resolve(undefined)
    await vi.waitFor(() => { expect(ctx.agents.get(child.id)?.status).toBe('idle') })
    expect(ctx.agents.get(child.id)).toBe(child)
    expect(parent.inbox.nextTurn.flatMap(message => message.content.flatMap(block =>
      block.type === 'text' ? [block.text] : []))).toContain(
      'Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/worker\nPayload:\nchild done',
    )
  })

  it('delivers queue-only mail to the next request of a running waiting parent', async () => {
    const adapter = new MockAdapter([
      'hang',
      toolCallResponse('wait-parent', 'wait_agent', { timeout_ms: 200 }),
      toolCallResponse('wait-parent-again', 'wait_agent', { timeout_ms: 20 }),
      textResponse('parent done'),
    ])
    const { ctx, parent } = await setup(adapter, {
      minWaitMs: 0, defaultWaitMs: 200, maxWaitMs: 500,
    }, false)
    const spawned = await call(ctx, parent, 'spawn_agent', {
      task_name: 'worker', message: 'Wait for more work', fork_turns: 'none',
    })
    expect(spawned.isError).toBe(false)
    const [entry] = await ctx.codexySubagents.listChildren(parent.id)
    const child = ctx.agents.get(entry!.id)
    if (child === undefined) throw new Error('expected live child')
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    parent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Coordinate the child' }],
      source: { kind: 'user' },
    }))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
    const sent = await call(ctx, child, 'send_message', { target: '/root', message: 'Found the answer' })
    expect(sent.isError).toBe(false)
    expect(snapshotProductEvents(parent.session).some(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => message.source.kind === 'agent-message'
        && message.source.queueOnly === true))).toBe(true)
    await vi.waitFor(() => { expect(adapter.requests.length).toBeGreaterThanOrEqual(3) })
    expect(JSON.stringify(adapter.requests[2]!.messages)).toContain('Found the answer')
    await parent.whenIdle()
    expect(adapter.requests).toHaveLength(4)
    expect(JSON.stringify(adapter.requests[3]!.messages)).toContain('Wait timed out.')
  })

  it('routes sibling mail within one root tree and treats path prefixes as segments', async () => {
    const release = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter(release.promise)
    const { ctx, parent } = await setup(adapter)
    for (const task_name of ['foo', 'foobar']) {
      const spawned = await call(ctx, parent, 'spawn_agent', {
        task_name, message: 'Keep working', fork_turns: 'none',
      })
      expect(spawned.isError).toBe(false)
    }
    const children = await ctx.codexySubagents.listChildren(parent.id)
    const sender = ctx.agents.get(children.find(child => child.label === '/root/foo')!.id)
    const receiver = ctx.agents.get(children.find(child => child.label === '/root/foobar')!.id)
    if (sender === undefined || receiver === undefined) throw new Error('expected live siblings')
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
    await expect(ctx.codexySubagents.sendMessage(sender, receiver.id, [{ type: 'text', text: 'Unscoped mail' }], {
      signal,
    })).rejects.toThrow(/belongs to another parent session/)
    const sent = await call(ctx, sender, 'send_message', {
      target: '/root/foobar', message: 'Sibling finding',
    })
    expect(sent.isError).toBe(false)
    expect(receiver.inbox.nextStep.some(message => message.source.kind === 'agent-message'
      && message.source.senderSessionId === sender.id)).toBe(true)
    const listed = await call(ctx, parent, 'list_agents', { path_prefix: '/root/foo' })
    expect(text(listed)).toContain('"agent_name":"/root/foo"')
    expect(text(listed)).not.toContain('"agent_name":"/root/foobar"')
    const all = await call(ctx, parent, 'list_agents', {})
    expect(text(all)).toContain('"agent_name":"/root"')
    expect(text(all)).toContain('"agent_name":"/root/foo"')
    expect(text(all)).toContain('"agent_name":"/root/foobar"')
    const rejectedFollowup = await call(ctx, sender, 'followup_task', {
      target: '/root', message: 'New task',
    })
    expect(rejectedFollowup.isError).toBe(true)
    expect(text(rejectedFollowup)).toContain("can't target the root")
    const rejectedInterrupt = await call(ctx, sender, 'interrupt_agent', { target: '/root' })
    expect(rejectedInterrupt.isError).toBe(true)
    expect(text(rejectedInterrupt)).toContain('root is not a spawned agent')
    release.resolve(undefined)
    await vi.waitFor(() => {
      expect(ctx.agents.get(sender.id)?.status).toBe('idle')
      expect(ctx.agents.get(receiver.id)?.status).toBe('idle')
    })
  })

  it('lets a sibling interrupt another live agent within the same root task tree', async () => {
    const adapter = new MockAdapter(['hang', 'hang'])
    const { ctx, parent } = await setup(adapter)
    for (const task_name of ['left', 'right']) {
      const spawned = await call(ctx, parent, 'spawn_agent', {
        task_name, message: 'Keep working', fork_turns: 'none',
      })
      expect(spawned.isError).toBe(false)
    }
    const children = await ctx.codexySubagents.listChildren(parent.id)
    const left = ctx.agents.get(children.find(child => child.label === '/root/left')!.id)
    const right = ctx.agents.get(children.find(child => child.label === '/root/right')!.id)
    if (left === undefined || right === undefined) throw new Error('expected live siblings')
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
    const interrupted = await call(ctx, left, 'interrupt_agent', { target: '/root/right' })
    expect(interrupted.isError).toBe(false)
    expect(text(interrupted)).toBe('{"previous_status":"running"}')
    await vi.waitFor(() => { expect(ctx.agents.get(right.id)?.status).toBe('idle') })
    const cleanup = await call(ctx, parent, 'interrupt_agent', { target: '/root/left' })
    expect(cleanup.isError).toBe(false)
    await vi.waitFor(() => { expect(ctx.agents.get(left.id)?.status).toBe('idle') })
  })

  it('counts the root among four resident agent slots', async () => {
    const adapter = new MockAdapter(['hang', 'hang', 'hang'])
    const { ctx, parent } = await setup(adapter)
    for (const task_name of ['three', 'one', 'two']) {
      const spawned = await call(ctx, parent, 'spawn_agent', {
        task_name, message: 'Keep working', fork_turns: 'none',
      })
      expect(spawned.isError).toBe(false)
    }
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(3) })
    const listed = await call(ctx, parent, 'list_agents', {})
    expect(text(listed).match(/"agent_name":"[^"]+"/g)).toEqual([
      '"agent_name":"/root"', '"agent_name":"/root/one"',
      '"agent_name":"/root/three"', '"agent_name":"/root/two"',
    ])
    const rejected = await call(ctx, parent, 'spawn_agent', {
      task_name: 'four', message: 'Extra work', fork_turns: 'none',
    })
    expect(rejected.isError).toBe(true)
    expect(text(rejected)).toContain('collab spawn failed: agent thread limit reached')
    expect(await ctx.codexySubagents.listChildren(parent.id)).toHaveLength(3)
  })

  it('keeps queued mail from making a completed resident evictable', async () => {
    const adapter = new MockAdapter([textResponse('first done'), textResponse('second done'), 'hang'])
    const { ctx, parent } = await setup(adapter, { maxConcurrentAgents: 2 })
    const spawned = await call(ctx, parent, 'spawn_agent', {
      task_name: 'worker', message: 'Finish', fork_turns: 'none',
    })
    expect(spawned.isError).toBe(false)
    const [worker] = await ctx.codexySubagents.listChildren(parent.id)
    await vi.waitFor(() => { expect(ctx.agents.get(worker!.id)?.status).toBe('idle') })
    const interrupted = await call(ctx, parent, 'interrupt_agent', { target: '/root/worker' })
    expect(JSON.parse(text(interrupted))).toEqual({ previous_status: { completed: 'first done' } })
    const mailed = await call(ctx, parent, 'send_message', {
      target: '/root/worker', message: 'Keep this note',
    })
    expect(mailed.isError).toBe(false)
    const blocked = await call(ctx, parent, 'spawn_agent', {
      task_name: 'newcomer', message: 'Wait', fork_turns: 'none',
    })
    expect(blocked.isError).toBe(true)
    expect(text(blocked)).toContain('agent thread limit reached')
    const followup = await call(ctx, parent, 'followup_task', {
      target: '/root/worker', message: 'Read the note and finish',
    })
    expect(followup.isError).toBe(false)
    await vi.waitFor(() => { expect(ctx.agents.get(worker!.id)?.status).toBe('idle') })
    const accepted = await call(ctx, parent, 'spawn_agent', {
      task_name: 'newcomer', message: 'Wait', fork_turns: 'none',
    })
    expect(accepted.isError).toBe(false)
    const listed = await call(ctx, parent, 'list_agents', {})
    expect(text(listed)).toContain('"agent_name":"/root/newcomer"')
    expect(text(listed)).not.toContain('"agent_name":"/root/worker"')
  })

  it('permits recursive v2 delegation unless maxDepth is explicitly set', async () => {
    const adapter = new MockAdapter(['hang', 'hang'])
    const { ctx, parent } = await setup(adapter)
    const first = await call(ctx, parent, 'spawn_agent', {
      task_name: 'worker', message: 'Delegate work', fork_turns: 'none',
    })
    expect(first.isError).toBe(false)
    const [entry] = await ctx.codexySubagents.listChildren(parent.id)
    const child = ctx.agents.get(entry!.id)
    if (child === undefined) throw new Error('expected live child')
    const nested = await call(ctx, child, 'spawn_agent', {
      task_name: 'reader', message: 'Read source', fork_turns: 'none',
    })
    expect(nested.isError).toBe(false)
    expect(JSON.parse(text(nested))).toEqual({ task_name: '/root/worker/reader' })
    const [grandchild] = await ctx.codexySubagents.listChildren(child.id)
    expect(grandchild?.label).toBe('/root/worker/reader')
    expect(ctx.agents.get(grandchild!.id)?.session.header.delegationDepth).toBe(2)
    await ctx.codexySubagents.drainContinuableDescendants([parent])
    expect(ctx.agents.get(grandchild!.id)).toBeUndefined()
    expect(ctx.agents.get(child.id)).toBeUndefined()
  })

  it('uses the nested child identity after a full-history fork and reports its completion to its parent', async () => {
    const release = Promise.withResolvers<undefined>()
    const adapter = new FirstRequestGatedAdapter(release.promise)
    const { ctx, parent } = await setup(adapter)
    const first = await call(ctx, parent, 'spawn_agent', {
      task_name: 'worker', message: 'Coordinate nested work', fork_turns: 'none',
    })
    expect(first.isError).toBe(false)
    const [worker] = await ctx.codexySubagents.listChildren(parent.id)
    const child = ctx.agents.get(worker!.id)
    if (child === undefined) throw new Error('expected live worker')
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const nested = await call(ctx, child, 'spawn_agent', {
      task_name: 'reader', message: 'Read one file', fork_turns: 'all',
    })
    expect(nested.isError, text(nested)).toBe(false)
    const [reader] = await ctx.codexySubagents.listChildren(child.id)
    await vi.waitFor(() => { expect(ctx.agents.get(reader!.id)?.status).toBe('idle') })
    expect(child.inbox.nextStep.concat(child.inbox.nextTurn).flatMap(message => message.content.flatMap(block =>
      block.type === 'text' ? [block.text] : []))).toContain(
      'Message Type: FINAL_ANSWER\nTask name: /root/worker\nSender: /root/worker/reader\nPayload:\ndone',
    )
    release.resolve(undefined)
  })

  it('queues a completed child result before its running descendant releases ownership', async () => {
    const workerRelease = Promise.withResolvers<undefined>()
    const readerRelease = Promise.withResolvers<undefined>()
    const adapter = new RequestGatedAdapter([workerRelease.promise, readerRelease.promise])
    const { ctx, parent } = await setup(adapter)
    try {
      const workerStart = await call(ctx, parent, 'spawn_agent', {
        task_name: 'worker', message: 'Coordinate', fork_turns: 'none',
      })
      expect(workerStart.isError).toBe(false)
      const [workerEntry] = await ctx.codexySubagents.listChildren(parent.id)
      const worker = ctx.agents.get(workerEntry!.id)
      if (worker === undefined) throw new Error('expected live worker')
      await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
      const readerStart = await call(ctx, worker, 'spawn_agent', {
        task_name: 'reader', message: 'Read', fork_turns: 'none',
      })
      expect(readerStart.isError).toBe(false)
      await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
      workerRelease.resolve(undefined)
      await vi.waitFor(() => {
        expect(worker.status).toBe('idle')
        expect(ctx.agents.get(worker.id)).toBe(worker)
        expect(parent.inbox.nextTurn.some(message => message.source.kind === 'subagent-settled'
          && message.content.some(block => block.type === 'text'
            && block.text.includes('Sender: /root/worker')))).toBe(true)
      })
      expect(parent.status).toBe('idle')
      const followup = await call(ctx, parent, 'followup_task', {
        target: '/root/worker', message: 'Finish another turn',
      })
      expect(followup.isError).toBe(false)
      await vi.waitFor(() => {
        expect(adapter.requests).toHaveLength(3)
        expect(parent.inbox.nextTurn.filter(message => message.source.kind === 'subagent-settled'
          && message.content.some(block => block.type === 'text'
            && block.text.includes('Sender: /root/worker')))).toHaveLength(2)
      })
      readerRelease.resolve(undefined)
      await ctx.codexySubagents.drainContinuableDescendants([parent])
      const notices = parent.inbox.nextTurn.filter(message => message.source.kind === 'subagent-settled'
        && message.content.some(block => block.type === 'text'
          && block.text.includes('Sender: /root/worker')))
      expect(notices).toHaveLength(2)
    } finally {
      workerRelease.resolve(undefined)
      readerRelease.resolve(undefined)
    }
  })

  it('unloads a terminal parent while its descendant keeps running and can message root', async () => {
    const workerRelease = Promise.withResolvers<undefined>()
    const readerRelease = Promise.withResolvers<undefined>()
    const replacementRelease = Promise.withResolvers<undefined>()
    const adapter = new RequestGatedAdapter([
      workerRelease.promise, readerRelease.promise, replacementRelease.promise,
    ])
    const { ctx, parent } = await setup(adapter, { maxConcurrentAgents: 3 })
    try {
      const spawned = await call(ctx, parent, 'spawn_agent', {
        task_name: 'worker', message: 'Coordinate', fork_turns: 'none',
      })
      expect(spawned.isError).toBe(false)
      const [workerEntry] = await ctx.codexySubagents.listChildren(parent.id)
      const worker = ctx.agents.get(workerEntry!.id)
      if (worker === undefined) throw new Error('expected live worker')
      await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
      const nested = await call(ctx, worker, 'spawn_agent', {
        task_name: 'reader', message: 'Keep reading', fork_turns: 'none',
      })
      expect(nested.isError).toBe(false)
      const [readerEntry] = await ctx.codexySubagents.listChildren(worker.id)
      const reader = ctx.agents.get(readerEntry!.id)
      if (reader === undefined) throw new Error('expected live reader')
      await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
      workerRelease.resolve(undefined)
      await vi.waitFor(() => { expect(worker.status).toBe('idle') })
      const replacement = await call(ctx, parent, 'spawn_agent', {
        task_name: 'replacement', message: 'Keep working', fork_turns: 'none',
      })
      expect(replacement.isError, text(replacement)).toBe(false)
      expect(ctx.agents.get(worker.id)).toBeUndefined()
      expect(ctx.agents.get(reader.id)).toBe(reader)
      expect(reader.status).toBe('running')
      const listed = await call(ctx, reader, 'list_agents', {})
      expect(listed.isError, text(listed)).toBe(false)
      expect(text(listed)).toContain('/root/worker/reader')
      const mailed = await call(ctx, reader, 'send_message', {
        target: '/root', message: 'Still reading',
      })
      expect(mailed.isError, text(mailed)).toBe(false)
      expect(parent.inbox.nextTurn.some(message => message.content.some(block => block.type === 'text'
        && block.text.includes('Still reading')))).toBe(true)
      const redirected = await call(ctx, parent, 'send_message', {
        target: '/root/worker/reader', message: 'Keep reading the file',
      })
      expect(redirected.isError, text(redirected)).toBe(false)
      expect(reader.inbox.nextStep.some(message => message.content.some(block => block.type === 'text'
        && block.text.includes('Keep reading the file')))).toBe(true)
    } finally {
      workerRelease.resolve(undefined)
      readerRelease.resolve(undefined)
      replacementRelease.resolve(undefined)
      await ctx.codexySubagents.drainContinuableDescendants([parent])
    }
  })

  it('keeps root ancestry when a child delegates after its parent was evicted', async () => {
    const releases = Array.from({ length: 5 }, () => Promise.withResolvers<undefined>())
    const adapter = new RequestGatedAdapter(releases.map(release => release.promise))
    const { ctx, parent } = await setup(adapter, { maxConcurrentAgents: 3 })
    try {
      const workerStart = await call(ctx, parent, 'spawn_agent', {
        task_name: 'worker', message: 'Coordinate', fork_turns: 'none',
      })
      expect(workerStart.isError).toBe(false)
      const [workerEntry] = await ctx.codexySubagents.listChildren(parent.id)
      const worker = ctx.agents.get(workerEntry!.id)
      if (worker === undefined) throw new Error('expected live worker')
      await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
      const readerStart = await call(ctx, worker, 'spawn_agent', {
        task_name: 'reader', message: 'Read', fork_turns: 'none',
      })
      expect(readerStart.isError).toBe(false)
      const [readerEntry] = await ctx.codexySubagents.listChildren(worker.id)
      const reader = ctx.agents.get(readerEntry!.id)
      if (reader === undefined) throw new Error('expected live reader')
      await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
      releases[0]!.resolve(undefined)
      await vi.waitFor(() => { expect(worker.status).toBe('idle') })
      const replacement = await call(ctx, parent, 'spawn_agent', {
        task_name: 'replacement', message: 'Wait', fork_turns: 'none',
      })
      expect(replacement.isError, text(replacement)).toBe(false)
      expect(ctx.agents.get(worker.id)).toBeUndefined()
      const [replacementEntry] = (await ctx.codexySubagents.listChildren(parent.id))
        .filter(entry => entry.label === '/root/replacement')
      if (replacementEntry === undefined) throw new Error('expected replacement')
      await vi.waitFor(() => { expect(adapter.requests).toHaveLength(3) })
      releases[2]!.resolve(undefined)
      await vi.waitFor(() => { expect(ctx.agents.get(replacementEntry.id)?.status).toBe('idle') })
      const delegated = await call(ctx, reader, 'spawn_agent', {
        task_name: 'searcher', message: 'Search', fork_turns: 'none',
      })
      expect(delegated.isError, text(delegated)).toBe(false)
      expect(ctx.agents.get(replacementEntry.id)).toBeUndefined()
      const [searcherEntry] = await ctx.codexySubagents.listChildren(reader.id)
      if (searcherEntry === undefined) throw new Error('expected searcher')
      await vi.waitFor(() => { expect(adapter.requests).toHaveLength(4) })
      releases[1]!.resolve(undefined)
      await vi.waitFor(() => { expect(reader.status).toBe('idle') })
      const next = await call(ctx, parent, 'spawn_agent', {
        task_name: 'next', message: 'Wait', fork_turns: 'none',
      })
      expect(next.isError, text(next)).toBe(false)
      expect(ctx.agents.get(reader.id)).toBeUndefined()
      expect(ctx.agents.get(searcherEntry.id)?.status).toBe('running')
      const mailed = await call(ctx, ctx.agents.get(searcherEntry.id)!, 'send_message', {
        target: '/root', message: 'Still searching',
      })
      expect(mailed.isError, text(mailed)).toBe(false)
      const redirected = await call(ctx, parent, 'send_message', {
        target: '/root/worker/reader/searcher', message: 'Keep searching',
      })
      expect(redirected.isError, text(redirected)).toBe(false)
      expect(ctx.agents.get(searcherEntry.id)?.inbox.nextStep.some(message =>
        message.content.some(block => block.type === 'text'
          && block.text.includes('Keep searching')))).toBe(true)
    } finally {
      for (const release of releases) release.resolve(undefined)
      await ctx.codexySubagents.drainContinuableDescendants([parent])
    }
  })

  it('reloads an evicted descendant after its direct parent was evicted', async () => {
    const adapter = new MockAdapter([
      textResponse('worker done'), 'hang',
      'hang', 'hang', 'hang', textResponse('reader resumed'),
    ])
    const { ctx, parent } = await setup(adapter, { maxConcurrentAgents: 4 })
    try {
      const workerStart = await call(ctx, parent, 'spawn_agent', {
        task_name: 'worker', message: 'Coordinate', fork_turns: 'none',
      })
      expect(workerStart.isError).toBe(false)
      const [workerEntry] = await ctx.codexySubagents.listChildren(parent.id)
      const worker = ctx.agents.get(workerEntry!.id)
      if (worker === undefined) throw new Error('expected live worker')
      await vi.waitFor(() => { expect(worker.status).toBe('idle') })
      const readerStart = await call(ctx, worker, 'spawn_agent', {
        task_name: 'reader', message: 'Read', fork_turns: 'none',
      })
      expect(readerStart.isError).toBe(false)
      const [readerEntry] = await ctx.codexySubagents.listChildren(worker.id)
      await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
      for (const task_name of ['one', 'two']) {
        const spawned = await call(ctx, parent, 'spawn_agent', {
          task_name, message: 'Keep working', fork_turns: 'none',
        })
        expect(spawned.isError, `${task_name}: ${text(spawned)}`).toBe(false)
      }
      expect(ctx.agents.get(worker.id)).toBeUndefined()
      const stoppedReader = await call(ctx, parent, 'interrupt_agent', { target: '/root/worker/reader' })
      expect(stoppedReader.isError).toBe(false)
      await vi.waitFor(() => { expect(ctx.agents.get(readerEntry!.id)?.status).toBe('idle') })
      const third = await call(ctx, parent, 'spawn_agent', {
        task_name: 'three', message: 'Keep working', fork_turns: 'none',
      })
      expect(third.isError, text(third)).toBe(false)
      expect(ctx.agents.get(readerEntry!.id)).toBeUndefined()
      const children = await ctx.codexySubagents.listChildren(parent.id)
      const first = children.find(entry => entry.label === '/root/one')
      if (first === undefined) throw new Error('expected first replacement')
      const interrupted = await call(ctx, parent, 'interrupt_agent', { target: '/root/one' })
      expect(interrupted.isError).toBe(false)
      await vi.waitFor(() => { expect(ctx.agents.get(first.id)?.status).toBe('idle') })
      const mailed = await call(ctx, parent, 'send_message', {
        target: '/root/worker/reader', message: 'Queued after eviction',
      })
      expect(mailed.isError, text(mailed)).toBe(false)
      const reloaded = ctx.agents.get(readerEntry!.id)
      expect(reloaded?.session.header.parentSession).toBe(worker.id)
      expect(reloaded?.inbox.nextStep.some(message => message.content.some(block => block.type === 'text'
        && block.text.includes('Queued after eviction')))).toBe(true)
      const followup = await call(ctx, parent, 'followup_task', {
        target: '/root/worker/reader', message: 'Finish the reading',
      })
      expect(followup.isError, text(followup)).toBe(false)
      await vi.waitFor(() => { expect(adapter.requests).toHaveLength(6) })
      const request = JSON.stringify(adapter.requests[5]!.messages)
      expect(request).toContain('Queued after eviction')
      expect(request).toContain('Finish the reading')
      const agentMessages = adapter.requests[5]!.messages
        .filter(message => message.role === 'user')
        .flatMap(message => message.content)
        .flatMap(block => block.type === 'text' ? [block.text] : [])
        .filter(value => value.startsWith('Message Type:'))
      expect(agentMessages).toMatchInlineSnapshot(`
        [
          "Message Type: NEW_TASK
        Task name: /root/worker/reader
        Sender: /root/worker
        Payload:
        Read",
          "Message Type: MESSAGE
        Task name: /root/worker/reader
        Sender: /root
        Payload:
        Queued after eviction",
          "Message Type: MESSAGE
        Task name: /root/worker/reader
        Sender: /root
        Payload:
        Finish the reading",
        ]
      `)
    } finally {
      await ctx.codexySubagents.drainContinuableDescendants([parent])
    }
  })

  it('honors an explicit v2 maxDepth limit', async () => {
    const adapter = new MockAdapter(['hang'])
    const { ctx, parent } = await setup(adapter, { maxDepth: 1 })
    const first = await call(ctx, parent, 'spawn_agent', {
      task_name: 'worker', message: 'Delegate work', fork_turns: 'none',
    })
    expect(first.isError).toBe(false)
    const [entry] = await ctx.codexySubagents.listChildren(parent.id)
    const child = ctx.agents.get(entry!.id)
    if (child === undefined) throw new Error('expected live child')
    const nested = await call(ctx, child, 'spawn_agent', {
      task_name: 'reader', message: 'Read source', fork_turns: 'none',
    })
    expect(nested.isError).toBe(true)
    expect(text(nested)).toContain('depth')
    await ctx.codexySubagents.drainContinuableDescendants([parent])
    expect(ctx.agents.get(child.id)).toBeUndefined()
  })

  it('requires a residency slot before sending mail to an evicted child', async () => {
    const adapter = new MockAdapter([textResponse('first done'), 'hang', 'hang', 'hang', 'hang'])
    const { ctx, parent } = await setup(adapter)
    const first = await call(ctx, parent, 'spawn_agent', {
      task_name: 'worker', message: 'Finish first', fork_turns: 'none',
    })
    expect(first.isError).toBe(false)
    const [worker] = await ctx.codexySubagents.listChildren(parent.id)
    await vi.waitFor(() => { expect(ctx.agents.get(worker!.id)?.status).toBe('idle') })
    for (const task_name of ['one', 'two', 'three']) {
      const spawned = await call(ctx, parent, 'spawn_agent', {
        task_name, message: 'Keep working', fork_turns: 'none',
      })
      expect(spawned.isError).toBe(false)
    }
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(4) })
    expect(ctx.agents.get(worker!.id)).toBeUndefined()
    const evicted = await call(ctx, parent, 'list_agents', { path_prefix: '/root/worker' })
    expect(JSON.parse(text(evicted))).toEqual({ agents: [] })
    const blocked = await call(ctx, parent, 'send_message', {
      target: '/root/worker', message: 'Queued note',
    })
    expect(blocked.isError).toBe(true)
    expect(text(blocked)).toContain('collab spawn failed: agent thread limit reached')
    const active = await ctx.codexySubagents.listChildren(parent.id)
    const one = active.find(entry => entry.label === '/root/one')
    if (one === undefined) throw new Error('expected first active child')
    const interrupted = await call(ctx, parent, 'interrupt_agent', { target: '/root/one' })
    expect(interrupted.isError).toBe(false)
    await vi.waitFor(() => { expect(ctx.agents.get(one.id)?.status).toBe('idle') })
    const sent = await call(ctx, parent, 'send_message', {
      target: '/root/worker', message: 'Queued note',
    })
    expect(sent.isError, text(sent)).toBe(false)
    const reloaded = ctx.agents.get(worker!.id)
    expect(reloaded).toBeDefined()
    expect(reloaded?.status).toBe('idle')
    expect(reloaded?.inbox.nextStep.some(message => message.source.kind === 'agent-message'
      && message.source.queueOnly === true)).toBe(true)
    const stored = await ctx.sessionQuery.observeSession(worker!.id, { signal })
    try {
      expect(stored.events.some(event => event.type === 'agent/inbox/spliced'
        && event.data.inserted.some(message => message.content.some(block => block.type === 'text'
          && block.text.includes('Queued note'))))).toBe(true)
    } finally {
      stored[Symbol.dispose]()
    }
    const resident = await call(ctx, parent, 'list_agents', { path_prefix: '/root/worker' })
    expect(JSON.parse(text(resident))).toEqual({
      agents: [{ agent_name: '/root/worker', agent_status: { completed: 'first done' } }],
    })
    const resumed = await call(ctx, parent, 'followup_task', {
      target: '/root/worker', message: 'Resume now',
    })
    expect(resumed.isError).toBe(false)
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(5) })
    const request = JSON.stringify(adapter.requests[4]!.messages)
    expect(request).toContain('Queued note')
    expect(request).toContain('Resume now')
  })

  it('reserves one free slot across simultaneous cold follow-ups', async () => {
    const adapter = new MockAdapter([textResponse('first done'), textResponse('second done'),
      'hang', 'hang', 'hang', 'hang'])
    const { ctx, parent } = await setup(adapter)
    for (const task_name of ['first', 'second']) {
      const spawned = await call(ctx, parent, 'spawn_agent', {
        task_name, message: 'Finish', fork_turns: 'none',
      })
      expect(spawned.isError).toBe(false)
    }
    const children = await ctx.codexySubagents.listChildren(parent.id)
    await vi.waitFor(() => {
      for (const entry of children) expect(ctx.agents.get(entry.id)?.status).toBe('idle')
    })
    for (const task_name of ['one', 'two']) {
      const spawned = await call(ctx, parent, 'spawn_agent', {
        task_name, message: 'Keep working', fork_turns: 'none',
      })
      expect(spawned.isError).toBe(false)
    }
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(4) })
    const resumed = await Promise.all(['first', 'second'].map(target => call(ctx, parent, 'followup_task', {
      target, message: 'Resume',
    })))
    expect(resumed.filter(result => !result.isError)).toHaveLength(1)
    expect(resumed.filter(result => result.isError).map(text)[0]).toContain('agent thread limit reached')
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(5) })
    expect(['first', 'second'].filter((label) => {
      const entry = children.find(child => child.label === `/root/${label}`)
      return entry !== undefined && ctx.agents.get(entry.id) !== undefined
    })).toHaveLength(1)
  })

  it('serializes concurrent inactive mail and follow-up without losing either message', async () => {
    const adapter = new MockAdapter([
      textResponse('first done'), textResponse('second done'), textResponse('third done'),
    ])
    const { ctx, parent } = await setup(adapter)
    const spawned = await call(ctx, parent, 'spawn_agent', {
      task_name: 'worker', message: 'Finish first', fork_turns: 'none',
    })
    expect(spawned.isError).toBe(false)
    const [entry] = await ctx.codexySubagents.listChildren(parent.id)
    await vi.waitFor(() => { expect(ctx.agents.get(entry!.id)?.status).toBe('idle') })
    expect(await ctx.codexySubagents.tryUnloadCodexfulChild(parent, entry!.id)).toBe(true)
    const [mail, followup] = await Promise.all([
      call(ctx, parent, 'send_message', { target: '/root/worker', message: 'Queued finding' }),
      call(ctx, parent, 'followup_task', { target: '/root/worker', message: 'Resume task' }),
    ])
    expect(mail.isError, text(mail)).toBe(false)
    expect(followup.isError, text(followup)).toBe(false)
    await vi.waitFor(() => { expect(ctx.agents.get(entry!.id)?.status).toBe('idle') })
    const stored = await ctx.sessionQuery.observeSession(entry!.id, { signal })
    try {
      const inserted = stored.events.flatMap(event => event.type === 'agent/inbox/spliced'
        ? event.data.inserted.flatMap(message => message.content.flatMap(block => block.type === 'text'
          ? [block.text] : [])) : [])
      expect(inserted.filter(value => value.includes('Queued finding'))).toHaveLength(1)
      expect(inserted.filter(value => value.includes('Resume task'))).toHaveLength(1)
      const visible = stored.events.flatMap(event => event.type === 'user/message'
        ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []) : [])
      const pending = [
        ...(ctx.agents.get(entry!.id)?.inbox.nextStep ?? []),
        ...(ctx.agents.get(entry!.id)?.inbox.nextTurn ?? []),
      ].flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
      expect([...visible, ...pending].some(value => value.includes('Queued finding'))).toBe(true)
      expect([...visible, ...pending].some(value => value.includes('Resume task'))).toBe(true)
    } finally {
      stored[Symbol.dispose]()
    }
  })

  it('loads an inactive grandchild for mail while reporting its parent completion', async () => {
    const release = Promise.withResolvers<undefined>()
    const adapter = new FirstRequestGatedAdapter(release.promise)
    const { ctx, parent } = await setup(adapter)
    const first = await call(ctx, parent, 'spawn_agent', {
      task_name: 'worker', message: 'Finish after nested child', fork_turns: 'none',
    })
    expect(first.isError).toBe(false)
    const [worker] = await ctx.codexySubagents.listChildren(parent.id)
    const child = ctx.agents.get(worker!.id)
    if (child === undefined) throw new Error('expected live child')
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const nested = await call(ctx, child, 'spawn_agent', {
      task_name: 'reader', message: 'Finish quickly', fork_turns: 'none',
    })
    expect(nested.isError).toBe(false)
    const [reader] = await ctx.codexySubagents.listChildren(child.id)
    await vi.waitFor(() => { expect(ctx.agents.get(reader!.id)?.status).toBe('idle') })
    expect(await ctx.codexySubagents.tryUnloadCodexfulChild(child, reader!.id)).toBe(true)
    const sent = await call(ctx, child, 'send_message', {
      target: '/root/worker/reader', message: 'Keep this note for later',
    })
    expect(sent.isError, text(sent)).toBe(false)
    expect(ctx.agents.get(reader!.id)?.inbox.nextStep.some(message => message.source.kind === 'agent-message'
      && message.source.queueOnly === true)).toBe(true)
    release.resolve(undefined)
    await vi.waitFor(() => {
      expect(child.status).toBe('idle')
      expect(parent.inbox.nextTurn.some(message => message.source.kind === 'subagent-settled'
        && message.content.some(block => block.type === 'text'
          && block.text.includes('Sender: /root/worker')))).toBe(true)
    })
    await ctx.codexySubagents.drainContinuableDescendants([parent])
  })

  it('reports a steered user input to wait_agent without consuming it', async () => {
    const { ctx, parent } = await setup(new MockAdapter([]), {
      minWaitMs: 0, defaultWaitMs: 200, maxWaitMs: 500,
    })
    const waiting = call(ctx, parent, 'wait_agent', { timeout_ms: 200 })
    parent.inbox.append('next-turn', createUserMessage({
      content: [{ type: 'text', text: 'new request' }],
      source: { kind: 'user' },
    }))
    expect(JSON.parse(text(await waiting))).toMatchObject({
      message: 'Wait interrupted by new input.', timed_out: false,
    })
    expect(parent.inbox.nextTurn).toHaveLength(1)
  })

  it('observes an inbox message that arrived before the wait listener was installed', async () => {
    const { ctx, parent } = await setup(new MockAdapter([]), {
      minWaitMs: 0, defaultWaitMs: 200, maxWaitMs: 500,
    })
    parent.inbox.append('next-step', createUserMessage({
      content: [{ type: 'text', text: 'already queued' }],
      source: { kind: 'user' },
    }))
    const result = await call(ctx, parent, 'wait_agent', { timeout_ms: 200 })
    expect(JSON.parse(text(result))).toMatchObject({
      message: 'Wait interrupted by new input.', timed_out: false,
    })
    expect(parent.inbox.nextStep).toHaveLength(1)
  })

  it('resumes an inactive child with followup_task and sends it a new model turn', async () => {
    const adapter = new MockAdapter([textResponse('first result'), textResponse('second result')])
    const { ctx, parent } = await setup(adapter)
    const spawned = await call(ctx, parent, 'spawn_agent', {
      task_name: 'worker', message: 'Do first task', fork_turns: 'none',
    })
    expect(spawned.isError).toBe(false)
    const [entry] = await ctx.codexySubagents.listChildren(parent.id)
    await vi.waitFor(() => { expect(ctx.agents.get(entry!.id)?.status).toBe('idle') })
    expect(await ctx.codexySubagents.tryUnloadCodexfulChild(parent, entry!.id)).toBe(true)
    const completed = await call(ctx, parent, 'list_agents', { path_prefix: '/root/worker' })
    expect(JSON.parse(text(completed))).toEqual({
      agents: [{ agent_name: '/root/worker', agent_status: { completed: 'first result' } }],
    })
    const followup = await call(ctx, parent, 'followup_task', {
      target: '/root/worker', message: 'Do second task',
    })
    expect(followup.isError).toBe(false)
    expect(text(followup)).toBe('')
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('Do second task')
  })

  it('lists a running named child and interrupts its current turn', async () => {
    const adapter = new MockAdapter(['hang', textResponse('resumed')])
    adapter.developerHistory = 'native'
    const { ctx, parent } = await setup(adapter)
    const spawned = await call(ctx, parent, 'spawn_agent', {
      task_name: 'worker', message: 'Do long task', fork_turns: 'none',
    })
    expect(spawned.isError).toBe(false)
    const [entry] = await ctx.codexySubagents.listChildren(parent.id)
    const child = ctx.agents.get(entry!.id)
    if (child === undefined) throw new Error('expected live child')
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const listed = await call(ctx, parent, 'list_agents', { path_prefix: '/root/worker' })
    expect(JSON.parse(text(listed))).toEqual({
      agents: [{ agent_name: '/root/worker', agent_status: 'running' }],
    })
    const interrupted = await call(ctx, parent, 'interrupt_agent', { target: '/root/worker' })
    expect(JSON.parse(text(interrupted))).toEqual({ previous_status: 'running' })
    await vi.waitFor(() => { expect(ctx.agents.get(entry!.id)?.status).toBe('idle') })
    const childEvents = child.session.snapshotEvents()
    expect(childEvents.some(event => event.type === 'turn/end' && event.data.reason.kind === 'aborted'
      && event.data.reason.reason.kind === 'user')).toBe(true)
    expect(childEvents.some(event => event.type === 'user/message'
      && event.data.content.some(block => block.type === 'text'
        && block.text.includes('The previous turn was interrupted on purpose.')))).toBe(true)
    const followup = await call(ctx, parent, 'followup_task', { target: '/root/worker', message: 'Continue' })
    expect(followup.isError).toBe(false)
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
    expect(adapter.requests[1]!.messages.some(message => message.role === 'developer'
      && message.content.some(block => block.type === 'text'
        && block.text.includes('The previous turn was interrupted on purpose.')))).toBe(true)
  })
})
