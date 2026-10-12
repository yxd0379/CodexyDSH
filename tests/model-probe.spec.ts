/** Loopback/mock-only protocol probes. Never contact a model or remove files. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { createSseParser, measureSseRequest, parseProbeArgs, PATCH_INPUT, runModelProbe, validateBaseUrl } from 'dsh-parity/src/model-probe.mjs'

type Json = Record<string, unknown>
const textItem = (text: string): Json => ({ id: 'message_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] })
const reasoningItem: Json = { id: 'reasoning_1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'Fixture reasoning.' }] }
const complete = (output: Json[], usage: Json = { input_tokens: 20, output_tokens: 10, output_tokens_details: { reasoning_tokens: 4 } }): Json => ({ type: 'response.completed', response: { id: 'response_1', object: 'response', status: 'completed', output, usage } })
const sse = (value: Json, newline = '\n'): string => `event: ${String(value['type'])}${newline}data: ${JSON.stringify(value)}${newline}${newline}`

function emitResponse(response: ServerResponse, output: Json[]): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.write(': heartbeat\r\n\r\n')
  response.write(sse({ type: 'response.created', response: { id: 'response_1', status: 'in_progress' } }, '\r\n'))
  response.write(sse({ type: 'response.reasoning_summary_text.delta', item_id: 'reasoning_1', delta: 'Fixture reasoning.' }))
  for (const item of output) {
    response.write(sse({ type: 'response.output_item.added', output_index: 0, item }))
    if (item['type'] === 'function_call' || item['type'] === 'custom_tool_call') {
      const raw = String(item[item['type'] === 'function_call' ? 'arguments' : 'input'])
      const type = item['type'] === 'function_call' ? 'response.function_call_arguments.delta' : 'response.custom_tool_call_input.delta'
      response.write(sse({ type, item_id: item['id'], delta: raw.slice(0, 11) }))
      response.write(sse({ type, item_id: item['id'], delta: raw.slice(11) }))
    }
    if (item['type'] === 'message') {
      const parts = item['content'] as { text: string }[]
      response.write(sse({ type: 'response.output_text.delta', item_id: item['id'], delta: parts[0]?.text ?? '' }))
    }
    response.write(sse({ type: 'response.output_item.done', output_index: 0, item }))
  }
  response.end(sse(complete(output)))
}

async function serverFixture(handle: (body: Json, response: ServerResponse, request: IncomingMessage) => void | Promise<void>): Promise<string> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Json
    try { await handle(body, response, request) }
    catch { if (!response.headersSent) response.writeHead(500); response.end() }
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  onTestFinished(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing loopback fixture')
  return `http://127.0.0.1:${address.port}/v1`
}

it('parses arbitrarily split CRLF, comments and multiline SSE data', () => {
  const events: { event: string; data: string }[] = []
  const parser = createSseParser(value => events.push(value))
  for (const chunk of [': hello\r', '\n\r\n', 'event: response.test\r', '\ndata: {"one":\r\ndata: 1}\r', '\n\r', '\n']) parser.push(chunk)
  parser.finish()
  expect(events).toEqual([{ event: 'response.test', data: '{"one":\n1}' }])
})

it('rejects an unfinished SSE frame rather than promoting partial output to success', () => {
  const parser = createSseParser(() => {})
  parser.push('data: {"type":"response.completed"}\n')
  expect(() => parser.finish()).toThrow('TRUNCATED_SSE_FRAME')
})

it('measures reasoning/content TTFT and server-count throughput independently of delta count', async () => {
  let time = 0
  const packets: [number, string][] = [
    [20, sse({ type: 'response.created', response: { id: 'r' } })],
    [30, sse({ type: 'response.reasoning_text.delta', delta: '思考' })],
    [80, sse({ type: 'response.output_text.delta', delta: 'one two three' })],
    [180, sse({ type: 'response.output_text.delta', delta: ' four five' })],
    [200, sse(complete([textItem('one two three four five')], { input_tokens: 30, output_tokens: 16, output_tokens_details: { reasoning_tokens: 6 } }))],
  ]
  const fetchImpl: typeof fetch = async () => {
    time = 10
    return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      const packet = packets.shift()
      if (packet === undefined) { controller.close(); return }
      time = packet[0]; controller.enqueue(new TextEncoder().encode(packet[1]))
    } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
  }
  const result = await measureSseRequest({ url: 'http://127.0.0.1/v1/responses', payload: { model: 'fixture', stream: true }, protocol: 'responses', fetchImpl, now: () => time })
  expect(result.metrics).toMatchObject({ ttftReasoningMs: 30, ttftContentMs: 80, ttftAnyOutputMs: 30, outputTokens: 16, reasoningTokens: 6, totalMs: 200, decodeWindowMs: 150, approximateDecodeTokensPerSecond: 100, endToEndOutputTokensPerSecond: 80 })
  expect(result.evidence.eventCount).toBe(5)
  expect(result.metrics.reasoningChannels).toEqual(['response.reasoning_text.delta'])
})

it('preserves split UTF-8 and leaves throughput unknown without server usage', async () => {
  const all = new TextEncoder().encode(sse({ type: 'response.output_text.delta', delta: '你好' }) + sse(complete([textItem('你好')], {})))
  let index = 0
  const fetchImpl: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({ pull(controller) { if (index >= all.length) controller.close(); else controller.enqueue(all.slice(index, ++index)) } }), { headers: { 'content-type': 'text/event-stream' } })
  const result = await measureSseRequest({ url: 'http://127.0.0.1/v1/responses', payload: {}, protocol: 'responses', fetchImpl })
  expect(result.content).toBe('你好')
  expect(result.metrics.outputTokens).toBeNull()
  expect(result.metrics.approximateDecodeTokensPerSecond).toBeNull()
})

it('proves native Responses function, custom freeform/grammar, and complete-output stateless history', async () => {
  const requests: Json[] = []
  const url = await serverFixture((body, response, request) => {
    expect(request.url).toBe('/v1/responses')
    expect(request.headers.authorization).toBeUndefined()
    expect(body['store']).toBe(false)
    requests.push(body)
    const input = body['input'] as Json[]
    const returned = input.find(item => ['custom_tool_call_output', 'function_call_output'].includes(String(item['type'])))
    if (returned !== undefined) {
      expect(input[1]).toEqual(reasoningItem)
      const call = input[2]
      expect(returned['call_id']).toBe(call?.['call_id'])
      expect(returned['type']).toBe(call?.['type'] === 'custom_tool_call' ? 'custom_tool_call_output' : 'function_call_output')
      const result = JSON.parse(String(returned['output'])) as Json
      expect(result['filesystemWrites']).toBe(0)
      expect(body['tool_choice']).toBe('none')
      emitResponse(response, [textItem(String(result['receipt']))])
      return
    }
    const tools = body['tools'] as Json[] | undefined
    if (tools === undefined) { emitResponse(response, [textItem('1 2 3')]); return }
    const tool = tools[0]
    const custom = tool?.['type'] === 'custom'
    emitResponse(response, [reasoningItem, {
      type: custom ? 'custom_tool_call' : 'function_call', id: 'tool_1', call_id: 'call_1', name: tool?.['name'], status: 'completed',
      ...(custom ? { input: PATCH_INPUT } : { arguments: '{"value":"probe-only"}' }),
    }])
  })
  const result = await runModelProbe({ baseUrl: url, model: 'Qwen3.8-27B-w8a8' })
  expect(result.qualification.passed).toBe(true)
  expect(result.qualification.fullCodexCompatibility).toBe(false)
  expect(result.qualification.checks).toHaveLength(7)
  expect(requests).toHaveLength(7)
  const grammarTool = (requests[5]?.['tools'] as Json[])[0]
  expect(grammarTool).toMatchObject({ type: 'custom', name: 'apply_patch', format: { type: 'grammar', syntax: 'lark' } })
  const report = JSON.stringify(result)
  expect(report).not.toContain('Fixture reasoning.')
  expect(report).not.toContain(PATCH_INPUT)
  expect(report).not.toContain('FUNCTION_HISTORY_OK_63b290')
})

it('fails custom-to-function coercion even when Chat and Responses function succeed', async () => {
  const url = await serverFixture((body, response, request) => {
    if (request.url === '/v1/chat/completions') {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: {"choices":[{"index":0,"delta":{"content":"chat works"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3}}\n\ndata: [DONE]\n\n')
      return
    }
    const input = body['input'] as Json[]
    const result = input.find(item => item['type'] === 'function_call_output')
    if (result !== undefined) { emitResponse(response, [textItem(String((JSON.parse(String(result['output'])) as Json)['receipt']))]); return }
    const tool = (body['tools'] as Json[] | undefined)?.[0]
    if (tool === undefined) { emitResponse(response, [textItem('responses text works')]); return }
    emitResponse(response, [{ type: 'function_call', id: 'tool_1', call_id: 'call_1', name: tool['name'], status: 'completed', arguments: '{"value":"probe-only"}' }])
  })
  const result = await runModelProbe({ baseUrl: url, model: 'fixture', chat: true })
  expect(result.performance.chat[0]?.passed).toBe(true)
  expect(result.qualification.checks.find(check => check.name === 'responses.function_history')?.passed).toBe(true)
  expect(result.qualification.checks.filter(check => check.name.endsWith('_call') && check.name.includes('custom'))).toEqual([
    expect.objectContaining({ name: 'responses.custom_freeform_call', passed: false, error: { code: 'WRONG_TOOL_CALL_TYPE' } }),
    expect.objectContaining({ name: 'responses.custom_grammar_call', passed: false, error: { code: 'WRONG_TOOL_CALL_TYPE' } }),
  ])
  expect(result.qualification.passed).toBe(false)
})

it('rejects terminal-only tool output without native custom SSE deltas', async () => {
  const url = await serverFixture((body, response) => {
    const tool = (body['tools'] as Json[] | undefined)?.[0]
    if (tool === undefined) { emitResponse(response, [textItem('works')]); return }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(sse(complete([{ id: 'tool_1', status: 'completed', type: tool['type'] === 'custom' ? 'custom_tool_call' : 'function_call', call_id: 'call_1', name: tool['name'], input: PATCH_INPUT, arguments: '{"value":"probe-only"}' }])))
  })
  const result = await runModelProbe({ baseUrl: url, model: 'fixture' })
  expect(result.qualification.passed).toBe(false)
  expect(result.qualification.checks.find(check => check.name === 'responses.custom_grammar_call')).toMatchObject({ passed: false, error: { code: 'TOOL_SSE_NOT_NATIVE_OR_INCONSISTENT' } })
})

it('does not accept a final response that ignores the actual tool result', async () => {
  const url = await serverFixture((body, response) => {
    if (body['tool_choice'] === 'none') { emitResponse(response, [textItem('I ran the tool successfully.')]); return }
    const tool = (body['tools'] as Json[] | undefined)?.[0]
    if (tool === undefined) { emitResponse(response, [textItem('works')]); return }
    emitResponse(response, [{ id: 'tool_1', status: 'completed', type: tool['type'] === 'custom' ? 'custom_tool_call' : 'function_call', call_id: 'call_1', name: tool['name'], input: PATCH_INPUT, arguments: '{"value":"probe-only"}' }])
  })
  const result = await runModelProbe({ baseUrl: url, model: 'fixture' })
  expect(result.qualification.checks.find(check => check.name === 'responses.function_history')).toMatchObject({ passed: false, error: { code: 'HISTORY_CONTINUATION_FAILED' } })
  expect(result.qualification.passed).toBe(false)
})

it.each([
  ['application/json', JSON.stringify({ status: 'completed', output: [] }), 'NOT_SSE'],
  ['text/event-stream', 'data: [DONE]\n\n', 'RESPONSES_MISSING_COMPLETED'],
  ['text/event-stream', sse({ type: 'response.failed', response: { status: 'failed', error: { message: 'never-report-secret' } } }), 'RESPONSES_NOT_COMPLETED'],
  ['text/event-stream', 'event: response.completed\ndata: {"type":"response.created"}\n\n', 'SSE_EVENT_TYPE_MISMATCH'],
])('rejects non-native/incomplete Responses wire replies (%s)', async (contentType, body, code) => {
  const fetchImpl: typeof fetch = async () => new Response(body, { headers: { 'content-type': contentType } })
  await expect(measureSseRequest({ url: 'http://127.0.0.1/v1/responses', payload: {}, protocol: 'responses', fetchImpl })).rejects.toThrow(code)
})

it('bounds actual HTTP request time and never reports remote credential/error bodies', async () => {
  const url = await serverFixture(async (_body, response) => { await delay(100); if (!response.destroyed) { response.writeHead(401); response.end('{"error":"Authorization: secret-token"}') } })
  await expect(measureSseRequest({ url: `${url}/responses`, payload: {}, protocol: 'responses', timeoutMs: 10 })).rejects.toThrow('REQUEST_TIMEOUT')
  const result = await runModelProbe({ baseUrl: url, model: 'fixture', timeoutMs: 500 })
  expect(result.qualification.passed).toBe(false)
  expect(JSON.stringify(result)).not.toContain('secret-token')
  expect(result.performance.responses[0]).toMatchObject({ passed: false, error: { code: 'HTTP_ERROR', httpStatus: 401 } })
})

it('rejects redirects without following them or revealing their target', async () => {
  let destinationRequests = 0
  const destination = await serverFixture((_body, response) => { destinationRequests++; emitResponse(response, [textItem('wrong destination')]) })
  const redirect = await serverFixture((_body, response) => { response.writeHead(307, { location: `${destination}/responses?api_key=never-read` }); response.end() })
  const result = await runModelProbe({ baseUrl: redirect, model: 'fixture' })
  expect(destinationRequests).toBe(0)
  expect(JSON.stringify(result)).not.toContain('never-read')
  expect(result.qualification.passed).toBe(false)
})

it('validates explicit bounded CLI options and rejects credential-bearing URLs', () => {
  expect(parseProbeArgs(['--base-url', 'http://127.0.0.1:8000/v1', '--model', 'Qwen3.8-27B-w8a8', '--runs', '3', '--chat'])).toMatchObject({ runs: 3, chat: true })
  expect(() => parseProbeArgs(['--base-url', 'http://127.0.0.1', '--model', 'fixture', '--runs', '1.5'])).toThrow('INVALID_ARGUMENT')
  expect(() => parseProbeArgs(['--base-url', 'http://127.0.0.1', '--model', 'fixture', '--model', 'other'])).toThrow('DUPLICATE_ARGUMENT')
  for (const input of ['http://user:password@localhost:8000/v1', 'http://localhost:8000/v1?api_key=secret', 'https://localhost:8000/v1#token', 'file:///tmp/model', 'http://localhost:8000/another-api']) expect(() => validateBaseUrl(input)).toThrow('INVALID_BASE_URL')
  expect(validateBaseUrl('http://127.0.0.1:8000')).toBe('http://127.0.0.1:8000/v1/')
})

it('distinguishes insufficient output budget from protocol rejection', async () => {
  const url = await serverFixture((_body, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(sse({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] } }))
  })
  const result = await runModelProbe({ baseUrl: url, model: 'fixture', maxOutputTokens: 16 })
  expect(result.performance.responses[0]).toMatchObject({ passed: false, error: { code: 'OUTPUT_TOKEN_LIMIT', classification: 'inconclusive_budget_or_timeout' } })
  expect(result.qualification.passed).toBe(false)
  expect(result.qualification.scope).toContain('inconclusive')
})

it('accepts an optional SSE DONE trailer only after native Responses completion', async () => {
  const body = sse({ type: 'response.output_text.delta', delta: 'hello' }) + sse(complete([textItem('hello')])) + 'data: [DONE]\n\n'
  const fetchImpl: typeof fetch = async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  const result = await measureSseRequest({ url: 'http://127.0.0.1/v1/responses', payload: {}, protocol: 'responses', fetchImpl })
  expect(result.evidence.terminal).toBe('response.completed')
})

it('emits a JSON failure receipt and exit 1 from the real standalone CLI', async () => {
  const url = await serverFixture((_body, response) => { response.writeHead(404); response.end('{"error":"secret-response-must-not-leak"}') })
  const execute = promisify(execFile)
  let failure: unknown
  try { await execute(process.execPath, [fileURLToPath(import.meta.resolve('dsh-parity/src/model-probe.mjs')), '--base-url', url, '--model', 'fixture'], { timeout: 5000 }) }
  catch (error) { failure = error }
  expect(failure).toMatchObject({ code: 1, stderr: '' })
  const stdout = (failure as { stdout: string }).stdout
  expect(stdout).not.toContain('secret-response-must-not-leak')
  expect(JSON.parse(stdout)).toMatchObject({ version: 1, qualification: { passed: false, fullCodexCompatibility: false } })
})
