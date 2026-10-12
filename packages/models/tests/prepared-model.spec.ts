import { RequestProviders } from '@codexydsh/bridges'
/** Captured provider generations cover tool metadata and the later HTTP request. */
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import LlmRuntime, { createDeveloperMessage, createSystemMessage, createUserMessage, ReasoningEffortId } from '@codexydsh/runtime/llm'
import type { PreparedAdapterCall, StreamChunk, ToolSchema } from '@codexydsh/runtime/llm'
import { afterEach, describe, expect, it } from 'vitest'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'
import { closeMockServers, mockServer } from './mock-server.ts'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await closeMockServers()
})

const responseEvents = [
  '{"type":"response.created","response":{"id":"resp_done"}}',
  JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: {
    type: 'message', id: 'msg_done', role: 'assistant', content: [{ type: 'output_text', text: 'done' }],
  } }),
  JSON.stringify({ type: 'response.completed', response: {
    id: 'resp_done', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
  } }),
]

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('prepared pi-ai model generation', () => {
  it('derives model-specific defaults and developer capabilities within the snapshot held across HMR', async () => {
    const first = await mockServer([{ events: responseEvents }, { events: responseEvents }])
    const second = await mockServer([{ events: responseEvents }])
    const profilesFor = (next: boolean) => resolveProfiles({ local: {
      api: 'openai-responses', baseURL: next ? second.url : first.url,
      apiKeyEnv: next ? 'NEW_KEY' : 'OLD_KEY', headers: { 'x-generation': next ? 'new' : 'old' },
      models: [
        { id: 'current', contextWindow: 16_384, maxTokens: 512,
          reasoningEfforts: { low: 'low', high: 'high' } },
        { id: 'previous', contextWindow: next ? 32_768 : 65_536, maxTokens: next ? 222 : 111,
          reasoningEfforts: { low: 'low', high: 'high' }, compat: { supportsDeveloperRole: next } },
      ],
    } })
    let profiles = profilesFor(false)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const adapter = new class extends PiAiAdapter {
      override async prepareCall(provider: string, model: string): Promise<PreparedAdapterCall> {
        const captured = await super.prepareCall(provider, model)
        return { ...captured, withModel: async (id, signal) => {
          const derived = await captured.withModel!(id, signal)
          entered.resolve(undefined)
          await release.promise
          return derived
        } }
      }
    }({ profiles: () => profiles,
      resolveApiKey: (_provider, profile) => Promise.resolve(`key-for-${profile.apiKeyEnv}`), auth: memoryAuth(),
    })
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(RequestProviders)
    const registration = ctx.codexyRequests.registerAdapter(['local'], adapter)
    const current = await ctx.codexyRequests.prepareModel('local', 'current')
    const pending = current.withModel('previous')
    let previous: Awaited<typeof pending>
    try {
      await entered.promise
      profiles = profilesFor(true)
      registration()
      ctx.codexyRequests.registerAdapter(['local'], new PiAiAdapter({ profiles: () => profiles,
        resolveApiKey: (_provider, profile) => Promise.resolve(`key-for-${profile.apiKeyEnv}`), auth: memoryAuth(),
      }))
    } finally {
      release.resolve(undefined)
      previous = await pending
    }
    const controls = { provider: 'local', reasoningEffort: ReasoningEffortId('high') }
    const call = previous.prepareCall({ ...controls, model: 'previous' })
    expect(call.context?.contextWindow).toBe(65_536)
    expect(call.config.maxTokens).toBe(111)
    expect(call.developerHistory).toBeUndefined()
    const messages = [createUserMessage({ content: [{ type: 'text', text: 'permission fallback' }], source: { kind: 'user' } })]
    expect((await collect(call.stream({ ...call.config, messages }))).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    const developer = createDeveloperMessage({ content: [{ type: 'text', text: 'current permissions' }],
      source: { kind: 'system-prompt' },
    })
    const unsupported = previous.prepareCall({ ...controls, model: 'previous' })
    expect((await collect(unsupported.stream({ ...unsupported.config, messages: [developer] }))).at(-1))
      .toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'UNSUPPORTED_CONTENT' } } })
    const currentCall = current.prepareCall({ ...controls, model: 'current' })
    expect(currentCall.developerHistory).toBe('native')
    expect((await collect(currentCall.stream({ ...currentCall.config, messages: [developer, ...messages] }))).at(-1))
      .toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(first.requests).toHaveLength(2)
    expect(first.headers.map(headers => headers['x-generation'])).toEqual(['old', 'old'])
    expect(first.headers.map(headers => headers['authorization'])).toEqual(['Bearer key-for-OLD_KEY', 'Bearer key-for-OLD_KEY'])
    expect(first.requests[0]).toHaveProperty('model', 'previous')
    expect(first.requests[0]).toHaveProperty('max_output_tokens', 111)
    expect(first.requests[0]).toHaveProperty('reasoning.effort', 'high')
    expect(first.requests[1]).toHaveProperty('model', 'current')
    expect(first.requests[1]).toHaveProperty('input.0.role', 'developer')
    const next = await ctx.codexyRequests.prepareModel('local', 'previous')
    const nextCall = next.prepareCall({ ...controls, model: 'previous' })
    expect(nextCall.developerHistory).toBe('native')
    expect(nextCall.context?.contextWindow).toBe(32_768)
    const nextChunks: StreamChunk[] = []
    for await (const chunk of nextCall.stream({ ...nextCall.config, messages: [developer, ...messages] })) nextChunks.push(chunk)
    expect(nextChunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(second.requests).toHaveLength(1)
    expect(second.headers[0]?.['x-generation']).toBe('new')
    expect(second.requests[0]).toHaveProperty('max_output_tokens', 222)
    expect(second.requests[0]).toHaveProperty('input.0.role', 'developer')
  })

  it('keeps tool capabilities, defaults, and dispatch together when configuration changes before call preparation', async () => {
    const first = await mockServer([{ events: responseEvents }])
    const second = await mockServer([{ events: responseEvents }])
    const profilesFor = (next: boolean) => resolveProfiles({ local: {
      api: 'openai-responses', baseURL: next ? second.url : first.url,
      headers: { 'x-generation': next ? 'new' : 'old' },
      codexResponsesLite: next ? 'flat' : 'namespaced', reasoning: next ? 'high' : 'low',
      models: [
        { id: 'gpt-6-sol', showInPicker: true, multiAgentVersion: next ? 'v1' : 'v2',
          contextWindow: next ? 32_768 : 65_536, maxTokens: next ? 512 : 2048,
          reasoningEfforts: { low: 'low', high: 'high' } },
        { id: next ? 'new-model' : 'old-model', showInPicker: true,
          reasoningEfforts: next ? { high: 'high' } : { low: 'low', medium: 'medium' } },
      ],
    } })
    let profiles = profilesFor(false)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(RequestProviders)
    ctx.codexyRequests.registerAdapter(['local'], new PiAiAdapter({ profiles: () => profiles,
      resolveApiKey: () => Promise.resolve('test-key'), auth: memoryAuth(),
    }))
    const captured = await ctx.codexyRequests.prepareModel('local', 'gpt-6-sol')
    profiles = profilesFor(true)
    expect(captured.model.toolNamespaces).toBe('native')
    expect((await captured.listModels()).map(model => model.id)).toEqual(['gpt-6-sol', 'old-model'])
    expect((await captured.resolveModelInfo('old-model')).reasoning?.defaultEffort).toBe('low')
    await expect(captured.resolveModelInfo('new-model')).rejects.toHaveProperty('code', 'UNKNOWN_MODEL')

    const callConfig = { provider: 'local', model: 'gpt-6-sol',
      codexfulResponses: { omitDefaultMaxTokens: false, reasoningSummary: 'none' as const },
    }
    const call = captured.prepareCall(callConfig)
    expect(call.config.maxTokens).toBe(2048)
    expect(call.config.reasoningEffort).toBe('low')
    expect(call.context?.contextWindow).toBe(65_536)
    const tool: ToolSchema = { name: 'multi_agent_v1__spawn_agent', description: 'Spawn agent',
      parameters: { type: 'object' },
      namespace: { name: 'multi_agent_v1', description: 'Manage agents', toolName: 'spawn_agent' },
    }
    const request = {
      messages: [createSystemMessage('BASE')],
      sessionId: brandString<Branded<'SessionId'>>('coding-session-12345678-1234-1234-1234-123456789abc'),
    }
    const chunks: StreamChunk[] = []
    for await (const chunk of call.stream({ ...call.config, ...request, tools: [tool] })) chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(first.requests).toHaveLength(1)
    expect(second.requests).toHaveLength(0)
    expect(first.headers[0]?.['x-generation']).toBe('old')
    expect(first.requests[0]).toHaveProperty('reasoning.effort', 'low')
    expect(first.requests[0]).toHaveProperty('max_output_tokens', 2048)
    expect(first.requests[0]).toHaveProperty('input.0.tools.0.type', 'namespace')
    expect(first.requests[0]).toHaveProperty('input.0.tools.0.name', 'multi_agent_v1')

    const current = await ctx.codexyRequests.prepareModel('local', 'gpt-6-sol')
    expect(current.model.toolNamespaces).toBeUndefined()
    expect((await current.listModels()).map(model => model.id)).toEqual(['gpt-6-sol', 'new-model'])
    expect((await current.resolveModelInfo('new-model')).reasoning?.defaultEffort).toBe('high')
    const nextCall = current.prepareCall(callConfig)
    expect(nextCall.config.maxTokens).toBe(512)
    expect(nextCall.context?.contextWindow).toBe(32_768)
    const nextChunks: StreamChunk[] = []
    for await (const chunk of nextCall.stream({ ...nextCall.config, ...request,
      tools: [{ name: tool.name, description: tool.description, parameters: tool.parameters }],
    })) nextChunks.push(chunk)
    expect(nextChunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(first.requests).toHaveLength(1)
    expect(second.requests).toHaveLength(1)
    expect(second.headers[0]?.['x-generation']).toBe('new')
    expect(second.requests[0]).toHaveProperty('reasoning.effort', 'high')
    expect(second.requests[0]).toHaveProperty('max_output_tokens', 512)
    expect(second.requests[0]).toHaveProperty('input.0.tools.0.type', 'function')
    expect(second.requests[0]).toHaveProperty('input.0.tools.0.name', 'multi_agent_v1__spawn_agent')
  })
})
