/** Real pi SDK serialization against a synthetic, credential-free loopback provider. */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { RequestProviders } from '@codexydsh/bridges'
import LlmRuntime, { createDeveloperMessage, createSystemMessage, createUserMessage } from '@codexydsh/runtime/llm'
import type { GenerateOptions } from '@codexydsh/runtime/llm'
import { Session, SessionId, SessionLogOffset, appendProductEvent, deriveProductMessages, requestHeaderOf } from '@codexydsh/runtime/session'
import { decodeCodexyArtifact, encodeArtifactEvents, encodeArtifactHeader } from '../../runtime/src/persistence-codec.ts'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { responseItemIdBase } from '../src/response-item-id.ts'
import { memoryAuth } from './auth-double.ts'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer } from './mock-server.ts'

afterEach(closeMockServers)

const syntheticResponse = {
  id: 'resp_fixture', status: 'completed',
  output: [{ type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'fixture response' }] }],
  usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
}
const events = [
  JSON.stringify({ type: 'response.created', response: { ...syntheticResponse, status: 'in_progress', output: [] } }),
  JSON.stringify({ type: 'response.output_item.added', output_index: 0,
    item: { ...syntheticResponse.output[0], status: 'in_progress', content: [] } }),
  JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: syntheticResponse.output[0] }),
  JSON.stringify({ type: 'response.completed', response: syntheticResponse }),
]

/** Mount the product provider seam without reading ambient keys or accounts. */
async function harness(baseURL: string, lite = false, cacheRetention?: 'none', hosted = false): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(RequestProviders)
  const profiles = resolveProfiles({ local: {
    api: 'openai-responses', transport: 'sse', baseURL,
    ...hosted ? { backendHostedTools: ['web_search'] as const } : {},
    ...cacheRetention === undefined ? {} : { cacheRetention },
    ...lite ? { codexResponsesLite: 'flat' as const } : {},
    models: [{ id: lite ? 'gpt-6-sol' : 'qwen3.8-27b-w8a8', contextWindow: 32_768, maxTokens: 2048,
      ...lite ? { reasoningEfforts: { high: 'high' as const } } : {} }],
  } })
  ctx.codexyRequests.registerAdapter(['local'], new PiAiAdapter({
    profiles: () => profiles, resolveApiKey: () => Promise.resolve('fixture-key'), auth: memoryAuth(),
  }))
  return ctx
}

describe('explicit Codex 0.162.1 wire profile', () => {
  it('orders actual SDK function, namespace and hosted declarations only in the selected wire profile', async () => {
    const server = await mockServer([{ events }, { events }])
    const ctx = await harness(server.url, false, undefined, true)
    try {
      const fn = (name: string) => ({ name, description: `original ${name}`, parameters: { type: 'object' as const, properties: {} } })
      const tools = [fn('get_goal'), fn('create_goal'), fn('update_goal'), fn('view_image'), fn('write_stdin'),
        ...['spawn_agent', 'send_input', 'resume_agent', 'wait_agent', 'close_agent'].map(name => ({
          ...fn(`multi_agent_v1__${name}`), namespace: { name: 'multi_agent_v1', toolName: name, description: 'original namespace' },
        })), fn('exec_command'), fn('request_user_input')]
      for (const wireProfile of [undefined, 'codex-0.162.1'] as const) expect((await assemble(ctx, {
        provider: 'local', model: 'qwen3.8-27b-w8a8', messages: [createSystemMessage('BASE')], tools,
        codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none',
          ...wireProfile === undefined ? {} : { wireProfile } },
      })).finish).toEqual({ kind: 'stop' })
      const original = server.requests[0]?.['tools'] as Record<string, unknown>[]
      const native = server.requests[1]?.['tools'] as Record<string, unknown>[]
      expect(native.map(tool => tool['name'] ?? tool['type'])).toEqual([
        'exec_command', 'write_stdin', 'request_user_input', 'view_image', 'multi_agent_v1',
        'get_goal', 'create_goal', 'update_goal', 'web_search',
      ])
      expect(original.map(tool => tool['name'] ?? tool['type'])).not.toEqual(native.map(tool => tool['name'] ?? tool['type']))
      expect(native).toHaveLength(original.length)
      for (const tool of native) if (tool['type'] !== 'namespace') expect(original).toContainEqual(tool)
      const namespace = native.find(tool => tool['type'] === 'namespace')!
      expect((namespace['tools'] as { name: string }[]).map(tool => tool.name)).toEqual([
        'close_agent', 'resume_agent', 'send_input', 'spawn_agent', 'wait_agent',
      ])
      expect(native.at(-1)).toEqual({ type: 'web_search' })
      expect(tools.map(tool => tool.name)).toEqual([
        'get_goal', 'create_goal', 'update_goal', 'view_image', 'write_stdin',
        'multi_agent_v1__spawn_agent', 'multi_agent_v1__send_input', 'multi_agent_v1__resume_agent',
        'multi_agent_v1__wait_agent', 'multi_agent_v1__close_agent', 'exec_command', 'request_user_input',
      ])
    } finally { await ctx.fiber.dispose() }
  })

  it.each([undefined, 'codex-0.162.1'] as const)('keeps cache identity and captured session aliases stable across retry and compaction with profile=%s', async (wireProfile) => {
    const server = await mockServer([{ events }, { events }, { events }])
    const ctx = await harness(server.url)
    try {
      const uuid = '12345678-1234-1234-1234-123456789abc'
      const sessionId = SessionId(`coding-session-${uuid}`)
      const clientMetadata = Object.freeze({ session_id: sessionId, thread_id: sessionId, request_kind: 'turn' })
      const request: GenerateOptions = {
        provider: 'local', model: 'qwen3.8-27b-w8a8', sessionId,
        messages: [createSystemMessage('BASE'), createUserMessage({
          content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' },
        })],
        codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none', clientMetadata,
          ...wireProfile === undefined ? {} : { wireProfile } },
      }
      await assemble(ctx, request)
      await assemble(ctx, request)
      await assemble(ctx, { ...request, purpose: 'compaction', codexfulResponses: {
        ...request.codexfulResponses!, clientMetadata: Object.freeze({ ...clientMetadata, request_kind: 'compaction' }),
      } })
      for (const body of server.requests) {
        expect(body).toHaveProperty('prompt_cache_key', wireProfile === undefined ? uuid : sessionId)
        if (wireProfile === undefined) expect(body).not.toHaveProperty('client_metadata')
        else expect(body).toMatchObject({ client_metadata: { session_id: sessionId, thread_id: sessionId } })
      }
      expect(server.requests[1]).toEqual(server.requests[0])
      expect(request.codexfulResponses?.clientMetadata).toBe(clientMetadata)
      expect(clientMetadata).toEqual({ session_id: sessionId, thread_id: sessionId, request_kind: 'turn' })
    } finally { await ctx.fiber.dispose() }
  })

  it.each([undefined, Object.freeze({ thread_id: 'known-thread-only' })])('leaves existing cache behavior unchanged without a captured session identity (%j)', async (clientMetadata) => {
    const server = await mockServer([{ events }])
    const ctx = await harness(server.url)
    try {
      const uuid = '12345678-1234-1234-1234-123456789abc'
      await assemble(ctx, {
        provider: 'local', model: 'qwen3.8-27b-w8a8', sessionId: SessionId(`coding-session-${uuid}`),
        messages: [createSystemMessage('BASE')],
        codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none', wireProfile: 'codex-0.162.1',
          ...clientMetadata === undefined ? {} : { clientMetadata } },
      })
      expect(server.requests[0]).toHaveProperty('prompt_cache_key', uuid)
    } finally { await ctx.fiber.dispose() }
  })

  it('does not re-enable an explicitly disabled cache from captured session metadata', async () => {
    const server = await mockServer([{ events }])
    const ctx = await harness(server.url, false, 'none')
    try {
      const sessionId = SessionId('cache-disabled-session')
      await assemble(ctx, {
        provider: 'local', model: 'qwen3.8-27b-w8a8', sessionId, messages: [createSystemMessage('BASE')],
        codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none', wireProfile: 'codex-0.162.1',
          clientMetadata: { session_id: sessionId } },
      })
      expect(server.requests[0]).not.toHaveProperty('prompt_cache_key')
      expect(server.requests[0]).toHaveProperty('client_metadata.session_id', sessionId)
    } finally { await ctx.fiber.dispose() }
  })

  it.each([undefined, 'codex-0.162.1'] as const)('only projects captured client metadata when profile=%s without changing normal metadata', async (wireProfile) => {
    const server = await mockServer([{ events }, { events }])
    const ctx = await harness(server.url)
    try {
      const clientMetadata = Object.freeze({ installation_id: 'product-installation', session_id: 'product-session',
        turn_id: 'product-turn', request_kind: 'turn', analytics_enabled: 'false' })
      const request: GenerateOptions = { provider: 'local', model: 'qwen3.8-27b-w8a8',
        messages: [createSystemMessage('BASE')],
        codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none', clientMetadata,
          ...wireProfile === undefined ? {} : { wireProfile } },
      }
      await assemble(ctx, request)
      await assemble(ctx, request)
      for (const body of server.requests) {
        if (wireProfile === undefined) expect(body).not.toHaveProperty('client_metadata')
        else expect(body).toHaveProperty('client_metadata', clientMetadata)
        expect(body).not.toHaveProperty('metadata', clientMetadata)
      }
      expect(server.requests[1]).toEqual(server.requests[0])
      expect(request.codexfulResponses?.clientMetadata).toBe(clientMetadata)
      expect(clientMetadata).toEqual({ installation_id: 'product-installation', session_id: 'product-session',
        turn_id: 'product-turn', request_kind: 'turn', analytics_enabled: 'false' })
    } finally { await ctx.fiber.dispose() }
  })

  it.each([undefined, 'codex-0.162.1'] as const)('preserves durable base text and id across retry and compaction with profile=%s', async (wireProfile) => {
    const server = await mockServer([{ events }, { events }, { events }])
    const ctx = await harness(server.url)
    try {
      const base = createSystemMessage('BASE\nexact text')
      const permissions = createDeveloperMessage({ content: [{ type: 'text', text: 'PERMISSIONS' }],
        source: { kind: 'model', provider: 'local', model: 'qwen3.8-27b-w8a8' } })
      const user = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
      const request: GenerateOptions = {
        provider: 'local', model: 'qwen3.8-27b-w8a8', messages: [base, permissions, user],
        codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none', strictModelInput: true,
          ...wireProfile === undefined ? {} : { wireProfile } },
      }
      expect((await assemble(ctx, request)).finish.kind).toBe('stop')
      // A retry serializes the same captured durable history, not a fresh base ID.
      expect((await assemble(ctx, request)).finish.kind).toBe('stop')
      expect((await assemble(ctx, { ...request, purpose: 'compaction', messages: [...request.messages,
        { role: 'user', content: [{ type: 'text', text: 'Summarize this conversation.' }] }],
      })).finish.kind).toBe('stop')
      const history = [
        { type: 'message', role: 'developer', id: `msg_${responseItemIdBase(permissions.id)}`,
          content: [{ type: 'input_text', text: 'PERMISSIONS' }] },
        { type: 'message', role: 'user', id: `msg_${responseItemIdBase(user.id)}`,
          content: [{ type: 'input_text', text: 'hello' }] },
      ]
      for (const [index, body] of server.requests.entries()) {
        const expectedHistory = index === 2 ? [...history,
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Summarize this conversation.' }] },
        ] : history
        if (wireProfile === undefined) {
          expect(body).toHaveProperty('instructions', 'BASE\nexact text')
          expect(body).toMatchObject({ input: expectedHistory })
        } else {
          expect(body).not.toHaveProperty('instructions')
          expect(body).toMatchObject({ input: [{ type: 'message', role: 'developer',
            id: `msg_${responseItemIdBase(base.id)}`, content: [{ type: 'input_text', text: 'BASE\nexact text' }] }, ...expectedHistory] })
        }
      }
      expect(server.requests[1]).toEqual(server.requests[0])
      expect(server.requests[2]).toHaveProperty('parallel_tool_calls', false)
      const finalIndex = wireProfile === undefined ? 2 : 3
      expect(server.requests[2]).toHaveProperty(`input.${finalIndex}.content`, [{ type: 'input_text', text: 'Summarize this conversation.' }])
      expect(server.requests[2]).not.toHaveProperty(`input.${finalIndex}.id`)
      expect(base.role).toBe('system')
      expect(request.messages[0]).toBe(base)
    } finally { await ctx.fiber.dispose() }
  })

  it('preserves the durable base text block boundaries instead of flattening them into instructions', async () => {
    const server = await mockServer([{ events }])
    const ctx = await harness(server.url)
    try {
      const base = { ...createSystemMessage(''), content: [
        { type: 'text' as const, text: 'FIRST\n' }, { type: 'text' as const, text: '\nSECOND' },
      ] }
      await assemble(ctx, {
        provider: 'local', model: 'qwen3.8-27b-w8a8', messages: [base],
        codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none', wireProfile: 'codex-0.162.1' },
      })
      expect(server.requests[0]).toHaveProperty('input.0', { type: 'message', role: 'developer',
        id: `msg_${responseItemIdBase(base.id)}`, content: [
          { type: 'input_text', text: 'FIRST\n' }, { type: 'input_text', text: '\nSECOND' },
        ] })
    } finally { await ctx.fiber.dispose() }
  })

  it('does not invent a durable id for an explicit one-shot system override', async () => {
    const server = await mockServer([{ events }])
    const ctx = await harness(server.url)
    try {
      await assemble(ctx, {
        provider: 'local', model: 'qwen3.8-27b-w8a8', system: 'ONE SHOT', messages: [],
        codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none', wireProfile: 'codex-0.162.1' },
      })
      expect(server.requests[0]).toHaveProperty('input.0', { type: 'message', role: 'developer',
        content: [{ type: 'input_text', text: 'ONE SHOT' }] })
      expect(server.requests[0]).not.toHaveProperty('instructions')
    } finally { await ctx.fiber.dispose() }
  })

  it('replays the same native developer base from a restored artifact without changing its original bytes or role', async () => {
    const server = await mockServer([{ events }, { events }])
    const ctx = await harness(server.url)
    try {
      const id = SessionId('wire-profile-restored')
      const header = { version: 4 as const, id, createdAt: 1000, isSeeded: false }
      const session = Session.create(id, undefined, header)
      session.append('turn/start', { turn: 1 })
      session.append('step/start', { turn: 1, step: 1 })
      const base = createSystemMessage('RESTORED BASE\nexact')
      session.append('system/message', { turn: 1, step: 1, message: base }, { surfaceOp: 'append' })
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      appendProductEvent(session, 'request/header', { reason: 'initial', header: { config: {
        provider: 'local', model: 'qwen3.8-27b-w8a8',
        codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none', wireProfile: 'codex-0.162.1',
          clientMetadata: { session_id: id, request_kind: 'turn', turn_started_at_unix_ms: '1000' } },
      } } })
      const metadata = { kind: 'codexy-session' as const, version: 1 as const, session: header, inheritedEventCount: SessionLogOffset(0) }
      const original = encodeArtifactHeader(metadata) + encodeArtifactEvents(session.snapshotEvents())
      const decoded = decodeCodexyArtifact(Buffer.from(original))
      const restored = Session.fromRestore(id, decoded.events, decoded.metadata.session, decoded.metadata.inheritedEventCount, 'detached')
      for (const source of [session, restored]) {
        const config = requestHeaderOf(source)?.config
        if (config === undefined) throw new Error('missing durable request header')
        await assemble(ctx, { ...config, sessionId: id, messages: deriveProductMessages(source) })
      }
      expect(server.requests[0]).not.toHaveProperty('instructions')
      expect(server.requests[0]).toHaveProperty('input.0', { type: 'message', role: 'developer',
        id: `msg_${responseItemIdBase(base.id)}`, content: [{ type: 'input_text', text: 'RESTORED BASE\nexact' }] })
      expect(server.requests[1]).toEqual(server.requests[0])
      expect(server.requests[1]).toHaveProperty('client_metadata', { session_id: id, request_kind: 'turn', turn_started_at_unix_ms: '1000' })
      expect(server.requests[1]).toHaveProperty('prompt_cache_key', id)
      expect(deriveProductMessages(restored)[0]).toEqual(base)
      expect(encodeArtifactHeader(metadata) + encodeArtifactEvents(session.snapshotEvents())).toBe(original)
      expect(encodeArtifactHeader(decoded.metadata) + encodeArtifactEvents(decoded.events)).toBe(original)
    } finally { await ctx.fiber.dispose() }
  })

  it('reuses the durable base in the existing Lite projection without duplicating it or rejecting the combination', async () => {
    const server = await mockServer([{ events }])
    const ctx = await harness(server.url, true)
    try {
      const base = createSystemMessage('LITE BASE')
      const request = { provider: 'local', model: 'gpt-6-sol', sessionId: 'fixture-session' as never,
        codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none' as const, wireProfile: 'codex-0.162.1' as const } }
      const prepared = await ctx.codexyRequests.prepareCall(request)
      expect(prepared.config.codexfulResponses).toMatchObject({ lite: true, wireProfile: 'codex-0.162.1' })
      await assemble(ctx, { ...request, codexfulResponses: prepared.config.codexfulResponses, messages: [base] })
      expect(server.requests[0]).not.toHaveProperty('instructions')
      expect(server.requests[0]).toMatchObject({ input: [
        { type: 'message', role: 'developer', id: `msg_${responseItemIdBase(base.id)}`,
          content: [{ type: 'input_text', text: 'LITE BASE' }] },
        { type: 'additional_tools', role: 'developer', tools: [] },
      ], reasoning: { context: 'all_turns' }, parallel_tool_calls: false })
      expect(server.requests[0]).toHaveProperty('input', expect.any(Array))
      expect((server.requests[0] as { input: unknown[] }).input).toHaveLength(2)
    } finally { await ctx.fiber.dispose() }
  })
})
