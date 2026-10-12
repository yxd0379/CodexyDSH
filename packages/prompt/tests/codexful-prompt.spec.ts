import { installModelSelection } from '@codexydsh/runtime/agent'
import { requestHeaderOf } from '@codexydsh/runtime/session'
import { appendProductEvent, snapshotProductEvents } from '@codexydsh/runtime/session'
import ProductPrompt from '@codexydsh/prompt-registry'
import { NativeToolRuntime, NativeTools } from '@codexydsh/bridges/tools'
import { createHash } from 'node:crypto'
import { readlinkSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createScope, type ScopeKey } from '@deepseek-ai/dsh-scope'
import { SESSION_FORMAT_VERSION, Session, SessionId, SessionLogOffset, SessionStore } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { FsTargetKey, FsVersion, type FsInfo, type FsTarget } from '@deepseek-ai/dsh-fs'
import SystemPrompt, { renderPrompt, renderContextSections, renderContextSnapshot, type PromptAssembly, type PromptPreparation } from '@codexydsh/runtime/prompt'
import { agentEvents, type Agent, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createToolResultMessage, createUserMessage, LlmAdapter, ReasoningEffortId, ToolCallId } from '@codexydsh/runtime/llm'
import type { GenerateOptions, LlmCallConfig, LlmResolvedModelInfo, PreparedAdapterCall, StreamChunk } from '@codexydsh/runtime/llm'
import type { CodexMailboxDeferral, CodexMailboxPreemption } from '@codexydsh/runtime'
import { AgentLoop, CODEX_EXPLICIT_MULTI_AGENT_MODE, CODEX_PROACTIVE_MULTI_AGENT_MODE } from '@codexydsh/runtime'
import { mountAgentLoopTestDependencies } from '@codexydsh/runtime-testkit'
import ToolRuntime, { defineTool, TOOL_REQUEST_CAPTURE } from '@codexydsh/runtime/tools'
import { codexV1IdentityProjectionDefinition } from '@codexydsh/delegation'
import { codexV1LiveRoster } from '@codexydsh/subagents/codex-v1'
import { acquireCodexV1NicknameRegistry } from '@codexydsh/subagents/src/codex-v1-nicknames.ts'
import { describe, expect, it, vi } from 'vitest'
import * as CodexfulPrompt from '../src/index.ts'
import { CODEXFUL_V1_TOOL_NAMES, CODEXFUL_V2_TOOL_NAMES, withoutUpdatePlanInstructions } from '../src/prompts.ts'
import { recordCodexfulMultiAgentVersion } from '../src/multi-agent-version.ts'
import { codexfulPreparationOf } from '../src/preparation.ts'

function fakeAgent(
  model: string | undefined,
  id = SessionId('codexful-prompt'),
  metadata: { parentSession?: SessionId; isSeeded?: boolean } = {},
): Agent {
  return {
    id,
    options: { provider: 'test', ...model === undefined ? {} : { model } },
    session: Session.create(id, [], {
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: 0,
      cwd: '/work/a&b',
      isSeeded: false,
      ...metadata,
    }, metadata.isSeeded ? SessionLogOffset(0) : undefined),
  } as Agent
}

function delegationTools(ctx: Context): void {
  for (const name of ['multi_agent_v1__spawn_agent', 'spawn_agent']) {
    ctx.codexyTools.register(defineTool({
      name,
      ...name.startsWith('multi_agent_v1__') ? {
        namespace: { name: 'multi_agent_v1', description: 'Tools for spawning and managing sub-agents.', toolName: 'spawn_agent' },
      } : {},
      description: name,
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { return name },
    }))
  }
}

async function services(
  ctx: Context,
  mode: 'read-only' | 'workspace-write' | 'danger-full-access' = 'workspace-write',
  approval: 'ask' | 'never' = 'ask',
  nativeDeveloperHistory = true,
  routeDefault?: string,
) {
  await ctx.plugin(SessionProjections)
  ctx.provide('sandboxPolicy', {
    resolve: () => ({ mode, workspaceRoot: '/work/a&b' }),
  } as never)
  ctx.provide('codexyApproval', {
    config: { policy: approval },
    overrideOf: () => undefined,
    reviewerOf: () => 'user',
  } as never)
  ctx.provide('subprocess', {
    terminalEnvironment: async () => ({ platform: 'posix', defaultShell: '/bin/zsh' }),
  } as never)
  const enableCodexModelSwitch = vi.fn((_agent: Agent, _instructions: (assembly: PromptAssembly) => string) => () => {})
  const enableCodexMailboxPreemption = vi.fn((_agent: Agent, _shouldPreempt: CodexMailboxPreemption) => () => {})
  const enableCodexMailboxDeferral = vi.fn((_agent: Agent, _shouldDefer: CodexMailboxDeferral) => () => {})
  const enableCodexInputOrder = vi.fn((_agent: Agent, _isMailbox: (message: ReturnType<typeof createUserMessage>) => boolean) => () => {})
  ctx.provide('agentLoop', {
    enableCodexModelSwitch,
    enableCodexWorldState: () => () => {},
    enableInterruptedTurnMarker: () => () => {},
    enableCodexToolArgumentFeedback: () => () => {},
    enableCodexToolConcurrency: () => () => {},
    enableCodexInputOrder,
    enableCodexStreamingTools: () => () => {},
    enableCodexMailboxPreemption,
    enableCodexMailboxDeferral,
  } as never)
  ctx.provide('llmRetry', { registerAgentRetryOverrides: () => () => {} })
  const resolveModelInfo = vi.fn(async (provider: string, model: string) => ({
    provider, id: model, name: model,
    reasoning: {
      efforts: ['low', 'medium', 'high'].map(id => ({ id: ReasoningEffortId(id), name: id })),
      ...routeDefault === undefined ? {} : { defaultEffort: ReasoningEffortId(routeDefault) },
    },
  }))
  ctx.provide('codexyRequests', {
    prepareCall: async () => nativeDeveloperHistory ? { developerHistory: 'native' } : {},
    resolveModelInfo,
  } as never)
  return { resolveModelInfo, enableCodexModelSwitch, enableCodexMailboxPreemption, enableCodexMailboxDeferral, enableCodexInputOrder }
}

async function resolvedRequest(model: string, reasoningEffort?: string, routeDefault?: string): Promise<{
  config: LlmCallConfig
  modelLookups: number
}> {
  const ctx = new Context()
  try {
    const { resolveModelInfo } = await services(ctx, 'workspace-write', 'ask', true, routeDefault)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ProductPrompt)
    await ctx.plugin(NativeToolRuntime)
    await ctx.plugin(NativeTools)
    const agent = fakeAgent(model)
    const scope = createScope(ctx, agent)
    await scope.ctx.plugin(CodexfulPrompt, {})
    await ctx.codexyPrompt.assemble({ scope: agent, agent })
    const config = await agentEvents(ctx, agent).waterfall(
      'codexy-agent/request', { turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'test', model,
        ...reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) } }),
    )
    return { config, modelLookups: resolveModelInfo.mock.calls.length }
  } finally {
    await ctx.fiber.dispose()
  }
}

class RequestControlsAdapter extends LlmAdapter {
  readonly requests: { lite: boolean; options: GenerateOptions }[] = []
  lite = false

  constructor(private readonly native: boolean, private readonly efforts: readonly string[] = ['low', 'medium', 'high']) {
    super()
  }

  private metadata(provider: string, model: string, lite: boolean): LlmResolvedModelInfo {
    return {
      provider, id: model, name: model,
      reasoning: { efforts: this.efforts.map(id => ({ id: ReasoningEffortId(id), name: id })) },
      ...lite ? { codexResponsesLite: true as const } : {},
    }
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve(this.metadata(provider, model, this.lite))
  }

  override prepareCall(provider: string, model: string): Promise<PreparedAdapterCall> {
    const lite = this.lite
    return Promise.resolve({
      model: this.metadata(provider, model, lite),
      ...this.native ? { developerHistory: 'native' as const } : {},
      stream: options => this.dispatch(lite, options),
    })
  }

  private async * dispatch(lite: boolean, options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push({ lite, options })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.dispatch(this.lite, options)
  }
}

async function mountRequestControlsLoop(
  ctx: Context,
  adapter: RequestControlsAdapter,
  beforeExecPreparation?: () => Promise<void>,
): Promise<void> {
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.effect(() => ctx.codexyRequests.registerAdapter(['test'], adapter), 'request-controls.adapter')
  ctx.provide('sandboxPolicy', {
    resolve: () => ({ mode: 'danger-full-access', workspaceRoot: '/work/a&b' }),
  } as never)
  ctx.provide('codexyApproval', { config: { policy: 'never' }, overrideOf: () => undefined, reviewerOf: () => 'user' } as never)
  ctx.provide('subprocess', {
    terminalEnvironment: async () => ({ platform: 'posix', defaultShell: '/bin/zsh' }),
  } as never)
  ctx.provide('llmRetry', { registerAgentRetryOverrides: () => () => {} })
  for (const name of ['exec_command', 'write_stdin', 'update_plan']) {
    const definition = defineTool({
      name, description: name, parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: () => Promise.resolve('done'),
    })
    ctx.effect(() => ctx.codexyTools.register({
      ...definition,
      ...name === 'exec_command' && beforeExecPreparation !== undefined ? {
        async resolveRequest() {
          await beforeExecPreparation()
          return definition
        },
      } : {},
    }), `request-controls.${name}`)
  }
}

/** Synthetic execution-world filesystem; no host filesystem operations are performed. */
async function mountWorkingDirectory(ctx: Context): Promise<Set<string>> {
  const directories = new Set(['/work/a&b', '/work/current', '/work/later'])
  ctx.provide('fs', {
    resolve: (path: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> => {
      options?.signal?.throwIfAborted()
      const displayPath = resolvePath(options?.cwd ?? '/work/a&b', path)
      return Promise.resolve({ targetKey: FsTargetKey(`memory:${displayPath}`), displayPath })
    },
    stat: (target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> => {
      signal?.throwIfAborted()
      return Promise.resolve(directories.has(target.displayPath)
        ? { type: 'directory', version: FsVersion('memory-directory') } : undefined)
    },
    processPath: (target: FsTarget): string => target.displayPath,
  } as never)
  await ctx.plugin(WorkingDirectoryService, { defaultDirectory: '/work/a&b' })
  return directories
}

async function mountStrictWorkingDirectoryPrompt(ctx: Context, config: Partial<CodexfulPrompt.Config> = {}): Promise<Set<string>> {
  await services(ctx, 'danger-full-access', 'never')
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ProductPrompt)
  await ctx.plugin(NativeToolRuntime)
  await ctx.plugin(NativeTools)
  const directories = await mountWorkingDirectory(ctx)
  for (const name of ['exec_command', 'write_stdin']) {
    ctx.codexyTools.register(defineTool({
      name, description: name, parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: () => Promise.resolve('unused synthetic tool'),
    }))
  }
  await ctx.plugin(CodexfulPrompt, { toolProfile: 'codex-pinned', strictModelInput: true, networkAccess: 'enabled', ...config })
  return directories
}

function workingDirectoryAgent(ctx: Context, id = SessionId('working-directory-prompt')): Agent & { inject: ReturnType<typeof vi.fn> } {
  return Object.assign(fakeAgent('gpt-5.5', id), { ctx, inject: vi.fn() })
}

describe('Codexful public working-directory capture', () => {
  it('captures Git metadata from the prepared public cwd, not the header or a later cwd', async () => {
    const ctx = new Context()
    try {
      await mountStrictWorkingDirectoryPrompt(ctx, { wireProfile: 'codex-0.162.1' })
      const probes: SubprocessSpawnSpec[] = []
      Object.assign(ctx.subprocess, {
        resolveExecutable: vi.fn(async () => '/execution-world/git'),
        spawn: (spec: SubprocessSpawnSpec) => {
          probes.push(spec)
          const text = spec.argv.includes('--show-toplevel') ? '/work/current\n'
            : `# branch.oid ${'a'.repeat(40)}\n# branch.head main\n`
          return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: {
            stdout: { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) },
          } }
        },
      })
      const agent = workingDirectoryAgent(ctx)
      agent.session.append('turn/start', { turn: 1 })
      await ctx.workingDirectory.set(agent, '/work/current')
      const promptPreparation = await ctx.codexyPrompt.prepare({ agent })
      await ctx.workingDirectory.set(agent, '/work/later')
      await ctx.codexyPrompt.assemble({ agent }, promptPreparation)
      const request = await agentEvents(ctx, agent).waterfall('codexy-agent/request', {
        turn: 1, step: 1, signal: new AbortController().signal, promptPreparation,
      }, async () => ({ provider: 'test', model: 'gpt-5.5', reasoningEffort: ReasoningEffortId('medium') }))
      const metadata = request.codexfulResponses?.clientMetadata
      expect(metadata).toBeDefined()
      expect(JSON.parse(metadata!['x-codex-turn-metadata']!).workspaces)
        .toEqual({ '/work/current': { latest_git_commit_hash: 'a'.repeat(40), has_changes: false } })
      expect(probes).toHaveLength(2)
      expect(probes.every(probe => probe.cwd === '/work/current' && probe.argv[2] === '/work/current'
        && probe.env?.GIT_OPTIONAL_LOCKS === '0')).toBe(true)
      expect(agent.session.header.cwd).toBe('/work/a&b')
      expect(ctx.workingDirectory.get(agent.session)).toBe('/work/later')
      appendProductEvent(agent.session, 'request/header', { reason: 'initial', header: { config: request } })
      expect(requestHeaderOf(agent.session)?.config.codexfulResponses?.clientMetadata).toEqual(metadata)
    } finally { await ctx.fiber.dispose() }
  })

  it('consumes the standard current context into the frozen environment while preserving stock changes and notices', async () => {
    const ctx = new Context()
    try {
      await mountStrictWorkingDirectoryPrompt(ctx)
      const agent = workingDirectoryAgent(ctx)
      const originalHeader = agent.session.header
      const initial = await ctx.codexyPrompt.assemble({ agent })
      expect(initial.contexts.some(context => context.name === 'working-directory:current')).toBe(false)
      expect(initial.contexts.find(context => context.name === 'codexful:environment')?.text)
        .toContain('<cwd>/work/a&amp;b</cwd>')
      await ctx.workingDirectory.set(agent, '/work/current')
      expect(agent.session.header).toBe(originalHeader)
      expect(agent.session.header.cwd).toBe('/work/a&b')
      expect(agent.session.snapshotEvents().filter(event => event.type === 'working-directory/change'))
        .toMatchObject([{ data: { cwd: '/work/current' } }])
      expect(agent.inject).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        source: { kind: 'working-directory' },
        content: [{ type: 'text', text: 'The working directory changed from "/work/a&b" to "/work/current".' }],
      }))
      const stock = await ctx.systemPrompt.assemble({ agent })
      expect(stock.contexts.filter(context => context.name === 'working-directory:current'))
        .toEqual([{ name: 'working-directory:current', text: 'Current working directory: "/work/current".', interpolate: false }])
      const token = await ctx.codexyPrompt.prepare({ agent })
      const current = await ctx.codexyPrompt.assemble({ agent }, token)
      expect(current.contexts.some(context => context.name === 'working-directory:current')).toBe(false)
      expect(current.contexts.find(context => context.name === 'codexful:environment')?.text)
        .toContain('<cwd>/work/current</cwd>')
      await ctx.workingDirectory.set(agent, '/work/later')
      const compacted = await ctx.waterfall('codexy-compaction/initial-context', { agent, promptPreparation: token }, async () => undefined)
      const environment = compacted?.find(message => message.source.kind === 'runtime-context'
        && message.source.codexWorldState?.section === 'environment')
      expect(environment?.source).toMatchObject({ codexWorldState: {
        section: 'environment', mode: 'full', snapshot: { cwd: '/work/current' },
      } })
      expect(environment?.content).toEqual([{ type: 'text', text: expect.stringContaining('<cwd>/work/current</cwd>') }])
      expect(compacted?.flatMap(message => message.content).filter(block => block.type === 'text')
        .some(block => block.text.startsWith('Current working directory:'))).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('replays the committed cwd, then commits stock recovery to the original project before capturing it', async () => {
    const ctx = new Context()
    try {
      const directories = await mountStrictWorkingDirectoryPrompt(ctx)
      const source = workingDirectoryAgent(ctx, SessionId('working-directory-resume'))
      await ctx.workingDirectory.set(source, '/work/current')
      const originalEvents = source.session.snapshotEvents()
      const resumed = Object.assign(workingDirectoryAgent(ctx, source.id), {
        session: Session.create(source.id, originalEvents, source.session.header),
      })
      const replayed = await ctx.codexyPrompt.assemble({ agent: resumed })
      expect(replayed.contexts.find(context => context.name === 'codexful:environment')?.text)
        .toContain('<cwd>/work/current</cwd>')
      directories.delete('/work/current')
      const recovered = await ctx.codexyPrompt.assemble({ agent: resumed })
      expect(recovered.contexts.find(context => context.name === 'codexful:environment')?.text)
        .toContain('<cwd>/work/a&amp;b</cwd>')
      expect(resumed.session.header.cwd).toBe('/work/a&b')
      expect(resumed.session.snapshotEvents().filter(event => event.type === 'working-directory/change').at(-1))
        .toMatchObject({ data: { cwd: '/work/a&b' } })
      expect(resumed.inject).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        source: { kind: 'working-directory' },
        content: [{ type: 'text', text: 'The working directory "/work/current" is unavailable. The working directory is now "/work/a&b".' }],
      }))
      expect(source.session.snapshotEvents()).toEqual(originalEvents)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps the prepared cwd when a directory changes away and back without blocking assembly', async () => {
    const ctx = new Context()
    try {
      await mountStrictWorkingDirectoryPrompt(ctx)
      const agent = workingDirectoryAgent(ctx)
      const context = { agent }
      const before = await ctx.codexyPrompt.prepare(context)
      await ctx.workingDirectory.set(agent, '/work/current')
      await ctx.workingDirectory.set(agent, '/work/a&b')
      const assembly = await ctx.codexyPrompt.assemble(context, before)
      expect(assembly.contexts.find(context => context.name === 'codexful:environment')?.text)
        .toContain('<cwd>/work/a&amp;b</cwd>')
      expect(agent.session.header.cwd).toBe('/work/a&b')
      await expect(ctx.codexyPrompt.assemble(context)).resolves.toHaveProperty('contextSnapshotIntro', 'none')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each(['stock assembly', 'preparation waterfall', 'terminal await', 'prefix await'] as const)(
    'preserves frozen environment facts through a directory change during %s', async (phase) => {
      const ctx = new Context()
      const entered = Promise.withResolvers<undefined>()
      const release = Promise.withResolvers<undefined>()
      let pending: Promise<unknown> | undefined
      try {
        await mountStrictWorkingDirectoryPrompt(ctx)
        const agent = workingDirectoryAgent(ctx)
        const initial = await ctx.codexyPrompt.assemble({ agent })
        const completed = vi.fn()
        ctx.on('codexy-prompt/assembled', completed)
        const pause = async () => { entered.resolve(undefined); await release.promise }
        if (phase === 'stock assembly') ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
          const assembly = await next()
          await pause()
          return assembly
        }, { prepend: true })
        if (phase === 'preparation waterfall') ctx.on('codexy-prompt/prepare', async (_variables, _context, next) => {
          const variables = await next()
          await pause()
          return variables
        })
        if (phase === 'terminal await') vi.spyOn(ctx.subprocess, 'terminalEnvironment').mockImplementationOnce(async () => {
          await pause()
          return { platform: 'posix', defaultShell: '/bin/zsh' }
        })
        if (phase === 'prefix await') ctx.on('codexful/active-prefixes', async (_request, next) => {
          const prefixes = await next()
          await pause()
          return prefixes
        })
        pending = ctx.codexyPrompt.assemble({ agent })
        await Promise.race([entered.promise, pending.then(() => { throw new Error('assembly completed before the race barrier') })])
        await ctx.workingDirectory.set(agent, '/work/current')
        await ctx.workingDirectory.set(agent, '/work/a&b')
        release.resolve(undefined)
        const captured = await pending as PromptAssembly
        expect(captured.contexts.find(context => context.name === 'codexful:environment')?.text)
          .toBe(initial.contexts.find(context => context.name === 'codexful:environment')?.text)
        expect(completed).toHaveBeenCalledOnce()
        const compacted = await ctx.waterfall('codexy-compaction/initial-context', { agent }, async () => undefined)
        expect(compacted?.at(-1)?.content).toEqual([{ type: 'text', text: initial.contexts
          .find(context => context.name === 'codexful:environment')!.text }])
      } finally {
        release.resolve(undefined)
        await pending?.catch(() => {})
        await ctx.fiber.dispose()
      }
    },
  )

  it.each(['text', 'duplicate', 'role', 'interpolate', 'missing'] as const)(
    'preserves an altered %s context without failing assembly', async (alteration) => {
      const ctx = new Context()
      try {
        await mountStrictWorkingDirectoryPrompt(ctx)
        const agent = workingDirectoryAgent(ctx)
        const token = await ctx.codexyPrompt.prepare({ agent })
        ctx.on('codexy-prompt/assemble', async (_assembly, _context, next) => {
          const assembly = await next()
          const current = assembly.contexts.find(context => context.name === 'working-directory:current')!
          if (alteration === 'text') current.text = 'Current working directory: "/work/forged".'
          if (alteration === 'duplicate') assembly.contexts.push({ ...current })
          if (alteration === 'role') current.role = 'user'
          if (alteration === 'interpolate') current.interpolate = true
          if (alteration === 'missing') assembly.contexts = assembly.contexts.filter(context => context !== current)
          return assembly
        })
        const assembly = await ctx.codexyPrompt.assemble({ agent }, token)
        const retained = assembly.contexts.filter(context => context.name === 'working-directory:current')
        if (alteration === 'text') expect(retained[0]?.text).toBe('Current working directory: "/work/forged".')
        if (alteration === 'duplicate') expect(retained).toHaveLength(2)
        if (alteration === 'role') expect(retained[0]?.role).toBe('user')
        if (alteration === 'interpolate') expect(retained[0]?.interpolate).toBe(true)
        if (alteration === 'missing') expect(retained).toEqual([])
        expect(assembly.contexts.find(context => context.name === 'codexful:environment')?.text)
          .toContain('<cwd>/work/a&amp;b</cwd>')
      } finally {
        await ctx.fiber.dispose()
      }
    },
  )

  it('preserves unknown and reintroduced directory context without inventing a dispatch guard', async () => {
    const ctx = new Context()
    try {
      await mountStrictWorkingDirectoryPrompt(ctx)
      const agent = workingDirectoryAgent(ctx)
      ctx.codexyPrompt.context({ name: 'working-directory:unknown', order: 0, text: 'unrecognized directory facts' })
      expect((await ctx.codexyPrompt.assemble({ agent })).contexts)
        .toContainEqual({ name: 'working-directory:unknown', text: 'unrecognized directory facts' })
    } finally {
      await ctx.fiber.dispose()
    }
    const reintroduced = new Context()
    try {
      await mountStrictWorkingDirectoryPrompt(reintroduced)
      const agent = workingDirectoryAgent(reintroduced)
      reintroduced.on('codexy-prompt/assemble', async (_assembly, _context, next) => {
        const assembly = await next()
        assembly.contexts.push({ name: 'working-directory:current', text: 'Current working directory: "/work/a&b".', interpolate: false })
        return assembly
      }, { prepend: true })
      expect((await reintroduced.codexyPrompt.assemble({ agent })).contexts).toContainEqual({ name: 'working-directory:current',
        text: 'Current working directory: "/work/a&b".', interpolate: false })
    } finally {
      await reintroduced.fiber.dispose()
    }
  })

  it('uses the existing durable full/delta projection for real loop requests and replay', async () => {
    const ctx = new Context()
    try {
      const adapter = new RequestControlsAdapter(true)
      await mountRequestControlsLoop(ctx, adapter)
      await mountWorkingDirectory(ctx)
      CodexfulPrompt.apply(ctx, { toolProfile: 'codex-pinned', strictModelInput: true, networkAccess: 'enabled' })
      const errors: unknown[] = []
      ctx.on('agent/error', ({ error }) => { errors.push(error) })
      const agent = await ctx.agentLoop.create(SessionId('working-directory-durable-loop'),
        { provider: 'test', model: 'gpt-5.5' }, { cwd: '/work/a&b' })
      const input = () => createUserMessage({ content: [{ type: 'text', text: 'synthetic task' }], source: { kind: 'user' } })
      agent.followup(input())
      await agent.whenIdle()
      await ctx.workingDirectory.set(agent, '/work/current')
      // Preserve the original service's queued notice; inject itself does not wake a turn.
      await agent.whenIdle()
      expect(adapter.requests).toHaveLength(1)
      agent.followup(input())
      await agent.whenIdle()
      expect(errors).toEqual([])
      // Codex input ordering gives the fresh task and queued stock notice separate requests.
      expect(adapter.requests).toHaveLength(3)
      const events = agent.session.snapshotEvents()
      const environments = events.flatMap(event => event.type === 'user/message'
        && event.data.source.kind === 'runtime-context' && event.data.source.codexWorldState?.section === 'environment'
        ? [event.data] : [])
      expect(environments.map(message => message.source.kind === 'runtime-context' ? message.source.codexWorldState : undefined))
        .toMatchObject([{ mode: 'full', snapshot: { cwd: '/work/a&b' } }, { mode: 'delta', snapshot: { cwd: '/work/current' } }])
      const snapshots = environments.map(message => message.source.kind === 'runtime-context'
        && message.source.codexWorldState?.section === 'environment' ? message.source.codexWorldState.snapshot : undefined)
      expect(environments[1]?.content).toEqual([{ type: 'text', text: CodexfulPrompt.renderEnvironmentDiff(snapshots[1]!, snapshots[0]!) }])
      expect(ctx.sessionProjections.stateOf(agent.session, 'codexWorldState')?.environment?.cwd).toBe('/work/current')
      const replayed = Session.create(agent.id, events, agent.session.header)
      expect(ctx.sessionProjections.stateOf(replayed, 'codexWorldState')?.environment?.cwd).toBe('/work/current')
      expect(ctx.workingDirectory.get(replayed)).toBe('/work/current')
      expect(agent.session.header.cwd).toBe('/work/a&b')
      const compacted = await ctx.waterfall('codexy-compaction/initial-context', { agent }, async () => undefined)
      expect(compacted?.at(-1)?.source).toMatchObject({ codexWorldState: { mode: 'full', snapshot: { cwd: '/work/current' } } })
      expect(adapter.requests.flatMap(request => request.options.messages).flatMap(message => message.content)
        .some(block => block.type === 'text' && block.text.startsWith('Current working directory:'))).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('dispatches the captured environment when cwd changes during tool preparation, then records the next cwd', async () => {
    const ctx = new Context()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let pending: Promise<void> | undefined
    try {
      const adapter = new RequestControlsAdapter(true)
      await mountRequestControlsLoop(ctx, adapter, async () => {
        entered.resolve(undefined)
        await release.promise
      })
      await mountWorkingDirectory(ctx)
      CodexfulPrompt.apply(ctx, { toolProfile: 'codex-pinned', strictModelInput: true, networkAccess: 'enabled' })
      const errors: unknown[] = []
      ctx.on('agent/error', ({ error }) => { errors.push(error) })
      const agent = await ctx.agentLoop.create(SessionId('working-directory-pre-dispatch-race'),
        { provider: 'test', model: 'gpt-5.5' }, { cwd: '/work/a&b' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'synthetic task' }], source: { kind: 'user' } }))
      pending = agent.whenIdle()
      await Promise.race([entered.promise, pending.then(() => { throw new Error('agent became idle before tool preparation') })])
      await ctx.workingDirectory.set(agent, '/work/current')
      release.resolve(undefined)
      await pending
      expect(errors).toEqual([])
      expect(adapter.requests).toHaveLength(2)
      const environmentTexts = adapter.requests.map(request => request.options.messages.flatMap(message => message.content)
        .flatMap(block => block.type === 'text' && block.text.startsWith('<environment_context>') ? [block.text] : []))
      expect(environmentTexts[0]?.at(-1)).toContain('<cwd>/work/a&amp;b</cwd>')
      expect(environmentTexts[1]?.at(-1)).toContain('<cwd>/work/current</cwd>')
      expect(ctx.sessionProjections.stateOf(agent.session, 'codexWorldState')?.environment?.cwd).toBe('/work/current')
    } finally {
      release.resolve(undefined)
      await pending
      await ctx.fiber.dispose()
    }
  })
})

describe('Codexful prompt', () => {
  it('previews the default deployment before a model is selected and rejects an unprepared request route', async () => {
    const ctx = new Context()
    try {
      await services(ctx)
      await ctx.plugin(SystemPrompt)
    await ctx.plugin(ProductPrompt)
      await ctx.plugin(NativeToolRuntime)
    await ctx.plugin(NativeTools)
      CodexfulPrompt.apply(ctx, {})
      const agent = fakeAgent(undefined)
      const context = { agent }
      const token = await ctx.codexyPrompt.prepare(context)
      const snapshot = codexfulPreparationOf(token)
      const assembly = await ctx.codexyPrompt.assemble(context, token)
      expect(snapshot.deployment.toolProfile).toBe('daily')
      expect(snapshot.deployment.networkAccess).toBe('unknown')
      expect(snapshot.modelProfile.sourceModel).toBe('fallback')
      expect(snapshot.defaultReasoningEffort).toBeUndefined()
      expect(renderPrompt(assembly)).toContain('# DSH runtime adaptation')
      expect(assembly.contexts.find(section => section.name === 'codexful:permissions')?.text)
        .toContain('Network reachability is reported as unknown')
      await expect(agentEvents(ctx, agent).waterfall('codexy-agent/request', {
        turn: 1, step: 1, signal: new AbortController().signal,
      }, async () => ({ provider: 'test', model: 'gpt-5.5' }))).rejects.toThrow('Codexful prompt needs a provider and model before assembly')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('executes the advertised tools from an older binding while direct calls follow the new profile', async () => {
    const ctx = new Context()
    try {
      await services(ctx)
      await ctx.plugin(SystemPrompt)
    await ctx.plugin(ProductPrompt)
      await ctx.plugin(NativeToolRuntime)
    await ctx.plugin(NativeTools)
      const calls: string[] = []
      for (const name of ['exec_command', 'write_stdin', 'update_plan']) ctx.codexyTools.register(defineTool({
        name, description: name, parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute() { calls.push(name); return name },
      }))
      const agent = fakeAgent('gpt-5.5')
      const scope = createScope(ctx, agent)
      Object.assign(agent, { ctx: scope.ctx })
      const config: CodexfulPrompt.Config = { toolProfile: 'codex-pinned', updatePlan: true }
      await scope.ctx.plugin(Object.assign((inner: Context) => { CodexfulPrompt.apply(inner, config) }, { inject: CodexfulPrompt.inject }))
      await agentEvents(ctx, agent).serial('agent/created', { source: 'startup' })
      const context = { scope: agent, agent, signal: new AbortController().signal }
      const token = await ctx.codexyPrompt.prepare(context)
      const capture = await ctx.codexyTools.prepareRequest({ context, variables: token.variables })
      const first = await ctx.codexyPrompt.assemble({ ...context, [TOOL_REQUEST_CAPTURE]: capture }, token)
      const binding = ctx.codexyTools.bindAssembly(capture, first.tools)
      expect(first.tools.map(tool => tool.name)).toEqual(['exec_command', 'update_plan', 'write_stdin'])
      config.updatePlan = false
      const second = await ctx.codexyPrompt.assemble(context)
      expect(second.tools.map(tool => tool.name)).toEqual(['exec_command', 'write_stdin'])
      const denied = await ctx.codexyTools.execute({
        agent, callId: ToolCallId('direct-plan'), name: 'update_plan', arguments: {}, signal: context.signal,
      })
      expect(denied.isError).toBe(true)
      expect(denied.content).toEqual([{ type: 'text', text: 'Error: update_plan is unavailable in the current Codexful model tool profile' }])
      const bound = await ctx.codexyTools.execute({
        agent, requestBinding: binding, callId: ToolCallId('bound-plan'), name: 'update_plan', arguments: {}, signal: context.signal,
      })
      expect(bound.isError).toBe(false)
      expect(bound.content).toEqual([{ type: 'text', text: 'update_plan' }])
      expect(calls).toEqual(['update_plan'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects a direct assembly waterfall without the service-validated preparation token', async () => {
    const ctx = new Context()
    try {
      await services(ctx)
      await ctx.plugin(SystemPrompt)
    await ctx.plugin(ProductPrompt)
      await ctx.plugin(NativeToolRuntime)
    await ctx.plugin(NativeTools)
      CodexfulPrompt.apply(ctx, {})
      const assembly: PromptAssembly = { sections: [], contexts: [], tools: [], variables: {} }
      await expect(ctx.waterfall('codexy-prompt/assemble', assembly, { agent: fakeAgent('gpt-5.5') },
        async () => assembly)).rejects.toThrow('Codexful assembly requires a prompt preparation token')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each(['provider', 'model'] as const)('rejects a %s change introduced after prompt preparation', async (field) => {
    const ctx = new Context()
    try {
      await services(ctx)
      await ctx.plugin(SystemPrompt)
    await ctx.plugin(ProductPrompt)
      await ctx.plugin(NativeToolRuntime)
    await ctx.plugin(NativeTools)
      CodexfulPrompt.apply(ctx, {})
      ctx.on('codexy-prompt/assemble', async (_assembly, _context, next) => {
        const assembly = await next()
        return { ...assembly, variables: { ...assembly.variables, [field]: 'changed route' } }
      })
      await expect(ctx.codexyPrompt.assemble({ agent: fakeAgent('gpt-5.5') }))
        .rejects.toThrow('Codexful assembly route differs from its captured preparation')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('freezes an explicit wire profile before tool preparation and retains the durable base when the next step returns to default', async () => {
    const ctx = new Context()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let pending: Promise<void> | undefined
    try {
      const adapter = new RequestControlsAdapter(true)
      let preparations = 0
      await mountRequestControlsLoop(ctx, adapter, async () => {
        if (preparations++ === 0) { entered.resolve(undefined); await release.promise }
      })
      const modelPolicy = { nodeReplDisabled: false, nodeReplAutoReviewRequired: false }
      const config: CodexfulPrompt.Config = { toolProfile: 'codex-pinned', networkAccess: 'enabled', wireProfile: 'codex-0.162.1',
        metadata: { modelPolicy } }
      CodexfulPrompt.apply(ctx, config)
      const errors: unknown[] = []
      ctx.on('agent/error', ({ error }) => { errors.push(error) })
      const agent = await ctx.agentLoop.create(SessionId('captured-wire-profile'), { provider: 'test', model: 'gpt-5.5' })
      const input = () => createUserMessage({ content: [{ type: 'text', text: 'task' }], source: { kind: 'user' } })
      agent.followup(input())
      pending = agent.whenIdle()
      await Promise.race([entered.promise, pending.then(() => { throw new Error('agent became idle before tool preparation') })])
      config.wireProfile = undefined
      modelPolicy.nodeReplDisabled = true
      modelPolicy.nodeReplAutoReviewRequired = true
      release.resolve(undefined)
      await pending
      expect(errors).toEqual([])
      expect(adapter.requests).toHaveLength(1)
      const metadata = adapter.requests[0]?.options.codexfulResponses?.clientMetadata
      if (metadata === undefined) throw new Error('explicit wire profile did not capture client metadata')
      expect(adapter.requests[0]?.options.codexfulResponses).toEqual({ omitDefaultMaxTokens: true, reasoningSummary: 'none', wireProfile: 'codex-0.162.1', clientMetadata: metadata })
      const canonical = JSON.parse(metadata['x-codex-turn-metadata']!)
      expect(canonical).toMatchObject({ session_id: agent.session.id, thread_id: agent.session.id,
        request_kind: 'turn', model: 'gpt-5.5', reasoning_effort: 'medium',
        node_repl_disabled: false, node_repl_auto_review_required: false })
      const committedTurn = snapshotProductEvents(agent.session).find(event => event.type === 'turn/start'
        && `${agent.session.id}:turn:${event.seq}` === canonical.turn_id)
      expect(committedTurn).toBeDefined()
      expect(canonical.turn_started_at_unix_ms).toBe(committedTurn?.time)
      expect(requestHeaderOf(agent.session)?.config.codexfulResponses).toEqual(adapter.requests[0]?.options.codexfulResponses)
      const originalBase = adapter.requests[0]?.options.messages.find(message => message.role === 'system')
      expect(originalBase).toMatchObject({ role: 'system', source: { kind: 'system-prompt' } })
      agent.followup(input())
      await agent.whenIdle()
      expect(errors).toEqual([])
      expect(adapter.requests).toHaveLength(2)
      expect(adapter.requests[1]?.options.codexfulResponses).toEqual({ omitDefaultMaxTokens: true, reasoningSummary: 'none' })
      expect(adapter.requests[1]?.options.messages.find(message => message.role === 'system')).toEqual(originalBase)
      expect(requestHeaderOf(agent.session)?.config.codexfulResponses).toEqual(adapter.requests[1]?.options.codexfulResponses)
    } finally {
      release.resolve(undefined)
      await pending
      await ctx.fiber.dispose()
    }
  })

  it.each([false, true])('keeps prepared request controls through an async strict-policy change with native history=%s', async (native) => {
    const ctx = new Context()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let pending: Promise<void> | undefined
    try {
      const adapter = new RequestControlsAdapter(native)
      let preparations = 0
      await mountRequestControlsLoop(ctx, adapter, async () => {
        if (preparations++ === 0) {
          entered.resolve(undefined)
          await release.promise
        }
      })
      const config: CodexfulPrompt.Config = { toolProfile: 'codex-pinned', networkAccess: 'enabled', strictModelInput: false }
      CodexfulPrompt.apply(ctx, config)
      const errors: unknown[] = []
      ctx.on('agent/error', ({ error }) => { errors.push(error) })
      const agent = await ctx.agentLoop.create(SessionId(`captured-controls-${native}`), { provider: 'test', model: 'gpt-5.5' })
      const input = () => createUserMessage({ content: [{ type: 'text', text: 'task' }], source: { kind: 'user' } })
      agent.followup(input())
      pending = agent.whenIdle()
      await Promise.race([
        entered.promise,
        pending.then(() => { throw new Error('agent became idle before tool preparation') }),
      ])
      config.strictModelInput = true
      config.wireProfile = 'codex-0.162.1'
      release.resolve(undefined)
      await pending
      expect(errors).toEqual([])
      expect(adapter.requests).toHaveLength(1)
      expect(adapter.requests[0]?.options.reasoningEffort).toBe('medium')
      expect(adapter.requests[0]?.options.codexfulResponses).toEqual({ omitDefaultMaxTokens: true, reasoningSummary: 'none' })
      expect(requestHeaderOf(agent.session)?.config.codexfulResponses).toEqual({ omitDefaultMaxTokens: true, reasoningSummary: 'none' })
      const firstTexts = adapter.requests[0]!.options.messages.flatMap(message => message.content.flatMap(block =>
        block.type === 'text' ? [block.text] : []))
      expect(firstTexts.findLast(text => text.startsWith('<permissions instructions>')))
        .toContain('Network access is enabled.\n\nApproval policy is currently never.')
      expect(firstTexts.join('\n')).not.toContain('# DSH runtime adaptation')
      expect(adapter.requests[0]?.options.tools?.map(tool => tool.name)).toEqual(['exec_command', 'write_stdin'])

      agent.followup(input())
      await agent.whenIdle()
      expect(errors).toEqual([])
      expect(adapter.requests).toHaveLength(2)
      expect(adapter.requests[1]?.options.reasoningEffort).toBe('medium')
      const metadata = adapter.requests[1]?.options.codexfulResponses?.clientMetadata
      if (metadata === undefined) throw new Error('next step did not capture its explicit client metadata')
      expect(adapter.requests[1]?.options.codexfulResponses).toEqual({ omitDefaultMaxTokens: true, reasoningSummary: 'none', strictModelInput: true, wireProfile: 'codex-0.162.1', clientMetadata: metadata })
      expect(requestHeaderOf(agent.session)?.config.codexfulResponses).toEqual(adapter.requests[1]?.options.codexfulResponses)
      const canonical = JSON.parse(metadata['x-codex-turn-metadata']!)
      expect(canonical).toMatchObject({ session_id: agent.session.id, thread_id: agent.session.id,
        request_kind: 'turn', model: 'gpt-5.5', reasoning_effort: 'medium' })
      const committedTurn = snapshotProductEvents(agent.session).find(event => event.type === 'turn/start'
        && `${agent.session.id}:turn:${event.seq}` === canonical.turn_id)
      expect(committedTurn).toBeDefined()
      expect(canonical.turn_started_at_unix_ms).toBe(committedTurn?.time)
      const nextTexts = adapter.requests[1]!.options.messages.flatMap(message => message.content.flatMap(block =>
        block.type === 'text' ? [block.text] : []))
      expect(nextTexts.findLast(text => text.startsWith('<permissions instructions>')))
        .toContain('Network access is enabled.\nApproval policy is currently never.')
      expect(nextTexts.join('\n')).not.toContain('# DSH runtime adaptation')
      expect(adapter.requests[1]?.options.tools?.map(tool => tool.name)).toEqual(['exec_command', 'write_stdin'])
    } finally {
      release.resolve(undefined)
      await pending
      await ctx.fiber.dispose()
    }
  })

  it.each(['prepare', 'tools', 'assemble', 'pre-step', 'request'] as const)(
    'keeps one deployment generation while %s is waiting, then adopts the next configuration', async (phase) => {
      const ctx = new Context()
      const entered = Promise.withResolvers<undefined>()
      const release = Promise.withResolvers<undefined>()
      let pending: Promise<void> | undefined
      let waiting = false
      const barrier = async () => {
        if (waiting) return
        waiting = true
        entered.resolve(undefined)
        await release.promise
      }
      try {
        const adapter = new RequestControlsAdapter(true)
        await mountRequestControlsLoop(ctx, adapter, phase === 'tools' ? barrier : undefined)
        const sandbox = vi.spyOn(ctx.sandboxPolicy, 'resolve').mockReturnValue({ mode: 'workspace-write', workspaceRoot: '/work/a&b' })
        const approval = vi.spyOn(ctx.codexyApproval, 'overrideOf').mockReturnValue('ask')
        const config: CodexfulPrompt.Config = {
          toolProfile: 'daily', strictModelInput: false, updatePlan: false, networkAccess: 'disabled',
          protectExistingWorkspaceMetadata: false, additionalRetryableCodes: ['FIRST_CODE'],
        }
        CodexfulPrompt.apply(ctx, config)
        const snapshots: ReturnType<typeof codexfulPreparationOf>[] = []
        ctx.on('codexy-prompt/assemble', async (_assembly, context, next) => {
          const assembly = await next()
          if (context.agent !== undefined && context.promptPreparation !== undefined) {
            snapshots.push(codexfulPreparationOf(context.promptPreparation))
            expect(Object.getOwnPropertySymbols(assembly.variables)).toEqual([])
            expect(Object.keys(assembly.variables).filter(key => key.startsWith('codexful_')))
              .toEqual(['codexful_multi_agent_version'])
          }
          return assembly
        })
        if (phase === 'prepare') ctx.on('codexy-prompt/prepare', async (_variables, context, next) => {
          if (context.agent !== undefined) await barrier()
          return next()
        })
        if (phase === 'assemble') ctx.on('codexy-prompt/assemble', async (_assembly, context, next) => {
          if (context.agent !== undefined) await barrier()
          return next()
        })
        if (phase === 'pre-step') ctx.on('codexy-agent/pre-step', async (_event, next) => {
          await barrier()
          return next()
        })
        if (phase === 'request') ctx.on('codexy-agent/request', async (_event, next) => {
          await barrier()
          return next()
        })
        const errors: unknown[] = []
        ctx.on('agent/error', ({ error }) => { errors.push(error) })
        const agent = await ctx.agentLoop.create(SessionId(`captured-deployment-${phase}`), { provider: 'test', model: 'gpt-5.5' })
        const input = () => createUserMessage({ content: [{ type: 'text', text: 'task' }], source: { kind: 'user' } })
        agent.followup(input())
        pending = agent.whenIdle()
        await Promise.race([entered.promise, pending.then(() => { throw new Error('agent became idle before the barrier') })])
        config.toolProfile = 'codex-pinned'
        config.strictModelInput = true
        config.updatePlan = true
        config.networkAccess = 'enabled'
        config.protectExistingWorkspaceMetadata = true
        config.additionalRetryableCodes?.splice(0, 1, 'SECOND_CODE')
        release.resolve(undefined)
        await pending
        expect(errors).toEqual([])
        expect(adapter.requests).toHaveLength(1)
        const texts = (options: GenerateOptions) => options.messages.flatMap(message => message.content.flatMap(block =>
          block.type === 'text' ? [block.text] : []))
        expect(adapter.requests[0]?.options.tools?.map(tool => tool.name)).toEqual(['exec_command', 'write_stdin'])
        expect(adapter.requests[0]?.options.codexfulResponses).not.toHaveProperty('strictModelInput')
        expect(texts(adapter.requests[0]!.options).join('\n')).toContain('# DSH runtime adaptation')
        expect(texts(adapter.requests[0]!.options).findLast(text => text.startsWith('<permissions instructions>')))
          .toContain('shell sandbox does not protect those paths separately')
        expect(texts(adapter.requests[0]!.options).findLast(text => text.startsWith('<permissions instructions>')))
          .toContain('Network reachability is reported as disabled')
        expect(snapshots[0]?.deployment).toMatchObject({ toolProfile: 'daily', strictModelInput: false,
          updatePlan: false, networkAccess: 'disabled', protectExistingWorkspaceMetadata: false,
          additionalRetryableCodes: ['FIRST_CODE'] })
        expect(Object.isFrozen(snapshots[0])).toBe(true)
        expect(Object.isFrozen(snapshots[0]?.deployment.additionalRetryableCodes)).toBe(true)
        expect(Object.isFrozen(snapshots[0]?.toolProfile.hiddenTools)).toBe(true)
        expect(Object.isFrozen(snapshots[0]?.toolProfile.sourceTruncation)).toBe(true)

        sandbox.mockReturnValue({ mode: 'danger-full-access', workspaceRoot: '/work/a&b' })
        approval.mockReturnValue('never')
        agent.followup(input())
        await agent.whenIdle()
        expect(errors).toEqual([])
        expect(adapter.requests).toHaveLength(2)
        expect(adapter.requests[1]?.options.tools?.map(tool => tool.name)).toEqual(['exec_command', 'update_plan', 'write_stdin'])
        expect(adapter.requests[1]?.options.codexfulResponses).toHaveProperty('strictModelInput', true)
        expect(texts(adapter.requests[1]!.options).findLast(text => text.startsWith('<permissions instructions>')))
          .toContain('Network access is enabled.')
        expect(snapshots[1]?.deployment).toMatchObject({ toolProfile: 'codex-pinned', strictModelInput: true,
          updatePlan: true, networkAccess: 'enabled', protectExistingWorkspaceMetadata: true,
          additionalRetryableCodes: ['SECOND_CODE'] })
        expect(snapshots[1]).not.toBe(snapshots[0])

        config.strictModelInput = false
        sandbox.mockReturnValue({ mode: 'workspace-write', workspaceRoot: '/work/a&b' })
        approval.mockReturnValue('ask')
        agent.followup(input())
        await agent.whenIdle()
        expect(errors).toEqual([])
        expect(adapter.requests).toHaveLength(3)
        expect(texts(adapter.requests[2]!.options).findLast(text => text.startsWith('<permissions instructions>')))
          .toContain('shell protection depends on the runner and whether a metadata path already exists')
      } finally {
        release.resolve(undefined)
        await pending
        await ctx.fiber.dispose()
      }
    },
  )

  it.each(['prepare', 'tools'] as const)('keeps a prepared pinned v1 prompt through %s while the next step adopts daily v2', async (phase) => {
    const ctx = new Context()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let pending: Promise<void> | undefined
    try {
      const adapter = new RequestControlsAdapter(true)
      let preparations = 0
      const barrier = async () => {
        if (preparations++ === 0) {
          entered.resolve(undefined)
          await release.promise
        }
      }
      await mountRequestControlsLoop(ctx, adapter, phase === 'tools' ? barrier : undefined)
      delegationTools(ctx)
      const config: CodexfulPrompt.Config = { toolProfile: 'codex-pinned', networkAccess: 'enabled', strictModelInput: false }
      CodexfulPrompt.apply(ctx, config)
      if (phase === 'prepare') ctx.on('codexy-prompt/prepare', async (_variables, context, next) => {
        if (context.agent !== undefined) await barrier()
        return next()
      })
      let skills = 'PROFILE SKILLS FIRST'
      ctx.codexyPrompt.context({ name: 'codexful:skills', order: 0, role: 'developer', text: () => skills })
      const errors: unknown[] = []
      ctx.on('agent/error', ({ error }) => { errors.push(error) })
      const agent = await ctx.agentLoop.create(SessionId(`captured-profile-version-${phase}`), { provider: 'test', model: 'gpt-5.5' })
      const instructions = (text: string) => createUserMessage({
        content: [{ type: 'text', text }], source: { kind: 'agent-instructions', form: 'instructions', changes: [] },
      })
      const instructionOrder = (options: GenerateOptions, instructionText: string, skillText: string) =>
        options.messages.flatMap((message) => {
          const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
          if (text === instructionText) return [`AGENTS:${message.role}`]
          if (text === skillText) return [`skills:${message.role}`]
          return []
        })
      const input = () => createUserMessage({ content: [{ type: 'text', text: 'task' }], source: { kind: 'user' } })
      agent.inject(instructions('PROFILE AGENTS FIRST'))
      agent.steer(input())
      pending = agent.whenIdle()
      await Promise.race([
        entered.promise,
        pending.then(() => { throw new Error('agent became idle before tool preparation') }),
      ])
      config.toolProfile = 'daily'
      appendProductEvent(agent.session, 'codexful/multi-agent-version', { version: 'v2' })
      release.resolve(undefined)
      await pending
      expect(errors).toEqual([])
      expect(adapter.requests).toHaveLength(1)
      expect(adapter.requests[0]?.options.tools?.map(tool => tool.name)).toEqual([
        'exec_command', 'multi_agent_v1__spawn_agent', 'write_stdin',
      ])
      const firstTexts = adapter.requests[0]!.options.messages.flatMap(message => message.content.flatMap(block =>
        block.type === 'text' ? [block.text] : []))
      expect(firstTexts.join('\n')).not.toContain('# DSH runtime adaptation')
      expect(instructionOrder(adapter.requests[0]!.options, 'PROFILE AGENTS FIRST', 'PROFILE SKILLS FIRST'))
        .toEqual(['skills:developer', 'AGENTS:user'])
      expect(snapshotProductEvents(agent.session).filter(event => event.type === 'codexful/multi-agent-version').at(-1)?.data)
        .toEqual({ version: 'v1' })

      skills = 'PROFILE SKILLS SECOND'
      agent.inject(instructions('PROFILE AGENTS SECOND'))
      agent.steer(input())
      await agent.whenIdle()
      expect(errors).toEqual([])
      expect(adapter.requests).toHaveLength(2)
      expect(adapter.requests[1]?.options.tools?.map(tool => tool.name)).toEqual([
        'exec_command', 'spawn_agent', 'update_plan', 'write_stdin',
      ])
      expect(adapter.requests[1]!.options.messages.flatMap(message => message.content.flatMap(block =>
        block.type === 'text' ? [block.text] : [])).join('\n')).toContain('# DSH runtime adaptation')
      expect(instructionOrder(adapter.requests[1]!.options, 'PROFILE AGENTS SECOND', 'PROFILE SKILLS SECOND'))
        .toEqual(['AGENTS:user', 'skills:developer'])
      expect(requestHeaderOf(agent.session)?.tools).toEqual(adapter.requests[1]?.options.tools)
      expect(snapshotProductEvents(agent.session).filter(event => event.type === 'codexful/multi-agent-version').at(-1)?.data)
        .toEqual({ version: 'v2' })
    } finally {
      release.resolve(undefined)
      await pending
      await ctx.fiber.dispose()
    }
  })

  it('uses the scoped model selection for every derived setting in the snapshot', async () => {
    const ctx = new Context()
    try {
      const adapter = new RequestControlsAdapter(true)
      await mountRequestControlsLoop(ctx, adapter)
      delegationTools(ctx)
      CodexfulPrompt.apply(ctx, { toolProfile: 'codex-pinned', networkAccess: 'enabled' })
      const errors: unknown[] = []
      ctx.on('agent/error', ({ error }) => { errors.push(error) })
      const agent = await ctx.agentLoop.create(SessionId('prepared-model-selection'), { provider: 'test', model: 'gpt-6-sol' })
      const selection = { current: { provider: 'test', model: 'gpt-5.5' }, assembled: undefined }
      agent.ctx.effect(() => installModelSelection(agent.ctx, selection), 'preparation.modelSelection')
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'task' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      expect(errors).toEqual([])
      expect(adapter.requests).toHaveLength(1)
      expect(adapter.requests[0]?.options.model).toBe('gpt-5.5')
      expect(adapter.requests[0]?.options.reasoningEffort).toBe('medium')
      expect(adapter.requests[0]?.options.tools?.map(tool => tool.name)).toEqual([
        'exec_command', 'multi_agent_v1__spawn_agent', 'write_stdin',
      ])
      expect(adapter.requests[0]?.options.messages[0]?.content)
        .toEqual([{ type: 'text', text: withoutUpdatePlanInstructions(CodexfulPrompt.codexfulModelProfile('gpt-5.5').prompt) }])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each(['scoped model selection', 'outer prepend selector'] as const)(
    'derives its scoped private snapshot from the final route after %s', async (selector) => {
      const ctx = new Context()
      try {
        await services(ctx)
        await ctx.plugin(SystemPrompt)
    await ctx.plugin(ProductPrompt)
        await ctx.plugin(NativeToolRuntime)
    await ctx.plugin(NativeTools)
        delegationTools(ctx)
        const agent = fakeAgent('gpt-6-sol', SessionId(`final-route-${selector}`))
        const scope = createScope(ctx, agent)
        Object.assign(agent, { ctx: scope.ctx })
        const selection: ModelSelectionRef = { current: {
          provider: 'test', model: selector === 'scoped model selection' ? 'gpt-5.5' : 'gpt-6-sol',
          reasoningEffort: ReasoningEffortId(selector === 'scoped model selection' ? 'high' : 'low'),
        }, assembled: undefined }
        scope.ctx.effect(() => installModelSelection(scope.ctx, selection), 'final-route.modelSelection')
        await scope.ctx.plugin(CodexfulPrompt, { toolProfile: 'codex-pinned', networkAccess: 'disabled' })
        if (selector === 'outer prepend selector') ctx.on('codexy-prompt/prepare', async (_variables, _context, next) => ({
          ...await next(), provider: 'test', model: 'gpt-5.5', reasoning_effort: 'high',
        }), { prepend: true })
        const context = { agent, scope: agent }
        const promptPreparation = await ctx.codexyPrompt.prepare(context)
        const captured = codexfulPreparationOf(promptPreparation)
        expect(promptPreparation.variables).toMatchObject({ provider: 'test', model: 'gpt-5.5',
          reasoning_effort: 'high', codexful_multi_agent_version: 'v1',
        })
        expect(captured).toMatchObject({ provider: 'test', model: 'gpt-5.5', multiAgentVersion: 'v1',
          reasoningSummary: 'none', defaultReasoningEffort: 'medium', configuredReasoningEffort: 'high',
        })
        const assembly = await ctx.codexyPrompt.assemble(context, promptPreparation)
        expect(renderPrompt(assembly)).toBe(withoutUpdatePlanInstructions(CodexfulPrompt.codexfulModelProfile('gpt-5.5').prompt))
        expect(assembly.tools.map(tool => tool.name)).toEqual(['multi_agent_v1__spawn_agent'])
        expect(Object.getOwnPropertySymbols(assembly.variables)).toEqual([])
        expect(Object.keys(assembly.variables).filter(key => key.startsWith('codexful_')))
          .toEqual(['codexful_multi_agent_version'])
        const request = await agentEvents(ctx, agent).waterfall('codexy-agent/request', {
          turn: 1, step: 1, signal: new AbortController().signal, promptPreparation,
        }, async () => ({ provider: 'test', model: 'gpt-6-sol' }))
        expect(request).toMatchObject({ provider: 'test', model: 'gpt-5.5', reasoningEffort: 'high',
          codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none' },
        })
      } finally {
        await ctx.fiber.dispose()
      }
    },
  )

  it('reuses the last successful snapshot for manual input placement, requests, and compaction', async () => {
    const ctx = new Context()
    try {
      const adapter = new RequestControlsAdapter(true)
      await mountRequestControlsLoop(ctx, adapter)
      const config: CodexfulPrompt.Config = { toolProfile: 'daily', networkAccess: 'disabled', updatePlan: false }
      CodexfulPrompt.apply(ctx, config)
      const errors: unknown[] = []
      ctx.on('agent/error', ({ error }) => { errors.push(error) })
      const agent = await ctx.agentLoop.create(SessionId('manual-prepared-generation'), { provider: 'test', model: 'gpt-5.5' })
      const task = createUserMessage({ content: [{ type: 'text', text: 'task' }], source: { kind: 'user' } })
      agent.followup(task)
      await agent.whenIdle()
      expect(errors).toEqual([])
      config.toolProfile = 'codex-pinned'
      config.strictModelInput = true
      config.networkAccess = 'enabled'
      const dispatch = agentEvents(ctx, agent)
      const control = { turn: 2, step: 1, signal: new AbortController().signal }
      const decision = await dispatch.waterfall('codexy-agent/pre-step', { ...control, messages: [task] },
        async () => ({ kind: 'enter', messages: [task] }))
      expect(decision).toHaveProperty('developerContextPlacement', 'after-agent-instructions')
      const request = await dispatch.waterfall('codexy-agent/request', control, async () => ({ provider: 'test', model: 'gpt-5.5' }))
      expect(request.codexfulResponses).toEqual({ omitDefaultMaxTokens: true, reasoningSummary: 'none' })
      const captured = await ctx.waterfall('codexy-compaction/initial-context', { agent }, async () => undefined)
      expect(captured?.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
        .find(text => text.startsWith('<permissions instructions>'))).toContain('Network reachability is reported as disabled')
      expect(adapter.requests).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps the triggering request context when a later preview finishes before compaction', async () => {
    const ctx = new Context()
    const entered = Promise.withResolvers<PromptPreparation>()
    const release = Promise.withResolvers<undefined>()
    let pending: Promise<void> | undefined
    try {
      const adapter = new RequestControlsAdapter(true, ['low', 'medium', 'high', 'ultra'])
      await mountRequestControlsLoop(ctx, adapter)
      delegationTools(ctx)
      let skills = 'REQUEST SKILLS'
      ctx.codexyPrompt.context({ name: 'codexful:skills', order: 0, role: 'developer', text: () => skills })
      const config: CodexfulPrompt.Config = { toolProfile: 'daily', networkAccess: 'disabled', updatePlan: false }
      CodexfulPrompt.apply(ctx, config)
      let paused = false
      ctx.on('agent/request-enter', async ({ promptPreparation }) => {
        if (paused) return
        paused = true
        entered.resolve(promptPreparation)
        await release.promise
      })
      const errors: unknown[] = []
      ctx.on('agent/error', ({ error }) => { errors.push(error) })
      const agent = await ctx.agentLoop.create(SessionId('compaction-request-preview'), { provider: 'test', model: 'gpt-6-sol' })
      const selection: ModelSelectionRef = {
        current: { provider: 'test', model: 'gpt-6-sol', reasoningEffort: ReasoningEffortId('ultra') },
        assembled: undefined,
      }
      agent.ctx.effect(() => installModelSelection(agent.ctx, selection), 'compaction-preview.modelSelection')
      const task = createUserMessage({ content: [{ type: 'text', text: 'task' }], source: { kind: 'user' } })
      agent.followup(task)
      pending = agent.whenIdle()
      const promptPreparation = await Promise.race([
        entered.promise,
        pending.then(() => {
          expect(errors).toEqual([])
          throw new Error('agent became idle before request admission')
        }),
      ])
      expect(adapter.requests).toHaveLength(0)
      config.toolProfile = 'codex-pinned'
      config.networkAccess = 'enabled'
      config.updatePlan = true
      skills = 'PREVIEW SKILLS'
      selection.current = { provider: 'test', model: 'gpt-5.5', reasoningEffort: ReasoningEffortId('high') }
      const preview = await ctx.codexyPrompt.assemble({ agent, scope: agent })
      const captured = await ctx.waterfall('codexy-compaction/initial-context', { agent, promptPreparation }, async () => undefined)
      const text = (messages: typeof captured) => messages?.flatMap(message => message.content.flatMap(block =>
        block.type === 'text' ? [block.text] : [])).join('\n') ?? ''
      expect(text(captured)).toContain('REQUEST SKILLS')
      expect(text(captured)).not.toContain('PREVIEW SKILLS')
      expect(text(captured)).toContain('Network reachability is reported as disabled')
      expect(text(captured)).toContain(CODEX_PROACTIVE_MULTI_AGENT_MODE)
      expect(text(captured)).not.toContain(CODEX_EXPLICIT_MULTI_AGENT_MODE)

      preview.contexts.find(section => section.name === 'codexful:skills')!.text = 'MUTATED PREVIEW SKILLS'
      preview.variables.model = 'MUTATED PREVIEW MODEL'
      preview.tools.splice(0)
      const standalone = await ctx.waterfall('codexy-compaction/initial-context', { agent }, async () => undefined)
      expect(text(standalone)).toContain('PREVIEW SKILLS')
      expect(text(standalone)).not.toContain('MUTATED PREVIEW')
      expect(text(standalone)).toContain('Network access is enabled.')
      expect(text(standalone)).toContain(CODEX_EXPLICIT_MULTI_AGENT_MODE)
      expect(text(standalone)).not.toContain(CODEX_PROACTIVE_MULTI_AGENT_MODE)

      release.resolve(undefined)
      await pending
      expect(errors).toEqual([])
      expect(adapter.requests).toHaveLength(1)
      expect(adapter.requests[0]?.options.model).toBe('gpt-6-sol')
      expect(adapter.requests[0]?.options.reasoningEffort).toBe('ultra')
      const original = adapter.requests[0]!.options.messages.flatMap(message => message.content.flatMap(block =>
        block.type === 'text' ? [block.text] : [])).join('\n')
      expect(original).toContain('REQUEST SKILLS')
      expect(original).not.toContain('PREVIEW SKILLS')
      expect(original).toContain('Network reachability is reported as disabled')
      agent.followup(task)
      await agent.whenIdle()
      expect(errors).toEqual([])
      expect(adapter.requests[1]?.options.model).toBe('gpt-5.5')
      expect(adapter.requests[1]?.options.reasoningEffort).toBe('high')
    } finally {
      release.resolve(undefined)
      await pending
      await ctx.fiber.dispose()
    }
  })

  it('rejects foreign, unassembled, and failed preparation tokens without replacing the last successful context', async () => {
    const ctx = new Context()
    try {
      await services(ctx)
      await ctx.plugin(SystemPrompt)
    await ctx.plugin(ProductPrompt)
      await ctx.plugin(NativeToolRuntime)
    await ctx.plugin(NativeTools)
      CodexfulPrompt.apply(ctx, {})
      const agent = fakeAgent('gpt-6-sol')
      const context = { agent, scope: agent }
      const successful = await ctx.codexyPrompt.prepare(context)
      await ctx.codexyPrompt.assemble(context, successful)
      const foreign = fakeAgent('gpt-6-sol', SessionId('foreign-captured-owner'))
      const rejected = 'Codexful preparation has no successful assembly owned by this agent'
      await expect(ctx.waterfall('codexy-compaction/initial-context', { agent: foreign, promptPreparation: successful }, async () => undefined))
        .rejects.toThrow(rejected)
      const unassembled = await ctx.codexyPrompt.prepare(context)
      await expect(ctx.waterfall('codexy-compaction/initial-context', { agent, promptPreparation: unassembled }, async () => undefined))
        .rejects.toThrow(rejected)
      const failed = await ctx.codexyPrompt.prepare(context)
      vi.spyOn(ctx.subprocess, 'terminalEnvironment').mockRejectedValueOnce(new Error('environment unavailable'))
      await expect(ctx.codexyPrompt.assemble(context, failed)).rejects.toThrow('environment unavailable')
      await expect(ctx.waterfall('codexy-compaction/initial-context', { agent, promptPreparation: failed }, async () => undefined))
        .rejects.toThrow(rejected)
      const control = { turn: 1, step: 1, signal: new AbortController().signal, promptPreparation: unassembled }
      const task = createUserMessage({ content: [{ type: 'text', text: 'task' }], source: { kind: 'user' } })
      await expect(agentEvents(ctx, agent).waterfall('codexy-agent/pre-step', { ...control, messages: [task] },
        async () => ({ kind: 'enter', messages: [task] }))).rejects.toThrow(rejected)
      await expect(agentEvents(ctx, agent).waterfall('codexy-agent/request', control,
        async () => ({ provider: 'test', model: 'gpt-6-sol' }))).rejects.toThrow(rejected)
      const expected = await ctx.waterfall('codexy-compaction/initial-context', { agent, promptPreparation: successful }, async () => undefined)
      expect(expected).toBeDefined()
      const standalone = await ctx.waterfall('codexy-compaction/initial-context', { agent }, async () => undefined)
      expect(standalone?.map(({ role, content, source }) => ({ role, content, source })))
        .toEqual(expected?.map(({ role, content, source }) => ({ role, content, source })))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each(['outer failure', 'cancelled'] as const)(
    'retains successful context and direct tool visibility after %s following its own assembly listener', async (failure) => {
      const ctx = new Context()
      try {
        await mountRequestControlsLoop(ctx, new RequestControlsAdapter(true))
        let skills = 'SUCCESSFUL SKILLS'
        ctx.codexyPrompt.context({ name: 'codexful:skills', order: 0, role: 'developer', text: () => skills })
        const config: CodexfulPrompt.Config = { toolProfile: 'daily', networkAccess: 'disabled', updatePlan: true }
        CodexfulPrompt.apply(ctx, config)
        const agent = await ctx.agentLoop.create(SessionId(`final-assembly-${failure}`), { provider: 'test', model: 'gpt-6-sol' })
        const context = { agent, scope: agent }
        const successful = await ctx.codexyPrompt.prepare(context)
        await ctx.codexyPrompt.assemble(context, successful)
        config.networkAccess = 'enabled'
        config.updatePlan = false
        skills = 'FAILED SKILLS'
        const controller = new AbortController()
        ctx.on('codexy-prompt/assemble', async (_assembly, _context, next) => {
          const assembly = await next()
          if (failure === 'outer failure') throw new Error('outer listener rejected assembly')
          controller.abort(new Error('cancelled after inner assembly'))
          return assembly
        }, { prepend: true })
        const failedContext = { ...context, signal: controller.signal }
        const failed = await ctx.codexyPrompt.prepare(failedContext)
        await expect(ctx.codexyPrompt.assemble(failedContext, failed)).rejects.toThrow(failure === 'outer failure'
          ? 'outer listener rejected assembly' : 'cancelled after inner assembly')
        await expect(ctx.waterfall('codexy-compaction/initial-context', { agent, promptPreparation: failed }, async () => undefined))
          .rejects.toThrow('Codexful preparation has no successful assembly owned by this agent')
        const captured = await ctx.waterfall('codexy-compaction/initial-context', { agent }, async () => undefined)
        const texts = captured?.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
        expect(texts).toContain('SUCCESSFUL SKILLS')
        expect(texts).not.toContain('FAILED SKILLS')
        expect(texts).toContain('Network reachability is reported as disabled')
        const result = await ctx.codexyTools.execute({
          agent, callId: ToolCallId(`retained-plan-${failure}`), name: 'update_plan', arguments: {}, signal: new AbortController().signal,
        })
        expect(result.isError).toBe(false)
        expect(result.content).toEqual([{ type: 'text', text: 'done' }])
      } finally {
        await ctx.fiber.dispose()
      }
    },
  )

  it('captures context changes made by an outer assembly listener before final notification', async () => {
    const ctx = new Context()
    try {
      await services(ctx)
      await ctx.plugin(SystemPrompt)
    await ctx.plugin(ProductPrompt)
      await ctx.plugin(NativeToolRuntime)
    await ctx.plugin(NativeTools)
      CodexfulPrompt.apply(ctx, {})
      ctx.on('codexy-prompt/assemble', async (_assembly, _context, next) => {
        const assembly = await next()
        return { ...assembly, variables: { ...assembly.variables, skill: 'outer skill' },
          contexts: [...assembly.contexts, { name: 'outer:skill', role: 'developer', text: '{{skill}}' }],
        }
      }, { prepend: true })
      const agent = fakeAgent('gpt-6-sol')
      const context = { agent }
      const promptPreparation = await ctx.codexyPrompt.prepare(context)
      const returned = await ctx.codexyPrompt.assemble(context, promptPreparation)
      returned.variables.skill = 'later mutation'
      const captured = await ctx.waterfall('codexy-compaction/initial-context', { agent, promptPreparation }, async () => undefined)
      expect(captured?.[0]?.content).toEqual([{ type: 'text', text: 'outer skill' }])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects an older preparation without Codexful controls instead of substituting the live configuration', async () => {
    const ctx = new Context()
    try {
      await mountRequestControlsLoop(ctx, new RequestControlsAdapter(true))
      const agent = await ctx.agentLoop.create(SessionId('missing-prepared-profile'), { provider: 'test', model: 'gpt-5.5' })
      const context = { agent, scope: agent }
      const prepared = await ctx.codexyPrompt.prepare(context)
      await ctx.plugin(CodexfulPrompt, { toolProfile: 'codex-pinned', networkAccess: 'enabled' })
      await expect(ctx.codexyPrompt.assemble(context, prepared))
        .rejects.toThrow('Codexful requires its captured preparation snapshot')
      const preview = await ctx.codexyPrompt.assemble(context)
      expect(preview.variables).toMatchObject({ codexful_multi_agent_version: 'v1' })
      expect(preview.tools.map(tool => tool.name)).toEqual(['exec_command', 'write_stdin'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('validates the proposed strict controls when a same-route generation changes from Lite to standard', async () => {
    const ctx = new Context()
    try {
      const adapter = new RequestControlsAdapter(true)
      adapter.lite = true
      await mountRequestControlsLoop(ctx, adapter)
      await ctx.plugin(CodexfulPrompt, { toolProfile: 'codex-pinned', networkAccess: 'enabled', strictModelInput: true })
      const errors: unknown[] = []
      ctx.on('agent/error', ({ error }) => { errors.push(error) })
      const agent = await ctx.agentLoop.create(SessionId('captured-controls-lite'), { provider: 'test', model: 'gpt-5.5' })
      const input = () => createUserMessage({ content: [{ type: 'text', text: 'task' }], source: { kind: 'user' } })
      agent.followup(input())
      await agent.whenIdle()
      expect(errors).toEqual([])
      expect(adapter.requests).toHaveLength(1)
      expect(adapter.requests[0]?.lite).toBe(true)
      expect(requestHeaderOf(agent.session)?.config.codexfulResponses).toEqual({
        omitDefaultMaxTokens: true, reasoningSummary: 'none', strictModelInput: true, lite: true,
      })

      adapter.lite = false
      agent.followup(input())
      await agent.whenIdle()
      expect(errors).toEqual([])
      expect(adapter.requests).toHaveLength(2)
      expect(adapter.requests[1]?.lite).toBe(false)
      expect(adapter.requests[1]?.options.codexfulResponses).toEqual({ omitDefaultMaxTokens: true, reasoningSummary: 'none', strictModelInput: true })
      expect(requestHeaderOf(agent.session)?.config.codexfulResponses).toEqual({ omitDefaultMaxTokens: true, reasoningSummary: 'none', strictModelInput: true })
      expect(adapter.requests[1]?.options.messages.filter(message => message.source?.kind === 'model-selection')).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each(['gpt-5.5', 'qwen3.8'])('uses only the pinned base prompt for %s without requiring native developer history', async (model) => {
    const ctx = new Context()
    try {
      await services(ctx, 'workspace-write', 'ask', false)
      await ctx.plugin(SystemPrompt)
    await ctx.plugin(ProductPrompt)
      await ctx.plugin(NativeToolRuntime)
    await ctx.plugin(NativeTools)
      ctx.codexyPrompt.section({ name: 'fixture:host', order: 0, text: 'HOST_ONLY_SECTION' })
      ctx.codexyPrompt.context({ name: 'codexful:skills', order: 0, role: 'developer', text: 'SKILLS' })
      await ctx.plugin(CodexfulPrompt, { toolProfile: 'codex-pinned' })
      const agent = fakeAgent(model)
      const assembly = await ctx.codexyPrompt.assemble({ agent })
      expect(renderPrompt(assembly)).toBe(withoutUpdatePlanInstructions(CodexfulPrompt.codexfulModelProfile(model).prompt))
      expect(assembly.contexts.map(section => section.name)).toEqual(['codexful:skills', 'codexful:permissions', 'codexful:environment'])
      const task = createUserMessage({ content: [{ type: 'text', text: 'task' }], source: { kind: 'user' } })
      const decision = await agentEvents(ctx, agent).waterfall('codexy-agent/pre-step', {
        turn: 1, step: 1, messages: [task], signal: new AbortController().signal,
      }, async () => ({ kind: 'enter', messages: [task] }))
      expect(decision).not.toHaveProperty('developerContextPlacement')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('captures compaction context from the last successful assembly and releases the contribution on unload', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
    await ctx.plugin(ProductPrompt)
      await ctx.plugin(NativeToolRuntime)
    await ctx.plugin(NativeTools)
      const { resolveModelInfo } = await services(ctx, 'workspace-write', 'ask', true, 'ultra')
      let selectedModel = 'gpt-6-sol'
      ctx.codexyPrompt.variable('model', () => selectedModel)
      delegationTools(ctx)
      ctx.codexyPrompt.context({ name: 'codexful-v2:multi-agent-role', order: 0, role: 'developer', text: 'plain root role' })
      const fiber = ctx.plugin(CodexfulPrompt, { networkAccess: 'enabled' })
      await fiber
      const agent = fakeAgent('gpt-6-sol')
      await ctx.codexyPrompt.assemble({ agent })
      selectedModel = 'gpt-5.6-luna'
      vi.spyOn(ctx.subprocess, 'terminalEnvironment').mockRejectedValueOnce(new Error('environment unavailable'))
      await expect(ctx.codexyPrompt.assemble({ agent })).rejects.toThrow('environment unavailable')
      const captured = await ctx.waterfall('codexy-compaction/initial-context', { agent }, async () => undefined)
      expect(resolveModelInfo).toHaveBeenLastCalledWith('test', 'gpt-6-sol', undefined)
      expect(captured?.map(message => message.role)).toEqual(['developer', 'developer', 'developer', 'user'])
      expect(captured?.[1]?.content).toEqual([{ type: 'text', text: 'plain root role' }])
      expect(captured?.[2]?.source).toMatchObject({
        codexMultiAgentWorldState: { section: 'multi-agent-mode', mode: 'full', snapshot: { body: CODEX_PROACTIVE_MULTI_AGENT_MODE, role: 'plain root role' } },
      })
      expect(captured?.at(-1)?.content[0]).toHaveProperty('text', expect.stringContaining('<cwd>/work/a&amp;b</cwd>'))
      const unrelated = fakeAgent('gpt-6-sol', SessionId('unassembled-codexful'))
      const fallback = [createUserMessage({ content: [{ type: 'text', text: 'other application context' }], source: { kind: 'user' } })]
      const next = vi.fn(async () => fallback)
      await expect(ctx.waterfall('codexy-compaction/initial-context', { agent: unrelated }, next)).resolves.toBe(fallback)
      expect(next).toHaveBeenCalledOnce()
      await fiber.dispose()
      await expect(ctx.waterfall('codexy-compaction/initial-context', { agent }, async () => undefined)).resolves.toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each([
    { name: 'restored explicit ultra', before: 'ultra', adapterDefault: false, selected: undefined, prepared: undefined, providerDefault: 'medium', proactive: true },
    { name: 'restored provider default', before: 'ultra', adapterDefault: true, selected: undefined, prepared: undefined, providerDefault: 'medium', proactive: false },
    { name: 'selected default clears restored effort', before: 'ultra', adapterDefault: false, selected: '', prepared: undefined, providerDefault: 'medium', proactive: false },
    { name: 'prepared override of selected ultra', before: undefined, adapterDefault: false, selected: 'ultra', prepared: 'high', providerDefault: 'medium', proactive: false },
    { name: 'prepared absent effort', before: undefined, adapterDefault: false, selected: undefined, prepared: null, providerDefault: 'ultra', proactive: false },
  ])('captures compaction delegation mode for $name', async ({ before, adapterDefault, selected, prepared, providerDefault, proactive }) => {
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
    await ctx.plugin(ProductPrompt)
      await ctx.plugin(NativeToolRuntime)
    await ctx.plugin(NativeTools)
      await ctx.plugin(SessionStore)
      await services(ctx, 'workspace-write', 'ask', true, providerDefault)
      delegationTools(ctx)
      if (selected !== undefined) ctx.codexyPrompt.variable('reasoning_effort', () => selected)
      await ctx.plugin(CodexfulPrompt, { networkAccess: 'enabled' })
      const agent = fakeAgent('gpt-6-sol')
      ctx.effect(() => ctx.sessions.enter(agent.session), 'compaction-mode.session')
      const recordHeader = (effort: string | null) => agent.session.append('request/header', {
        reason: requestHeaderOf(agent.session) === undefined ? 'initial' : 'change',
        header: { config: { provider: 'test', model: 'gpt-6-sol',
          ...effort === null ? {} : { reasoningEffort: ReasoningEffortId(effort) } },
        ...adapterDefault ? { adapterDefaults: { reasoningEffort: true as const } } : {} },
      })
      if (before !== undefined) recordHeader(before)
      const context = { agent }
      const promptPreparation = await ctx.codexyPrompt.prepare(context)
      await ctx.codexyPrompt.assemble(context, promptPreparation)
      if (prepared !== undefined) await agentEvents(ctx, agent).serial('agent/request-enter', {
        turn: 1, step: 1, attempt: 1, signal: new AbortController().signal, promptPreparation,
        config: Object.freeze({ provider: 'test', model: 'gpt-6-sol',
          ...prepared === null ? {} : { reasoningEffort: ReasoningEffortId(prepared) } }),
      })
      const captured = await ctx.waterfall('codexy-compaction/initial-context', { agent, promptPreparation }, async () => undefined)
      const mode = captured?.find(message => message.source.kind === 'runtime-context'
        && message.source.codexMultiAgentWorldState?.section === 'multi-agent-mode')
      expect(mode?.content).toEqual([{ type: 'text', text: `<multi_agent_mode>${proactive
        ? CODEX_PROACTIVE_MULTI_AGENT_MODE : CODEX_EXPLICIT_MULTI_AGENT_MODE}</multi_agent_mode>` }])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('preempts a completed reasoning or commentary item only for pending agent mail', async () => {
    const ctx = new Context()
    try {
      const { enableCodexMailboxPreemption, enableCodexMailboxDeferral, enableCodexInputOrder } = await services(ctx)
      await ctx.plugin(SystemPrompt)
    await ctx.plugin(ProductPrompt)
      await ctx.plugin(NativeToolRuntime)
    await ctx.plugin(NativeTools)
      const agent = fakeAgent('gpt-6-sol')
      const scope = createScope(ctx, agent)
      Object.assign(agent, { ctx: scope.ctx })
      await scope.ctx.plugin(CodexfulPrompt, { streamToolsDuringResponse: true })
      await agentEvents(ctx, agent).serial('agent/created', { source: 'startup' })
      const shouldPreempt = enableCodexMailboxPreemption.mock.calls[0]?.[1]
      if (shouldPreempt === undefined) throw new Error('Codexful did not register mailbox preemption')
      const mail = createUserMessage({
        content: [{ type: 'text', text: 'worker update' }],
        source: { kind: 'agent-message', form: 'relay', senderSessionId: SessionId('worker') },
      })
      const user = createUserMessage({ content: [{ type: 'text', text: 'more work' }], source: { kind: 'user' } })
      const isMailbox = enableCodexInputOrder.mock.calls[0]?.[1]
      if (isMailbox === undefined) throw new Error('Codexful did not register input ordering')
      expect(isMailbox(mail)).toBe(true)
      expect(isMailbox(user)).toBe(false)
      const commentary = { response: {}, blocks: [{ type: 'text', textSignature:
        JSON.stringify({ v: 1, id: 'msg-1', phase: 'commentary' }) }] }
      const final = { response: {}, blocks: [{ type: 'text', textSignature:
        JSON.stringify({ v: 1, id: 'msg-2', phase: 'final_answer' }) }] }
      expect(shouldPreempt({ type: 'reasoning', text: 'thinking' }, undefined, [mail])).toBe(true)
      expect(shouldPreempt({ type: 'text', text: 'working' }, commentary, [mail])).toBe(true)
      expect(shouldPreempt({ type: 'text', text: 'done' }, final, [mail])).toBe(false)
      expect(shouldPreempt({ type: 'reasoning', text: 'thinking' }, undefined, [user])).toBe(false)
      expect(shouldPreempt({ type: 'text', text: 'working' }, commentary, [])).toBe(false)
      const shouldDefer = enableCodexMailboxDeferral.mock.calls[0]?.[1]
      if (shouldDefer === undefined) throw new Error('Codexful did not register mailbox deferral')
      const queueOnlyMail = createUserMessage({
        content: [{ type: 'text', text: 'queued update' }],
        source: { kind: 'agent-message', form: 'relay', senderSessionId: SessionId('worker'), queueOnly: true },
      })
      const answer = createAssistantMessage({
        content: [{ type: 'text', text: 'answer' }], source: { provider: 'mock', model: 'mock' },
      })
      const working = createAssistantMessage({
        content: [{ type: 'text', text: 'working' }],
        source: { provider: 'mock', model: 'mock', replayState: commentary },
      })
      expect(shouldDefer(answer, [queueOnlyMail])).toBe(true)
      expect(shouldDefer(answer, [queueOnlyMail, user])).toBe(false)
      expect(shouldDefer(answer, [mail])).toBe(false)
      expect(shouldDefer(working, [queueOnlyMail])).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.skipIf(process.platform !== 'linux')('uses the Linux zoneinfo name in the assembled environment', async () => {
    let localtime: string
    try {
      localtime = readlinkSync('/etc/localtime')
    } catch (_error) {
      // Some Linux hosts use /etc/timezone without a localtime symlink.
      return
    }
    const prefix = ['/usr/share/zoneinfo/', '../usr/share/zoneinfo/', '/etc/zoneinfo/', '../etc/zoneinfo/']
      .find(value => localtime.startsWith(value))
    if (prefix === undefined) return
    const ctx = new Context()
    try {
      await services(ctx)
      await ctx.plugin(SystemPrompt)
    await ctx.plugin(ProductPrompt)
      await ctx.plugin(NativeToolRuntime)
    await ctx.plugin(NativeTools)
      const agent = fakeAgent('gpt-6-sol')
      const scope = createScope(ctx, agent)
      await scope.ctx.plugin(CodexfulPrompt, {})
      const environment = renderContextSnapshot(await ctx.codexyPrompt.assemble({ scope: agent, agent }))
      expect(environment).toContain(`<timezone>${localtime.slice(prefix.length)}</timezone>`)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('supplies this step\'s assembled base to the scoped model-switch effect', async () => {
    const ctx = new Context()
    try {
      const { enableCodexModelSwitch } = await services(ctx)
      await ctx.plugin(SystemPrompt)
    await ctx.plugin(ProductPrompt)
      await ctx.plugin(NativeToolRuntime)
    await ctx.plugin(NativeTools)
      const agent = fakeAgent('gpt-6-sol')
      const scope = createScope(ctx, agent)
      Object.assign(agent, { ctx: scope.ctx })
      await scope.ctx.plugin(CodexfulPrompt, {})
      await agentEvents(ctx, agent).serial('agent/created', { source: 'startup' })
      const assembly = await ctx.codexyPrompt.assemble({ scope: agent, agent })
      expect(enableCodexModelSwitch).toHaveBeenCalledOnce()
      const renderer = enableCodexModelSwitch.mock.calls[0]![1]
      expect(renderer(assembly)).toBe(assembly.sections.find(section => section.name === 'codexful:base')!.text)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each([
    ['gpt-6-astra', 'low'],
    ['gpt-6-sol', 'medium'],
    ['gpt-6-luna', 'medium'],
    ['gpt-5.6-sol', 'low'],
    ['gpt-5.6-terra', 'medium'],
    ['gpt-5.6-luna', 'medium'],
    ['gpt-5.5', 'medium'],
  ] as const)('selects pinned %s reasoning when the route has no default', async (model, effort) => {
    const request = await resolvedRequest(model)
    expect(request.config.reasoningEffort).toBe(ReasoningEffortId(effort))
    expect(request.modelLookups).toBe(1)
  })

  it('preserves explicit request and route reasoning defaults', async () => {
    const explicit = await resolvedRequest('gpt-5.6-luna', 'high')
    expect(explicit.config.reasoningEffort).toBe(ReasoningEffortId('high'))
    expect(explicit.modelLookups).toBe(0)
    const route = await resolvedRequest('gpt-5.6-luna', undefined, 'high')
    expect(route.config.reasoningEffort).toBeUndefined()
    expect(route.modelLookups).toBe(1)
    const generic = await resolvedRequest('qwen3.8')
    expect(generic.config.reasoningEffort).toBeUndefined()
    expect(generic.modelLookups).toBe(0)
  })

  it('renders the pinned Codex single-workspace environment format under full access', () => {
    expect(CodexfulPrompt.renderEnvironmentContext({
      cwd: '/tmp/work',
      shell: 'bash',
      date: '2026-09-28',
      timezone: 'Etc/UTC',
      sandbox: { mode: 'danger-full-access', workspaceRoot: '/tmp/work' },
      approval: 'never',
      network: 'enabled',
    })).toBe([
      '<environment_context>',
      '  <cwd>/tmp/work</cwd>',
      '  <shell>bash</shell>',
      '  <current_date>2026-09-28</current_date>',
      '  <timezone>Etc/UTC</timezone>',
      '  <network enabled="true"></network>',
      '  <filesystem><workspace_roots><root>/tmp/work</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>',
      '</environment_context>',
    ].join('\n'))
  })

  it('omits unchanged cwd and shell from a date-only environment update', () => {
    const previous = {
      cwd: '/work', shell: 'bash', date: '2026-09-29', timezone: 'Asia/Shanghai',
      network: '<network enabled="true"></network>', filesystem: '<filesystem>work</filesystem>', subagents: [],
    }
    const current = { ...previous, date: '2026-09-30' }
    const update = CodexfulPrompt.renderEnvironmentDiff(current, previous)
    expect(update).toContain('<current_date>2026-09-30</current_date>')
    expect(update).not.toContain('<cwd>')
    expect(update).not.toContain('<shell>')
    expect(update).toContain('<filesystem>work</filesystem>')
    expect(CodexfulPrompt.renderEnvironmentDiff(previous, previous)).toBeUndefined()
  })

  it('lists direct subagent paths inside the bounded environment context', () => {
    const environment = CodexfulPrompt.renderEnvironmentContext({
      cwd: '/tmp/work',
      shell: 'bash',
      date: '2026-09-28',
      timezone: 'Etc/UTC',
      sandbox: { mode: 'danger-full-access', workspaceRoot: '/tmp/work' },
      approval: 'never',
      network: 'enabled',
      subagents: ['/root/alpha', '/root/a&b', ...Array.from({ length: 8 }, (_, index) => `/root/extra_${index}`)],
    })
    expect(environment).toContain('  <subagents>\n    <agent name="/root/alpha" />\n    <agent name="/root/a&amp;b" />')
    expect(environment.match(/<agent name=/g)).toHaveLength(8)
    expect(environment).not.toContain('/root/extra_6')
  })

  it('renders unbounded legacy children in full path and id order using path names and optional nicknames', () => {
    const legacySubagents = [
      { id: SessionId('z'), nickname: 'Curie', agentPath: '/root/zebra/reader' },
      { id: SessionId('b'), nickname: 'Bohr' },
      { id: SessionId('a'), nickname: '' },
      { id: SessionId('y'), nickname: 'Euler', agentPath: '/root/alpha/reader' },
      { id: SessionId('x'), agentPath: '/root/alpha/reader' },
      ...Array.from({ length: 9 }, (_, index) => ({
        id: SessionId(`extra-${index}`), nickname: `Euclid ${'x'.repeat(150)}`,
      })),
    ]
    const environment = CodexfulPrompt.renderEnvironmentContext({
      cwd: '/tmp/work', shell: 'bash', date: '2026-09-30', timezone: 'UTC',
      sandbox: { mode: 'danger-full-access', workspaceRoot: '/tmp/work' },
      approval: 'never', network: 'enabled', legacySubagents,
    })
    const rendered = environment.split('\n').filter(line => line.startsWith('    - '))
    expect(rendered).toHaveLength(14)
    expect(rendered.slice(0, 2)).toEqual(['    - a', '    - b: Bohr'])
    expect(rendered.slice(-3)).toEqual(['    - reader', '    - reader: Euler', '    - reader: Curie'])
    expect(Buffer.byteLength(rendered.join('\n'))).toBeGreaterThan(1_024)
    expect(environment).not.toContain('<agent name=')
    expect(legacySubagents[0]?.id).toBe('z')
  })

  for (const family of ['v1', 'v2'] as const) {
    it(`includes the current ${family} roster only alongside a changed environment field`, () => {
      const previous = {
        cwd: '/work', shell: 'bash', date: '2026-09-29', timezone: 'UTC',
        network: '', filesystem: '<filesystem />', subagents: family === 'v2' ? ['/root/old'] : [],
        ...family === 'v1' ? { legacySubagents: [{ id: SessionId('old'), nickname: 'Bohr' }] } : {},
      }
      const current = {
        ...previous, subagents: family === 'v2' ? ['/root/current'] : [],
        ...family === 'v1' ? { legacySubagents: [{ id: SessionId('current'), nickname: 'Euclid' }] } : {},
      }
      expect(CodexfulPrompt.renderEnvironmentDiff(current, previous)).toBeUndefined()
      const update = CodexfulPrompt.renderEnvironmentDiff({ ...current, date: '2026-09-30' }, previous)
      expect(update).toContain(family === 'v1' ? '- current: Euclid' : '<agent name="/root/current" />')
      expect(update).not.toContain('old')
      const empty = CodexfulPrompt.renderEnvironmentDiff({
        ...current, date: '2026-09-30', subagents: [],
        ...family === 'v1' ? { legacySubagents: [] } : {},
      }, previous)
      expect(empty).not.toContain('codexySubagents')
      expect(empty).not.toContain('unavailable')
    })
  }

  it('includes only loaded direct child paths in assembled environment context', async () => {
    const ctx = new Context()
    try {
      await services(ctx)
      const liveId = SessionId('codexful-live-child')
      ctx.provide('agents', { get: (id: SessionId) => id === liveId ? {} : undefined } as never)
      ctx.provide('codexySubagents', { listChildren: async () => [
        { id: liveId, mode: 'continuable', label: '/root/live', createdAt: 0 },
        { id: SessionId('codexful-cold-child'), mode: 'continuable', label: '/root/cold', createdAt: 0 },
      ] } as never)
      await ctx.plugin(SystemPrompt)
    await ctx.plugin(ProductPrompt)
      await ctx.plugin(NativeToolRuntime)
    await ctx.plugin(NativeTools)
      const scopeKey: ScopeKey = { agent: 'subagent-environment' }
      await createScope(ctx, scopeKey).ctx.plugin(CodexfulPrompt, {})
      const environment = renderContextSnapshot(await ctx.codexyPrompt.assemble({ scope: scopeKey, agent: fakeAgent('gpt-6-sol') }))
      expect(environment).toContain('<agent name="/root/live" />')
      expect(environment).not.toContain('/root/cold')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('assembles the frozen v1 roster from loaded direct child identities and preserves it through compaction', async () => {
    const ctx = new Context()
    try {
      await services(ctx)
      ctx.sessionProjections.register(codexV1IdentityProjectionDefinition)
      const parent = fakeAgent('gpt-6-sol')
      const completed = fakeAgent('gpt-6-sol', SessionId('b-completed'), { parentSession: parent.id })
      completed.session.append('subagent/codex-v1-identity', { nickname: 'Euler' })
      completed.session.append('turn/start', { turn: 1 })
      completed.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      const canonical = fakeAgent('gpt-6-sol', SessionId('z-canonical'), { parentSession: parent.id })
      canonical.session.append('subagent/codex-v1-identity', { nickname: 'Curie', agentPath: '/root/research/reader' })
      const nameless = fakeAgent('gpt-6-sol', SessionId('a-nameless'), { parentSession: parent.id })
      const closed = fakeAgent('gpt-6-sol', SessionId('closed'), { parentSession: parent.id })
      closed.session.append('subagent/codex-v1-identity', { nickname: 'Bohr' })
      const foreign = fakeAgent('gpt-6-sol', SessionId('foreign'), { parentSession: SessionId('other-parent') })
      foreign.session.append('subagent/codex-v1-identity', { nickname: 'Newton' })
      const children = [canonical, completed, nameless, closed, foreign]
      const loaded = new Map(children.map(child => [child.id, child]))
      ctx.provide('agents', { get: (id: SessionId) => loaded.get(id) } as never)
      ctx.provide('codexySubagents', {
        listChildren: async () => [
          ...children.map(child => ({ id: child.id, mode: 'continuable', label: 'Generic child label', createdAt: 0 })),
          { id: SessionId('cold'), mode: 'continuable', label: '/root/cold', createdAt: 0 },
        ],
        loadedContinuable: (owner: Agent, id: SessionId) => owner === parent && id !== closed.id
          && loaded.get(id)?.session.header.parentSession === parent.id ? loaded.get(id) : undefined,
      } as never)
      const closeCall = ToolCallId('close-child')
      parent.session.append('tool/call', {
        turn: 1, step: 1, name: 'multi_agent_v1__close_agent', callId: closeCall,
        arguments: JSON.stringify({ target: closed.id }),
      })
      parent.session.append('tool/result', {
        turn: 1, step: 1,
        message: createToolResultMessage({ callId: closeCall, content: [{ type: 'text', text: '{"previous_status":"running"}' }], isError: false }),
      }, { surfaceOp: 'append' })
      await ctx.plugin(SystemPrompt)
    await ctx.plugin(ProductPrompt)
      await ctx.plugin(NativeToolRuntime)
    await ctx.plugin(NativeTools)
      const scope = createScope(ctx, parent)
      await scope.ctx.plugin(CodexfulPrompt, { toolProfile: 'codex-pinned' })
      recordCodexfulMultiAgentVersion(ctx.sessionProjections, parent.session, 'v1')
      const assembly = await ctx.codexyPrompt.assemble({ scope: parent, agent: parent })
      const environment = renderContextSnapshot(assembly)
      expect(assembly.variables.codexful_multi_agent_version).toBe('v1')
      expect(environment.split('\n').filter(line => line.startsWith('    - '))).toEqual([
        '    - a-nameless', '    - b-completed: Euler', '    - reader: Curie',
      ])
      expect(environment).not.toContain('Generic child label')
      expect(environment).not.toContain('<agent name=')
      expect(environment).not.toContain('Bohr')
      expect(environment).not.toContain('Newton')
      expect(environment).not.toContain('/root/cold')
      const captured = await ctx.waterfall('codexy-compaction/initial-context', { agent: parent }, async () => undefined)
      expect(captured?.at(-1)?.source).toMatchObject({ codexWorldState: {
        section: 'environment', mode: 'full', snapshot: { subagents: [], legacySubagents: [
          { id: nameless.id }, { id: completed.id, nickname: 'Euler' },
          { id: canonical.id, nickname: 'Curie', agentPath: '/root/research/reader' },
        ] },
      } })
      expect(captured?.at(-1)?.content).toEqual([{ type: 'text', text: assembly.contexts.find(section => section.name === 'codexful:environment')?.text }])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('retains a truly resumed v1 child when tool reload removes the uncommitted open overlay', async () => {
    const ctx = new Context()
    try {
      await services(ctx)
      ctx.sessionProjections.register(codexV1IdentityProjectionDefinition)
      const parent = fakeAgent('gpt-5.6-luna')
      const child = fakeAgent('gpt-5.6-luna', SessionId('resumed-v1-child'), { parentSession: parent.id })
      child.session.append('subagent/codex-v1-identity', { nickname: 'Euclid' })
      const closeCall = ToolCallId('previous-v1-close')
      parent.session.append('tool/call', {
        turn: 1, step: 1, name: 'multi_agent_v1__close_agent', callId: closeCall,
        arguments: JSON.stringify({ target: child.id }),
      })
      parent.session.append('tool/result', {
        turn: 1, step: 1,
        message: createToolResultMessage({ callId: closeCall, content: [{ type: 'text', text: '{"previous_status":"shutdown"}' }], isError: false }),
      }, { surfaceOp: 'append' })
      let closing = false
      ctx.provide('agents', { get: (id: SessionId) => id === child.id ? child : undefined } as never)
      ctx.provide('codexySubagents', {
        listChildren: async () => [{ id: child.id, mode: 'continuable', label: 'Generic child label', createdAt: 0 }],
        loadedContinuable: (owner: Agent, id: SessionId) => owner === parent && id === child.id && !closing ? child : undefined,
      } as never)
      await ctx.plugin(SystemPrompt)
    await ctx.plugin(ProductPrompt)
      await ctx.plugin(NativeToolRuntime)
    await ctx.plugin(NativeTools)
      const scope = createScope(ctx, parent)
      Object.assign(parent, { ctx: scope.ctx })
      await scope.ctx.plugin(CodexfulPrompt, { toolProfile: 'codex-pinned' })
      const stopTools = scope.ctx.effect(() => {
        const lease = acquireCodexV1NicknameRegistry(ctx.codexySubagents)
        lease.pool(parent).mark(child.id, 'open')
        return () => { lease.dispose() }
      })
      const environment = async () => renderContextSnapshot(await ctx.codexyPrompt.assemble({ scope: parent, agent: parent }))
      expect(await environment()).toContain(`    - ${child.id}: Euclid`)
      await stopTools()
      expect(codexV1LiveRoster(ctx.codexySubagents, parent.id).size).toBe(0)
      expect(await environment()).toContain(`    - ${child.id}: Euclid`)
      closing = true
      expect(ctx.agents.get(child.id)).toBe(child)
      expect(await environment()).not.toContain('Euclid')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('explains automatic approval while keeping workspace confinement and rejection handling', () => {
    const facts: CodexfulPrompt.EnvironmentFacts = {
      cwd: '/work', shell: 'bash', date: '2026-10-02', timezone: 'Asia/Shanghai',
      sandbox: { mode: 'workspace-write', workspaceRoot: '/work' },
      approval: 'ask', approvalReviewer: 'auto_review', network: 'unknown',
    }
    const text = CodexfulPrompt.renderPermissionInstructions(facts)
    expect(text).toContain('standing file sandbox allows writes under the workspace root')
    expect(text).toContain('`approvals_reviewer` is `auto_review`')
    expect(text).toContain('materially safer alternative')
    expect(CodexfulPrompt.renderPermissionInstructions({ ...facts, approvalReviewer: 'user' }))
      .not.toContain('`approvals_reviewer` is `auto_review`')
  })

  it('uses the pinned Codex permission text when full access, never approval, and network reachability agree', () => {
    expect(CodexfulPrompt.renderPermissionInstructions({
      cwd: '/tmp/work',
      shell: 'bash',
      date: '2026-09-28',
      timezone: 'Etc/UTC',
      sandbox: { mode: 'danger-full-access', workspaceRoot: '/tmp/work' },
      approval: 'never',
      network: 'enabled',
    })).toBe('Filesystem sandboxing defines which files can be read or written. `sandbox_mode` is `danger-full-access`: No filesystem sandboxing - all commands are permitted. Network access is enabled.\n\n'
      + 'Approval policy is currently never. Do not provide the `sandbox_permissions` for any reason, commands will be rejected.')
  })

  it('renders the pinned permissions templates with their exact single-newline separator', () => {
    const facts: CodexfulPrompt.EnvironmentFacts = {
      cwd: '/tmp/work', shell: 'bash', date: '2026-09-28', timezone: 'Etc/UTC',
      sandbox: { mode: 'danger-full-access', workspaceRoot: '/tmp/work' },
      approval: 'never', network: 'enabled',
    }
    expect(CodexfulPrompt.renderPinnedPermissionInstructions(facts)).toBe(
      'Filesystem sandboxing defines which files can be read or written. `sandbox_mode` is `danger-full-access`: No filesystem sandboxing - all commands are permitted. Network access is enabled.\n'
      + 'Approval policy is currently never. Do not provide the `sandbox_permissions` for any reason, commands will be rejected.',
    )
    expect(CodexfulPrompt.renderPinnedPermissionInstructions({
      ...facts, sandbox: { ...facts.sandbox, mode: 'read-only' },
    })).toBe(
      'Filesystem sandboxing defines which files can be read or written. `sandbox_mode` is `read-only`: The sandbox only permits reading files. Network access is enabled.\n'
      + 'Approval policy is currently never. Do not provide the `sandbox_permissions` for any reason, commands will be rejected.',
    )
    for (const unsupported of [
      { ...facts, network: 'unknown' as const },
      { ...facts, approval: 'ask' as const },
      { ...facts, sandbox: { ...facts.sandbox, mode: 'workspace-write' as const } },
    ]) {
      expect(CodexfulPrompt.renderPinnedPermissionInstructions(unsupported))
        .toBe(CodexfulPrompt.renderPermissionInstructions(unsupported))
    }
  })

  it('assembles strict Codex model text, permissions role, and environment order without host prose', async () => {
    const ctx = new Context()
    try {
      await services(ctx, 'danger-full-access', 'never')
      await ctx.plugin(SystemPrompt)
    await ctx.plugin(ProductPrompt)
      await ctx.plugin(NativeToolRuntime)
    await ctx.plugin(NativeTools)
      for (const name of ['exec_command', 'write_stdin', 'apply_patch']) {
        ctx.codexyTools.register(defineTool({
          name, description: name, parameters: {},
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
          async execute() { return name },
        }))
      }
      ctx.codexyPrompt.section({ name: 'tool:bash', order: 100, text: 'DSH shell guidance.' })
      ctx.codexyPrompt.context({
        name: 'codexful:skills', order: 100, role: 'developer',
        text: '<skills_instructions>\n## Skills\n- sample: Coding help. (file: /work/skills/sample/SKILL.md)\n</skills_instructions>',
      })
      ctx.codexyPrompt.context({ name: 'subagent:delegation', order: 90, text: 'Approval policy is always deny.' })
      const agent = fakeAgent('gpt-6-sol')
      const scope = createScope(ctx, agent)
      Object.assign(agent, { ctx: scope.ctx })
      await scope.ctx.plugin(CodexfulPrompt, {
        strictModelInput: true, toolProfile: 'codex-pinned', networkAccess: 'enabled',
      })
      const assembly = await ctx.codexyPrompt.assemble({ scope: agent, agent })
      expect(renderPrompt(assembly)).toBe(withoutUpdatePlanInstructions(CodexfulPrompt.codexfulModelProfile('gpt-6-sol').prompt))
      expect(renderPrompt(assembly)).not.toContain('DSH runtime adaptation')
      expect(assembly.tools.map(tool => tool.name).sort()).toEqual(['apply_patch', 'exec_command', 'write_stdin'])
      expect(renderContextSections(assembly, 'developer').map(section => section.text)).toEqual([
        '<skills_instructions>\n## Skills\n- sample: Coding help. (file: /work/skills/sample/SKILL.md)\n</skills_instructions>',
        '<permissions instructions>\n'
        + CodexfulPrompt.renderPinnedPermissionInstructions({
          cwd: '/work/a&b', shell: 'zsh', date: '2026-09-28', timezone: 'Etc/UTC',
          sandbox: { mode: 'danger-full-access', workspaceRoot: '/work/a&b' },
          approval: 'never', network: 'enabled',
        })
        + '\n</permissions instructions>',
      ])
      expect(renderContextSections(assembly).map(section => section.name)).toEqual(['codexful:environment'])
      expect(renderContextSnapshot(assembly)).not.toContain('Approval policy is always deny.')
      expect(renderContextSnapshot(assembly)).not.toContain('<network')
      expect(renderContextSnapshot(assembly)).toContain('<permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile>')
      const dispatch = agentEvents(ctx, agent)
      const payload = { turn: 1, step: 1, signal: new AbortController().signal }
      await expect(dispatch.waterfall('codexy-agent/request', payload, async () => ({ provider: 'test', model: 'gpt-6-sol' })))
        .resolves.toMatchObject({ provider: 'test', model: 'gpt-6-sol' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('preserves additional tools and runtime contexts instead of rejecting a pinned input request', async () => {
    const ctx = new Context()
    try {
      await services(ctx, 'danger-full-access', 'never', false)
      await ctx.plugin(SystemPrompt)
    await ctx.plugin(ProductPrompt)
      await ctx.plugin(NativeToolRuntime)
    await ctx.plugin(NativeTools)
      const agent = fakeAgent('gpt-6-sol')
      const scope = createScope(ctx, agent)
      Object.assign(agent, { ctx: scope.ctx })
      let removeSkill: (() => void) | undefined
      for (const name of ['exec_command', 'write_stdin', 'skill']) {
        const dispose = ctx.codexyTools.register(defineTool({
          name, description: name, parameters: {},
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
          async execute() { return name },
        }))
        if (name === 'skill') removeSkill = dispose
      }
      await scope.ctx.plugin(CodexfulPrompt, {
        strictModelInput: true, toolProfile: 'codex-pinned', networkAccess: 'enabled',
      })
      const assemble = () => ctx.codexyPrompt.assemble({ scope: agent, agent })
      expect((await assemble()).tools.map(tool => tool.name)).toContain('skill')
      removeSkill?.()
      const removeSubagent = ctx.codexyTools.register(defineTool({
        name: 'spawn_agent', description: 'spawn_agent', parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute() { return 'spawn_agent' },
      }))
      expect((await assemble()).tools.map(tool => tool.name)).toContain('spawn_agent')
      removeSubagent()
      const removeRole = ctx.codexyPrompt.context({
        name: 'codexful-v2:multi-agent-role', order: 100, role: 'developer', text: '<multi_agent_role>V2</multi_agent_role>',
      })
      expect(renderContextSections(await assemble(), 'developer').map(section => section.text))
        .toContain('<multi_agent_role>V2</multi_agent_role>')
      removeRole()
      const removeMemory = ctx.codexyPrompt.context({ name: 'memory:summary', order: 100, text: 'Extra runtime state.' })
      expect(renderContextSections(await assemble()).map(section => section.text)).toContain('Extra runtime state.')
      removeMemory()
      const removePinnedMemory = ctx.codexyPrompt.context({
        name: 'codexful:memory:0', order: 70, role: 'developer', text: 'PINNED MEMORY READ INSTRUCTIONS',
      })
      const withMemory = await assemble()
      expect(renderContextSections(withMemory, 'developer').map(section => section.text))
        .toContain('PINNED MEMORY READ INSTRUCTIONS')
      removePinnedMemory()
      for (const name of ['codexful:memory:0', 'codexful:memory:summary']) {
        const removeInvalidMemory = ctx.codexyPrompt.context({ name, order: 70, role: 'user', text: 'Invalid memory role.' })
        expect((await assemble()).contexts.find(section => section.name === name))
          .toMatchObject({ role: 'user', text: 'Invalid memory role.' })
        removeInvalidMemory()
      }
      const removeInvalidSkills = ctx.codexyPrompt.context({
        name: 'codexful:skills', order: 100, role: 'user', text: '<skills_instructions>Invalid role.</skills_instructions>',
      })
      expect((await assemble()).contexts.find(section => section.name === 'codexful:skills'))
        .toMatchObject({ role: 'user', text: '<skills_instructions>Invalid role.</skills_instructions>' })
      removeInvalidSkills()
      await assemble()
      const dispatch = agentEvents(ctx, agent)
      const payload = { turn: 1, step: 1, signal: new AbortController().signal }
      await expect(dispatch.waterfall('codexy-agent/request', payload, async () => ({ provider: 'test', model: 'gpt-6-sol' })))
        .resolves.toMatchObject({ provider: 'test', model: 'gpt-6-sol', codexfulResponses: { strictModelInput: true } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('omits the v2 role from strict v1 input when the v2 tools are hidden', async () => {
    const ctx = new Context()
    try {
      await services(ctx, 'danger-full-access', 'never')
      await ctx.plugin(SystemPrompt)
    await ctx.plugin(ProductPrompt)
      await ctx.plugin(NativeToolRuntime)
    await ctx.plugin(NativeTools)
      for (const name of ['exec_command', 'write_stdin']) {
        ctx.codexyTools.register(defineTool({
          name, description: name, parameters: {},
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
          async execute() { return name },
        }))
      }
      ctx.codexyPrompt.context({
        name: 'codexful-v2:multi-agent-role', order: 100, role: 'developer', text: '<multi_agent_role>V2</multi_agent_role>',
      })
      const agent = fakeAgent('gpt-5.6-luna')
      const scope = createScope(ctx, agent)
      Object.assign(agent, { ctx: scope.ctx })
      await scope.ctx.plugin(CodexfulPrompt, {
        strictModelInput: true, toolProfile: 'codex-pinned', networkAccess: 'enabled',
      })
      const assembly = await ctx.codexyPrompt.assemble({ scope: agent, agent })
      expect(assembly.tools.map(tool => tool.name)).toEqual(['exec_command', 'write_stdin'])
      expect(renderContextSections(assembly, 'developer').map(section => section.text).join('\n'))
        .not.toContain('<multi_agent_role>')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each(['daily', 'codex-pinned'] as const)(
    'keeps actual permissions, unknown contexts, and extra tool schemas with %s serialization', async (toolProfile) => {
      const ctx = new Context()
      try {
        await services(ctx, 'workspace-write', 'ask', false)
        await ctx.plugin(SystemPrompt)
        await ctx.plugin(ProductPrompt)
        await ctx.plugin(NativeToolRuntime)
        await ctx.plugin(NativeTools)
        ctx.codexyTools.register(defineTool({
          name: 'schedule_list', description: 'List the mounted schedules.',
          parameters: { prefix: { type: 'string' } },
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
          async execute() { return '[]' },
        }))
        const extraText = 'Independent plugin context: keep "quotes" and 中文 unchanged.'
        ctx.codexyPrompt.context({ name: 'independent:context', role: 'developer', order: 70, text: extraText, interpolate: false })
        const agent = fakeAgent('gpt-6-sol')
        const scope = createScope(ctx, agent)
        Object.assign(agent, { ctx: scope.ctx })
        await scope.ctx.plugin(CodexfulPrompt, { toolProfile, strictModelInput: true })
        const assembly = await ctx.codexyPrompt.assemble({ scope: agent, agent })
        expect(assembly.tools).toHaveLength(1)
        expect(assembly.tools[0]).toMatchObject({ name: 'schedule_list', description: 'List the mounted schedules.',
          parameters: { type: 'object', properties: { prefix: { type: 'string' } } } })
        expect(assembly.contexts.find(section => section.name === 'independent:context'))
          .toMatchObject({ role: 'developer', text: extraText, interpolate: false })
        expect(assembly.contexts.find(section => section.name === 'codexful:permissions')?.text)
          .toContain('Approval policy is ask.')
        expect(renderContextSnapshot(assembly)).toContain('<network status="unknown" />')
        expect(renderContextSnapshot(assembly)).toContain('<entry access="write"><path>/work/a&amp;b</path></entry>')
        await expect(agentEvents(ctx, agent).waterfall('codexy-agent/request', {
          turn: 1, step: 1, signal: new AbortController().signal,
        }, async () => ({ provider: 'test', model: 'gpt-6-sol' })))
          .resolves.toMatchObject({ codexfulResponses: { strictModelInput: true } })
      } finally {
        await ctx.fiber.dispose()
      }
    },
  )

  it('selects model-family prose and exposes current runtime facts only in its scope', async () => {
    const ctx = new Context()
    try {
      await services(ctx)
      await ctx.plugin(SystemPrompt, { personaPrefix: 'Deployment assistant.' })
      await ctx.plugin(ProductPrompt, { personaPrefix: 'Deployment assistant.' })
      await ctx.plugin(NativeToolRuntime)
    await ctx.plugin(NativeTools)
      ctx.codexyPrompt.section({ name: 'skill:guide', order: 3500, text: 'Read the relevant skill.' })
      ctx.codexyPrompt.section({ name: 'ui:deliverable-file-references', order: 3600, text: 'Call present to show a file.' })
      ctx.codexyPrompt.context({ name: 'sandbox:policy', order: 110, text: 'Old DSH sandbox prose.' })
      ctx.codexyPrompt.context({ name: 'memory:summary', order: 120, text: 'User prefers concise updates.' })
      ctx.codexyPrompt.context({ name: 'subagent:delegation', order: 90, text: 'Approval policy is always deny.' })
      const scopeKey: ScopeKey = { agent: 'codexful' }
      const fiber = await createScope(ctx, scopeKey).ctx.plugin(CodexfulPrompt, { networkAccess: 'enabled' })
      const agent = fakeAgent('gpt-6-sol')
      const assembly = await ctx.codexyPrompt.assemble({ scope: scopeKey, agent })
      expect(renderPrompt(assembly)).toContain('You are Codex, an agent based on GPT-6.')
      expect(renderPrompt(assembly).startsWith(CodexfulPrompt.codexfulModelProfile('gpt-6-sol').prompt)).toBe(true)
      expect(renderPrompt(assembly)).toContain('The Codex functions.exec JavaScript orchestrator')
      expect(renderPrompt(assembly)).toContain('Read the relevant skill.')
      expect(renderPrompt(assembly)).not.toContain('Call present to show a file.')
      expect(renderPrompt(assembly)).not.toContain('Deployment assistant.')
      expect(renderContextSnapshot(assembly)).toContain('<cwd>/work/a&amp;b</cwd>')
      expect(renderContextSnapshot(assembly)).toContain('<shell>zsh</shell>')
      expect(renderContextSnapshot(assembly)).toContain('<filesystem><workspace_roots><root>/work/a&amp;b</root></workspace_roots><permission_profile type="managed"><file_system type="restricted"><entry access="read"><special>:root</special></entry><entry access="write"><path>/work/a&amp;b</path></entry><entry access="write"><special>:slash_tmp</special></entry><entry access="write"><special>:tmpdir</special></entry></file_system></permission_profile></filesystem>')
      expect(renderContextSnapshot(assembly)).not.toContain('<network_access>')
      expect(renderContextSnapshot(assembly)).toContain('User prefers concise updates.')
      expect(renderContextSnapshot(assembly)).not.toContain('Old DSH sandbox prose.')
      expect(renderContextSnapshot(assembly)).not.toContain('Approval policy is always deny.')
      expect(renderPrompt(await ctx.codexyPrompt.assemble())).toContain('Deployment assistant.')
      expect(renderPrompt(await ctx.codexyPrompt.assemble())).toContain('Call present to show a file.')
      await fiber.dispose()
      expect(renderPrompt(await ctx.codexyPrompt.assemble({ scope: scopeKey, agent }))).toContain('Deployment assistant.')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each(['ptc'] as const)('rejects %s tool presentation before sending a model request', async (mode) => {
    const ctx = new Context()
    try {
      await services(ctx)
      await ctx.plugin(SystemPrompt)
    await ctx.plugin(ProductPrompt)
      await ctx.plugin(NativeToolRuntime, { mode })
      await ctx.plugin(NativeTools)
      ctx.provide('ptcRuntime', { language: 'typescript', isolation: 'fake' } as never)
      const scopeKey: ScopeKey = { agent: `codexful-${mode}` }
      await createScope(ctx, scopeKey).ctx.plugin(CodexfulPrompt, {})
      await expect(ctx.codexyPrompt.assemble({ scope: scopeKey, agent: fakeAgent('gpt-6-sol') }))
        .rejects.toThrow('requires native JSON tools')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('uses the model captured by assembly variables and refreshes permissions', async () => {
    const ctx = new Context()
    try {
      await services(ctx, 'read-only')
      await ctx.plugin(SystemPrompt)
    await ctx.plugin(ProductPrompt)
      await ctx.plugin(NativeToolRuntime)
    await ctx.plugin(NativeTools)
      const scopeKey: ScopeKey = { agent: 'switchable' }
      const scope = createScope(ctx, scopeKey)
      await scope.ctx.plugin(CodexfulPrompt, { networkAccess: 'disabled' })
      ctx.codexyPrompt.variable('model', () => 'gpt-5.6-sol')
      const agent = fakeAgent('gpt-6-sol')
      const first = await ctx.codexyPrompt.assemble({ scope: scopeKey, agent })
      expect(renderPrompt(first)).toContain('You are Codex, an agent based on GPT-5.')
      expect(renderContextSnapshot(first)).toContain('<permission_profile type="managed"><file_system type="restricted"><entry access="read"><special>:root</special></entry></file_system></permission_profile>')
      expect(renderContextSnapshot(first)).not.toContain('<entry access="write">')
      expect(renderContextSnapshot(first)).not.toContain('<network_access>')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each([
    { mode: 'read-only', approval: 'ask', expected: 'denies file writes by exec_command and apply_patch' },
    { mode: 'workspace-write', approval: 'ask', expected: 'shell sandbox does not protect those paths separately' },
    { mode: 'danger-full-access', approval: 'ask', expected: 'ordinary exec_command and apply_patch calls do not request approval' },
    { mode: 'read-only', approval: 'never', expected: 'Do not set sandbox_permissions or justification' },
    { mode: 'workspace-write', approval: 'never', expected: 'Do not set sandbox_permissions or justification' },
    { mode: 'danger-full-access', approval: 'never', expected: 'Do not set sandbox_permissions or justification' },
  ] as const)('describes the effective $mode/$approval permissions to the model', async ({ mode, approval, expected }) => {
    const ctx = new Context()
    try {
      await services(ctx, mode, approval)
      await ctx.plugin(SystemPrompt)
    await ctx.plugin(ProductPrompt)
      await ctx.plugin(NativeToolRuntime)
    await ctx.plugin(NativeTools)
      const scopeKey: ScopeKey = { agent: 'codexful-permissions' }
      await createScope(ctx, scopeKey).ctx.plugin(CodexfulPrompt, {})
      const agent = fakeAgent('gpt-6-sol')
      const assembly = await ctx.codexyPrompt.assemble({ scope: scopeKey, agent })
      const environment = renderContextSnapshot(assembly)
      const permissions = renderContextSections(assembly, 'developer').map(section => section.text).join('\n\n')
      expect(environment).not.toContain('# Permissions')
      expect(permissions).toContain('<permissions instructions>\n# Permissions\n\nThe DSH local file sandbox governs writes; it does not isolate reads or network traffic.')
      expect(environment).toContain('<filesystem><workspace_roots><root>/work/a&amp;b</root></workspace_roots>')
      expect(environment).not.toContain('<approval_policy>')
      expect(permissions).toContain(expected)
      if (approval === 'ask' && mode !== 'danger-full-access') {
        expect(permissions).toContain('sandbox_permissions: "require_escalated"')
        expect(permissions).toContain('prefix_rule with require_escalated to propose a Session-scoped grant')
        expect(permissions).toContain('If you know a required exec_command needs file access outside the standing sandbox')
        expect(permissions).toContain(`If apply_patch is denied, retry the patch with sandbox_permissions: "${mode === 'read-only' ? 'workspace-write' : 'danger-full-access'}"`)
        expect(permissions).toContain('An approved command runs without the DSH file sandbox')
        expect(permissions).toContain('do not work around it through another tool')
      } else {
        expect(permissions).not.toContain('retry the same command with those parameters')
        expect(permissions).not.toContain('prefix_rule with require_escalated')
      }
      if (mode === 'workspace-write') {
        expect(environment).toContain('<entry access="write"><path>/work/a&amp;b</path></entry>')
        expect(permissions).toContain('Treat top-level .git, .agents, .codex, and .aws workspace metadata as protected')
      } else if (mode === 'danger-full-access') {
        expect(environment).toContain('<permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile>')
      } else {
        expect(environment).not.toContain('<entry access="write">')
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('describes the native runner metadata protection without promising coverage for absent paths', () => {
    const instructions = CodexfulPrompt.renderPermissionInstructions({
      cwd: '/work', shell: 'zsh', date: '2026-09-29', timezone: 'Etc/UTC',
      sandbox: { mode: 'workspace-write', workspaceRoot: '/work' },
      approval: 'ask', network: 'unknown',
    }, new Set(), true)
    expect(instructions).toContain('shell protection depends on the runner and whether a metadata path already exists')
    expect(instructions).not.toContain('shell sandbox does not protect those paths separately')
  })

  it('keeps the pinned Codex prompt bytes for known models and the generic fallback', () => {
    const sourceHashes = {
      'gpt-6-astra': '35bd51b5f577cb7b24cd5f4629e49e37cb724ab57754ce6f8f202001635bab8a',
      'gpt-6-sol': 'b1dd8718c037906c53a305c5cbccb4a4be35ccbb7837461ec349bfc495412f0d',
      'gpt-6-luna': 'b707476816bfe5e571a1bd2179f130fff2b132da5ab8e61063acdb7fd24daf12',
      'gpt-5.6-sol': 'a91357a1cd2727a0be06d461248d6e3a7274746e38108f548a3adf2cc2430415',
      'gpt-5.6-terra': 'a91357a1cd2727a0be06d461248d6e3a7274746e38108f548a3adf2cc2430415',
      'gpt-5.6-luna': 'a91357a1cd2727a0be06d461248d6e3a7274746e38108f548a3adf2cc2430415',
      'gpt-5.5': '2351631dfc5644dc5a45eaaca4139475bd02810ee6cb792d058b551559b3242e',
    }
    for (const [model, digest] of Object.entries(sourceHashes)) {
      const profile = CodexfulPrompt.codexfulModelProfile(model)
      expect(profile.sourceModel).toBe(model)
      expect(profile.promptVersion).toBe('codex-8f195c93-verbatim-v4')
      expect(createHash('sha256').update(profile.prompt).digest('hex')).toBe(digest)
    }
    expect(CodexfulPrompt.codexfulModelProfile('gpt-5.6-luna').prompt)
      .toBe(CodexfulPrompt.codexfulModelProfile('gpt-5.6-sol').prompt)
    for (const model of ['deepseek-v4', 'qwen3.8', 'gpt-6-future']) {
      const profile = CodexfulPrompt.codexfulModelProfile(model)
      expect(profile.sourceModel).toBe('fallback')
      expect(profile.prompt).toMatch(/^You are a coding agent running in the Codex CLI/)
      expect(createHash('sha256').update(profile.prompt).digest('hex')).toBe('ac8ae107a0d72fe3476b430afb161ea4e67da2e446d778aefc44828160559807')
    }
  })

  it('omits Codex checklist guidance when the plan tool is unavailable', () => {
    const fallback = CodexfulPrompt.codexfulModelProfile('qwen3.8').prompt
    const filtered = withoutUpdatePlanInstructions(fallback)
    expect(fallback).toContain('## Planning\n')
    expect(fallback).toContain('## `update_plan`\n')
    expect(filtered).not.toContain('## Planning\n')
    expect(filtered).not.toContain('## `update_plan`\n')
    expect(filtered).toContain('# How you work\n')
    expect(filtered).toContain('# Tool Guidelines\n')

    const otherPlanning = '# Plan Mode\nKeep planning.\n\n## Planning\nDiscuss architecture before editing.\n'
    expect(withoutUpdatePlanInstructions(otherPlanning)).toBe(otherPlanning)
    expect(withoutUpdatePlanInstructions('Before.\n\n## Plan tool\nUse a checklist.\n\n## Work\nImplement.\n'))
      .toBe('Before.\n\n## Work\nImplement.\n')
  })

  it('keeps daily JSON patch and plan tools while exposing pinned model defaults explicitly', () => {
    expect(CodexfulPrompt.codexfulToolProfile('qwen3.8', 'daily').hiddenTools).toEqual([...CODEXFUL_V1_TOOL_NAMES])
    expect(CodexfulPrompt.codexfulToolProfile('qwen3.8', 'daily').sourceTruncation)
      .toEqual({ mode: 'bytes', limit: 10000 })
    expect(CodexfulPrompt.codexfulToolProfile('qwen3.8', 'codex-pinned')).toMatchObject({
      hiddenTools: ['apply_patch', ...CODEXFUL_V2_TOOL_NAMES, 'update_plan'],
      sourcePatch: null,
      sourceResponsesLite: false,
      sourceMultiAgentVersion: 'v1',
      sourceShellType: 'unified_exec',
    })
    expect(CodexfulPrompt.codexfulToolProfile('gpt-6-sol', 'codex-pinned')).toMatchObject({
      hiddenTools: [...CODEXFUL_V1_TOOL_NAMES, 'update_plan'],
      sourceTruncation: { mode: 'tokens', limit: 10000 },
      sourcePatch: 'freeform',
      sourceResponsesLite: true,
      sourceShellType: 'shell_command',
    })
    expect(CodexfulPrompt.codexfulToolProfile('qwen3.8', 'codex-pinned', true).hiddenTools)
      .toEqual(['apply_patch', ...CODEXFUL_V2_TOOL_NAMES])
  })

  it.each([
    { model: 'gpt-5.6-luna', multiAgent: 'v1', lite: true, toolMode: 'code_mode_only', skillsUsage: false, hiddenV1: [] },
    { model: 'gpt-5.5', multiAgent: 'v1', lite: false, toolMode: null, skillsUsage: true, hiddenV1: [] },
  ] as const)('uses the pinned $model multi-agent version', ({ model, multiAgent, lite, toolMode, skillsUsage, hiddenV1 }) => {
    expect(CodexfulPrompt.codexfulToolProfile(model, 'codex-pinned')).toMatchObject({
      hiddenTools: [...hiddenV1, ...CODEXFUL_V2_TOOL_NAMES, 'update_plan'],
      sourceTruncation: { mode: 'tokens', limit: 10000 },
      sourceResponsesLite: lite,
      sourcePatch: 'freeform',
      sourceMultiAgentVersion: multiAgent,
      sourceToolMode: toolMode,
      sourceShellType: 'shell_command',
      sourceSkillsUsageInstructions: skillsUsage,
      sourceParallelToolCalls: true,
    })
  })

  it.each([
    ['gpt-5.6-luna', 'multi_agent_v1__spawn_agent', 'v1'],
    ['gpt-6-sol', 'spawn_agent', 'v2'],
  ] as const)('retains the first %s delegation selection when the model changes', async (model, tool, version) => {
    const ctx = new Context()
    try {
      await services(ctx)
      await ctx.plugin(SystemPrompt)
    await ctx.plugin(ProductPrompt)
      await ctx.plugin(NativeToolRuntime)
    await ctx.plugin(NativeTools)
      delegationTools(ctx)
      const agent = fakeAgent(model)
      const scope = createScope(ctx, agent)
      Object.assign(agent, { ctx: scope.ctx })
      await scope.ctx.plugin(CodexfulPrompt, { toolProfile: 'codex-pinned' })
      let selected: string = model
      ctx.codexyPrompt.variable('model', () => selected)
      for (const next of [model, 'test-27b', 'gpt-5.6-luna', 'gpt-6-sol']) {
        selected = next
        const assembly = await ctx.codexyPrompt.assemble({ scope: agent, agent })
        expect(assembly.tools.map(candidate => candidate.name)).toEqual([tool])
      }
      expect(snapshotProductEvents(agent.session).filter(event => event.type === 'codexful/multi-agent-version'))
        .toMatchObject([{ data: { version } }])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each([
    ['startup', false, 'spawn_agent'],
    ['resume', false, 'multi_agent_v1__spawn_agent'],
    ['startup', true, 'multi_agent_v1__spawn_agent'],
  ] as const)('selects the legacy surface for %s with seeded=%s and no version metadata', async (source, isSeeded, tool) => {
    const ctx = new Context()
    try {
      await services(ctx)
      await ctx.plugin(SystemPrompt)
    await ctx.plugin(ProductPrompt)
      await ctx.plugin(NativeToolRuntime)
    await ctx.plugin(NativeTools)
      delegationTools(ctx)
      const agent = fakeAgent('gpt-6-sol', SessionId('legacy-delegation'), { isSeeded })
      const scope = createScope(ctx, agent)
      Object.assign(agent, { ctx: scope.ctx })
      await scope.ctx.plugin(CodexfulPrompt, { toolProfile: 'codex-pinned' })
      await agentEvents(ctx, agent).serial('agent/created', { source })
      const assembly = await ctx.codexyPrompt.assemble({ scope: agent, agent })
      expect(assembly.tools.map(candidate => candidate.name)).toEqual([tool])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each([undefined, 'v1'] as const)('inherits parent delegation unless the child already recorded %s', async (restored) => {
    const ctx = new Context()
    try {
      await services(ctx)
      await ctx.plugin(SystemPrompt)
    await ctx.plugin(ProductPrompt)
      await ctx.plugin(NativeToolRuntime)
    await ctx.plugin(NativeTools)
      delegationTools(ctx)
      const parent = fakeAgent('gpt-6-sol', SessionId('delegation-parent'))
      const parentScope = createScope(ctx, parent)
      Object.assign(parent, { ctx: parentScope.ctx })
      await parentScope.ctx.plugin(CodexfulPrompt, { toolProfile: 'codex-pinned' })
      await ctx.codexyPrompt.assemble({ scope: parent, agent: parent })
      ctx.provide('agents', { get: (id: SessionId) => id === parent.id ? parent : undefined } as never)

      const child = fakeAgent('gpt-5.6-luna', SessionId('delegation-child'), { parentSession: parent.id })
      if (restored !== undefined) appendProductEvent(child.session, 'codexful/multi-agent-version', { version: restored })
      const childScope = createScope(ctx, child)
      Object.assign(child, { ctx: childScope.ctx })
      await childScope.ctx.plugin(CodexfulPrompt, { toolProfile: 'codex-pinned' })
      await agentEvents(ctx, child).serial('agent/created', { source: 'startup' })
      const assembly = await ctx.codexyPrompt.assemble({ scope: child, agent: child })
      expect(assembly.tools.map(candidate => candidate.name))
        .toEqual([restored === 'v1' ? 'multi_agent_v1__spawn_agent' : 'spawn_agent'])
      expect(snapshotProductEvents(child.session).filter(event => event.type === 'codexful/multi-agent-version'))
        .toMatchObject([{ data: { version: restored ?? 'v2' } }])
      await parentScope.dispose()
      const surviving = await ctx.codexyPrompt.assemble({ scope: child, agent: child })
      expect(surviving.tools.map(candidate => candidate.name))
        .toEqual([restored === 'v1' ? 'multi_agent_v1__spawn_agent' : 'spawn_agent'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each([
    ['codex-pinned', 'gpt-5.6-luna', 'v2', 'spawn_agent'],
    ['daily', 'gpt-6-sol', 'v1', 'spawn_agent'],
  ] as const)('restores %s delegation before the next model request', async (toolProfile, model, restored, tool) => {
    const ctx = new Context()
    try {
      await services(ctx)
      await ctx.plugin(SystemPrompt)
    await ctx.plugin(ProductPrompt)
      await ctx.plugin(NativeToolRuntime)
    await ctx.plugin(NativeTools)
      delegationTools(ctx)
      const agent = fakeAgent(model)
      appendProductEvent(agent.session, 'codexful/multi-agent-version', { version: restored })
      const scope = createScope(ctx, agent)
      Object.assign(agent, { ctx: scope.ctx })
      await scope.ctx.plugin(CodexfulPrompt, { toolProfile })
      await agentEvents(ctx, agent).serial('agent/created', { source: 'resume' })
      const assembly = await ctx.codexyPrompt.assemble({ scope: agent, agent })
      expect(assembly.tools.map(candidate => candidate.name)).toEqual([tool])
      expect(snapshotProductEvents(agent.session).filter(event => event.type === 'codexful/multi-agent-version')
        .map(event => event.data)).toEqual(toolProfile === 'daily'
        ? [{ version: 'v1' }, { version: 'v2' }] : [{ version: 'v2' }])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('hides and denies omitted tools on the first request, then permits patch after a model switch', async () => {
    const ctx = new Context()
    try {
      await services(ctx)
      await ctx.plugin(SystemPrompt)
    await ctx.plugin(ProductPrompt)
      await ctx.plugin(NativeToolRuntime)
    await ctx.plugin(NativeTools)
      let executed = 0
      for (const name of ['exec_command', 'apply_patch', 'update_plan', 'spawn_agent']) {
        ctx.codexyTools.register(defineTool({
          name,
          description: name,
          parameters: {},
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
          async execute() { executed++; return name },
        }))
      }
      ctx.codexyPrompt.context({
        name: 'codexful-v2:multi-agent-role', order: 400, role: 'developer', text: '<multi_agent_role>V2</multi_agent_role>',
      })
      const agent = fakeAgent('qwen3.8')
      const scope = createScope(ctx, agent)
      Object.assign(agent, { ctx: scope.ctx })
      await scope.ctx.plugin(CodexfulPrompt, { toolProfile: 'codex-pinned' })
      await agentEvents(ctx, agent).serial('agent/created', { source: 'startup' })
      let selected = 'qwen3.8'
      ctx.codexyPrompt.variable('model', () => selected)
      const first = await ctx.codexyPrompt.assemble({ scope: agent, agent })
      expect(first.tools.map(tool => tool.name)).toEqual(['exec_command'])
      expect(renderContextSections(first, 'developer').map(section => section.text).join('\n')).not.toContain('<multi_agent_role>')
      expect(renderPrompt(first)).toBe(withoutUpdatePlanInstructions(CodexfulPrompt.codexfulModelProfile('qwen3.8').prompt))
      expect(renderPrompt(first)).not.toContain('## Planning\n')
      expect(renderPrompt(first)).not.toContain('## `update_plan`\n')
      expect(renderContextSections(first, 'developer').map(section => section.text).join('\n')).not.toContain('If apply_patch is denied')
      const denied = await ctx.codexyTools.execute({
        agent, callId: ToolCallId('strict-patch'), name: 'apply_patch', arguments: {}, signal: new AbortController().signal,
      })
      expect(denied.isError).toBe(true)
      expect(denied.content).toMatchObject([{ text: 'Error: apply_patch is unavailable in the current Codexful model tool profile' }])
      expect(executed).toBe(0)

      selected = 'gpt-6-sol'
      const second = await ctx.codexyPrompt.assemble({ scope: agent, agent })
      expect(second.tools.map(tool => tool.name)).toEqual(['apply_patch', 'exec_command'])
      expect(renderContextSections(second, 'developer').map(section => section.text).join('\n')).not.toContain('<multi_agent_role>')
      const allowed = await ctx.codexyTools.execute({
        agent, callId: ToolCallId('known-patch'), name: 'apply_patch', arguments: {}, signal: new AbortController().signal,
      })
      expect(allowed.isError).toBe(false)
      expect(executed).toBe(1)

      for (const model of ['gpt-5.6-luna', 'gpt-5.5']) {
        selected = model
        const assembly = await ctx.codexyPrompt.assemble({ scope: agent, agent })
        expect(assembly.tools.map(tool => tool.name)).toEqual(['apply_patch', 'exec_command'])
        expect(renderContextSections(assembly, 'developer').map(section => section.text).join('\n')).not.toContain('<multi_agent_role>')
        const deniedV2 = await ctx.codexyTools.execute({
          agent, callId: ToolCallId(`v2-${model}`), name: 'spawn_agent', arguments: {}, signal: new AbortController().signal,
        })
        expect(deniedV2.isError).toBe(true)
        expect(deniedV2.content).toMatchObject([{ text: 'Error: spawn_agent is unavailable in the current Codexful model tool profile' }])
      }
      expect(executed).toBe(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
