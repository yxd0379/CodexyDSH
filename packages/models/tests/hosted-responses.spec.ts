/** Synthetic hosted-capable backend; no external search/model/account is invoked. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { RequestProviders } from '@codexydsh/bridges'
import LlmRuntime, { BlockAssembler, ToolCallId, createToolResultMessage, createUserMessage } from '@codexydsh/runtime/llm'
import type { GenerateOptions, StreamChunk } from '@codexydsh/runtime/llm'
import { Session, SessionId, SessionLogOffset, appendProductEvent, deriveProductMessages, interruptedTurnClosers, snapshotProductEvents } from '@codexydsh/runtime/session'
import { decodeCodexyArtifact, encodeArtifactEvents, encodeArtifactHeader } from '../../runtime/src/persistence-codec.ts'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { HostedResponsesCapture } from '../src/hosted-responses.ts'
import CodexyRuntime from '../../runtime/src/index.ts'
import { mountAgentLoopTestDependencies } from '../../runtime-testkit/src/index.ts'
import { memoryAuth } from './auth-double.ts'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer } from './mock-server.ts'

afterEach(closeMockServers)
const web = { type: 'web_search_call', id: 'ws_actual_backend', status: 'completed',
  action: { type: 'search', queries: ['synthetic question'], sources: [{ type: 'url', url: 'https://example.invalid/source' }] },
  backend_extension: { original: true } }
const text = { type: 'message', id: 'msg_backend', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: 'synthetic answer', annotations: [{ type: 'url_citation', start_index: 0,
    end_index: 9, url: 'https://example.invalid/source', title: 'Synthetic source' }] }] }
const local = { type: 'function_call', id: 'fc_backend', call_id: 'call_local', name: 'local_echo',
  arguments: '{"value":"exact"}', status: 'completed' }
const event = (value: object) => JSON.stringify(value)
function script(output: readonly object[], complete = true): string[] {
  const response = { id: 'resp_backend', model: 'fixture', status: 'completed', output,
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } }
  return [event({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }),
    ...output.flatMap((item, output_index) => [
      event({ type: 'response.output_item.added', output_index, item: { ...item, status: 'in_progress' } }),
      ...item === web ? ['in_progress', 'searching', 'completed'].map(state => event({ type: `response.web_search_call.${state}`, output_index, item_id: web.id })) : [],
      event({ type: 'response.output_item.done', output_index, item }),
    ]), ...complete ? [event({ type: 'response.completed', response })] : []]
}
async function harness(baseURL: string, enabled = true, externalAccess?: boolean) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(RequestProviders)
  const profiles = resolveProfiles({ hosted: { api: 'openai-responses', baseURL, transport: 'sse',
    compat: { supportsOpenAIGrammarTools: true },
    ...enabled ? { backendHostedTools: ['web_search' as const] } : {},
    ...externalAccess === undefined ? {} : { backendWebSearchExternalAccess: externalAccess },
    models: [{ id: 'fixture', contextWindow: 4096, maxTokens: 256 }] },
  other: { api: 'openai-responses', baseURL, transport: 'sse', models: [{ id: 'fixture' }] } })
  const degraded = vi.fn()
  ctx.codexyRequests.registerAdapter(['hosted', 'other'], new PiAiAdapter({ profiles: () => profiles,
    resolveApiKey: () => Promise.resolve('synthetic-key'), auth: memoryAuth(), onReplayDegrade: degraded }))
  return { ctx, degraded }
}
const user = () => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'synthetic query' }] })
const request = (): GenerateOptions => ({ provider: 'hosted', model: 'fixture', messages: [user()] })

describe('explicit backend-hosted Responses web_search', () => {
  it.each([undefined, true, false])('serializes only the configured external web access policy (%s), preserving the local function', async (externalAccess) => {
    const server = await mockServer([{ events: script([text]) }])
    const { ctx } = await harness(server.url, true, externalAccess)
    try {
      const first = request()
      first.tools = [{ name: 'web_search', description: 'a distinct local function', parameters: { type: 'object' } }]
      first.codexfulResponses = { omitDefaultMaxTokens: true, reasoningSummary: 'none',
        strictModelInput: true, wireProfile: 'codex-0.162.1' }
      const originalTools = structuredClone(first.tools)
      await assemble(ctx, first)
      expect(server.requests[0]).toHaveProperty('tools', [
        expect.objectContaining({ type: 'function', name: 'web_search' }),
        { type: 'web_search', ...externalAccess === undefined ? {} : { external_web_access: externalAccess } },
      ])
      expect(first.tools).toEqual(originalTools)
    } finally { await ctx.fiber.dispose() }
  })

  it('does not advertise a hosted capability merely because an external-access policy was configured', async () => {
    const server = await mockServer([{ events: script([text]) }])
    const { ctx } = await harness(server.url, false, true)
    try {
      await assemble(ctx, request())
      expect(server.requests[0]).not.toHaveProperty('tools')
    } finally { await ctx.fiber.dispose() }
  })

  it('keeps raw HTTP metadata and arbitrarily split SSE bytes exactly, including UTF-8 and CRLF', async () => {
    const bytes = Buffer.from(`data: ${event({ type: 'response.output_item.added', output_index: 0, item: web })}\r\n\r\ndata: ${event({ type: 'response.output_item.done', output_index: 0, item: { ...web, unicode: '搜索' } })}\r\n\r\n`)
    const upstream: typeof fetch = async () => new Response(new ReadableStream({ start(controller) {
      for (let index = 0; index < bytes.length; index += 3) controller.enqueue(bytes.subarray(index, index + 3))
      controller.close()
    } }), { status: 201, statusText: 'Actual status', headers: { 'content-type': 'text/event-stream', 'x-fixture': 'kept' } })
    const capture = new HostedResponsesCapture('hosted', 'fixture')
    const forwarded = await capture.fetch(upstream)('http://127.0.0.1/synthetic')
    expect(forwarded.status).toBe(201)
    expect(forwarded.statusText).toBe('Actual status')
    expect(forwarded.headers.get('x-fixture')).toBe('kept')
    expect(Buffer.from(await forwarded.arrayBuffer())).toEqual(bytes)
    expect(capture.replay().output).toEqual([{ ...web, unicode: '搜索' }])
  })

  it('sends a real native declaration, retains local tools, and restores original items/annotations in same-route history', async () => {
    const server = await mockServer([{ events: script([web, text]) }, { events: script([text]) }])
    const { ctx } = await harness(server.url)
    try {
      const first = request()
      first.tools = [{ name: 'web_search', description: 'a distinct local function', parameters: { type: 'object' } }]
      const result = await assemble(ctx, first)
      expect(result.finish.kind).toBe('stop')
      expect(server.requests[0]).toHaveProperty('tools', [expect.objectContaining({ type: 'function', name: 'web_search' }), { type: 'web_search' }])
      expect(result.message.content).toEqual([
        { type: 'provider-output', api: 'openai-responses', outputIndex: 0, item: web },
        { type: 'text', text: 'synthetic answer' },
      ])
      await assemble(ctx, { ...first, messages: [...first.messages, result.message, user()],
        codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none', strictModelInput: true } })
      expect(server.requests[1]).toHaveProperty('input.1', web)
      expect(server.requests[1]).toHaveProperty('input.2', text)
      expect(JSON.stringify(server.requests[1])).not.toContain('function_call_output')
      expect(result.message).toHaveProperty('source.replayState.response.hostedResponses.events', expect.arrayContaining([
        expect.objectContaining({ type: 'response.web_search_call.searching' }),
      ]))
    } finally { await ctx.fiber.dispose() }
  })

  it('accepts hosted-only success without invented text and truthfully degrades on another route', async () => {
    const server = await mockServer([{ events: script([web]) }, { events: script([text]) }, { events: script([text]) }])
    const { ctx, degraded } = await harness(server.url)
    try {
      const first = request()
      const result = await assemble(ctx, first)
      expect(result.finish.kind).toBe('stop')
      expect(result.message.content).toHaveLength(1)
      expect(result.message.content[0]?.type).toBe('provider-output')
      await assemble(ctx, { ...first, messages: [...first.messages, result.message, user()] })
      expect(server.requests[1]).toHaveProperty('input.1', web)
      await assemble(ctx, { ...first, provider: 'other', messages: [...first.messages, result.message, user()] })
      expect(degraded).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringContaining('different or non-hosted route') }))
      expect(JSON.stringify(server.requests[2])).not.toContain('web_search_call')
      expect(server.requests[2]).not.toHaveProperty('tools')
    } finally { await ctx.fiber.dispose() }
  })

  it('preserves mixed backend and local call order without returning fake local results for hosted search', async () => {
    const server = await mockServer([{ events: script([text, web, local]) }, { events: script([text]) }])
    const { ctx } = await harness(server.url)
    try {
      const first = request()
      const result = await assemble(ctx, first)
      expect(result.message.content.map(block => block.type)).toEqual(['text', 'provider-output', 'tool-call'])
      const call = result.message.content.find(block => block.type === 'tool-call')
      expect(call?.id).toBe('call_local|fc_backend')
      await assemble(ctx, { ...first, messages: [...first.messages, result.message, createToolResultMessage({
        callId: ToolCallId('call_local|fc_backend'), content: [{ type: 'text', text: 'actually executed echo' }],
      })] })
      expect(server.requests[1]).toHaveProperty('input.1', text)
      expect(server.requests[1]).toHaveProperty('input.2', web)
      expect(server.requests[1]).toHaveProperty('input.3', local)
      expect(server.requests[1]).toHaveProperty('input.4', expect.objectContaining({ type: 'function_call_output', call_id: 'call_local' }))
    } finally { await ctx.fiber.dispose() }
  })

  it('keeps raw native history but advertises no hosted tool on an actual compaction request', async () => {
    const server = await mockServer([{ events: script([web]) }, { events: script([text]) }])
    const { ctx } = await harness(server.url, true, true)
    try {
      const first = request()
      const result = await assemble(ctx, first)
      await assemble(ctx, { ...first, purpose: 'compaction', tools: [],
        messages: [...first.messages, result.message, user()],
        codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none', strictModelInput: true } })
      expect(server.requests[1]).toHaveProperty('tools', [])
      expect((server.requests[1] as { input: { type?: string }[] }).input.filter(item => item.type === 'web_search_call')).toEqual([web])
    } finally { await ctx.fiber.dispose() }
  })

  it.each(['function_call', 'custom_tool_call'] as const)('replays consumed %s done identities/results and durably preserves a different terminal snapshot', async (type) => {
    const done = { type, id: `${type}_consumed_done`, call_id: 'call_consumed_done', name: 'local_echo', status: 'completed',
      ...type === 'function_call' ? { arguments: '{ "value" : "consumed exact" }' } : { input: 'consumed\nfreeform exact' },
      done_extension: { original: true } }
    const later = { ...done, id: `${type}_terminal_later`, call_id: 'call_terminal_later',
      ...type === 'function_call' ? { arguments: '{"value":"terminal different"}' } : { input: 'terminal different' },
      terminal_extension: ['original terminal'] }
    const response = { id: 'resp_different_terminal', model: 'fixture', status: 'completed', output: [later],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 }, original_terminal: true }
    const doneEvent = { type: 'response.output_item.done', output_index: 0, item: done, sequence_number: 12 }
    const terminalEvent = { type: 'response.completed', response, sequence_number: 13 }
    const server = await mockServer([{ events: [
      event({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }),
      event({ type: 'response.output_item.added', output_index: 0, item: { ...done, status: 'in_progress' } }),
      event(doneEvent), event(terminalEvent),
    ] }, { events: script([text]) }])
    const { ctx } = await harness(server.url)
    try {
      const first = request()
      const result = await assemble(ctx, first)
      const call = result.message.content.find(block => block.type === 'tool-call')
      expect(call?.id).toBe(`call_consumed_done|${done.id}`)
      expect(call?.arguments).toBe(type === 'function_call' ? done.arguments : done.input)
      expect(result.message).toHaveProperty('source.replayState.response.hostedResponses.output', [done])
      expect(result.message).toHaveProperty('source.replayState.response.hostedResponses.terminal', response)
      expect(result.message).toHaveProperty('source.replayState.response.hostedResponses.events', [doneEvent, terminalEvent])
      const id = SessionId(`hosted-consumption-${type}`)
      const header = { version: 4 as const, id, createdAt: 1, isSeeded: false }
      const session = Session.create(id, undefined, header)
      session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
      session.append('user/message', first.messages[0] as ReturnType<typeof user>, { surfaceOp: 'append' })
      session.append('assistant/message', { turn: 1, step: 1, message: result.message as never, stream: [] }, { surfaceOp: 'append' })
      const encoded = encodeArtifactHeader({ kind: 'codexy-session', version: 1, session: header,
        inheritedEventCount: SessionLogOffset(0) }) + encodeArtifactEvents(session.snapshotEvents())
      const decoded = decodeCodexyArtifact(Buffer.from(encoded))
      const restored = Session.fromRestore(id, decoded.events, decoded.metadata.session, decoded.metadata.inheritedEventCount, 'detached')
      expect(deriveProductMessages(restored).find(message => message.role === 'assistant')).toEqual(result.message)
      const next = await assemble(ctx, { ...first, messages: [...deriveProductMessages(restored), createToolResultMessage({
        callId: ToolCallId(`call_consumed_done|${done.id}`), content: [{ type: 'text', text: 'actual local result' }],
        ...type === 'custom_tool_call' ? { toolKind: 'freeform', name: 'local_echo' } : {},
      })] })
      expect(next.finish).toEqual({ kind: 'stop' })
      expect(server.requests[1]).toHaveProperty('input.1', done)
      expect(server.requests[1]).toHaveProperty('input.2', expect.objectContaining({
        type: type === 'function_call' ? 'function_call_output' : 'custom_tool_call_output', call_id: 'call_consumed_done', output: 'actual local result',
      }))
      expect(JSON.stringify(server.requests[1])).not.toContain('call_terminal_later')
    } finally { await ctx.fiber.dispose() }
  })

  it('durably checkpoints an interrupted hosted-only item through actual public Session encoding/restore and crash recovery', async () => {
    const server = await mockServer([{ events: script([web], false) }, { events: script([text]) }])
    const { ctx } = await harness(server.url)
    try {
      const id = SessionId('hosted-interrupted-fixture')
      const header = { version: 4 as const, id, createdAt: 1, isSeeded: false }
      const session = Session.create(id, undefined, header)
      session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
      const first = request()
      session.append('user/message', first.messages[0] as ReturnType<typeof user>, { surfaceOp: 'append' })
      const chunks: StreamChunk[] = []
      for await (const chunk of ctx.codexyRequests.stream(first)) {
        chunks.push(chunk)
        if (chunk.type === 'block-end') appendProductEvent(session, 'assistant/output-item', {
          turn: 1, step: 1, index: chunk.index, block: chunk.block as never, provider: 'hosted', model: 'fixture',
          ...chunk.replayState === undefined ? {} : { replayState: chunk.replayState },
        })
      }
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
      expect(snapshotProductEvents(session).filter(row => row.type === 'assistant/output-item')).toHaveLength(1)
      const metadata = { kind: 'codexy-session' as const, version: 1 as const, session: header, inheritedEventCount: SessionLogOffset(0) }
      const bytes = encodeArtifactHeader(metadata) + encodeArtifactEvents(session.snapshotEvents())
      const decoded = decodeCodexyArtifact(Buffer.from(bytes))
      const restored = Session.fromRestore(id, decoded.events, decoded.metadata.session, decoded.metadata.inheritedEventCount, 'detached')
      const projected = snapshotProductEvents(restored)
      const recovered = interruptedTurnClosers(projected)
      const assistant = recovered.find(row => row.type === 'assistant/message')
      expect(assistant).toMatchObject({ data: { interrupted: true, message: { content: [
        { type: 'provider-output', api: 'openai-responses', item: web },
      ] } } })
      if (assistant?.type !== 'assistant/message') throw new Error('missing recovered native item')
      await assemble(ctx, { ...first, messages: [...deriveProductMessages(restored), assistant.data.message, user()] })
      expect(server.requests[1]).toHaveProperty('input.1', web)
      expect(encodeArtifactHeader(metadata) + encodeArtifactEvents(session.snapshotEvents())).toBe(bytes)
    } finally { await ctx.fiber.dispose() }
  })

  it('does not change the default route or claim hosted qualification from configuration', async () => {
    const server = await mockServer([{ events: script([text]) }])
    const { ctx } = await harness(server.url, false)
    try {
      await assemble(ctx, request())
      expect(server.requests[0]).not.toHaveProperty('tools')
      expect(() => resolveProfiles({ invalid: { api: 'openai-completions', backendHostedTools: ['web_search'] } })).toThrow('requires openai-responses')
      expect(() => resolveProfiles({ invalid: { api: 'openai-responses', transport: 'websocket', backendHostedTools: ['web_search'] } })).toThrow('over SSE')
    } finally { await ctx.fiber.dispose() }
  })

  it.each([true, false])('runs the actual agent loop (stream tools=%s) with hosted-only output, no local execution, and durable next-turn history', async (eager) => {
    const server = await mockServer([{ events: script([web]) }, { events: script([text]) }])
    const ctx = new Context()
    try {
      await mountAgentLoopTestDependencies(ctx, { systemPrompt: { includeHarnessIdentity: false } })
      await ctx.plugin(CodexyRuntime, { agents: [] })
      const profiles = resolveProfiles({ hosted: { api: 'openai-responses', baseURL: server.url,
        transport: 'sse', backendHostedTools: ['web_search'], models: [{ id: 'fixture' }] } })
      ctx.codexyRequests.registerAdapter(['hosted'], new PiAiAdapter({ profiles: () => profiles,
        resolveApiKey: () => Promise.resolve('synthetic-key'), auth: memoryAuth() }))
      const search = vi.fn(async () => 'local function must not run')
      ctx.codexyTools.register({ name: 'web_search', description: 'actual local capability',
        parameters: { type: 'object' }, execute: search,
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] } })
      const agent = await ctx.agentLoop.create(SessionId('actual-hosted-eager-loop'), { provider: 'hosted', model: 'fixture' })
      if (eager) ctx.agentLoop.enableCodexStreamingTools(agent)
      agent.followup(user()); await agent.whenIdle()
      expect(search).not.toHaveBeenCalled()
      const events = snapshotProductEvents(agent.session)
      expect(events.findLast(row => row.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'completed' } } })
      expect(events.filter(row => row.type === 'assistant/output-item')).toHaveLength(1)
      const nativeMessage = events.findLast(row => row.type === 'assistant/message')
      expect(nativeMessage).toMatchObject({ data: { message: { content: [
        { type: 'provider-output', item: web },
      ] } } })
      const header = { kind: 'codexy-session' as const, version: 1 as const, session: agent.session.header,
        inheritedEventCount: SessionLogOffset(0) }
      const encoded = encodeArtifactHeader(header) + encodeArtifactEvents(agent.session.snapshotEvents())
      const decoded = decodeCodexyArtifact(Buffer.from(encoded))
      const restored = Session.fromRestore(agent.id, decoded.events, decoded.metadata.session, decoded.metadata.inheritedEventCount, 'detached')
      expect(deriveProductMessages(restored).findLast(message => message.role === 'assistant')?.content).toEqual([
        { type: 'provider-output', api: 'openai-responses', outputIndex: 0, item: web },
      ])
      agent.followup(user()); await agent.whenIdle()
      const body = server.requests[1] as { input: { type?: string }[] }
      expect(body.input.filter(item => item.type === 'web_search_call')).toEqual([web])
      expect(search).not.toHaveBeenCalled()
    } finally { await ctx.fiber.dispose() }
  })

  it.each([true, false])('retains a completed hosted item through an actual failed agent request (stream tools=%s), and replays it next turn', async (eager) => {
    const server = await mockServer([{ events: script([web], false) }, { events: script([text]) }])
    const ctx = new Context()
    try {
      await mountAgentLoopTestDependencies(ctx, { systemPrompt: { includeHarnessIdentity: false } })
      await ctx.plugin(CodexyRuntime, { agents: [] })
      const profiles = resolveProfiles({ hosted: { api: 'openai-responses', baseURL: server.url,
        transport: 'sse', backendHostedTools: ['web_search'], models: [{ id: 'fixture' }] } })
      ctx.codexyRequests.registerAdapter(['hosted'], new PiAiAdapter({ profiles: () => profiles,
        resolveApiKey: () => Promise.resolve('synthetic-key'), auth: memoryAuth() }))
      const agent = await ctx.agentLoop.create(SessionId(`actual-hosted-failed-loop-${eager}`), { provider: 'hosted', model: 'fixture' })
      if (eager) ctx.agentLoop.enableCodexStreamingTools(agent)
      agent.followup(user()); await agent.whenIdle()
      const events = snapshotProductEvents(agent.session)
      expect(events.findLast(row => row.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'error' } } })
      expect(events.findLast(row => row.type === 'assistant/message')).toMatchObject({ data: { interrupted: true,
        message: { content: [{ type: 'provider-output', item: web }] } } })
      agent.followup(user()); await agent.whenIdle()
      expect((server.requests[1] as { input: { type?: string }[] }).input.filter(item => item.type === 'web_search_call')).toEqual([web])
    } finally { await ctx.fiber.dispose() }
  })

  it.each([true, false])('restores unfinished hosted progress as an attempt, never completed history (stream tools=%s)', async (eager) => {
    const pending = { ...web, status: 'in_progress', action: { type: 'search', queries: ['synthetic pending'] } }
    const failure = { id: 'resp_pending', model: 'fixture', status: 'failed', output: [pending],
      error: { code: 'fixture_failure', message: 'synthetic backend failure' } }
    const events = [event({ type: 'response.created', response: { ...failure, status: 'in_progress', output: [] } }),
      event({ type: 'response.output_item.added', output_index: 0, item: pending }),
      event({ type: 'response.web_search_call.searching', output_index: 0, item_id: web.id, backend_progress: 'original' }),
      event({ type: 'response.failed', response: failure })]
    const server = await mockServer([{ events }, { events: script([text]) }])
    const ctx = new Context()
    try {
      await mountAgentLoopTestDependencies(ctx, { systemPrompt: { includeHarnessIdentity: false } })
      await ctx.plugin(CodexyRuntime, { agents: [] })
      const profiles = resolveProfiles({ hosted: { api: 'openai-responses', baseURL: server.url,
        transport: 'sse', backendHostedTools: ['web_search'], models: [{ id: 'fixture' }] } })
      ctx.codexyRequests.registerAdapter(['hosted'], new PiAiAdapter({ profiles: () => profiles,
        resolveApiKey: () => Promise.resolve('synthetic-key'), auth: memoryAuth() }))
      const agent = await ctx.agentLoop.create(SessionId(`actual-hosted-progress-loop-${eager}`), { provider: 'hosted', model: 'fixture' })
      if (eager) ctx.agentLoop.enableCodexStreamingTools(agent)
      agent.followup(user()); await agent.whenIdle()
      const rows = snapshotProductEvents(agent.session)
      expect(rows.findLast(row => row.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'error' } } })
      expect(rows.filter(row => row.type === 'assistant/output-item' || row.type === 'assistant/message')).toEqual([])
      const attempt = rows.findLast(row => row.type === 'assistant/attempt')
      expect(attempt).toHaveProperty('data.replayState.response.hostedResponses', {
        output: [], events: [JSON.parse(events[1]!), JSON.parse(events[2]!), JSON.parse(events[3]!)], terminal: failure,
        pendingOutput: [{ outputIndex: 0, item: pending }],
      })
      if (attempt?.type !== 'assistant/attempt') throw new Error('missing actual unfinished attempt')
      expect(attempt.data.stream.some(record => record.type === 'chunk' && record.chunk.type === 'block-end')).toBe(false)
      const header = { kind: 'codexy-session' as const, version: 1 as const, session: agent.session.header,
        inheritedEventCount: SessionLogOffset(0) }
      const encoded = encodeArtifactHeader(header) + encodeArtifactEvents(agent.session.snapshotEvents())
      const decoded = decodeCodexyArtifact(Buffer.from(encoded))
      const restored = Session.fromRestore(agent.id, decoded.events, decoded.metadata.session, decoded.metadata.inheritedEventCount, 'detached')
      expect(snapshotProductEvents(restored).findLast(row => row.type === 'assistant/attempt')).toEqual(attempt)
      expect(deriveProductMessages(restored).filter(message => message.role === 'assistant')).toEqual([])
      expect(interruptedTurnClosers(snapshotProductEvents(restored)).filter(row => row.type === 'assistant/message')).toEqual([])
      agent.followup(user()); await agent.whenIdle()
      expect(JSON.stringify(server.requests[1])).not.toContain('web_search_call')
    } finally { await ctx.fiber.dispose() }
  })

  it('keeps cancelled progress incomplete without inventing a native block end', async () => {
    const pending = { ...web, status: 'in_progress' }
    const server = await mockServer([{ delayMs: 25, events: [
      event({ type: 'response.created', response: { id: 'resp_pending_abort', status: 'in_progress', output: [] } }),
      event({ type: 'response.output_item.added', output_index: 0, item: pending }),
      event({ type: 'response.web_search_call.searching', output_index: 0, item_id: web.id }),
    ] }])
    const { ctx } = await harness(server.url)
    try {
      const signal = new AbortController()
      const assembler = new BlockAssembler()
      const chunks: StreamChunk[] = []
      for await (const chunk of ctx.codexyRequests.stream({ ...request(), signal: signal.signal })) {
        chunks.push(chunk); assembler.push(chunk)
        if (chunk.type === 'block-start' && chunk.replayState !== undefined) signal.abort('synthetic progress cancellation')
      }
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })
      expect(chunks.filter(chunk => chunk.type === 'block-end')).toEqual([])
      expect(assembler.completedBlocks()).toEqual([])
      expect(assembler.interruptedBlocks()).toEqual([])
      expect(assembler.attemptReplayState).toHaveProperty('response.hostedResponses.pendingOutput', [{ outputIndex: 0, item: pending }])
    } finally { await ctx.fiber.dispose() }
  })

  it('retains pending native facts beside completed text without replaying the unfinished search', async () => {
    const pending = { ...web, status: 'in_progress' }
    const firstEvents = [...script([text], false),
      event({ type: 'response.output_item.added', output_index: 1, item: pending }),
      event({ type: 'response.web_search_call.searching', output_index: 1, item_id: web.id })]
    const server = await mockServer([{ events: firstEvents }, { events: script([text]) }])
    const ctx = new Context()
    try {
      await mountAgentLoopTestDependencies(ctx, { systemPrompt: { includeHarnessIdentity: false } })
      await ctx.plugin(CodexyRuntime, { agents: [] })
      const profiles = resolveProfiles({ hosted: { api: 'openai-responses', baseURL: server.url,
        transport: 'sse', backendHostedTools: ['web_search'], models: [{ id: 'fixture' }] } })
      ctx.codexyRequests.registerAdapter(['hosted'], new PiAiAdapter({ profiles: () => profiles,
        resolveApiKey: () => Promise.resolve('synthetic-key'), auth: memoryAuth() }))
      const agent = await ctx.agentLoop.create(SessionId('actual-hosted-mixed-progress'), { provider: 'hosted', model: 'fixture' })
      ctx.agentLoop.enableCodexStreamingTools(agent)
      agent.followup(user()); await agent.whenIdle()
      const assistant = deriveProductMessages(agent.session).findLast(message => message.role === 'assistant')
      expect(assistant?.content).toEqual([{ type: 'text', text: 'synthetic answer' }])
      expect(assistant).toHaveProperty('source.replayState.response.hostedResponses.pendingOutput', [{ outputIndex: 1, item: pending }])
      agent.followup(user()); await agent.whenIdle()
      expect((server.requests[1] as { input: { type?: string }[] }).input.filter(item => item.type === 'web_search_call')).toEqual([])
      expect(server.requests[1]).toHaveProperty('input.1', text)
    } finally { await ctx.fiber.dispose() }
  })

  it('emits a completed hosted checkpoint before a backend stalls and cancellation, without waiting for an SDK text event', async () => {
    const server = await mockServer([{ events: script([web]), delayMs: 25 }])
    const { ctx } = await harness(server.url)
    try {
      const abort = new AbortController()
      const assembler = new BlockAssembler()
      let sawHosted = false
      const chunks: StreamChunk[] = []
      for await (const chunk of ctx.codexyRequests.stream({ ...request(), signal: abort.signal })) {
          chunks.push(chunk)
          assembler.push(chunk)
          if (chunk.type === 'block-end' && chunk.block.type === 'provider-output') {
            sawHosted = true
            abort.abort('synthetic user cancellation after actual hosted item')
          }
      }
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })
      expect(sawHosted).toBe(true)
      expect(assembler.completedBlocks()).toEqual([{ type: 'provider-output', api: 'openai-responses', outputIndex: 0, item: web }])
      expect(assembler.completedReplayState).toHaveProperty('response.hostedResponses.output', [web])
    } finally { await ctx.fiber.dispose() }
  })
})
