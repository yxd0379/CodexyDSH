/** Native custom wire calls preserve source bytes through streaming and history replay. */
import { afterEach, describe, expect, it } from 'vitest'
import {
  BlockAssembler, createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId,
} from '@codexydsh/runtime/llm'
import type { FreeformToolSchema, GenerateOptions, StreamChunk } from '@codexydsh/runtime/llm'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'
import { closeMockServers, mockServer } from './mock-server.ts'

afterEach(closeMockServers)

const grammar = 'start: SOURCE\nSOURCE: /[\\s\\S]+/\n'
const raw = '// @exec: {"yield_time_ms": 1000}\r\ntext("中文🦉");\n'
const schema: FreeformToolSchema = {
  kind: 'freeform', name: 'exec', description: 'Execute JavaScript',
  format: { type: 'grammar', syntax: 'lark', definition: grammar },
}

function customEvents(): string[] {
  const item = { type: 'custom_tool_call', call_id: 'call_1', id: 'ctc_1', name: 'exec' }
  return [
    '{"type":"response.created","response":{"id":"resp_1"}}',
    JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { ...item, input: '' } }),
    ...[raw.slice(0, 12), raw.slice(12, 35), raw.slice(35)].map(delta => JSON.stringify({ type: 'response.custom_tool_call_input.delta', output_index: 0, delta })),
    JSON.stringify({ type: 'response.custom_tool_call_input.done', output_index: 0, input: raw }),
    JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { ...item, input: raw } }),
    JSON.stringify({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } }),
  ]
}

const doneEvents = [
  JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_done', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } }),
  JSON.stringify({ type: 'response.completed', response: { id: 'resp_done', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } }),
]

function adapter(baseURL: string, grammarTools = true, lite = false): PiAiAdapter {
  return new PiAiAdapter({
    profiles: () => resolveProfiles({ custom: {
      api: 'openai-responses', baseURL,
      compat: { supportsOpenAIGrammarTools: grammarTools, supportsDeveloperRole: true },
      ...lite ? { codexResponsesLite: 'namespaced' } : {},
      models: [{ id: 'gpt-6-luna', contextWindow: 32768, maxTokens: 2048, reasoningEfforts: { low: 'low' } }],
    } }),
    resolveApiKey: () => Promise.resolve('test-key'), auth: memoryAuth(),
  })
}

function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'custom', model: 'gpt-6-luna', messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'work' }] })], tools: [schema], ...overrides }
}

async function collect(instance: PiAiAdapter, options: GenerateOptions): Promise<{ assembler: BlockAssembler; chunks: StreamChunk[] }> {
  const assembler = new BlockAssembler()
  const chunks: StreamChunk[] = []
  for await (const chunk of instance.stream(options)) { chunks.push(chunk); assembler.push(chunk) }
  return { assembler, chunks }
}

describe('native custom grammar tools', () => {
  it('emits custom grammar schemas and preserves source deltas and completed calls', async () => {
    const server = await mockServer([{ events: customEvents() }])
    const { assembler, chunks } = await collect(adapter(server.url), request())
    expect(server.requests[0]).toMatchObject({ tools: [{ type: 'custom', name: 'exec', format: schema.format }] })
    expect(assembler.blocks()).toEqual([{ type: 'tool-call', id: ToolCallId('call_1|ctc_1'), name: 'exec', kind: 'freeform', arguments: raw }])
    expect(chunks.filter(chunk => chunk.type === 'tool-call-delta').map(chunk => chunk.argumentsDelta).join('')).toBe(raw)
    expect(chunks.filter(chunk => chunk.type === 'tool-call-delta').every(chunk => chunk.kind === 'freeform')).toBe(true)
  })

  it.each([true, false])('replays removed custom tools with native replay=%s', async (nativeReplay) => {
    const server = await mockServer([{ events: customEvents() }, { events: doneEvents }])
    const instance = adapter(server.url)
    const { assembler } = await collect(instance, request())
    const assistant = assembler.message({ provider: 'custom', model: 'gpt-6-luna',
      ...nativeReplay ? { replayState: assembler.replayState } : {},
    })
    const output = createToolResultMessage({ callId: ToolCallId('call_1|ctc_1'), content: [{ type: 'text', text: 'answer' }], isError: false, toolKind: 'freeform', name: 'exec' })
    await collect(instance, request({ tools: [], messages: [assistant, output] }))
    const expectedCallId = nativeReplay ? 'call_1' : 'call_1_ctc_1'
    expect(server.requests[1]).toMatchObject({ input: [
      { type: 'custom_tool_call', call_id: expectedCallId, name: 'exec', input: raw },
      { type: 'custom_tool_call_output', call_id: expectedCallId, output: 'answer' },
    ] })
  })

  it('keeps a historical function call when its name is now a freeform tool', async () => {
    const server = await mockServer([{ events: doneEvents }])
    const callId = ToolCallId('call_old|fc_old')
    const argumentsJson = '{ "input": "historical JSON" }'
    const assistant = createAssistantMessage({ source: { provider: 'custom', model: 'gpt-6-luna' },
      content: [{ type: 'tool-call', id: callId, name: 'exec', arguments: argumentsJson }],
    })
    const output = createToolResultMessage({ callId, content: [{ type: 'text', text: 'answer' }], isError: false })
    await collect(adapter(server.url), request({ messages: [assistant, output] }))
    expect(server.requests[0]).toMatchObject({ input: [
      { type: 'function_call', call_id: 'call_old_fc_old', name: 'exec', arguments: argumentsJson },
      { type: 'function_call_output', call_id: 'call_old_fc_old', output: 'answer' },
    ] })
  })

  it('groups native custom tools into the logged Responses Lite namespace', async () => {
    const server = await mockServer([{ events: doneEvents }])
    await collect(adapter(server.url, true, true), request({
      tools: [{ ...schema, namespace: { name: 'code_mode', description: 'Run code', toolName: 'exec' } }],
      sessionId: 'coding-session-12345678-1234-1234-1234-123456789abc' as never,
      codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'none', lite: true },
    }))
    expect(server.requests[0]).toMatchObject({ input: [{ type: 'additional_tools', tools: [
      { type: 'namespace', name: 'code_mode', tools: [{ type: 'custom', name: 'exec', format: schema.format }] },
    ] }, { role: 'user' }] })
  })

  it('rejects a function-only route before sending a grammar request', async () => {
    const server = await mockServer([])
    await expect(collect(adapter(server.url, false), request())).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
    expect(server.requests).toEqual([])
  })
})
