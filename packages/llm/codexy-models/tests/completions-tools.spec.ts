/** Chat Completions requests retain tool history without declaring empty tools. */
import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
} from '@codexydsh/runtime/llm'
import type { GenerateOptions, RequestMessage, ToolSchema } from '@codexydsh/runtime/llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'

afterEach(() => { vi.unstubAllGlobals() })

const tool: ToolSchema = {
  name: 'lookup',
  description: 'Look up a value.',
  parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
}

function history(withTools: boolean): RequestMessage[] {
  const user = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Summarize the result.' }] })
  if (!withTools) return [user]
  const callId = ToolCallId('lookup-history')
  return [user, createAssistantMessage({
    source: { provider: 'fixture', model: 'fixture' },
    content: [{ type: 'tool-call', id: callId, name: 'lookup', arguments: '{"key":"answer"}' }],
  }), createToolResultMessage({ callId, content: [{ type: 'text', text: '42' }], isError: false })]
}

/** Capture the actual pi-ai HTTP body; only the provider response is replaced. */
async function requestBody(messages: RequestMessage[], tools: GenerateOptions['tools']): Promise<Record<string, unknown>> {
  const requests: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (_input, init) => {
    if (typeof init?.body !== 'string') throw new Error('Expected the SDK JSON request body')
    requests.push(JSON.parse(init.body) as Record<string, unknown>)
    return new Response([
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Summary"},"finish_reason":null}]}',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      'data: [DONE]',
    ].join('\n\n') + '\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }))
  const adapter = new PiAiAdapter({
    profiles: () => resolveProfiles({ fixture: {
      api: 'openai-completions', baseURL: 'https://fixture.invalid/v1',
      models: [{ id: 'fixture', reasoningEfforts: false }],
    } }),
    resolveApiKey: () => Promise.resolve('fixture-key'),
    auth: {
      credentials: new InMemoryCredentialStore(),
      authContext: { env: () => Promise.resolve(undefined), fileExists: () => Promise.resolve(false) },
    },
  })
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'fixture', model: 'fixture', messages,
    ...tools === undefined ? {} : { tools },
  })) chunks.push(chunk)
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  expect(requests).toHaveLength(1)
  return requests[0]!
}

describe('Chat Completions tool declarations', () => {
  it.each([
    { label: 'no tools', withHistory: false, withCurrentTools: false },
    { label: 'tool history without current tools', withHistory: true, withCurrentTools: false },
    { label: 'tool history and current tools', withHistory: true, withCurrentTools: true },
  ])('$label', async ({ withHistory, withCurrentTools }) => {
    const body = await requestBody(history(withHistory), withCurrentTools ? [tool] : undefined)
    if (withCurrentTools) {
      expect(body['tools']).toEqual([expect.objectContaining({
        type: 'function', function: expect.objectContaining({ name: 'lookup', parameters: tool.parameters }),
      })])
    } else {
      expect(body).not.toHaveProperty('tools')
      expect(body).not.toHaveProperty('tool_choice')
    }
    if (withHistory) expect(body['messages']).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', tool_calls: [expect.objectContaining({ function: expect.objectContaining({ name: 'lookup' }) })] }),
      expect.objectContaining({ role: 'tool', content: '42' }),
    ]))
  })
})
