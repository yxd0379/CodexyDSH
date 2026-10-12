/** Native Responses items decoded by the real pi SDK; no model or account is used. */
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { RequestProviders } from '@codexydsh/bridges'
import LlmRuntime, { ToolCallId, createToolResultMessage, createUserMessage } from '@codexydsh/runtime/llm'
import type { GenerateOptions } from '@codexydsh/runtime/llm'
import { Session, SessionId, SessionLogOffset, deriveProductMessages, snapshotProductEvents } from '@codexydsh/runtime/session'
import { decodeCodexyArtifact, encodeArtifactEvents, encodeArtifactHeader } from '../../runtime/src/persistence-codec.ts'
import CodexyRuntime from '../../runtime/src/index.ts'
import { mountAgentLoopTestDependencies } from '../../runtime-testkit/src/index.ts'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { toPiAssistant } from '../src/replay.ts'
import { memoryAuth } from './auth-double.ts'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer } from './mock-server.ts'

afterEach(closeMockServers)

const reasoning = { type: 'reasoning', id: 'a6d7e0566b6e3007', summary: [],
  content: [{ type: 'reasoning_text', text: 'Synthetic provider reasoning, kept as a typed item.' }], encrypted_content: null, status: 'completed' }
const text = { type: 'message', id: 'ac2de047692eb37b', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: 'Synthetic provider message.' }] }
const call = { type: 'function_call', id: '948160cf633d93d1', call_id: 'call_native_exact',
  name: 'exec_command', namespace: null, arguments: '{ "cmd" : "fixture command, not executed by a shell" }', status: 'completed' }
const final = { ...text, content: [{ type: 'output_text', text: 'Synthetic final.' }] }
function script(output: readonly object[]): string[] {
  return [JSON.stringify({ type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress', output: [] } }),
    ...output.flatMap((item, output_index) => [
      JSON.stringify({ type: 'response.output_item.added', output_index, item: { ...item, status: 'in_progress' } }),
      JSON.stringify({ type: 'response.output_item.done', output_index, item }),
    ]), JSON.stringify({ type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output,
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } })]
}

function profile(baseURL: string, hosted: boolean) {
  return resolveProfiles({ local: { api: 'openai-responses', baseURL, transport: 'sse',
    ...hosted ? { backendHostedTools: ['web_search' as const] } : {},
    models: [{ id: 'fixture', contextWindow: 65536, maxTokens: 4096 }] } })
}

async function harness(baseURL: string, hosted = true) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(RequestProviders)
  const profiles = profile(baseURL, hosted)
  const degraded = vi.fn()
  ctx.codexyRequests.registerAdapter(['local'], new PiAiAdapter({ profiles: () => profiles,
    resolveApiKey: () => Promise.resolve('fixture-key'), auth: memoryAuth(), onReplayDegrade: degraded }))
  return { ctx, degraded }
}

const user = () => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic native item test.' }] })
const request = (): GenerateOptions => ({ provider: 'local', model: 'fixture', messages: [user()],
  tools: [{ name: 'exec_command', description: 'Fixture function, not a shell.', parameters: {
    type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'], additionalProperties: false,
  } }], codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none', strictModelInput: true, wireProfile: 'codex-0.162.1' } })

function restore(message: Awaited<ReturnType<typeof assemble>>['message']) {
  const id = SessionId('native-null-namespace-restore')
  const header = { version: 4 as const, id, createdAt: 1, isSeeded: false }
  const session = Session.create(id, undefined, header)
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', user(), { surfaceOp: 'append' })
  session.append('assistant/message', { turn: 1, step: 1, message: message as never, stream: [] }, { surfaceOp: 'append' })
  const encoded = encodeArtifactHeader({ kind: 'codexy-session', version: 1, session: header,
    inheritedEventCount: SessionLogOffset(0) }) + encodeArtifactEvents(session.snapshotEvents())
  const decoded = decodeCodexyArtifact(Buffer.from(encoded))
  const restored = Session.fromRestore(id, decoded.events, decoded.metadata.session, decoded.metadata.inheritedEventCount, 'detached')
  expect(deriveProductMessages(restored).find(item => item.role === 'assistant')).toEqual(message)
  // Restoring an unseeded Session legitimately appends end-seed; the original
  // artifact's own events and metadata still re-encode without losing facts.
  expect(encodeArtifactHeader(decoded.metadata) + encodeArtifactEvents(decoded.events)).toBe(encoded)
  return restored
}

describe('nullable Responses namespaces do not downgrade native replay', () => {
  it.each([undefined, 'codex-0.162.1'] as const)('preserves original provider facts but applies typed None semantics only in the pinned projection (%s)', async (wireProfile) => {
    const originalReasoning = { ...reasoning, id: 'rs_fixture' }
    const originalText = { ...text, id: 'msg_fixture', phase: null, summary: [], content: [{
      type: 'output_text', text: text.content[0]!.text, annotations: [{ type: 'url_citation', start_index: 0,
        end_index: 9, url: 'https://example.invalid/annotation', title: 'Synthetic citation' }],
    }] }
    const originalCall = { ...call, id: 'fc_fixture', caller: null }
    const original = [originalReasoning, originalText, originalCall]
    const server = await mockServer([{ events: script(original) }, { events: script([final]) }])
    const { ctx, degraded } = await harness(server.url)
    try {
      const first = request()
      first.codexfulResponses = wireProfile === undefined ? undefined
        : { omitDefaultMaxTokens: true, reasoningSummary: 'none', strictModelInput: true, wireProfile }
      const result = await assemble(ctx, first)
      expect(result.message).toHaveProperty('source.replayState.response.hostedResponses.output', original)
      const restored = restore(result.message)
      await assemble(ctx, { ...first, messages: [...deriveProductMessages(restored), createToolResultMessage({
        callId: ToolCallId(`${call.call_id}|${originalCall.id}`), content: [{ type: 'text', text: 'actual fixture result' }],
      })] })
      const input = (server.requests[1] as { input: Record<string, unknown>[] }).input.slice(1, 4)
      if (wireProfile === undefined) expect(input).toEqual(original)
      else expect(input).toEqual([
        { type: 'reasoning', id: originalReasoning.id, summary: [], content: reasoning.content, encrypted_content: null },
        { type: 'message', id: originalText.id, role: 'assistant', content: text.content },
        { type: 'function_call', id: originalCall.id, call_id: call.call_id, name: call.name, arguments: call.arguments },
      ])
      expect(result.message).toHaveProperty('source.replayState.response.hostedResponses.output', original)
      expect(degraded).not.toHaveBeenCalled()
    } finally { await ctx.fiber.dispose() }
  })

  it.each([true, false])('keeps reasoning and native call identity across durable replay (hosted=%s)', async (hosted) => {
    const server = await mockServer([{ events: script([reasoning, text, call]) }, { events: script([final]) }])
    const { ctx, degraded } = await harness(server.url, hosted)
    try {
      const first = request()
      const result = await assemble(ctx, first)
      if (result.message.role !== 'assistant') throw new Error('expected assistant')
      const tool = result.message.content.find(block => block.type === 'tool-call')
      expect(tool).toMatchObject({ name: 'exec_command', id: `${call.call_id}|${call.id}`, arguments: call.arguments })
      expect(tool?.namespace).toBeUndefined()
      expect(result.message.content[0]).toEqual({ type: 'reasoning', text: reasoning.content[0]!.text })
      const native = toPiAssistant(result.message, degraded)
      expect(native.api).toBe('openai-responses')
      expect(degraded).not.toHaveBeenCalled()
      const restored = restore(result.message)
      await assemble(ctx, { ...first, messages: [...deriveProductMessages(restored), createToolResultMessage({
        callId: ToolCallId(`${call.call_id}|${call.id}`), content: [{ type: 'text', text: 'actual fixture result' }],
      })] })
      const input = (server.requests[1] as { input: Record<string, unknown>[] }).input
      expect(input.find(item => item['type'] === 'reasoning')).toEqual({ type: 'reasoning', summary: [],
        content: reasoning.content, encrypted_content: null })
      expect(input.find(item => item['type'] === 'function_call')?.['call_id']).toBe(call.call_id)
      expect(input.find(item => item['type'] === 'function_call')?.['arguments']).toBe(call.arguments)
      expect(input.find(item => item['type'] === 'function_call_output')?.['call_id']).toBe(call.call_id)
      expect(degraded).not.toHaveBeenCalled()
    } finally { await ctx.fiber.dispose() }
  })

  it('retains non-null phase, namespace and caller facts in the pinned typed projection', async () => {
    const originalText = { ...text, id: 'msg_phase', phase: 'commentary', summary: [] }
    const originalCall = { ...call, id: 'fc_namespace', namespace: 'functions', caller: { type: 'direct' } }
    const server = await mockServer([{ events: script([originalText, originalCall]) }, { events: script([final]) }])
    const { ctx, degraded } = await harness(server.url)
    try {
      const first = request()
      const result = await assemble(ctx, first)
      const restored = restore(result.message)
      await assemble(ctx, { ...first, messages: [...deriveProductMessages(restored), createToolResultMessage({
        callId: ToolCallId(`${call.call_id}|${originalCall.id}`), content: [{ type: 'text', text: 'actual fixture result' }],
      })] })
      const input = (server.requests[1] as { input: Record<string, unknown>[] }).input
      expect(input.find(item => item['type'] === 'message' && item['role'] === 'assistant'))
        .toMatchObject({ phase: 'commentary', content: text.content })
      expect(input.find(item => item['type'] === 'function_call')).toMatchObject({
        namespace: 'functions', caller: { type: 'direct' }, call_id: call.call_id, arguments: call.arguments,
      })
      expect(degraded).not.toHaveBeenCalled()
    } finally { await ctx.fiber.dispose() }
  })

  it.each([true, false])('dispatches the real decoded name to an owned handler (stream tools=%s)', async (eager) => {
    const server = await mockServer([{ events: script([reasoning, text, call]) }, { events: script([final]) }])
    const ctx = new Context()
    try {
      await mountAgentLoopTestDependencies(ctx, { systemPrompt: { includeHarnessIdentity: false } })
      await ctx.plugin(CodexyRuntime, { agents: [] })
      const profiles = profile(server.url, true)
      ctx.codexyRequests.registerAdapter(['local'], new PiAiAdapter({ profiles: () => profiles,
        resolveApiKey: () => Promise.resolve('fixture-key'), auth: memoryAuth() }))
      const handler = vi.fn(async (_args: Record<string, unknown>) => 'owned handler ran; no shell was launched')
      ctx.codexyTools.register({ name: 'exec_command', description: 'Owned test handler.',
        parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] }, execute: handler,
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] } })
      const agent = await ctx.agentLoop.create(SessionId(`nullable-namespace-handler-${eager}`), { provider: 'local', model: 'fixture' })
      if (eager) ctx.agentLoop.enableCodexStreamingTools(agent)
      agent.followup(user())
      await agent.whenIdle()
      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler.mock.calls[0]?.[0]).toEqual(JSON.parse(call.arguments))
      expect(snapshotProductEvents(agent.session).findLast(row => row.type === 'turn/end'))
        .toMatchObject({ data: { reason: { kind: 'completed' } } })
      expect((server.requests[1] as { input: Record<string, unknown>[] }).input
        .find(item => item['type'] === 'function_call_output')?.['call_id']).toBe(call.call_id)
    } finally { await ctx.fiber.dispose() }
  })

  const cassettePath = process.env.CODEXY_RESPONSES_CASSETTE
  it('replays the retained actual tx0 SSE bytes through the SDK and compares its next typed input to native Codex', {
    skip: cassettePath === undefined,
  }, async () => {
    if (cassettePath === undefined) throw new Error('explicit retained cassette path required')
    interface Row { type: string; id?: number; data?: string; request?: { body: string } }
    const rows = (await readFile(cassettePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Row)
    const raw = Buffer.concat(rows.filter(row => row.type === 'chunk' && row.id === 0).map(row => Buffer.from(row.data!, 'base64')))
    const baseline = JSON.parse(Buffer.from(rows.find(row => row.type === 'request' && row.id === 1)!.request!.body, 'base64').toString()) as {
      input: Record<string, unknown>[]
    }
    const server = await mockServer([{ body: raw.toString(), headers: { 'content-type': 'text/event-stream' } }, { events: script([final]) }])
    const { ctx, degraded } = await harness(server.url)
    try {
      const first = request()
      const result = await assemble(ctx, first)
      if (result.message.role !== 'assistant') throw new Error('expected actual assistant')
      const tool = result.message.content.find(block => block.type === 'tool-call')
      if (tool?.type !== 'tool-call') throw new Error('missing actual tool call')
      expect(tool.name).toBe('exec_command')
      expect(tool.namespace).toBeUndefined()
      expect(tool.arguments).toBe(baseline.input[6]!['arguments'])
      expect(toPiAssistant(result.message, degraded).api).toBe('openai-responses')
      const restored = restore(result.message)
      await assemble(ctx, { ...first, messages: [...deriveProductMessages(restored), createToolResultMessage({
        callId: tool.id, content: [{ type: 'text', text: 'owned fixture result, not baseline tool output' }],
      })] })
      const input = (server.requests[1] as { input: Record<string, unknown>[] }).input
      expect(input.slice(1, 4).map(item => Object.keys(item).sort()))
        .toEqual(baseline.input.slice(4, 7).map(item => Object.keys(item).sort()))
      // A boolean assertion avoids dumping a long actual provider reasoning
      // transcript if a field differs; equality still includes its exact text.
      expect(deepEqualJson(input.slice(1, 4), baseline.input.slice(4, 7))).toBe(true)
      expect(input.find(item => item['type'] === 'function_call_output')?.['call_id']).toBe(baseline.input[6]!['call_id'])
      expect(degraded).not.toHaveBeenCalled()
    } finally { await ctx.fiber.dispose() }
  })
})
