import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createUserMessage } from '@codexydsh/runtime/llm'
import type { StreamChunk } from '@codexydsh/runtime/llm'
import { nativeResponseFetch } from '../src/native-response-stream.ts'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'

const encoder = new TextEncoder()
const sse = (value: unknown, newline = '\n') => encoder.encode(`data: ${JSON.stringify(value)}${newline}${newline}`)
const terminal = (response: Record<string, unknown> = { id: 'resp_complete' }) => ({ type: 'response.completed', response })
const servers: Server[] = []
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(servers.splice(0).map(server => new Promise<void>(done => server.close(done)))) })

async function captured(chunks: Uint8Array[], ending: 'stall' | 'error' | 'end' = 'stall') {
  const canceled = vi.fn()
  let index = 0
  const input = new ReadableStream<Uint8Array>({
    pull(controller) { const value = chunks[index++]; if (value !== undefined) controller.enqueue(value)
      else if (ending === 'end') controller.close(); else if (ending === 'error') controller.error(new Error('terminated')) },
    cancel: canceled,
  })
  const fetch = vi.fn(async () => new Response(input, { headers: { 'content-type': 'text/event-stream' } }))
  return { response: await nativeResponseFetch(fetch)('http://fixture.invalid'), canceled }
}

describe('Native response reader ownership', () => {
  it.each(['completed', 'incomplete', undefined])('closes on response.completed with status %s without waiting for HTTP EOF', async status => {
    const bytes = sse(terminal({ id: 'resp_complete', ...status === undefined ? {} : { status } }))
    const f = await captured([bytes])
    expect(new Uint8Array(await f.response.arrayBuffer())).toEqual(bytes)
    expect(f.canceled).toHaveBeenCalledTimes(1)
  })
  it('preserves UTF-8, split CRLF and original bytes while dropping same-chunk tail', async () => {
    const bytes = sse(terminal({ id: '完成é', usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } }), '\r\n')
    const chunks = Array.from(bytes, byte => new Uint8Array([byte]))
    chunks[chunks.length - 1] = new Uint8Array([10, ...sse({ type: 'response.failed', response: { status: 'failed' } })])
    const f = await captured(chunks)
    expect(new Uint8Array(await f.response.arrayBuffer())).toEqual(bytes)
    expect(f.canceled).toHaveBeenCalledTimes(1)
  })
  it('accepts exact signed i64 boundary usage without losing original numeric tokens', async () => {
    const bytes = encoder.encode('data: {"type":"response.completed","response":{"id":"r","usage":{"input_tokens":9223372036854775807,"output_tokens":-9223372036854775808,"total_tokens":0}}}\n\n')
    const f = await captured([bytes]); expect(new Uint8Array(await f.response.arrayBuffer())).toEqual(bytes)
    expect(f.canceled).toHaveBeenCalledTimes(1)
  })
  it('recognizes the Native interrupted incomplete boundary without changing its payload', async () => {
    const bytes = sse({ type: 'response.incomplete', response: { id: 'r', status: 'incomplete', incomplete_details: { reason: 'interrupted' } } })
    const f = await captured([bytes]); expect(new Uint8Array(await f.response.arrayBuffer())).toEqual(bytes)
    expect(f.canceled).toHaveBeenCalledTimes(1)
  })
  it.each([
    encoder.encode('data: {"type":"response.completed"}\n\n'),
    encoder.encode('data: {broken-json}\n\n'),
    encoder.encode('data: {"type":"response.completed","response":{"id":"r"}}\n'),
    sse(terminal({ id: 'r', usage: { input_tokens: 1.5, output_tokens: 1, total_tokens: 2 } })),
    sse(terminal({ id: 'r', end_turn: 'false' })),
    sse(terminal({ id: 'r', usage_metadata: { amount: 2 } })),
    sse({ type: 'response.failed', response: { id: 'r', status: 'failed' } }),
    sse({ type: 'response.incomplete', response: { id: 'r', incomplete_details: { reason: 'content_filter' } } }),
  ])('does not turn invalid, partial or failed frames into completion', async bytes => {
    const f = await captured([bytes], 'error')
    await expect(f.response.arrayBuffer()).rejects.toThrow('terminated')
  })
  it('rejects graceful EOF before a valid completion rather than manufacturing success', async () => {
    const f = await captured([sse(terminal({ usage: null }))], 'end')
    await expect(f.response.arrayBuffer()).rejects.toThrow('before a valid completion')
  })
  it('keeps caller abort authoritative and does not abort a caller after natural completion', async () => {
    const controller = new AbortController(), reason = new Error('caller stopped')
    const fetch = vi.fn(async () => { controller.abort(reason); return new Response(new ReadableStream({ start(c) { c.enqueue(sse(terminal())) } }), { headers: { 'content-type': 'text/event-stream' } }) })
    const response = await nativeResponseFetch(fetch)('http://fixture.invalid', { signal: controller.signal })
    await expect(response.arrayBuffer()).rejects.toBe(reason)
    const safe = new AbortController(), canceled = vi.fn()
    const completedFetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(sse(terminal())) }, cancel: canceled }), { headers: { 'content-type': 'text/event-stream' } }))
    const natural = await nativeResponseFetch(completedFetch)('http://fixture.invalid', { signal: safe.signal })
    await natural.arrayBuffer(); expect(safe.signal.aborted).toBe(false); expect(canceled).toHaveBeenCalledTimes(1)
  })
})

async function endpoint(chunks: Uint8Array[], ending: 'abort' | 'end' = 'abort') {
  let canceled = false, requests = 0
  const server = createServer(async (_request, response) => {
    requests++; response.on('close', () => { if (!response.writableFinished) canceled = true })
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders()
    for (const chunk of chunks) await new Promise<void>(done => response.write(chunk, () => done()))
    if (ending === 'end') response.end()
    else { const timer = setTimeout(() => response.destroy(), 1000); timer.unref(); response.on('close', () => clearTimeout(timer)) }
  }); servers.push(server)
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('fixture address missing')
  return { url: `http://127.0.0.1:${address.port}/v1`, canceled: () => canceled, requests: () => requests }
}
async function adapterChunks(url: string, native: boolean): Promise<StreamChunk[]> {
  const adapter = new PiAiAdapter({ profiles: () => resolveProfiles({ local: { api: 'openai-responses', baseURL: url,
    retryPolicy: { mode: 'normal', maxRetries: 0 }, models: [{ id: 'fixture', contextWindow: 131072, reasoningEfforts: false }] } }),
    resolveApiKey: async () => 'loopback-only-fixture', auth: memoryAuth() })
  const result: StreamChunk[] = []
  for await (const chunk of adapter.stream({ provider: 'local', model: 'fixture', messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'fixture' }] })],
    ...native ? { codexfulResponses: { wireProfile: 'codex-0.162.1' as const, omitDefaultMaxTokens: true, reasoningSummary: 'none' } } : {} })) result.push(chunk)
  return result
}

describe('Native adapter terminal HTTP delivery', () => {
  const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'summary' }] }
  const events = [sse({ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } }),
    sse({ type: 'response.output_text.delta', output_index: 0, delta: 'summary' }),
    sse({ type: 'response.output_item.done', output_index: 0, item }),
    sse(terminal({ id: 'resp_fixture', status: 'completed', output: [item], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } }))]
  it('finishes and really cancels after completion on a still-open HTTP response', async () => {
    const f = await endpoint(events), chunks = await adapterChunks(f.url, true)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'block-end', block: { type: 'text', text: 'summary' } }))
    expect(chunks.some(c => c.type === 'usage')).toBe(true)
    await vi.waitFor(() => expect(f.canceled()).toBe(true)); expect(f.requests()).toBe(1)
  })
  it('retains the generic provider transport error after a completed event', async () => {
    const f = await endpoint(events), chunks = await adapterChunks(f.url, false)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
    expect(f.requests()).toBe(1)
  })
  it('keeps response.failed and a disconnect before completion as real errors', async () => {
    const failed = await endpoint([sse({ type: 'response.failed', response: { id: 'r', status: 'failed', error: { code: 'fixture_failed', message: 'fixture failed' } } })], 'end')
    expect((await adapterChunks(failed.url, true)).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
    const partial = await endpoint(events.slice(0, -1))
    expect((await adapterChunks(partial.url, true)).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
  })
  it.skipIf(process.env['CODEXY_NATIVE_TRANSPORT_ORACLE_ROOT'] === undefined).each([
    ['arktype-json-schema-refs-dependencies', 2, 136], ['fastapi-deprecation-response-headers', 2, 72],
    ['katex-multicolumn-array-spans', 1, 42], ['python-statemachine-state-data-scoping', 3, 35],
  ] as const)('consumes the original sealed %s completion bytes over HTTP', async (task, attempt, id) => {
    const root = process.env['CODEXY_NATIVE_TRANSPORT_ORACLE_ROOT']!
    const path = `${root}/${task}/attempt-${String(attempt).padStart(2, '0')}.jsonl`
    const rows = (await readFile(path, 'utf8')).trimEnd().split('\n').map(row => JSON.parse(row) as Record<string, unknown>)
    const terminal = rows.find(row => row['type'] === 'terminal' && row['id'] === id)
    expect(terminal).toMatchObject({ outcome: 'abort', side: 'client' })
    const chunks = rows.filter(row => row['type'] === 'chunk' && row['id'] === id).map(row => Buffer.from(String(row['data']), 'base64'))
    const raw = Buffer.concat(chunks), oracleHash = createHash('sha256').update(raw).digest('hex')
    const f = await endpoint(chunks)
    const result = await adapterChunks(f.url, true)
    const finish = result.findLast(chunk => chunk.type === 'finish')
    expect(finish).toBeDefined(); expect(finish?.reason.kind).not.toBe('error')
    const events = raw.toString('utf8').split(/\r\n\r\n|\n\n|\r\r/).flatMap(frame => {
      const data = frame.split(/\r\n|\n|\r/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
      try { return [JSON.parse(data) as Record<string, unknown>] } catch { return [] }
    })
    const complete = events.find(event => event['type'] === 'response.completed')!['response'] as Record<string, unknown>
    const expectedText = events.filter(event => event['type'] === 'response.output_item.done').flatMap(event => {
      const item = event['item'] as { type: string; content?: Array<{ type: string; text?: string }> }
      return item.type === 'message' ? item.content?.filter(c => c.type === 'output_text').map(c => c.text ?? '') ?? [] : []
    }).join('')
    const actualText = result.flatMap(chunk => chunk.type === 'block-end' && chunk.block.type === 'text' ? [chunk.block.text] : []).join('')
    expect(actualText).toBe(expectedText)
    const usage = complete['usage'] as { input_tokens: number; output_tokens: number; total_tokens: number; input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } }
    expect(result.findLast(chunk => chunk.type === 'usage')).toMatchObject({ type: 'usage', usage: {
      inputTokens: usage.input_tokens - (usage.input_tokens_details?.cached_tokens ?? 0) - (usage.input_tokens_details?.cache_write_tokens ?? 0),
      outputTokens: usage.output_tokens, totalTokens: usage.total_tokens,
    } })
    expect(finish?.reason.kind).toBe(complete['status'] === 'incomplete' ? 'max-tokens' : 'stop')
    await vi.waitFor(() => expect(f.canceled()).toBe(true))
    expect(f.requests()).toBe(1)
  })
})
