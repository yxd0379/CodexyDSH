/** Transport diagnostics follow actual provider I/O and preserve streaming ownership. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@codexydsh/runtime/llm'
import type { LlmRequestTiming, StreamChunk } from '@codexydsh/runtime/llm'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { timedFetch } from '../src/request-timing.ts'
import { memoryAuth } from './auth-double.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

afterEach(async () => {
  vi.unstubAllGlobals()
  await closeMockServers()
})

const responses = [
  JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: {
    type: 'message', id: 'msg_done', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }],
  } }),
  JSON.stringify({ type: 'response.completed', response: {
    id: 'resp_done', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
  } }),
]
const anthropic = [
  { type: 'message_start', message: {
    id: 'msg_done', type: 'message', role: 'assistant', model: 'model', content: [],
    usage: { input_tokens: 3, output_tokens: 0 },
  } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
]

describe('pi-ai request timing', () => {
  it.each([
    { api: 'openai-completions', events: textEvents },
    { api: 'openai-responses', events: responses },
    { api: 'anthropic-messages', events: anthropic.map(event => `${JSON.stringify(event)}\nevent: ${event.type}`) },
  ])('records HTTP milestones for $api without adding model input', async ({ api, events }) => {
    const endpoint = await mockServer([{ events }])
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ gateway: {
        api, baseURL: endpoint.url, models: [{ id: 'model', reasoningEfforts: false }],
      } }),
      resolveApiKey: () => Promise.resolve('test-key'), auth: memoryAuth(),
    })
    const timings: LlmRequestTiming[] = []
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      provider: 'gateway', model: 'model',
      messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] })],
      onRequestTiming: timing => timings.push(timing),
    })) chunks.push(chunk)
    const phases = timings.map(timing => timing.phase)
    expect(phases).toHaveLength(8)
    expect(phases).toEqual(expect.arrayContaining([
      'adapter-start', 'credentials-ready', 'images-ready', 'body-ready',
      'http-start', 'response-headers', 'response-ready', 'first-byte',
    ]))
    expect(phases.indexOf('body-ready')).toBeLessThan(phases.indexOf('http-start'))
    expect(phases.indexOf('response-headers')).toBeLessThan(phases.indexOf('first-byte'))
    expect(timings.every(timing => Number.isSafeInteger(timing.time))).toBe(true)
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'block-end', block: { type: 'text', text: 'hello' } }))
    expect(endpoint.requests[0]).not.toHaveProperty('onRequestTiming')
    expect(endpoint.requests[0]).not.toHaveProperty('requestTimings')
  })

  it('retains dispatch and header observations when the provider rejects a request', async () => {
    const endpoint = await mockServer([{ status: 401, body: '{"error":{"message":"Unauthorized"}}' }])
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ gateway: {
        api: 'openai-completions', baseURL: endpoint.url, models: [{ id: 'model' }],
      } }),
      resolveApiKey: () => Promise.resolve('test-key'), auth: memoryAuth(),
    })
    const timings: LlmRequestTiming[] = []
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      provider: 'gateway', model: 'model', messages: [], onRequestTiming: timing => timings.push(timing),
    })) chunks.push(chunk)
    expect(timings.slice(-2).map(timing => timing.phase)).toEqual(['http-start', 'response-headers'])
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH' } } })
  })
})

describe('timed fetch', () => {
  it('observes a heartbeat once, preserves response metadata, and cancels the provider reader', async () => {
    const cancelled = Promise.withResolvers<unknown>()
    const firstByte = Promise.withResolvers<undefined>()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array())
        controller.enqueue(new TextEncoder().encode(': heartbeat\n\n'))
      },
      cancel(reason) { cancelled.resolve(reason) },
    })
    const response = new Response(body, { headers: { 'x-request-id': 'synthetic' } })
    Object.defineProperties(response, { url: { value: 'https://gateway.test/v1/messages' }, redirected: { value: true } })
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response)
    vi.stubGlobal('fetch', fetch)
    const timings: LlmRequestTiming[] = []
    const measured = await timedFetch((timing) => {
      timings.push(timing)
      if (timing.phase === 'first-byte') firstByte.resolve(undefined)
    })('https://gateway.test/v1/messages', { method: 'POST', body: '{}' })
    try {
      expect(measured.url).toBe(response.url)
      expect(measured.redirected).toBe(true)
      expect(measured.type).toBe(response.type)
      expect(measured.headers.get('x-request-id')).toBe('synthetic')
      const reader = measured.body!.getReader()
      try {
        await reader.read()
        await reader.read()
        await firstByte.promise
      } finally { await reader.cancel('consumer stopped') }
      expect(await cancelled.promise).toBe('consumer stopped')
      expect(timings.map(timing => timing.phase)).toEqual(['http-start', 'response-headers', 'response-ready', 'first-byte'])
      expect(fetch).toHaveBeenCalledExactlyOnceWith('https://gateway.test/v1/messages', { method: 'POST', body: '{}' })
    } finally {
      if (!measured.body?.locked) await measured.body?.cancel()
    }
  })

  it.each([new Response(null, { status: 204 }), new Response('denied', { status: 403 })])(
    'keeps empty and rejected responses intact', async (response) => {
      vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(response))
      const timings: LlmRequestTiming[] = []
      expect(await timedFetch(timing => timings.push(timing))('https://gateway.test')).toBe(response)
      expect(timings.map(timing => timing.phase)).toEqual(['http-start', 'response-headers'])
    },
  )
})
