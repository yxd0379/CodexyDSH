/** Product AgentFactory composes only released DSH services and owned provider ports. */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SessionSeq, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'
import { LlmAdapter, ToolCallId, createUserMessage, createSystemMessage } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import CodexyRuntime from '../src/index.ts'
import Persistence, { decodeCodexyArtifact, decodeLegacySession } from '../src/persistence.ts'
import { requestHeaderOf, snapshotProductEvents, buildForkSeed } from '../src/session.ts'
import type { GenerateOptions, StreamChunk, PreparedAdapterCall } from '../src/llm.ts'
import type { ToolDefinition } from '../src/tools.ts'
import { mountAgentLoopTestDependencies } from '../../runtime-testkit/src/index.ts'

class NativeModel extends LlmAdapter {
  requests: GenerateOptions[] = []
  constructor(private readonly swapTool: () => void) { super() }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, codexResponsesLite: true })
  }
  override async prepareCall(provider: string, model: string): Promise<PreparedAdapterCall> {
    return { model: await this.resolveModel(provider, model), developerHistory: 'native', stream: options => this.stream(options) }
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) {
      this.swapTool()
      const call = { type: 'tool-call' as const, id: ToolCallId('native-call'), name: 'native_echo', kind: 'freeform' as const, arguments: 'raw input' }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, kind: 'freeform', argumentsDelta: call.arguments }
      yield { type: 'block-end', index: 0, block: call, replayState: { response: { completed: true }, blocks: [{ id: 'native-call' }] } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'done' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

describe('Codexy AgentFactory on released DSH', () => {
  const resources: { ctx: Context; root: string }[] = []
  afterEach(async () => { for (const { ctx, root } of resources.splice(0)) { try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) } } })
  it('runs and restores a child fork after a native completed-output checkpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codexy-agent-fork-'))
    const ctx = new Context()
    resources.push({ ctx, root })
    await mountAgentLoopTestDependencies(ctx, { systemPrompt: { includeHarnessIdentity: false } })
    await ctx.plugin(Persistence, { root })
    await ctx.plugin(CodexyRuntime, { agents: [] })
    const adapter = new NativeModel(() => {})
    adapter.requests.push({ provider: 'native', model: 'fixture', messages: [] })
    ctx.codexyRequests.registerAdapter(['native'], adapter)
    const fixture = await readFile(new URL('./fixtures/released-v5-native.jsonl', import.meta.url), 'utf8')
    const rows: Record<string, unknown>[] = fixture.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    rows[0] = { ...rows[0]!, isSeeded: false }
    const user = rows[1]!
    const turnStart = rows[3]!
    const stepStart = rows[4]!
    rows[1] = { ...turnStart, seq: 0 }
    rows[2] = { ...stepStart, seq: 1 }
    rows[3] = { type: 'system/message', seq: 2, time: 1001, data: { turn: 1, step: 1, message: createSystemMessage('') }, surfaceOp: 'append' }
    rows[4] = { ...user, seq: 3 }
    const call = { ...rows[8]!, seq: 6 }
    const early = Buffer.from([...rows.slice(0, 7), call].map(row => JSON.stringify(row)).join('\n') + '\n')
    const imported = decodeLegacySession(early, 'native-parent.jsonl')
    const seed = buildForkSeed(imported.events, SessionSeq(imported.events.length - 1))
    const inheritedEventCount = SessionLogOffset(imported.events.length)
    const id = SessionId('native-fork-child')
    const handle = await ctx.agents.create({
      sessionId: id, seed, inheritedEventCount,
      meta: { parentSession: imported.metadata.session.id, isSeeded: true },
      agentOptions: { provider: 'native', model: 'fixture' },
    })
    handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'continue child' }] }))
    await handle.agent.whenIdle()
    const request = adapter.requests.at(-1)!
    expect(request.messages.some(message => message.role === 'assistant' && message.content.some(block => block.type === 'tool-call' && block.kind === 'freeform'))).toBe(true)
    expect(request.messages.some(message => message.role === 'tool' && message.source.kind === 'tool')).toBe(true)
    expect(request.messages.at(-1)?.content).toEqual([{ type: 'text', text: 'continue child' }])
    await ctx.sessionPersistence.flush()
    await handle.dispose()
    const artifact = decodeCodexyArtifact(await readFile(join(root, `${id}.codexy.jsonl`)))
    expect(artifact.metadata.inheritedEventCount).toBe(inheritedEventCount)
    expect(artifact.events.slice(0, inheritedEventCount)).toEqual(seed.slice(0, inheritedEventCount))
    const continuation = await ctx.agents.resume({ resumeSessionId: id, agentOptions: { provider: 'native', model: 'fixture' } })
    continuation.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'resume child' }] }))
    await continuation.agent.whenIdle()
    expect(adapter.requests.at(-1)!.messages.at(-1)?.content).toEqual([{ type: 'text', text: 'resume child' }])
    expect(snapshotProductEvents(continuation.agent.session).filter(event => event.type === 'assistant/output-item')).toHaveLength(1)
    await continuation.dispose()
  })
  it.each(['replace', 'remove'] as const)('freezes native requests and executes captured tools once after %s', async mode => {
    const root = await mkdtemp(join(tmpdir(), 'codexy-agent-factory-'))
    const ctx = new Context()
    resources.push({ ctx, root })
    await mountAgentLoopTestDependencies(ctx, { systemPrompt: { includeHarnessIdentity: false } })
    await ctx.plugin(Persistence, { root })
    await ctx.plugin(CodexyRuntime, { agents: [] })
    const calls: string[] = []
    const requestHooks = { native: 0, platform: 0 }
    const observed: GenerateOptions[] = []
    ctx.on('codexy-llm/stream', (options, next) => { requestHooks.native++; observed.push(options); return next() })
    ctx.on('llm/stream', (options, next) => {
      requestHooks.platform++
      expect(Object.isFrozen(options)).toBe(true)
      if (options.tools !== undefined) expect(options.tools[0]!.parameters).toEqual({ type: 'string' })
      expect(() => Object.assign(options, { model: 'tampered' })).toThrow(TypeError)
      return next()
    })
    const hooks = { pre: 0, dispatch: 0, post: 0, result: 0, finalize: 0 }
    function definition(generation: string): ToolDefinition {
      return { name: 'native_echo', description: generation, kind: 'freeform', format: { type: 'grammar', syntax: 'regex', definition: '.*' },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
        execute: async args => { calls.push(generation); return `${generation}:${String(args)}` },
        finalizeContent: () => { hooks.finalize++; return undefined },
      }
    }
    let remove = ctx.codexyTools.register(definition('captured'))
    const adapter = new NativeModel(() => { remove(); if (mode === 'replace') remove = ctx.codexyTools.register(definition('replacement')) })
    ctx.codexyRequests.registerAdapter(['native'], adapter)
    ctx.on('tools/pre-execute', (_exec, next) => { hooks.pre++; return next() })
    ctx.on('tools/execute', (_exec, next) => { hooks.dispatch++; return next() })
    ctx.on('tools/post-execute', (_exec, _result, next) => { hooks.post++; return next() })
    ctx.on('tools/result', () => { hooks.result++; return undefined })
    ctx.on('codexy-agent/request', async (_payload, next) => ({ ...await next(), codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'auto' } }))
    const id = SessionId('native-product-agent')
    const handle = await ctx.agents.create({ sessionId: id, agentOptions: { provider: 'native', model: 'fixture' } })
    const agent = handle.agent
    ctx.agentLoop.enableCodexStreamingTools(agent)
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'use the tool' }] }))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(snapshotProductEvents(agent.session).filter(event => event.type === 'request/header')).toHaveLength(2)
    expect(requestHooks).toEqual({ native: 2, platform: 2 })
    expect(observed[0]!.tools?.[0]).toMatchObject({ kind: 'freeform' })
    expect(adapter.requests[0]!.model).toBe('fixture')
    expect(adapter.requests[0]!.codexfulResponses).toMatchObject({ omitDefaultMaxTokens: true })
    expect(calls).toEqual(['captured'])
    expect(hooks).toEqual({ pre: 1, dispatch: 1, post: 1, result: 1, finalize: 1 })
    expect(Object.isFrozen(adapter.requests[0])).toBe(true)
    expect(Object.isFrozen(adapter.requests[0]!.messages)).toBe(true)
    expect(adapter.requests[0]!.tools?.[0]).toMatchObject({ kind: 'freeform', description: 'captured' })
    if (mode === 'replace') expect(adapter.requests[1]!.tools?.[0]).toMatchObject({ kind: 'freeform', description: 'replacement' })
    else expect(adapter.requests[1]!.tools).toBeUndefined()
    expect(adapter.requests[1]!.messages.find(message => message.role === 'tool')?.content).toEqual([{ type: 'text', text: 'captured:raw input' }])
    expect(snapshotProductEvents(agent.session).some(event => event.type === 'assistant/output-item')).toBe(true)
    await ctx.sessionPersistence.flush()
    const artifact = decodeCodexyArtifact(await readFile(join(root, `${id}.codexy.jsonl`)))
    const restored = Session.fromRestore(id, artifact.events, artifact.metadata.session, artifact.metadata.inheritedEventCount, 'detached')
    expect(artifact.events.filter(event => event.type === 'request/header')).toHaveLength(2)
    expect(snapshotProductEvents(restored).filter(event => event.type === 'request/header')).toHaveLength(2)
    expect(artifact.events.some(event => event.type === 'codexy/fact' && event.data.type === 'runtime/feature')).toBe(true)
    expect(() => validateStoredEvents(restored.header, [...restored.snapshotEvents()])).toThrow('unknown to this harness')
    if (mode === 'replace') expect(requestHeaderOf(restored)?.tools?.[0]).toMatchObject({ kind: 'freeform', description: 'replacement' })
    else expect(requestHeaderOf(restored)?.tools).toBeUndefined()
    expect(restored.deriveMessages().findLast(message => message.role === 'assistant')?.content).toEqual([{ type: 'text', text: 'done' }])
    await handle.dispose()
  })
})
