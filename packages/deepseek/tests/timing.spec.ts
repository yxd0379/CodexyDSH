/** Transport milestones distinguish local preparation, HTTP wait, and stream delivery. */
import { describe, expect, it } from 'vitest'
import type { LlmRequestTiming } from '@codexydsh/runtime/llm'
import { adapter, chunks, options, server, sse, textEvents } from './helpers.ts'
import { parseSse } from '../src/sse.ts'

describe('DeepSeek transport timing', () => {
  it('reports HTTP dispatch before response headers and keeps diagnostics out of the request body', async () => {
    const arrived = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const endpoint = await server((response) => {
      arrived.resolve()
      void release.promise.then(() => { response.end(sse(textEvents)) })
    })
    const timings: LlmRequestTiming[] = []
    const work = chunks(adapter({ baseURL: endpoint.url }).stream(options({
      onRequestTiming: timing => timings.push(timing),
    })))
    try {
      await arrived.promise
      expect(timings.map(timing => timing.phase)).toEqual([
        'adapter-start', 'images-ready', 'credentials-ready', 'files-ready', 'body-ready', 'http-start',
      ])
      release.resolve()
      await work
      expect(timings.map(timing => timing.phase)).toEqual([
        'adapter-start', 'images-ready', 'credentials-ready', 'files-ready', 'body-ready', 'http-start',
        'response-headers', 'response-ready', 'first-byte',
      ])
      expect(timings.every(timing => Number.isSafeInteger(timing.time))).toBe(true)
      expect(endpoint.requests[0]?.body).not.toHaveProperty('onRequestTiming')
      expect(endpoint.requests[0]?.body).not.toHaveProperty('requestTimings')
    } finally {
      release.resolve()
      await endpoint.close()
      await work.catch((_closedEndpoint) => {
        // Closing this test's connection cannot replace its assertion failure.
      })
    }
  })

  it('retains dispatch and response-header milestones on an HTTP error', async () => {
    const endpoint = await server((response) => {
      response.statusCode = 400
      response.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Invalid request' } }))
    })
    const timings: LlmRequestTiming[] = []
    try {
      await expect(chunks(adapter({ baseURL: endpoint.url }).stream(options({
        onRequestTiming: timing => timings.push(timing),
      })))).rejects.toThrow('Invalid request')
      expect(timings.slice(-2).map(timing => timing.phase)).toEqual(['http-start', 'response-headers'])
    } finally { await endpoint.close() }
  })

  it('measures first bytes once even when the first bytes are a heartbeat', async () => {
    let observations = 0
    const encoder = new TextEncoder()
    const body = new ReadableStream<BufferSource>({ start(controller) {
      controller.enqueue(new Uint8Array())
      controller.enqueue(encoder.encode(': heartbeat\n\n'))
      controller.enqueue(encoder.encode(sse(textEvents)))
      controller.close()
    } })
    const result: Record<string, unknown>[] = []
    for await (const event of parseSse(body, () => {}, () => { observations++ })) result.push(event)
    expect(observations).toBe(1)
    expect(result).toEqual(textEvents)
  })
})
