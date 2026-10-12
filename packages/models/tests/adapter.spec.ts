import type {} from '@codexydsh/instructions'
import { RequestProviders } from '@codexydsh/bridges'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { AttachmentId, AttachmentStore, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  ImageRequestTarget,
  RequestImageAttachment,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import LlmRuntime, { createAssistantMessage, createDeveloperMessage, createSystemMessage, createToolResultMessage, createUserMessage, CONTEXT_WINDOW_EXCEEDED_CODE, LlmError, ReasoningEffortId, ToolCallId, userAgent } from '@codexydsh/runtime/llm'
import type { RequestMessage, ToolSchema } from '@codexydsh/runtime/llm'
import * as LlmPiAi from '@codexydsh/models'
import { PiAiAdapter } from '@codexydsh/models'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { DEFAULT_MAX_REQUEST_IMAGE_BYTES, resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'
import { groupStrictCodexfulInput } from '../src/strict-input.ts'

afterEach(async () => {
  vi.unstubAllEnvs()
  await closeMockServers()
})

const IMAGE_REF: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 1,
  width: 1,
  height: 1,
}
const HOST_IMAGE_PATH = '/host/.dsh/attachments/objects/aa/object'
const MODEL_IMAGE_PATH = '/model/.dsh/attachments/objects/aa/object'

class MappedFileSystem extends Service {
  constructor(ctx: Context) {
    super(ctx, 'fs')
  }

  processPathFromHostPath(hostPath: string): string | undefined {
    return hostPath === HOST_IMAGE_PATH ? MODEL_IMAGE_PATH : undefined
  }
}

async function harness(baseURL: string, overrides: Record<string, unknown> = {}): Promise<Context> {
  vi.stubEnv('PI_TEST_KEY', 'test-key')
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(RequestProviders)
  await ctx.plugin(LlmPiAi, {
    providers: { deepseek: { apiKeyEnv: 'PI_TEST_KEY', baseURL, ...overrides } },
  })
  return ctx
}

/** Direct adapter over the real profile resolver, with a fixed key per call. */
function adapterOf(
  providers: Record<string, LlmPiAi.PiAiProviderProfile>,
  apiKey: string | undefined = 'test-key',
): PiAiAdapter {
  return new PiAiAdapter({
    profiles: () => resolveProfiles(providers),
    resolveApiKey: () => Promise.resolve(apiKey),
    auth: memoryAuth(),
  })
}

beforeEach(() => {
  // Configuration carries only the reference; these mounts resolve it from
  // the environment, which is the whole credential plane without a seam.
  vi.stubEnv('PI_TEST_KEY', 'test-key')
})

describe('PiAiAdapter provider routing', () => {
  it.each([
    ['gpt-6-astra', 'low'],
    ['gpt-5.6-luna', 'medium'],
  ] as const)('sends Codexful %s reasoning effort %s in the Responses request', async (model, effort) => {
    const server = await mockServer([{ events: [
      '{"type":"response.created","response":{"id":"resp_1"}}',
      JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: {
        type: 'message', id: 'msg_1', role: 'assistant', content: [],
      } }),
      JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: {
        type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }],
      } }),
      JSON.stringify({ type: 'response.completed', response: {
        id: 'resp_1', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      } }),
    ] }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(RequestProviders)
    ctx.codexyRequests.registerAdapter(['local'], adapterOf({
      local: {
        api: 'openai-responses', baseURL: server.url,
        models: [{ id: model, contextWindow: 32_768, maxTokens: 2048,
          reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' } }],
      },
    }))
    const result = await assemble(ctx, {
      provider: 'local', model, messages: [], reasoningEffort: ReasoningEffortId(effort),
      codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none' },
    })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]).toMatchObject({ reasoning: { effort } })
  })

  it('types the idless Codexful compaction instruction and disables parallel tool calls', async () => {
    const server = await mockServer([{ events: [
      '{"type":"response.created","response":{"id":"resp_compact"}}',
      JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: {
        type: 'message', id: 'msg_summary', role: 'assistant', content: [{ type: 'output_text', text: 'summary' }],
      } }),
      JSON.stringify({ type: 'response.completed', response: {
        id: 'resp_compact', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      } }),
    ] }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(RequestProviders)
    ctx.codexyRequests.registerAdapter(['local'], adapterOf({
      local: { api: 'openai-responses', baseURL: server.url,
        models: [{ id: 'qwen3.8', contextWindow: 32_768, maxTokens: 2048 }] },
    }))
    const prior = createUserMessage({ content: [{ type: 'text', text: 'Run pwd.' }], source: { kind: 'user' } })
    const instruction: RequestMessage = { role: 'user', content: [{ type: 'text', text: 'Summarize this conversation.' }] }
    await assemble(ctx, {
      provider: 'local', model: 'qwen3.8', sessionId: 'compaction-session' as never,
      purpose: 'compaction',
      codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none' },
      messages: [createSystemMessage('BASE'), prior, instruction],
    })
    expect(server.requests[0]).toMatchObject({ input: [
      { type: 'message', role: 'user', id: `msg_${prior.id}`,
        content: [{ type: 'input_text', text: 'Run pwd.' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Summarize this conversation.' }] },
    ] })
    expect(server.requests[0]).not.toHaveProperty('input.1.id')
    expect(server.requests[0]).toHaveProperty('parallel_tool_calls', false)
  })

  it('keeps malformed Responses function arguments verbatim in output and the next request', async () => {
    const rawArguments = '{"cmd":'
    const server = await mockServer([{ events: [
      '{"type":"response.created","response":{"id":"resp_bad"}}',
      JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: {
        type: 'function_call', id: 'fc_bad', call_id: 'call_bad', name: 'exec_command', arguments: '', status: 'in_progress',
      } }),
      JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: {
        type: 'function_call', id: 'fc_bad', call_id: 'call_bad', name: 'exec_command', arguments: rawArguments, status: 'completed',
      } }),
      JSON.stringify({ type: 'response.completed', response: {
        id: 'resp_bad', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      } }),
    ] }, { events: [
      '{"type":"response.created","response":{"id":"resp_fixed"}}',
      JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: {
        type: 'message', id: 'msg_fixed', role: 'assistant', content: [{ type: 'output_text', text: 'fixed' }],
      } }),
      JSON.stringify({ type: 'response.completed', response: {
        id: 'resp_fixed', status: 'completed', output: [], usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
      } }),
    ] }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(RequestProviders)
    ctx.codexyRequests.registerAdapter(['local'], adapterOf({
      local: { api: 'openai-responses', baseURL: server.url, models: [{ id: 'qwen3.8', contextWindow: 32_768, maxTokens: 2048 }] },
    }))
    const request = { provider: 'local', model: 'qwen3.8',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'run command' }], source: { kind: 'user' } })],
      tools: [{ name: 'exec_command', description: 'Run a command', parameters: {
        type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'],
      } }],
    }
    const first = await assemble(ctx, request)
    const call = first.message.content.find(block => block.type === 'tool-call')
    if (call?.type !== 'tool-call') throw new Error('missing function call')
    expect(call.arguments).toBe(rawArguments)
    const error = createToolResultMessage({ callId: call.id, isError: true,
      content: [{ type: 'text', text: 'Error parsing function call' }],
    })
    await assemble(ctx, { ...request, messages: [...request.messages, first.message, error] })
    const secondRequest: unknown = server.requests[1]
    if (secondRequest === null || typeof secondRequest !== 'object') throw new Error('missing continuation request')
    const input: unknown = Reflect.get(secondRequest, 'input')
    if (!Array.isArray(input)) throw new Error('continuation request omitted input')
    const replayedCall: unknown = input.find((item: unknown) =>
      item !== null && typeof item === 'object' && Reflect.get(item, 'type') === 'function_call')
    expect(replayedCall).toMatchObject({ type: 'function_call', call_id: 'call_bad',
      name: 'exec_command', arguments: rawArguments,
    })
  })

  it('preserves Responses end_turn false as a same-turn continuation', async () => {
    const server = await mockServer([{ events: [
      '{"type":"response.created","response":{"id":"resp_commentary"}}',
      JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: {
        type: 'message', id: 'msg_commentary', role: 'assistant', phase: 'commentary',
        content: [{ type: 'output_text', text: 'working' }],
      } }),
      JSON.stringify({ type: 'response.completed', response: {
        id: 'resp_commentary', status: 'completed', end_turn: false, output: [],
        usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      } }),
    ] }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(RequestProviders)
    ctx.codexyRequests.registerAdapter(['local'], adapterOf({
      local: { api: 'openai-responses', baseURL: server.url, models: [{ id: 'qwen3.8', contextWindow: 32_768, maxTokens: 2048 }] },
    }))
    const first = await assemble(ctx, { provider: 'local', model: 'qwen3.8',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'solve task' }], source: { kind: 'user' } })],
    })
    expect(first.finish).toEqual({ kind: 'stop', endTurn: false })
    expect(first.message.content).toEqual([{ type: 'text', text: 'working' }])
  })

  it.each(['gpt-6-sol', 'gpt-5.6-luna'] as const)('logs route-selected Responses Lite for %s and keeps prefix items stable through a tool continuation', async (model) => {
    const toolEvents = [
      '{"type":"response.created","response":{"id":"resp_tool"}}',
      JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: {
        type: 'function_call', id: 'fc_stable', call_id: 'call_pwd', name: 'exec_command', arguments: '', status: 'in_progress',
      } }),
      JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: {
        type: 'function_call', id: 'fc_stable', call_id: 'call_pwd', name: 'exec_command', arguments: '{"cmd":"pwd"}', status: 'completed',
      } }),
      JSON.stringify({ type: 'response.completed', response: {
        id: 'resp_tool', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      } }),
    ]
    const doneEvents = [
      '{"type":"response.created","response":{"id":"resp_done"}}',
      JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: {
        type: 'message', id: 'msg_done', role: 'assistant', content: [],
      } }),
      JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: {
        type: 'message', id: 'msg_done', role: 'assistant', content: [{ type: 'output_text', text: 'done' }],
      } }),
      JSON.stringify({ type: 'response.completed', response: {
        id: 'resp_done', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      } }),
    ]
    const server = await mockServer([{ events: toolEvents }, { events: doneEvents }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(RequestProviders)
    ctx.codexyRequests.registerAdapter(['local'], adapterOf({
      local: {
        api: 'openai-responses', baseURL: server.url, codexResponsesLite: 'flat',
        models: [{ id: model, contextWindow: 32_768, maxTokens: 2048, reasoningEfforts: { low: 'low', high: 'high' } }],
      },
    }))
    const request = {
      provider: 'local', model, sessionId: 'coding-session-12345678-1234-1234-1234-123456789abc' as never,
      codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none' as const },
      tools: [{ name: 'exec_command', description: 'Run a command', parameters: {
        type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'],
      } }],
    }
    const prepared = await ctx.codexyRequests.prepareCall(request)
    expect(prepared.config.codexfulResponses).toEqual({
      omitDefaultMaxTokens: true, reasoningSummary: 'none', lite: true,
    })
    const liteMode = prepared.config.codexfulResponses
    if (liteMode === undefined) throw new Error('prepared call omitted Lite mode')
    const messages = [
      createSystemMessage('BASE'),
      createDeveloperMessage({
        content: [{ type: 'text', text: '<permissions>ask</permissions>' }],
        source: { kind: 'model', provider: 'local', model },
      }),
      createUserMessage({ content: [{ type: 'text', text: 'run pwd' }], source: { kind: 'user' } }),
    ]
    const first = await assemble(ctx, { ...request, codexfulResponses: liteMode, messages })
    const call = first.message.content.find(block => block.type === 'tool-call')
    if (call?.type !== 'tool-call') throw new Error('missing Lite tool call')
    const result = createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: '/work' }], isError: false })
    expect((await assemble(ctx, {
      ...request, codexfulResponses: liteMode,
      messages: [...messages, first.message, result],
    })).finish.kind).toBe('stop')

    for (const body of server.requests) {
      expect(body).not.toHaveProperty('instructions')
      expect(body).not.toHaveProperty('tools')
      expect(body).toMatchObject({
        parallel_tool_calls: false,
        reasoning: { context: 'all_turns' },
        include: ['reasoning.encrypted_content'],
      })
      expect(body).not.toHaveProperty('reasoning.summary')
    }
    expect(server.headers.map(headers => headers['x-openai-internal-codex-responses-lite'])).toEqual(['true', 'true'])
    expect(server.requests[0]).toMatchObject({ input: [
      { type: 'additional_tools', role: 'developer', tools: [{ type: 'function', name: 'exec_command', strict: false }] },
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'BASE' }],
        internal_chat_message_metadata_passthrough: { content_item_kinds: ['model.base_instructions'] } },
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions>ask</permissions>' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run pwd' }] },
    ] })
    expect(server.requests[0]).toHaveProperty('input.0.id', expect.stringMatching(/^at_[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/))
    expect(server.requests[0]).toHaveProperty('input.1.id', expect.stringMatching(/^msg_[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/))
    expect(server.requests[1]).toHaveProperty('input.0', (server.requests[0] as { input: unknown[] }).input[0])
    expect(server.requests[1]).toHaveProperty('input.1', (server.requests[0] as { input: unknown[] }).input[1])
    expect(server.requests[1]).toMatchObject({ input: [
      {}, {}, {}, {},
      { type: 'function_call', id: 'fc_stable', call_id: 'call_pwd', name: 'exec_command' },
      { type: 'function_call_output', id: `fco_${result.id}`, call_id: 'call_pwd', output: '/work' },
    ] })
    const { sessionId: _sessionId, ...withoutSession } = request
    expect((await assemble(ctx, {
      ...withoutSession, codexfulResponses: liteMode, messages,
    })).finish.kind).toBe('error')
    expect(server.requests).toHaveLength(2)
  })

  it('groups Lite tools by namespace on an opted-in route and rejects them on a flat route', async () => {
    const server = await mockServer([{ events: [
      '{"type":"response.created","response":{"id":"resp_namespaced"}}',
      JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: {
        type: 'message', id: 'msg_done', role: 'assistant', content: [{ type: 'output_text', text: 'done' }],
      } }),
      JSON.stringify({ type: 'response.completed', response: {
        id: 'resp_namespaced', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      } }),
    ] }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(RequestProviders)
    const model = { id: 'gpt-6-luna', contextWindow: 32_768, maxTokens: 2048, reasoningEfforts: { low: 'low' as const } }
    ctx.codexyRequests.registerAdapter(['grouped', 'flat'], adapterOf({
      grouped: { api: 'openai-responses', baseURL: server.url, codexResponsesLite: 'namespaced', models: [model] },
      flat: { api: 'openai-responses', baseURL: server.url, codexResponsesLite: 'flat', models: [model] },
    }))
    const namespace = { name: 'multi_agent_v1', description: 'Manage subagents', toolName: 'spawn_agent' }
    const tools: ToolSchema[] = [
      { name: 'exec_command', description: 'Run command', parameters: { type: 'object' } },
      { name: 'multi_agent_v1__spawn_agent', description: 'Spawn agent', parameters: { type: 'object' }, namespace },
      { name: 'multi_agent_v1__send_input', description: 'Send input', parameters: { type: 'object' },
        namespace: { ...namespace, toolName: 'send_input' } },
      { name: 'apply_patch', description: 'Apply patch', parameters: { type: 'object' } },
      { name: 'other__read', description: 'Read', parameters: { type: 'object' },
        namespace: { name: 'other', description: 'Other tools', toolName: 'read' } },
    ]
    const request = {
      model: 'gpt-6-luna', sessionId: 'coding-session-12345678-1234-1234-1234-123456789abc' as never,
      messages: [createSystemMessage('BASE')], tools,
      codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none' as const, lite: true as const },
    }
    expect((await assemble(ctx, { ...request, provider: 'grouped' })).finish.kind).toBe('stop')
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]).toMatchObject({ input: [{ type: 'additional_tools', tools: [
      { type: 'namespace', name: 'functions', description: '', tools: [
        { type: 'function', name: 'exec_command', strict: false },
        { type: 'function', name: 'apply_patch', strict: false },
      ] },
      { type: 'namespace', name: 'multi_agent_v1', description: 'Manage subagents', tools: [
        { type: 'function', name: 'spawn_agent', strict: false },
        { type: 'function', name: 'send_input', strict: false },
      ] },
      { type: 'namespace', name: 'other', description: 'Other tools', tools: [
        { type: 'function', name: 'read', strict: false },
      ] },
    ] }, {}] })
    expect((await assemble(ctx, { ...request, provider: 'flat' })).finish.kind).toBe('error')
    expect(server.requests).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('keeps flat tools beside a v1 namespace in ordinary Responses requests', async () => {
    const server = await mockServer([{ events: [
      '{"type":"response.created","response":{"id":"resp_namespace_ordinary"}}',
      JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: {
        type: 'function_call', id: 'fc_spawn', call_id: 'call_spawn', namespace: 'multi_agent_v1',
        name: 'spawn_agent', arguments: '', status: 'in_progress',
      } }),
      JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: {
        type: 'function_call', id: 'fc_spawn', call_id: 'call_spawn', namespace: 'multi_agent_v1',
        name: 'spawn_agent', arguments: '{"message":"review the code"}', status: 'completed',
      } }),
      JSON.stringify({ type: 'response.completed', response: {
        id: 'resp_namespace_ordinary', status: 'completed', output: [],
        usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      } }),
    ] }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(RequestProviders)
    ctx.codexyRequests.registerAdapter(['local'], adapterOf({ local: {
      api: 'openai-responses', baseURL: server.url,
      models: [{ id: 'test-27b', contextWindow: 32_768, maxTokens: 2048 }],
    } }))
    const tools: ToolSchema[] = [
      { name: 'exec_command', description: 'Run command', parameters: { type: 'object' } },
      { name: 'multi_agent_v1__spawn_agent', description: 'Spawn agent', parameters: { type: 'object' },
        namespace: { name: 'multi_agent_v1', description: 'Manage subagents', toolName: 'spawn_agent' } },
      { name: 'write_stdin', description: 'Write stdin', parameters: { type: 'object' } },
      { name: 'multi_agent_v1__send_input', description: 'Send input', parameters: { type: 'object' },
        namespace: { name: 'multi_agent_v1', description: 'Manage subagents', toolName: 'send_input' } },
    ]
    const result = await assemble(ctx, {
      provider: 'local', model: 'test-27b', messages: [createSystemMessage('BASE')], tools,
      codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none' },
    })
    expect(result.message.content).toContainEqual(expect.objectContaining({
      type: 'tool-call', namespace: 'multi_agent_v1', name: 'spawn_agent',
      arguments: '{"message":"review the code"}',
    }))
    expect(server.requests[0]).toMatchObject({ tools: [
      { type: 'function', name: 'exec_command' },
      { type: 'function', name: 'write_stdin' },
      { type: 'namespace', name: 'multi_agent_v1', description: 'Manage subagents', tools: [
        { type: 'function', name: 'spawn_agent' },
        { type: 'function', name: 'send_input' },
      ] },
    ] })
    await ctx.fiber.dispose()
  })

  it('keeps ordinary Responses for unlisted models and routes without Lite opt-in', async () => {
    const completion = '{"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}'
    const events = [
      '{"type":"response.created","response":{"id":"resp_1"}}',
      JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: {
        type: 'message', id: 'msg_done', role: 'assistant', content: [],
      } }),
      JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: {
        type: 'message', id: 'msg_done', role: 'assistant', content: [{ type: 'output_text', text: 'done' }],
      } }),
      completion,
    ]
    const server = await mockServer([{ events }, { events }, { events }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(RequestProviders)
    ctx.codexyRequests.registerAdapter(['local', 'plain'], adapterOf({
      local: { api: 'openai-responses', baseURL: server.url, codexResponsesLite: 'flat', models: [
        { id: 'qwen3.8', contextWindow: 32_768, maxTokens: 2048 },
        { id: 'gpt-5.5', contextWindow: 32_768, maxTokens: 2048 },
      ] },
      plain: { api: 'openai-responses', baseURL: server.url, models: [
        { id: 'gpt-6-sol', contextWindow: 32_768, maxTokens: 2048 },
      ] },
    }))
    for (const [provider, model] of [['local', 'qwen3.8'], ['plain', 'gpt-6-sol'], ['local', 'gpt-5.5']] as const) {
      const config = { provider, model, codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none' as const } }
      const prepared = await ctx.codexyRequests.prepareCall(config)
      expect(prepared.config.codexfulResponses).toEqual(config.codexfulResponses)
      expect((await assemble(ctx, { ...config, messages: [createSystemMessage('BASE')] })).finish.kind).toBe('stop')
    }
    expect((await ctx.codexyRequests.prepareCall({
      provider: 'local', model: 'gpt-5.5',
      codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none' },
    })).config.codexfulResponses?.lite).toBeUndefined()
    expect(server.requests).toHaveLength(3)
    for (const body of server.requests) {
      expect(body).toMatchObject({ instructions: 'BASE', parallel_tool_calls: true })
      expect(body).not.toHaveProperty('reasoning.context')
      expect(body).not.toHaveProperty('input.0.type', 'additional_tools')
    }
    expect(server.headers.every(headers => headers['x-openai-internal-codex-responses-lite'] === undefined)).toBe(true)
    await expect(ctx.codexyRequests.prepareCall({
      provider: 'local', model: 'qwen3.8',
      codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none', lite: true },
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
    expect((await assemble(ctx, {
      provider: 'local', model: 'qwen3.8', messages: [createSystemMessage('BASE')],
      codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none', lite: true },
    })).finish.kind).toBe('error')
    expect(server.requests).toHaveLength(3)
  })

  it('rejects a Lite declaration on a non-Responses provider route', () => {
    expect(() => resolveProfiles({ local: {
      api: 'openai-completions', baseURL: 'https://example.test/v1', codexResponsesLite: 'flat',
      models: [{ id: 'gpt-6-sol', contextWindow: 32_768, maxTokens: 2048 }],
    } })).toThrow('codexResponsesLite requires api "openai-responses"')
    expect(() => resolveProfiles({ local: {
      api: 'openai-completions', baseURL: 'https://example.test/v1', codexResponsesLite: 'namespaced',
      models: [{ id: 'gpt-6-sol', contextWindow: 32_768, maxTokens: 2048 }],
    } })).toThrow('codexResponsesLite requires api "openai-responses"')
  })

  it('sends durable developer history and base instructions with Codexful Responses roles', async () => {
    const eventsFor = (itemId: string) => [
      '{"type":"response.created","response":{"id":"resp_1"}}',
      JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: {
        type: 'message', id: itemId, role: 'assistant', content: [],
      } }),
      JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: {
        type: 'message', id: itemId, role: 'assistant', content: [{ type: 'output_text', text: 'hello' }],
      } }),
      JSON.stringify({ type: 'response.completed', response: {
        id: 'resp_1', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      } }),
    ]
    const server = await mockServer([
      { events: eventsFor('msg_stable') }, { events: eventsFor('barehex') }, { events: eventsFor('barehex') },
    ])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(RequestProviders)
    ctx.codexyRequests.registerAdapter(['local'], adapterOf({
      local: { api: 'openai-responses', baseURL: server.url, models: [{ id: 'qwen3.8', contextWindow: 32_768, maxTokens: 2048 }] },
    }))
    const messages = [
      createSystemMessage('BASE'),
      createDeveloperMessage({
        content: [
          { type: 'text', text: '<permissions instructions>read-only</permissions instructions>' },
          { type: 'text', text: 'Keep this developer fragment separate.' },
        ],
        source: { kind: 'model', provider: 'local', model: 'qwen3.8' },
      }),
      createUserMessage({ content: [{ type: 'text', text: 'solve this' }], source: { kind: 'user' } }),
    ]
    const config = {
      provider: 'local', model: 'qwen3.8',
      codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none' as const },
      tools: [{ name: 'exec_command', description: 'Run a command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } }],
    }
    const first = await assemble(ctx, { ...config, messages })
    expect(first.finish.kind).toBe('stop')
    const second = await assemble(ctx, { ...config, messages: [...messages, first.message] })
    expect(second.finish.kind).toBe('stop')
    expect((await assemble(ctx, { ...config, messages: [...messages, first.message, second.message] })).finish.kind).toBe('stop')

    for (const request of server.requests) {
      expect(request).toMatchObject({ instructions: 'BASE' })
      expect(request).toMatchObject({ tools: [{ type: 'function', name: 'exec_command', strict: false }] })
      if (request === null || typeof request !== 'object') throw new Error('Codexful Responses request is not an object')
      const tools: unknown = Reflect.get(request, 'tools')
      if (!Array.isArray(tools)) throw new Error('Codexful Responses request omitted tools')
      const firstTool: unknown = tools[0]
      if (firstTool === null || typeof firstTool !== 'object') throw new Error('Codexful Responses tool is not an object')
      expect(Object.keys(firstTool)).toEqual(['type', 'name', 'description', 'strict', 'parameters'])
      expect(request).not.toHaveProperty('input.0.role', 'system')
      expect(JSON.stringify(request)).not.toContain('__dsh_developer_')
    }
    expect(server.requests[0]).toMatchObject({ input: [
      { type: 'message', role: 'developer', id: `msg_${messages[1]?.id}`, content: [
        { type: 'input_text', text: '<permissions instructions>read-only</permissions instructions>' },
        { type: 'input_text', text: 'Keep this developer fragment separate.' },
      ] },
      { type: 'message', role: 'user', id: `msg_${messages[2]?.id}`, content: [{ type: 'input_text', text: 'solve this' }] },
    ] })
    expect(server.requests[1]).toMatchObject({ input: [
      { type: 'message', role: 'developer' }, { role: 'user' }, { role: 'assistant' },
    ] })
    expect(server.requests[1]).toHaveProperty('input.2.id', 'msg_stable')
    expect(server.requests[2]).toHaveProperty('input.2.id', 'msg_stable')
    expect(server.requests[2]).not.toHaveProperty('input.3.id')
    for (const request of server.requests) {
      expect(request).toHaveProperty('input.0.id', `msg_${messages[1]?.id}`)
      expect(request).toHaveProperty('input.1.id', `msg_${messages[2]?.id}`)
      expect(JSON.stringify(request)).not.toContain('__dshCodexfulResponseItemIdBase')
    }
  })

  it('groups separately logged developer context and permissions into one Codex Responses item', () => {
    const skillsText = '<skills_instructions>Use a skill.</skills_instructions>'
    const permissionText = '<permissions instructions>Read and write.</permissions instructions>'
    const skills = createDeveloperMessage({
      content: [{ type: 'text', text: skillsText }],
      source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'codexful:skills', text: skillsText }] },
    })
    const permissions = createDeveloperMessage({
      content: [{ type: 'text', text: permissionText }],
      source: {
        kind: 'runtime-context', form: 'snapshot',
        sections: [{ name: 'codexful:world-state:permissions', text: permissionText }],
        codexWorldState: { section: 'permissions', mode: 'full', snapshot: { instructions: permissionText, prefixes: [] } },
      },
    })
    const task = createUserMessage({ content: [{ type: 'text', text: 'Task.' }], source: { kind: 'user' } })
    const payload = { input: [
      { type: 'message', role: 'developer', id: `msg_${skills.id}`, content: [{ type: 'input_text', text: skillsText }] },
      { type: 'message', role: 'developer', id: `msg_${permissions.id}`, content: [{ type: 'input_text', text: permissionText }] },
      { type: 'message', role: 'user', id: `msg_${task.id}`, content: [{ type: 'input_text', text: 'Task.' }] },
    ] }
    expect(groupStrictCodexfulInput(payload, [skills, permissions, task])).toEqual({ input: [
      { type: 'message', role: 'developer', id: `msg_${skills.id}`, content: [
        { type: 'input_text', text: skillsText }, { type: 'input_text', text: permissionText },
      ] },
      payload.input[2],
    ] })
  })

  it('groups ordinary strict Responses fragments while keeping initial delegation role and mode separate', async () => {
    const events = [
      '{"type":"response.created","response":{"id":"resp_strict"}}',
      JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: {
        type: 'message', id: 'msg_strict', role: 'assistant', content: [],
      } }),
      JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: {
        type: 'message', id: 'msg_strict', role: 'assistant', content: [{ type: 'output_text', text: 'done' }],
      } }),
      JSON.stringify({ type: 'response.completed', response: {
        id: 'resp_strict', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      } }),
    ]
    const server = await mockServer([{ events }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(RequestProviders)
    ctx.codexyRequests.registerAdapter(['local'], adapterOf({
      local: { api: 'openai-responses', baseURL: server.url, models: [{ id: 'qwen3.8', contextWindow: 32_768, maxTokens: 2048 }] },
    }))
    const skillsText = '<skills_instructions>Use a skill.</skills_instructions>'
    const codingText = 'Keep coding changes focused.'
    const permissionText = '<permissions instructions>Read and write.</permissions instructions>'
    const skills = createDeveloperMessage({
      content: [{ type: 'text', text: skillsText }, { type: 'text', text: codingText }],
      source: { kind: 'runtime-context', form: 'snapshot', sections: [
        { name: 'codexful:skills', text: skillsText }, { name: 'codexful:coding', text: codingText },
      ] },
    })
    const permissions = createDeveloperMessage({
      content: [{ type: 'text', text: permissionText }],
      source: {
        kind: 'runtime-context', form: 'snapshot',
        sections: [{ name: 'codexful:world-state:permissions', text: permissionText }],
        codexWorldState: { section: 'permissions', mode: 'full', snapshot: { instructions: permissionText, prefixes: [] } },
      },
    })
    const roleText = 'You are the root agent in a team of agents.'
    const role = createDeveloperMessage({
      content: [{ type: 'text', text: roleText }],
      source: {
        kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'codexful-v2:multi-agent-role', text: roleText }],
        codexMultiAgentWorldState: { section: 'multi-agent-role', mode: 'full', snapshot: roleText },
      },
    })
    const modeText = '<multi_agent_mode>Proactive delegation is active.</multi_agent_mode>'
    const mode = createDeveloperMessage({
      content: [{ type: 'text', text: modeText }],
      source: {
        kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'codexful-v2:multi-agent-mode', text: modeText }],
        codexMultiAgentWorldState: { section: 'multi-agent-mode', mode: 'full', snapshot: { body: 'Proactive delegation is active.', role: 'You are the root agent.' } },
      },
    })
    const agentsText = '# AGENTS.md instructions\n\n<INSTRUCTIONS>Rule.</INSTRUCTIONS>'
    const environmentText = '<environment_context>\n  <cwd>/work</cwd>\n</environment_context>'
    const agents = createUserMessage({
      content: [{ type: 'text', text: agentsText }],
      source: { kind: 'agent-instructions', form: 'instructions', changes: [] },
    })
    const environment = createUserMessage({
      content: [{ type: 'text', text: environmentText }],
      source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'codexful:environment', text: environmentText }] },
    })
    const task = createUserMessage({ content: [{ type: 'text', text: 'Run pwd.' }], source: { kind: 'user' } })
    const assistant = createAssistantMessage({
      content: [{ type: 'text', text: 'Checking.' }],
      source: { provider: 'local', model: 'qwen3.8' },
    })
    expect((await assemble(ctx, {
      provider: 'local', model: 'qwen3.8',
      codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none', strictModelInput: true },
      messages: [
        createSystemMessage('BASE'),
        skills, permissions, role, mode,
        agents, environment, task, assistant,
      ],
    })).finish.kind).toBe('stop')
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]).toMatchObject({ input: [
      { type: 'message', role: 'developer', id: `msg_${skills.id}`, content: [
        { type: 'input_text', text: skillsText }, { type: 'input_text', text: codingText }, { type: 'input_text', text: permissionText },
      ] },
      { type: 'message', role: 'developer', id: `msg_${role.id}`, content: [{ type: 'input_text', text: roleText }] },
      { type: 'message', role: 'developer', id: `msg_${mode.id}`, content: [{ type: 'input_text', text: modeText }] },
      { type: 'message', role: 'user', id: `msg_${agents.id}`, content: [
        { type: 'input_text', text: agentsText },
        { type: 'input_text', text: environmentText },
      ] },
      { type: 'message', role: 'user', id: `msg_${task.id}`, content: [{ type: 'input_text', text: 'Run pwd.' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Checking.' }] },
    ] })
    const firstRequest: unknown = server.requests[0]
    if (firstRequest === null || typeof firstRequest !== 'object') throw new Error('Codexful strict Responses request is not an object')
    const input: unknown = Reflect.get(firstRequest, 'input')
    if (!Array.isArray(input)) throw new Error('Codexful strict Responses request omitted input')
    const firstInputItem: unknown = input[3]
    if (firstInputItem === null || typeof firstInputItem !== 'object') throw new Error('missing strict Responses input item')
    expect(Object.keys(firstInputItem)).toEqual(['type', 'id', 'role', 'content'])
    expect(JSON.stringify(input)).not.toContain(`msg_${environment.id}`)
    expect(JSON.stringify(input)).not.toContain(`msg_${permissions.id}`)
    expect(input[5]).toEqual({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Checking.' }] })
  })

  it('sends Codexful child tasks and completion notices as ordered Responses agent_message items', async () => {
    const server = await mockServer([{ events: [
      '{"type":"response.created","response":{"id":"resp_agent"}}',
      JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: {
        type: 'message', id: 'msg_agent', role: 'assistant', content: [],
      } }),
      JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: {
        type: 'message', id: 'msg_agent', role: 'assistant', content: [{ type: 'output_text', text: 'done' }],
      } }),
      JSON.stringify({ type: 'response.completed', response: {
        id: 'resp_agent', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      } }),
    ] }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(RequestProviders)
    ctx.codexyRequests.registerAdapter(['local'], adapterOf({
      local: { api: 'openai-responses', baseURL: server.url, models: [{ id: 'qwen3.8', contextWindow: 32_768, maxTokens: 2048 }] },
    }))
    const taskText = 'Message Type: NEW_TASK\nTask name: /root/worker\nSender: /root\nPayload:\nCheck the code.'
    const completionText = 'Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/worker\nPayload:\nDone.'
    const task = {
      ...createUserMessage({ content: [{ type: 'text', text: taskText }], source: { kind: 'user' } }),
      source: { kind: 'agent-message', form: 'relay', senderSessionId: 'parent' },
    } as RequestMessage
    const ordinary = {
      ...createUserMessage({ content: [{ type: 'text', text: 'Agent worker sent a message: older format' }], source: { kind: 'user' } }),
      source: { kind: 'agent-message', form: 'relay', senderSessionId: 'parent' },
    } as RequestMessage
    const completion = {
      ...createUserMessage({ content: [{ type: 'text', text: completionText }], source: { kind: 'user' } }),
      source: { kind: 'subagent-settled', form: 'notice', summary: 'Done', senderSessionId: 'child' },
    } as RequestMessage
    const plain = createUserMessage({ content: [{ type: 'text', text: 'Continue.' }], source: { kind: 'user' } })
    const result = await assemble(ctx, {
      provider: 'local', model: 'qwen3.8',
      codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none', strictModelInput: true },
      messages: [createSystemMessage('BASE'), task, ordinary, completion, plain],
    })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]).toMatchObject({ input: [
      { type: 'agent_message', author: '/root', recipient: '/root/worker', content: [{ type: 'input_text', text: taskText }] },
      { type: 'message', role: 'user', id: `msg_${ordinary.id}`, content: [{ type: 'input_text', text: 'Agent worker sent a message: older format' }] },
      { type: 'agent_message', author: '/root/worker', recipient: '/root', content: [{ type: 'input_text', text: completionText }] },
      { type: 'message', role: 'user', id: `msg_${plain.id}`, content: [{ type: 'input_text', text: 'Continue.' }] },
    ] })
    expect(server.requests[0]).not.toHaveProperty('input.0.id')
    expect(server.requests[0]).not.toHaveProperty('input.2.id')
  })

  it('omits pi-ai unset function-call item IDs when continuing after a tool result', async () => {
    const firstEvents = [
      '{"type":"response.created","response":{"id":"resp_tool"}}',
      JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: {
        type: 'function_call', id: 'barehex', call_id: 'call_pwd', name: 'exec_command', arguments: '', status: 'in_progress',
      } }),
      JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: {
        type: 'function_call', id: 'barehex', call_id: 'call_pwd', name: 'exec_command', arguments: '{"cmd":"pwd"}', status: 'completed',
      } }),
      JSON.stringify({ type: 'response.completed', response: {
        id: 'resp_tool', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      } }),
    ]
    const doneEvents = [
      '{"type":"response.created","response":{"id":"resp_done"}}',
      JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: {
        type: 'message', id: 'msg_done', role: 'assistant', content: [],
      } }),
      JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: {
        type: 'message', id: 'msg_done', role: 'assistant', content: [{ type: 'output_text', text: 'done' }],
      } }),
      JSON.stringify({ type: 'response.completed', response: {
        id: 'resp_done', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      } }),
    ]
    const server = await mockServer([{ events: firstEvents }, { events: doneEvents }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(RequestProviders)
    ctx.codexyRequests.registerAdapter(['local'], adapterOf({
      local: { api: 'openai-responses', baseURL: server.url, models: [{ id: 'qwen3.8', contextWindow: 32_768, maxTokens: 2048 }] },
    }))
    const config = { provider: 'local', model: 'qwen3.8', codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none' as const } }
    const messages = [
      createSystemMessage('BASE'),
      createUserMessage({ content: [{ type: 'text', text: 'run pwd' }], source: { kind: 'user' } }),
    ]
    const first = await assemble(ctx, { ...config, messages })
    const call = first.message.content.find(block => block.type === 'tool-call')
    if (call?.type !== 'tool-call') throw new Error('missing tool call from first Responses stream')
    const result = createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: '/work' }], isError: false })
    expect((await assemble(ctx, { ...config, messages: [...messages, first.message, result] })).finish.kind).toBe('stop')
    expect(server.requests).toHaveLength(2)
    expect(server.requests[1]).toMatchObject({ input: [
      { type: 'message', role: 'user', id: `msg_${messages[1]?.id}` },
      { type: 'function_call', call_id: 'call_pwd' },
      { type: 'function_call_output', id: `fco_${result.id}`, call_id: 'call_pwd', output: '/work' },
    ] })
    expect(server.requests[1]).not.toHaveProperty('input.1.id')
  })

  it('replays provider output without invented IDs or status in a Codexful tool continuation body', async () => {
    const server = await mockServer([{ events: [
      '{"type":"response.created","response":{"id":"resp_done"}}',
      JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: {
        type: 'message', id: 'msg_done', role: 'assistant', content: [],
      } }),
      JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: {
        type: 'message', id: 'msg_done', role: 'assistant', content: [{ type: 'output_text', text: 'done' }],
      } }),
      JSON.stringify({ type: 'response.completed', response: {
        id: 'resp_done', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      } }),
    ] }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(RequestProviders)
    ctx.codexyRequests.registerAdapter(['local'], adapterOf({
      local: { api: 'openai-responses', baseURL: server.url, models: [{ id: 'qwen3.8', contextWindow: 32_768, maxTokens: 2048 }] },
    }))
    const bareCall = ToolCallId('call_pwd')
    const signedCall = ToolCallId('call_ls|fc_signed')
    const replay = (blocks: unknown[]) => ({
      response: { kind: 'pi-ai', version: 2, api: 'openai-responses', provider: 'local', model: 'qwen3.8', stopReason: 'toolUse' },
      blocks,
    })
    const bareAssistant = createAssistantMessage({
      content: [
        { type: 'reasoning', text: 'first thought' },
        { type: 'reasoning', text: 'more thought' },
        { type: 'text', text: 'working' },
        { type: 'tool-call', id: bareCall, name: 'exec_command', arguments: '{"cmd":"pwd"}' },
      ],
      source: { provider: 'local', model: 'qwen3.8', replayState: replay([
        { type: 'reasoning', thinkingSignature: JSON.stringify({
          type: 'reasoning', summary: [], encrypted_content: 'opaque-first-thought', status: 'completed',
        }) },
        { type: 'reasoning', thinkingSignature: JSON.stringify({
          type: 'reasoning', id: 'barehex', summary: [], content: [{ type: 'reasoning_text', text: 'more thought' }],
          encrypted_content: null, status: 'completed',
        }) },
        { type: 'text' }, { type: 'tool-call' },
      ]) },
    })
    const signedAssistant = createAssistantMessage({
      content: [
        { type: 'reasoning', text: 'second thought' },
        { type: 'text', text: 'checking' },
        { type: 'tool-call', id: signedCall, name: 'exec_command', arguments: '{"cmd":"ls"}' },
      ],
      source: { provider: 'local', model: 'qwen3.8', replayState: replay([
        { type: 'reasoning', thinkingSignature: JSON.stringify({
          type: 'reasoning', id: 'rs_signed', summary: [], content: [{ type: 'text', text: 'second thought' }],
          encrypted_content: null, status: 'completed',
        }) },
        { type: 'text', textSignature: 'msg_signed' }, { type: 'tool-call' },
      ]) },
    })
    const bareResult = createToolResultMessage({ callId: bareCall, content: [{ type: 'text', text: '/work' }], isError: false })
    const signedResult = createToolResultMessage({ callId: signedCall, content: [{ type: 'text', text: 'file' }], isError: false })
    const messages = [
      createSystemMessage('BASE'),
      createUserMessage({ content: [{ type: 'text', text: 'inspect files' }], source: { kind: 'user' } }),
      bareAssistant, bareResult, signedAssistant, signedResult,
    ]
    const config = { provider: 'local', model: 'qwen3.8', codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none' as const } }
    expect((await assemble(ctx, { ...config, messages })).finish.kind).toBe('stop')
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]).toMatchObject({ input: [
      { type: 'message', role: 'user', id: `msg_${messages[1]?.id}` },
      { type: 'reasoning', summary: [], content: null, encrypted_content: 'opaque-first-thought' },
      { type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: 'more thought' }], encrypted_content: null },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'working', annotations: [] }] },
      { type: 'function_call', call_id: 'call_pwd', name: 'exec_command', arguments: '{"cmd":"pwd"}' },
      { type: 'function_call_output', id: `fco_${bareResult.id}`, call_id: 'call_pwd', output: '/work' },
      { type: 'reasoning', id: 'rs_signed' },
      { type: 'message', role: 'assistant', id: 'msg_signed' },
      { type: 'function_call', id: 'fc_signed', call_id: 'call_ls' },
      { type: 'function_call_output', id: `fco_${signedResult.id}`, call_id: 'call_ls', output: 'file' },
    ] })
    for (const index of [1, 2, 3, 4]) {
      expect(server.requests[0]).not.toHaveProperty(`input.${index}.id`)
    }
    expect(server.requests[0]).not.toHaveProperty('input.6.content')
    for (const index of [1, 2, 3, 4, 6, 7, 8]) {
      expect(server.requests[0]).not.toHaveProperty(`input.${index}.status`)
    }
  })

  it('omits provider-output fallback IDs across repeated requests and changed history length', async () => {
    const responseEvents = [
      '{"type":"response.created","response":{"id":"resp_done"}}',
      JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: {
        type: 'message', id: 'msg_done', role: 'assistant', content: [],
      } }),
      JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: {
        type: 'message', id: 'msg_done', role: 'assistant', content: [{ type: 'output_text', text: 'done' }],
      } }),
      JSON.stringify({ type: 'response.completed', response: {
        id: 'resp_done', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      } }),
    ]
    const server = await mockServer([{ events: responseEvents }, { events: responseEvents }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(RequestProviders)
    ctx.codexyRequests.registerAdapter(['local'], adapterOf({
      local: { api: 'openai-responses', baseURL: server.url, models: [{ id: 'qwen3.8', contextWindow: 32_768, maxTokens: 2048 }] },
    }))
    const user = createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } })
    const assistant = createAssistantMessage({
      content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }],
      source: { provider: 'local', model: 'qwen3.8' },
    })
    const extra = createUserMessage({ content: [{ type: 'text', text: 'later' }], source: { kind: 'user' } })
    const config = { provider: 'local', model: 'qwen3.8', codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none' as const } }
    expect((await assemble(ctx, { ...config, messages: [user, assistant] })).finish.kind).toBe('stop')
    expect((await assemble(ctx, { ...config, messages: [extra, user, assistant] })).finish.kind).toBe('stop')
    expect(server.requests[0]).toMatchObject({ input: [
      { role: 'user' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'one', annotations: [] }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'two', annotations: [] }] },
    ] })
    expect(server.requests[1]).toMatchObject({ input: [
      { role: 'user' }, { role: 'user' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'one', annotations: [] }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'two', annotations: [] }] },
    ] })
    for (const [requestIndex, itemIndexes] of [[0, [1, 2]], [1, [2, 3]]] as const) {
      for (const itemIndex of itemIndexes) expect(server.requests[requestIndex]).not.toHaveProperty(`input.${itemIndex}.id`)
    }
    expect(server.requests[0]).toHaveProperty('input.0.id', `msg_${user.id}`)
    expect(server.requests[1]).toHaveProperty('input.1.id', `msg_${user.id}`)
  })

  it('sends Codexful Responses fields only for the opted-in request', async () => {
    const completion = JSON.stringify({ type: 'response.completed', response: {
      id: 'resp_1', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
    } })
    const responseEvents = [
      '{"type":"response.created","response":{"id":"resp_1"}}',
      JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: {
        type: 'message', id: 'msg_1', role: 'assistant', content: [],
      } }),
      JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: {
        type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }],
      } }),
      completion,
    ]
    const server = await mockServer(Array.from({ length: 5 }, () => ({ events: responseEvents })))
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(RequestProviders)
    ctx.codexyRequests.registerAdapter(['local'], adapterOf({
      local: {
        api: 'openai-responses',
        baseURL: server.url,
        models: [{ id: 'qwen3.8', contextWindow: 32_768, maxTokens: 2048 }],
      },
    }))
    const uuid = '12345678-1234-1234-1234-123456789abc'
    const base = {
      provider: 'local', model: 'qwen3.8',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'task' }], source: { kind: 'user' } })],
      maxTokens: 2048,
      sessionId: `coding-session-${uuid}` as never,
    }
    expect((await assemble(ctx, {
      ...base,
      codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'auto' },
    })).finish.kind).toBe('stop')
    expect((await assemble(ctx, {
      ...base,
      codexfulResponses: { omitDefaultMaxTokens: false, reasoningSummary: 'auto' },
    })).finish.kind).toBe('stop')
    expect((await assemble(ctx, base)).finish.kind).toBe('stop')
    expect((await assemble(ctx, {
      ...base,
      sessionId: 'custom-session-key' as never,
      codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'auto' },
    })).finish.kind).toBe('stop')
    expect((await assemble(ctx, {
      ...base,
      codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none' },
    })).finish.kind).toBe('stop')

    expect(server.requests[0]).toMatchObject({
      tool_choice: 'auto',
      parallel_tool_calls: true,
      reasoning: { summary: 'auto' },
      include: ['reasoning.encrypted_content'],
    })
    expect(server.requests[0]).not.toHaveProperty('max_output_tokens')
    expect(server.requests[0]).toMatchObject({ prompt_cache_key: uuid })
    expect(server.requests[1]).toMatchObject({ max_output_tokens: 2048 })
    expect(server.requests[2]).toMatchObject({ max_output_tokens: 2048 })
    expect(server.requests[2]).not.toHaveProperty('parallel_tool_calls')
    expect(server.requests[2]).not.toHaveProperty('tool_choice')
    expect(server.requests[2]).toHaveProperty('input.0.role', 'user')
    expect(server.requests[2]).not.toHaveProperty('input.0.type')
    expect(server.requests[2]).not.toHaveProperty('input.0.id')
    expect(server.requests[2]).toMatchObject({ prompt_cache_key: `coding-session-${uuid}` })
    expect(server.requests[3]).toMatchObject({ prompt_cache_key: 'custom-session-key' })
    expect(server.requests[4]).toMatchObject({ reasoning: {}, include: ['reasoning.encrypted_content'] })
    expect(server.requests[4]).not.toHaveProperty('reasoning.summary')
  })

  it('leaves Chat Completions requests unchanged under Codexful', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(server.url)
    expect((await assemble(ctx, {
      model: 'deepseek-v4-flash', messages: [],
      codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'auto' },
    })).finish.kind).toBe('stop')
    expect(server.requests[0]).not.toHaveProperty('parallel_tool_calls')
    expect(server.requests[0]).not.toHaveProperty('include')
    expect(server.requests[0]).not.toHaveProperty('reasoning')
  })

  it('resolves a catalog model dynamically and uses a private endpoint', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, {
      model: 'deepseek-v4-flash',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      })],
    })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 1, totalTokens: 4 })
    expect(server.paths).toEqual(['/chat/completions'])
  })

  it('keeps prepared model metadata and dispatch on one profile snapshot', async () => {
    const first = await mockServer([{ events: textEvents }])
    const second = await mockServer([])
    let providers: Record<string, LlmPiAi.PiAiProviderProfile> = {
      deepseek: { apiKeyEnv: 'PI_TEST_KEY', baseURL: first.url },
    }
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(RequestProviders)
    ctx.codexyRequests.registerAdapter(['deepseek'], new PiAiAdapter({
      profiles: () => resolveProfiles(providers),
      resolveApiKey: () => Promise.resolve('test-key'),
      auth: memoryAuth(),
    }))

    const prepared = await ctx.codexyRequests.prepareCall({ provider: 'deepseek', model: 'deepseek-v4-flash' })
    providers = { deepseek: { apiKeyEnv: 'PI_TEST_KEY', baseURL: second.url } }
    const chunks: unknown[] = []
    for await (const chunk of prepared.stream({ ...prepared.config, messages: [] })) chunks.push(chunk)

    expect(chunks.length).toBeGreaterThan(0)
    expect(first.requests).toHaveLength(1)
    expect(second.requests).toHaveLength(0)
  })

  it('merges profile headers with Harness attribution winning', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(server.url, {
      headers: { 'x-company': 'private', 'User-Agent': 'wrong' },
    })
    await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })
    expect(server.headers[0]?.['x-company']).toBe('private')
    expect(server.headers[0]?.['user-agent']).toBe(userAgent())
  })

  it.each([
    ['Accept', 'User-Agent'],
    ['accept', 'user-agent'],
    ['aCcEpT', 'uSeR-aGeNt'],
  ] as const)('sends profile %s through the real Responses SDK with Harness %s winning for an unknown Qwen model', async (acceptHeader, userAgentHeader) => {
    const model = 'qwen3.8-27b-w8a8'
    const syntheticResponse = {
      id: 'resp_synthetic_qwen', object: 'response', status: 'completed',
      output: [{ type: 'message', id: 'msg_synthetic_qwen', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'synthetic hello', annotations: [] }] }],
      usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
    }
    const server = await mockServer([{ events: [
      JSON.stringify({ type: 'response.created', response: { ...syntheticResponse, status: 'in_progress', output: [] } }),
      JSON.stringify({ type: 'response.output_item.added', output_index: 0,
        item: { ...syntheticResponse.output[0], status: 'in_progress', content: [] } }),
      JSON.stringify({ type: 'response.output_text.delta', item_id: 'msg_synthetic_qwen', output_index: 0,
        content_index: 0, delta: 'synthetic hello' }),
      JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: syntheticResponse.output[0] }),
      JSON.stringify({ type: 'response.completed', response: syntheticResponse }),
    ] }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(RequestProviders)
    ctx.codexyRequests.registerAdapter(['local'], adapterOf({
      local: {
        api: 'openai-responses', baseURL: server.url, transport: 'sse',
        headers: { [acceptHeader]: 'text/event-stream', [userAgentHeader]: 'wrong-profile-agent' },
        models: [{ id: model, contextWindow: 32_768, maxTokens: 2048 }],
      },
    }))
    const result = await assemble(ctx, {
      provider: 'local', model,
      messages: [createUserMessage({ content: [{ type: 'text', text: 'Synthetic greeting only.' }], source: { kind: 'user' } })],
    })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.message.content).toEqual([{ type: 'text', text: 'synthetic hello' }])
    expect(server.paths).toEqual(['/responses'])
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]).toMatchObject({ model, stream: true })
    expect(server.headers[0]?.['accept']).toBe('text/event-stream')
    expect(server.headers[0]?.['user-agent']).toBe(userAgent())
  })

  it('forwards common stream options and profile reasoning', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(server.url, {
      reasoning: 'max',
      cacheRetention: 'none',
      transport: 'sse',
      timeoutMs: 5000,
      websocketConnectTimeoutMs: 3000,
      streamIdleTimeoutMs: 10_000,
      thinkingBudgets: { high: 2048 },
    })
    await assemble(ctx, {
      model: 'deepseek-v4-pro',
      messages: [],
      temperature: 0.2,
      maxTokens: 77,
      sessionId: 'session-for-pi' as never,
    })
    expect(server.requests[0]).toMatchObject({
      model: 'deepseek-v4-pro',
      temperature: 0.2,
      max_tokens: 77,
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    })
    expect(server.requests[0]).not.toHaveProperty('dsh_session_log')
    expect(server.requests[0]).not.toHaveProperty('dsh_plugin_packages')
  })

  it('uses a dynamic request effort and reports unsupported efforts before network I/O', async () => {
    const server = await mockServer([{ events: textEvents }, { events: textEvents }])
    const ctx = await harness(server.url, { reasoning: 'max' })

    await assemble(ctx, {
      model: 'deepseek-v4-flash',
      reasoningEffort: ReasoningEffortId('high'),
      messages: [],
    })
    expect(server.requests[0]).toMatchObject({ reasoning_effort: 'high' })

    await assemble(ctx, {
      model: 'deepseek-v4-flash',
      reasoningEffort: ReasoningEffortId('off'),
      messages: [],
    })
    expect(server.requests[1]).toMatchObject({ thinking: { type: 'disabled' } })
    expect(server.requests[1]).not.toHaveProperty('reasoning_effort')

    const unsupported = await assemble(ctx, {
      model: 'deepseek-v4-flash',
      reasoningEffort: ReasoningEffortId('xhigh'),
      messages: [],
    })
    expect(unsupported.finish).toMatchObject({
      kind: 'error',
      failure: { code: 'UNSUPPORTED_REASONING_EFFORT' },
    })
    expect(server.requests).toHaveLength(2)
  })

  it('preserves omitted profile options when constructing the adapter directly', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(RequestProviders)
    ctx.codexyRequests.registerAdapter(['deepseek'], adapterOf({
      deepseek: { apiKeyEnv: 'PI_TEST_KEY', baseURL: server.url },
    }))

    const result = await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })

    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('names a route by its displayName, and by its own key once the profiles drop it', () => {
    const adapter = adapterOf({ 'acme-gateway': {
      displayName: 'Acme Gateway',
      api: 'openai-completions',
      baseURL: 'https://acme.test/v1',
      models: [{ id: 'acme-large' }],
    } })
    expect(adapter.providerInfo('acme-gateway')).toEqual({ id: 'acme-gateway', name: 'Acme Gateway' })

    // The registry and the profiles can disagree for a moment: a refused
    // registration swap leaves the previous routes serving while resolution
    // has already moved on, so a selector may ask about a route the current
    // profiles no longer describe. It gets the key rather than nothing.
    expect(adapter.providerInfo('departed')).toEqual({ id: 'departed', name: 'departed' })
  })

  it('reports unsupported stop sequences rather than silently ignoring them', async () => {
    const server = await mockServer([])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'deepseek-v4-flash', messages: [], stop: ['END'] })
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'UNSUPPORTED_OPTION' } })
    expect(server.requests).toEqual([])
  })

  it('reports unknown catalog models before network I/O', async () => {
    const server = await mockServer([])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'not-in-the-catalog', messages: [] })
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'UNKNOWN_MODEL' } })
    expect(server.requests).toEqual([])
  })

  it('uses the catalog API implementation, including OpenAI Responses', async () => {
    const server = await mockServer([{ status: 401, body: JSON.stringify({ error: { message: 'expected mock failure' } }) }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(RequestProviders)
    await ctx.plugin(LlmPiAi, {
      providers: { openai: { apiKeyEnv: 'PI_TEST_KEY', baseURL: `${server.url}/v1` } },
    })
    const result = await assemble(ctx, { provider: 'openai', model: 'gpt-4.1', messages: [] })
    expect(result.finish.kind).toBe('error')
    expect(server.paths).toEqual(['/v1/responses'])
  })

  it('resolves attachment and filesystem services mounted after the adapter when dispatching an image', async () => {
    const server = await mockServer([{ status: 401, body: JSON.stringify({ error: { message: 'expected mock failure' } }) }])
    const attachmentId = AttachmentId(`sha256:${'a'.repeat(64)}`)
    const ref: ImageAttachmentRef = {
      attachmentId,
      mediaType: 'image/png',
      bytes: 1,
      width: 1,
      height: 1,
    }
    const readImage = vi.fn((_ref: ImageAttachmentRef): Promise<StoredImageAttachment> =>
      Promise.resolve({ ref, data: Uint8Array.of(1) }))
    const readImageRequest = vi.fn((
      value: ImageAttachmentRef,
      _target: ImageRequestTarget,
      _signal?: AbortSignal,
    ): Promise<RequestImageAttachment> => (
      Promise.resolve({
        variantId: ImageVariantId(`sha256:${'b'.repeat(64)}`),
        attachment: value,
        data: Uint8Array.of(1),
        mediaType: value.mediaType,
        bytes: 1,
        width: value.width,
        height: value.height,
        depth: 'uchar',
        space: 'srgb',
        hasAlpha: true,
      })
    ))

    class LateAttachmentStore extends AttachmentStore {
      readonly imageLimits: ImageAttachmentLimits = {
        maxImageBytes: 1,
        maxImagesPerMessage: 1,
        maxMessageImageBytes: 1,
        maxImagePixels: 1,
        maxImageDimension: 2000,
        mediaTypes: ['image/png'],
      }

      validateImage(_input: SaveImageAttachment): Promise<void> {
        return Promise.reject(new Error('not used'))
      }

      saveImage(_input: SaveImageAttachment): Promise<ImageAttachmentRef> {
        return Promise.reject(new Error('not used'))
      }

      readImage(value: ImageAttachmentRef): Promise<StoredImageAttachment> {
        return readImage(value)
      }

      override imageHostPath(_ref: ImageAttachmentRef): string {
        return HOST_IMAGE_PATH
      }

      override readImageRequest(
        value: ImageAttachmentRef,
        policy: ImageRequestTarget,
        signal?: AbortSignal,
      ): Promise<RequestImageAttachment> {
        return readImageRequest(value, policy, signal)
      }
    }

    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(RequestProviders)
    await ctx.plugin(LlmPiAi, {
      providers: { openai: { apiKeyEnv: 'PI_TEST_KEY', baseURL: `${server.url}/v1` } },
    })
    await ctx.plugin(LateAttachmentStore)
    await ctx.plugin(MappedFileSystem)

    const result = await assemble(ctx, {
      provider: 'openai',
      model: 'gpt-4.1',
      messages: [createUserMessage({
        content: [{ type: 'image', attachment: ref }],
        source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      })],
    })

    expect(result.finish.kind).toBe('error')
    expect(readImageRequest).toHaveBeenCalledWith(ref, {
      width: 1,
      height: 1,
      maxBytes: 1024 * 1024,
    }, expect.any(AbortSignal))
    expect(JSON.stringify(server.requests[0])).toContain(MODEL_IMAGE_PATH)
    expect(server.paths).toEqual(['/v1/responses'])
  })

  it('forces one wire request for an SDK-retryable provider failure', async () => {
    const server = await mockServer([
      {
        status: 429,
        headers: { 'retry-after-ms': '1' },
        body: JSON.stringify({ error: { message: 'retryable provider failure' } }),
      },
      { status: 500, body: JSON.stringify({ error: { message: 'hidden SDK retry' } }) },
      { status: 500, body: JSON.stringify({ error: { message: 'second hidden SDK retry' } }) },
    ])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(RequestProviders)
    await ctx.plugin(LlmPiAi, {
      providers: { openai: { apiKeyEnv: 'PI_TEST_KEY', baseURL: `${server.url}/v1` } },
    })

    const result = await assemble(ctx, { provider: 'openai', model: 'gpt-4.1', messages: [] })

    expect(result.finish).toMatchObject({ kind: 'error' })
    expect(server.paths).toEqual(['/v1/responses'])
  })

  it('uses OpenAI Responses against an Azure project v1 path with its API key header', async () => {
    const server = await mockServer([{ status: 401, body: JSON.stringify({ error: { message: 'expected mock failure' } }) }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(RequestProviders)
    await ctx.plugin(LlmPiAi, {
      providers: {
        openai: {
          apiKeyEnv: 'PI_TEST_KEY',
          baseURL: `${server.url}/api/projects/openai/openai/v1`,
          headers: { 'api-key': 'test-key', Authorization: '' },
        },
      },
    })
    const result = await assemble(ctx, { provider: 'openai', model: 'gpt-5.5', messages: [] })
    expect(result.finish.kind).toBe('error')
    expect(server.paths).toEqual(['/api/projects/openai/openai/v1/responses'])
    expect(server.headers[0]?.['api-key']).toBe('test-key')
    expect(server.headers[0]?.authorization).toBe('')
  })

  it.each([
    [401, 'AUTH'],
    [400, 'INVALID_REQUEST'],
    [429, 'RATE_LIMIT'],
    [500, 'SERVER'],
  ] as const)('maps HTTP %s failures to %s', async (status, code) => {
    const server = await mockServer([{ status, body: JSON.stringify({ error: { message: `provider ${status}` } }) }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code } })
    expect(server.paths).toEqual(['/chat/completions'])
  })

  it('uses the resolved catalog context window for usage-based overflow detection', async () => {
    const model = getBuiltinModels('deepseek').find(candidate => candidate.id === 'deepseek-v4-flash')
    if (model === undefined) throw new Error('deepseek-v4-flash missing from pi-ai test catalog')
    const events = [
      '{"choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":null}]}',
      JSON.stringify({
        choices: [{ delta: {}, index: 0, finish_reason: 'stop' }],
        usage: { prompt_tokens: model.contextWindow + 1, completion_tokens: 0 },
      }),
      '[DONE]',
    ]
    const server = await mockServer([{ events }])
    const ctx = await harness(server.url)

    const result = await assemble(ctx, { model: model.id, messages: [] })

    expect(result.finish).toEqual({
      kind: 'error',
      failure: {
        message: `pi-ai detected context overflow for model "${model.id}"`,
        code: CONTEXT_WINDOW_EXCEEDED_CODE,
      },
    })
  })

  it('stops the SDK request when the adapter idle watchdog expires', async () => {
    const server = await mockServer([{ events: textEvents, delayMs: 200 }])
    const ctx = await harness(server.url, { streamIdleTimeoutMs: 20 })

    const result = await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'TIMEOUT' } })
    await Promise.race([
      server.responseClosed,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => { reject(new Error('SDK request did not close after idle timeout')) }, 1_000)
      }),
    ])

    expect(server.paths).toEqual(['/chat/completions'])
    expect(server.closedResponses).toBe(1)
  })
})

describe('provider profile lifecycle', () => {
  it('keeps adapter helpers off the package root', () => {
    for (const helper of [
      'resolveProfiles',
      'toPiContext',
      'toPiReplayState',
      'toPiAssistant',
      'mapStopReason',
      'mapUsage',
      'toStreamChunks',
    ]) expect(LlmPiAi).not.toHaveProperty(helper)
  })

  it('registers every profile atomically and unregisters on dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(RequestProviders)
    const fiber = await ctx.plugin(LlmPiAi, {
      providers: {
        openai: {
          retryPolicy: {
            mode: 'always',
            backoff: { initialDelayMs: 25, maxDelayMs: 100, jitterRatio: 0.2 },
          },
        },
        anthropic: {},
      },
    })
    expect(ctx.codexyRequests.listProviders()).toEqual([
      { id: 'openai', name: 'openai' },
      { id: 'anthropic', name: 'anthropic' },
    ])
    expect(ctx.llm.providerRetryPolicy('openai')).toEqual({
      mode: 'always',
      initialDelayMs: 25,
      maxDelayMs: 100,
      jitterRatio: 0.2,
    })
    expect(ctx.llm.providerRetryPolicy('anthropic')).toMatchObject({
      mode: 'normal',
      maxRetries: 5,
    })
    await fiber.dispose()
    expect(ctx.codexyRequests.listProviders()).toEqual([])
  })

  it('exposes the installed pi-ai model catalog through provider-neutral metadata', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(RequestProviders)
    await ctx.plugin(LlmPiAi, { providers: { openai: {} } })
    const models = await ctx.codexyRequests.listModels('openai')
    expect(models.find(model => model.id === 'gpt-4.1')).toEqual({
      provider: 'openai', id: 'gpt-4.1', name: 'GPT-4.1',
      inputModalities: ['text', 'image'],
    })
    expect(models.every(model => model.provider === 'openai')).toBe(true)
    const info = await ctx.codexyRequests.resolveModelInfo('openai', 'gpt-4.1')
    expect(typeof info.context?.contextWindow).toBe('number')
  })

  it('exposes pi-ai model thinking levels verbatim without inventing a provider default', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(RequestProviders)
    await ctx.plugin(LlmPiAi, {
      providers: { deepseek: {}, openai: {} },
    })

    await expect(ctx.codexyRequests.resolveModelInfo('deepseek', 'deepseek-v4-flash'))
      .resolves.toMatchObject({
        reasoning: {
          efforts: [
            { id: ReasoningEffortId('off'), name: 'Off' },
            { id: ReasoningEffortId('low'), name: 'Low' },
            { id: ReasoningEffortId('high'), name: 'High' },
            { id: ReasoningEffortId('max'), name: 'Max' },
          ],
        },
      })
    const extended = await ctx.codexyRequests.resolveModelInfo('openai', 'gpt-5.6-sol')
    expect(extended.reasoning?.efforts.map(effort => effort.id)).toEqual([
      ReasoningEffortId('off'),
      ReasoningEffortId('low'),
      ReasoningEffortId('medium'),
      ReasoningEffortId('high'),
      ReasoningEffortId('xhigh'),
      ReasoningEffortId('max'),
    ])
    // A catalog model without reasoning is the same case as a hand-declared
    // one: pi-ai reports the single level `off`, which translates to omitting
    // the reasoning option — exactly what naming no effort already does. The
    // capability is reported unavailable rather than offering that control.
    expect((await ctx.codexyRequests.resolveModelInfo('openai', 'gpt-4.1')).reasoning).toBeUndefined()
  })

  it('uses a supported profile reasoning value as the model default and rejects an unsupported one', async () => {
    const supported = new Context()
    await supported.plugin(LlmRuntime)
    await supported.plugin(RequestProviders)
    await supported.plugin(LlmPiAi, {
      providers: { deepseek: { reasoning: 'max' } },
    })
    await expect(supported.codexyRequests.resolveModelInfo('deepseek', 'deepseek-v4-flash'))
      .resolves.toMatchObject({ reasoning: { defaultEffort: ReasoningEffortId('max') } })

    // A profile level this model cannot take DESCRIBES as no default rather
    // than failing: resolveModelInfo builds the model catalog, and a catalog
    // that throws takes its whole provider out of every picker — one mis-set
    // field would hide every model on the route, including the ones that do
    // support the level. The request path below is where it is refused.
    const unsupported = new Context()
    await unsupported.plugin(LlmRuntime)
    await unsupported.plugin(RequestProviders)
    await unsupported.plugin(LlmPiAi, {
      providers: { deepseek: { reasoning: 'medium' } },
    })
    const described = await unsupported.codexyRequests.resolveModelInfo('deepseek', 'deepseek-v4-flash')
    expect(described.reasoning?.defaultEffort).toBeUndefined()
    expect(described.reasoning?.efforts.length).toBeGreaterThan(0)
    await expect(assemble(unsupported, {
      provider: 'deepseek', model: 'deepseek-v4-flash', messages: [],
    })).resolves.toMatchObject({
      finish: { kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT' } },
    })

    const disabled = new Context()
    await disabled.plugin(LlmRuntime)
    await disabled.plugin(RequestProviders)
    await disabled.plugin(LlmPiAi, {
      providers: { deepseek: { reasoning: 'off' } },
    })
    await expect(disabled.codexyRequests.resolveModelInfo('deepseek', 'deepseek-v4-flash'))
      .resolves.toMatchObject({ reasoning: { defaultEffort: ReasoningEffortId('off') } })
  })

  it('serves declared reasoning efforts to selectors and honours the profile default', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(RequestProviders)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'acme-gateway': {
          apiKeyEnv: 'PI_TEST_KEY',
          api: 'openai-completions',
          baseURL: 'https://acme.test/v1',
          reasoning: 'high',
          models: [{
            id: 'acme-think',
            contextWindow: 65_536,
            maxTokens: 4096,
            reasoningEfforts: { off: null, low: 'low', high: 'high' },
          }],
        },
      },
    })

    // Declared levels reach the same seam catalog metadata does, so the
    // effort picker works for a model pi-ai has never heard of.
    await expect(ctx.codexyRequests.resolveModelInfo('acme-gateway', 'acme-think')).resolves.toMatchObject({
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('off'), name: 'Off' },
          { id: ReasoningEffortId('low'), name: 'Low' },
          { id: ReasoningEffortId('high'), name: 'High' },
        ],
        defaultEffort: ReasoningEffortId('high'),
      },
    })
  })

  it('sends the declared wire spelling and refuses undeclared levels before network I/O', async () => {
    vi.stubEnv('PI_TEST_KEY', 'test-key')
    const server = await mockServer([{ events: textEvents }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(RequestProviders)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'acme-gateway': {
          apiKeyEnv: 'PI_TEST_KEY',
          api: 'openai-completions',
          baseURL: `${server.url}/v1`,
          models: [{
            id: 'acme-think',
            contextWindow: 65_536,
            maxTokens: 4096,
            reasoningEfforts: { off: null, high: 'ultra' },
          }],
        },
      },
    })

    await assemble(ctx, {
      provider: 'acme-gateway',
      model: 'acme-think',
      reasoningEffort: ReasoningEffortId('high'),
      messages: [],
    })
    // The declared value, not the canonical level name, goes on the wire.
    expect(server.requests[0]).toMatchObject({ reasoning_effort: 'ultra' })

    const undeclared = await assemble(ctx, {
      provider: 'acme-gateway',
      model: 'acme-think',
      reasoningEffort: ReasoningEffortId('max'),
      messages: [],
    })
    expect(undeclared.finish).toMatchObject({
      kind: 'error',
      failure: { code: 'UNSUPPORTED_REASONING_EFFORT' },
    })
    expect(server.requests).toHaveLength(1)
  })

  it('dispatches the compat-switched dialect on a declared route', async () => {
    vi.stubEnv('PI_TEST_KEY', 'test-key')
    const server = await mockServer([{ events: textEvents }, { events: textEvents }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(RequestProviders)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'acme-gateway': {
          apiKeyEnv: 'PI_TEST_KEY',
          api: 'openai-completions',
          baseURL: `${server.url}/v1`,
          // Without the switch pi-ai guesses the dialect from the endpoint
          // URL, and a private gateway's URL says nothing.
          compat: { thinkingFormat: 'deepseek' },
          models: [{
            id: 'acme-think',
            contextWindow: 65_536,
            maxTokens: 4096,
            reasoningEfforts: { off: null, high: 'high' },
          }],
        },
      },
    })
    const prompt = (effort: string): Promise<unknown> => assemble(ctx, {
      provider: 'acme-gateway',
      model: 'acme-think',
      reasoningEffort: ReasoningEffortId(effort),
      messages: [],
    })

    await prompt('high')
    expect(server.requests[0]).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'high' })

    await prompt('off')
    expect(server.requests[1]).toMatchObject({ thinking: { type: 'disabled' } })
    expect(server.requests[1]).not.toHaveProperty('reasoning_effort')
  })

  it('keeps the system role on a declared route whose gateway rejects the developer one', async () => {
    vi.stubEnv('PI_TEST_KEY', 'test-key')
    const server = await mockServer([{ events: textEvents }, { events: textEvents }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(RequestProviders)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'acme-gateway': {
          apiKeyEnv: 'PI_TEST_KEY',
          api: 'openai-completions',
          baseURL: `${server.url}/v1`,
          models: [
            // pi-ai sends the system prompt as `developer` to a reasoning
            // model whenever its URL detection says the endpoint is OpenAI —
            // which is what an unrecognized private URL resolves to. Most
            // OpenAI-compatible gateways reject that role.
            { id: 'acme-think', reasoningEfforts: { off: null, high: 'high' }, compat: { supportsDeveloperRole: false } },
            { id: 'acme-guess', reasoningEfforts: { off: null, high: 'high' } },
          ],
        },
      },
    })
    const roles = async (model: string): Promise<string[]> => {
      await assemble(ctx, {
        provider: 'acme-gateway',
        model,
        reasoningEffort: ReasoningEffortId('high'),
        system: 'you are a harness',
        messages: [],
      })
      const request = server.requests.at(-1) as { messages: { role: string }[] }
      return request.messages.map(message => message.role)
    }

    expect(await roles('acme-think')).toEqual(['system'])
    // The switch is the only thing that changes it: the same route, same
    // endpoint, same reasoning declaration still gets pi-ai's guess.
    expect(await roles('acme-guess')).toEqual(['developer'])
  })

  it('sends a declared off value as the effort parameter instead of omitting it', async () => {
    vi.stubEnv('PI_TEST_KEY', 'test-key')
    const server = await mockServer([{ events: textEvents }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(RequestProviders)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'acme-gateway': {
          apiKeyEnv: 'PI_TEST_KEY',
          api: 'openai-completions',
          baseURL: `${server.url}/v1`,
          models: [{
            id: 'acme-think',
            contextWindow: 65_536,
            maxTokens: 4096,
            reasoningEfforts: { off: 'none', high: 'high' },
          }],
        },
      },
    })

    // The adapter strips a selected Off to "no reasoning option", and pi-ai's
    // dispatch reads thinkingLevelMap.off exactly then — so the declared value
    // still reaches the wire, which is the README's promise for `off: none`.
    await assemble(ctx, {
      provider: 'acme-gateway',
      model: 'acme-think',
      reasoningEffort: ReasoningEffortId('off'),
      messages: [],
    })
    expect(server.requests[0]).toMatchObject({ reasoning_effort: 'none' })
  })

  it('holds back reasoning_effort when the endpoint cannot take it', async () => {
    vi.stubEnv('PI_TEST_KEY', 'test-key')
    const server = await mockServer([{ events: textEvents }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(RequestProviders)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'acme-gateway': {
          apiKeyEnv: 'PI_TEST_KEY',
          api: 'openai-completions',
          baseURL: `${server.url}/v1`,
          compat: { supportsReasoningEffort: false },
          models: [{
            id: 'acme-think',
            contextWindow: 65_536,
            maxTokens: 4096,
            reasoningEfforts: { off: null, high: 'high' },
          }],
        },
      },
    })

    await assemble(ctx, {
      provider: 'acme-gateway',
      model: 'acme-think',
      reasoningEffort: ReasoningEffortId('high'),
      messages: [],
    })
    expect(server.requests[0]).not.toHaveProperty('reasoning_effort')
  })

  it('accepts absent credentials for pi-ai ambient authentication', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'ambient-key')
    const server = await mockServer([{ events: textEvents }])
    // A profile that names no reference at all is the one case that defers to
    // pi-ai's own provider-native discovery.
    const ctx = await harness(server.url, { apiKeyEnv: undefined })
    await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })
    expect(server.headers[0]?.authorization).toBe('Bearer ambient-key')
  })

  it('falls back to the ambient environment for apiKeyEnv without the credentials seam', async () => {
    vi.stubEnv('PI_CUSTOM_REF_KEY', 'custom-ref-key')
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(server.url, { apiKey: undefined, apiKeyEnv: 'PI_CUSTOM_REF_KEY' })
    await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })
    expect(server.headers[0]?.authorization).toBe('Bearer custom-ref-key')
  })

  it('fails a named-but-missing apiKeyEnv instead of using another ambient key', async () => {
    // The exact confusion this guards: the named reference is empty while an
    // unrelated provider key sits in the environment. Deferring to pi-ai's own
    // discovery here would authenticate as another tenant.
    vi.stubEnv('PI_CUSTOM_REF_KEY', '')
    vi.stubEnv('DEEPSEEK_API_KEY', 'ambient-key')
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(server.url, { apiKey: undefined, apiKeyEnv: 'PI_CUSTOM_REF_KEY' })
    const first = await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })
    expect(first.finish).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
    const second = await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })
    expect(second.finish.kind).toBe('error')
    if (second.finish.kind !== 'error') throw new Error('expected an error finish')
    expect(second.finish.failure.message).toMatch(/provider route "deepseek".*PI_CUSTOM_REF_KEY/s)
    expect(server.requests).toHaveLength(0)
  })

  it('validates empty, underspecified, legacy-shaped, and explicitly blank profiles', () => {
    expect(DEFAULT_MAX_REQUEST_IMAGE_BYTES).toBe(20 * 1024 * 1024)
    // Empty and omitted dicts are the dormant zero-route posture, not errors.
    expect(resolveProfiles({}).size).toBe(0)
    expect(resolveProfiles(undefined).size).toBe(0)
    expect(() => resolveProfiles({ '': {} })).toThrow(/non-empty/)
    // A route the installed catalog does not ship is allowed, but it has no
    // defaults to fall back on: it must describe its own models.
    expect(() => resolveProfiles({ 'not-real': {} })).toThrow(/resolves no models/)
    // The pre-release array shape and its per-profile provider field fail
    // loud with migration directions instead of half-working.
    expect(() => resolveProfiles([{ provider: 'openai' }] as never)).toThrow(/dict keyed by provider/)
    expect(() => resolveProfiles({ openai: { provider: 'openai' } as never })).toThrow(/moved to the providers dict key/)
    expect(() => resolveProfiles({ openai: { baseURL: '' } })).toThrow(/empty baseURL/)
    expect(() => resolveProfiles({ openai: { apiKeyEnv: 'not-a-var!' } })).toThrow(/must match/)
    expect(() => resolveProfiles({ openai: { maxRequestImageBytes: 0 } })).toThrow(/maxRequestImageBytes/)
    expect(resolveProfiles({ openai: {} }).get('openai')?.maxRequestImageBytes)
      .toBe(DEFAULT_MAX_REQUEST_IMAGE_BYTES)
    expect(resolveProfiles({ openai: { maxRequestImageBytes: 1024 } }).get('openai')?.maxRequestImageBytes)
      .toBe(1024)
  })

  it.each([
    ['bad header name', 'value'],
    ['x-company', 'line\nbreak'],
    ['x-company', '部署'],
  ])('rejects provider header %j when Fetch cannot represent the entry', (name, value) => {
    expect(() => resolveProfiles({ openai: { headers: { [name]: value } } }))
      .toThrow(`provider "openai" header "${name}" is not valid for Fetch`)
  })

  it.each(['maxRetries', 'maxRetryDelayMs'] as const)(
    'rejects removed profile field %s instead of silently restoring hidden SDK retries',
    async (field) => {
      const legacy = { [field]: 2 }
      expect(() => resolveProfiles({ openai: legacy })).toThrow(/removed.*agent recovery/i)
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(RequestProviders)
      await expect(ctx.plugin(LlmPiAi, { providers: { openai: legacy } }))
        .rejects.toThrow(/removed.*agent recovery/i)
    },
  )

  it('rejects invalid stream tunables at plugin load', async () => {
    const invalid = [
      { timeoutMs: -1 },
      { websocketConnectTimeoutMs: -1 },
      { streamIdleTimeoutMs: 0 },
      { streamIdleTimeoutMs: Number.NaN },
      { streamIdleTimeoutMs: MAX_TIMER_DELAY_MS + 1 },
      { maxRequestImageBytes: 0 },
      { maxRequestImageBytes: 1.5 },
      { maxRequestImageBytes: Number.NaN },
    ]
    for (const entry of invalid) {
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(RequestProviders)
      await expect(ctx.plugin(LlmPiAi, { providers: { openai: { ...entry } } }))
        .rejects.toThrow()
    }
  })

  it('rejects invalid nested retryPolicy at the provider-profile boundary', async () => {
    expect(() => resolveProfiles({
      openai: { retryPolicy: { mode: 'always', backoff: { jitterRatio: -1 } } },
    })).toThrow(/retryPolicy\.backoff\.jitterRatio/)

    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(RequestProviders)
    await expect(ctx.plugin(LlmPiAi, {
      providers: { openai: { retryPolicy: { mode: 'normal', maxRetries: -1 } } },
    })).rejects.toThrow(/retryPolicy/)
    expect(ctx.codexyRequests.listProviders()).toEqual([])
  })

  it('constructs the adapter directly and rejects routes it does not own', async () => {
    const adapter = adapterOf({ openai: {} })
    await expect(adapter.listModels('anthropic')).rejects.toMatchObject({ code: 'NO_ADAPTER' })
    await expect(adapter.resolveModel('anthropic', 'claude-sonnet-4'))
      .rejects.toMatchObject({ code: 'NO_ADAPTER' })
    await expect(adapter.resolveModel('openai', 'not-a-catalog-model'))
      .rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
    await expect((async () => {
      for await (const _chunk of adapter.stream({ provider: 'anthropic', model: 'claude-sonnet-4', messages: [] })) { /* drain */ }
    })()).rejects.toMatchObject({ code: 'NO_ADAPTER' })
    expect(new LlmError('x', 'X')).toBeInstanceOf(Error)
  })

  it('rejects unsupported or unresolved image input before provider I/O', async () => {
    const adapter = adapterOf({ openai: {}, deepseek: {} })
    const drain = async (options: Parameters<PiAiAdapter['stream']>[0]): Promise<void> => {
      for await (const _chunk of adapter.stream(options)) { /* drain */ }
    }

    await expect(drain({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      messages: [createUserMessage({
        content: [{ type: 'image', attachment: IMAGE_REF }],
        source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      })],
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    await expect(drain({
      provider: 'openai',
      model: 'gpt-4.1',
      messages: [createUserMessage({
        content: [{ type: 'image', attachment: IMAGE_REF }],
        source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      })],
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    await expect(drain({
      provider: 'openai',
      model: 'gpt-4.1',
      messages: [createToolResultMessage({
        callId: 'call-outer' as never,
        content: [{ type: 'image', attachment: IMAGE_REF }],
        isError: false,
      })],
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })

  it('validates profiles at the shared resolver boundary', () => {
    expect(() => resolveProfiles({
      openai: { streamIdleTimeoutMs: 0 },
    })).toThrow(/streamIdleTimeoutMs.*positive finite/)
    expect(() => resolveProfiles({
      openai: { streamIdleTimeoutMs: MAX_TIMER_DELAY_MS + 1 },
    })).toThrow(/streamIdleTimeoutMs.*no greater/)
  })
})

describe('abort wiring', () => {
  it('preserves an unknown pre-dispatch adapter Error exactly', async () => {
    const original = new Error('SDK context conversion exploded')
    const message = Object.defineProperty({}, 'content', {
      get() { throw original },
    })
    const adapter = adapterOf({ deepseek: {} })
    const drain = async (): Promise<void> => {
      for await (const _chunk of adapter.stream({
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        messages: [message as never],
      })) { /* drain */ }
    }

    await expect(drain()).rejects.toBe(original)
  })

  it('lets a concurrent caller abort classify a pre-dispatch adapter failure', async () => {
    const controller = new AbortController()
    const original = new Error('conversion lost its caller')
    const message = Object.defineProperty({}, 'content', {
      get() {
        controller.abort('caller cancelled during conversion')
        throw original
      },
    })
    const adapter = adapterOf({ deepseek: {} })
    const drain = async (): Promise<void> => {
      for await (const _chunk of adapter.stream({
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        messages: [message as never],
        signal: controller.signal,
      })) { /* drain */ }
    }

    await expect(drain()).rejects.toMatchObject({ code: 'ABORTED', cause: original })
  })

  it('resolves catalog endpoints without an override before honoring pre-abort', async () => {
    const adapter = adapterOf({ deepseek: {} })
    const controller = new AbortController()
    controller.abort('already stopped')
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      messages: [],
      signal: controller.signal,
    })) chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'aborted', failure: { code: 'ABORTED' } },
    })
  })

  it('honors a pre-aborted caller signal', async () => {
    const server = await mockServer([{ events: textEvents, delayMs: 20 }])
    const ctx = await harness(server.url)
    const controller = new AbortController()
    controller.abort('already stopped')
    const result = await assemble(ctx, { model: 'deepseek-v4-flash', messages: [], signal: controller.signal })
    expect(result.finish.kind).toBe('aborted')
  })

  it('forwards an abort that arrives while provider streaming is active', async () => {
    const server = await mockServer([{ events: textEvents, delayMs: 30 }])
    const ctx = await harness(server.url)
    const controller = new AbortController()
    const resultPromise = assemble(ctx, {
      model: 'deepseek-v4-flash', messages: [], signal: controller.signal,
    })
    setTimeout(() => { controller.abort('stopped during stream') }, 10)
    const result = await resultPromise
    expect(result.finish.kind).toBe('aborted')
  })

  it('aborts upstream when a consumer stops early', async () => {
    const server = await mockServer([{ events: textEvents, delayMs: 30 }])
    const ctx = await harness(server.url)
    for await (const chunk of ctx.codexyRequests.stream({ provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })) {
      if (chunk.type === 'block-start') break
    }
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(server.requests).toHaveLength(1)
  })
})
