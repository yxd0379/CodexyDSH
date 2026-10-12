/** Owned loopback fixtures only. Generated evidence is retained; never delete files. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { readCassette } from 'dsh-parity/src/cassette.mjs'
import { PATCH_INPUT } from 'dsh-parity/src/model-probe.mjs'
import { parseRecordingArgs, recordModelProbe, validateRecordingUpstream } from 'dsh-parity/src/record-model-probe.mjs'

type Json = Record<string, unknown>
type RecordedCassette = { transactions: { request: { body: string }; chunks: { data: string }[];
  terminal?: { outcome: string; side: string }; response?: { statusCode: number; headers: Json } }[] }
const readRecordedCassette = async (path: string): Promise<RecordedCassette> => await readCassette(path) as unknown as RecordedCassette
const execute = promisify(execFile)
const entry = fileURLToPath(import.meta.resolve('dsh-parity/src/record-model-probe.mjs'))
const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
const packet = (body: Json): string => `event: ${String(body['type'])}\r\ndata: ${JSON.stringify(body)}\r\n\r\n`
const message = (text: string): Json => ({ id: 'fixture_message', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] })

function wire(output: Json[]): string {
  let result = ': retained fixture heartbeat\r\n\r\n' + packet({ type: 'response.created', response: { id: 'fixture_response', status: 'in_progress' } })
  for (const item of output) {
    if (item['type'] === 'message') result += packet({ type: 'response.output_text.delta', item_id: item['id'], delta: (item['content'] as Json[])[0]?.['text'] })
    if (item['type'] === 'function_call' || item['type'] === 'custom_tool_call') result += packet({
      type: item['type'] === 'function_call' ? 'response.function_call_arguments.delta' : 'response.custom_tool_call_input.delta',
      item_id: item['id'], delta: item[item['type'] === 'function_call' ? 'arguments' : 'input'],
    })
    result += packet({ type: 'response.output_item.done', output_index: 0, item })
  }
  return result + packet({ type: 'response.completed', response: { id: 'fixture_response', object: 'response', status: 'completed', output,
    usage: { input_tokens: 12, output_tokens: 8, output_tokens_details: { reasoning_tokens: 0 } } } })
}

async function fixture(handle: (body: Json, response: ServerResponse, request: IncomingMessage) => void): Promise<string> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
    handle(JSON.parse(Buffer.concat(chunks).toString()) as Json, response, request)
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  onTestFinished(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture address missing')
  return `http://127.0.0.1:${address.port}/v1`
}

async function newOutput(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'codexy-record-model-probe-')), 'new-recording')
}

it('allows only credential-free numeric loopback API endpoints', () => {
  expect(validateRecordingUpstream('http://127.0.0.1:18273/v1')).toEqual({ origin: 'http://127.0.0.1:18273', baseUrl: 'http://127.0.0.1:18273/v1/' })
  expect(validateRecordingUpstream('http://[::1]:18273/').origin).toBe('http://[::1]:18273')
  for (const value of ['http://example.com/v1', 'http://localhost:18273/v1', 'http://user:secret@127.0.0.1/v1', 'http://127.0.0.1/v1?token=secret', 'http://127.0.0.1/v1#fragment', 'http://127.0.0.1/not-api']) expect(() => validateRecordingUpstream(value)).toThrow()
})

it('requires explicit true/false actual-model attestation and preserves original probe flags', () => {
  const args = ['--base-url', 'http://127.0.0.1:18273/v1', '--model', 'fixture', '--out', '/private/tmp/new-recording', '--actual-model', 'false', '--runs', '3', '--max-output-tokens', '2048', '--timeout-ms', '1000', '--chat']
  expect(parseRecordingArgs(args)).toMatchObject({ actualModel: false, out: '/private/tmp/new-recording', runs: 3, maxOutputTokens: 2048, timeoutMs: 1000, chat: true })
  expect(parseRecordingArgs(['--help'])).toEqual({ help: true })
  for (const suffix of [[], ['--actual-model', 'yes'], ['--actual-model', 'true', '--actual-model', 'false'], ['--actual-model', 'true', '--out', '/private/tmp/duplicate'], ['--actual-model', 'true', '--unknown']]) {
    expect(() => parseRecordingArgs(args.slice(0, 6).concat(suffix))).toThrow()
  }
})

it('records native tool/history requests and exact SSE bytes, with private exclusive hashes and source snapshots', async () => {
  const sent: { body: Json; wire: string }[] = []
  const baseUrl = await fixture((body, response, request) => {
    expect(request.headers.authorization).toBeUndefined()
    expect(request.headers.cookie).toBeUndefined()
    if (request.url === '/v1/chat/completions') {
      const raw = 'data: {"choices":[{"index":0,"delta":{"content":"fixture chat"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3}}\n\ndata: [DONE]\n\n'
      sent.push({ body, wire: raw })
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(raw)
      return
    }
    expect(request.url).toBe('/v1/responses')
    const input = body['input'] as Json[]
    const toolResult = input.find(item => ['function_call_output', 'custom_tool_call_output'].includes(String(item['type'])))
    const tool = (body['tools'] as Json[] | undefined)?.[0]
    const output = toolResult !== undefined ? [message(String((JSON.parse(String(toolResult['output'])) as Json)['receipt']))]
      : tool === undefined ? [message('1 2 3')]
      : [{ type: tool['type'] === 'custom' ? 'custom_tool_call' : 'function_call', id: 'fixture_tool', call_id: 'fixture_call', name: tool['name'], status: 'completed',
        ...tool['type'] === 'custom' ? { input: PATCH_INPUT } : { arguments: '{"value":"probe-only"}' } }]
    const raw = wire(output)
    sent.push({ body, wire: raw })
    response.writeHead(200, { 'content-type': 'text/event-stream', 'set-cookie': 'fixture-cookie-not-retained' })
    response.write(raw.slice(0, 31)); response.end(raw.slice(31))
  })
  const out = await newOutput()
  const result = await recordModelProbe({ baseUrl, model: 'synthetic-fixture', actualModel: false, out, chat: true })
  expect(result.exitCode).toBe(0)
  expect(result.report.qualification).toMatchObject({ passed: true, probePrerequisitesPassed: true, fullCodexCompatibility: false })
  expect(result.report.actualModelEvidence).toContain('caller attestation')
  expect(result.report.endpointIdentityVerified).toBe(false)
  expect(result.report.recording).toMatchObject({ captureCompleteBeforeClose: true, cassetteValidated: true, sourcesUnchangedDuringRun: true })
  const cassettePath = join(out, 'model-probe.cassette.jsonl')
  const cassette = await readRecordedCassette(cassettePath)
  expect(result.report.probe?.performance.chat[0]?.passed).toBe(true)
  expect(sent).toHaveLength(8)
  expect(cassette.transactions).toHaveLength(8)
  for (const [index, transaction] of cassette.transactions.entries()) {
    expect(JSON.parse(Buffer.from(transaction.request.body, 'base64').toString())).toEqual(sent[index]?.body)
    expect(Buffer.concat(transaction.chunks.map(chunk => Buffer.from(chunk.data, 'base64'))).toString()).toBe(sent[index]?.wire)
    expect(transaction.terminal).toEqual({ outcome: 'end', side: 'upstream' })
    expect(transaction.response?.headers).not.toHaveProperty('set-cookie')
  }
  expect(result.receipt.cassette.sha256).toBe(hash(await readFile(cassettePath)))
  expect(result.receipt.probeReport.sha256).toBe(hash(await readFile(result.reportPath)))
  expect(JSON.parse(await readFile(result.reportPath, 'utf8'))).toEqual(result.report)
  expect(JSON.parse(await readFile(result.receiptPath, 'utf8'))).toEqual(result.receipt)
  expect((await stat(out)).mode & 0o777).toBe(0o700)
  expect((await stat(join(out, 'sources'))).mode & 0o777).toBe(0o700)
  for (const name of ['model-probe.cassette.jsonl', 'report.json', 'receipt.json']) expect((await stat(join(out, name))).mode & 0o777).toBe(0o600)
  expect(Object.keys(result.receipt.sourceSha256).sort()).toEqual(['cassette.mjs', 'gateway.mjs', 'model-probe.mjs', 'record-model-probe.mjs'])
  for (const [name, sha] of Object.entries(result.receipt.sourceSha256)) {
    const snapshot = join(out, 'sources', name)
    expect(hash(await readFile(snapshot))).toBe(sha)
    expect(hash(await readFile(fileURLToPath(import.meta.resolve(`dsh-parity/src/${name}`))))).toBe(sha)
    expect((await stat(snapshot)).mode & 0o777).toBe(0o600)
  }
  expect((await readdir(out)).sort()).toEqual(['model-probe.cassette.jsonl', 'receipt.json', 'report.json', 'sources'])
})

it('preserves INVALID_FUNCTION_ARGUMENTS and EXPECTED_ONE_TOOL_CALL failures with raw diagnostic evidence', async () => {
  const baseUrl = await fixture((body, response) => {
    const tool = (body['tools'] as Json[] | undefined)?.[0]
    const output = tool === undefined ? [message('text works')]
      : tool['type'] === 'function' ? [{ type: 'function_call', id: 'f', call_id: 'c', name: tool['name'], status: 'completed', arguments: '{"wrong":"RAW_FUNCTION_DIAGNOSTIC"}' }]
      : [message('RAW_CUSTOM_DIAGNOSTIC: tool choice ignored')]
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(wire(output))
  })
  const out = await newOutput()
  const result = await recordModelProbe({ baseUrl, model: 'synthetic-failure', actualModel: false, out })
  expect(result.exitCode).toBe(1)
  expect(result.report.probe?.qualification.checks).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'responses.function_call', passed: false, error: { code: 'INVALID_FUNCTION_ARGUMENTS' } }),
    expect.objectContaining({ name: 'responses.custom_freeform_call', passed: false, error: { code: 'EXPECTED_ONE_TOOL_CALL' } }),
    expect.objectContaining({ name: 'responses.custom_grammar_call', passed: false, error: { code: 'EXPECTED_ONE_TOOL_CALL' } }),
  ]))
  expect(result.report.qualification.passed).toBe(false)
  expect(result.report.recording.cassetteValidated).toBe(true)
  const cassette = await readRecordedCassette(join(out, 'model-probe.cassette.jsonl'))
  expect(cassette.transactions).toHaveLength(4)
  const raw = cassette.transactions.map(transaction => Buffer.concat(transaction.chunks.map(chunk => Buffer.from(chunk.data, 'base64'))).toString()).join('')
  expect(raw).toContain('RAW_FUNCTION_DIAGNOSTIC')
  expect(raw).toContain('RAW_CUSTOM_DIAGNOSTIC')
  expect(JSON.stringify(result.report)).not.toContain('RAW_FUNCTION_DIAGNOSTIC')
  expect(JSON.stringify(result.report)).not.toContain('RAW_CUSTOM_DIAGNOSTIC')
})

it('records HTTP failures without dumping remote body secrets into reports or stdout', async () => {
  const baseUrl = await fixture((_body, response) => { response.writeHead(400, { 'content-type': 'application/json' }); response.end('{"error":"fixture-secret-error-body"}') })
  const out = await newOutput()
  const result = await recordModelProbe({ baseUrl, model: 'fixture-http-error', actualModel: false, out })
  expect(result.exitCode).toBe(1)
  expect(result.report.qualification.passed).toBe(false)
  expect(JSON.stringify(result.report)).not.toContain('fixture-secret-error-body')
  const cassette = await readRecordedCassette(join(out, 'model-probe.cassette.jsonl'))
  expect(cassette.transactions).toHaveLength(4)
  expect(cassette.transactions[0]?.response?.statusCode).toBe(400)
  expect(Buffer.from(cassette.transactions[0]?.chunks[0]?.data ?? '', 'base64').toString()).toContain('fixture-secret-error-body')
})

it('retains bounded timeout/abort evidence and never turns an inconclusive probe into success', async () => {
  const baseUrl = await fixture(() => { /* Intentionally silent owned upstream. */ })
  const out = await newOutput()
  const result = await recordModelProbe({ baseUrl, model: 'fixture-timeout', actualModel: false, timeoutMs: 30, out })
  expect(result.exitCode).toBe(1)
  expect(result.report.qualification.passed).toBe(false)
  expect(result.report.probe?.performance.responses[0]?.error).toEqual({ code: 'REQUEST_TIMEOUT', classification: 'inconclusive_budget_or_timeout' })
  const cassette = await readRecordedCassette(join(out, 'model-probe.cassette.jsonl'))
  expect(cassette.transactions).toHaveLength(4)
  expect(cassette.transactions.every(transaction => transaction.terminal?.outcome === 'abort')).toBe(true)
})

it.each(['directory', 'file', 'symlink'] as const)('refuses an existing %s without changing contents or sending inference', async kind => {
  let calls = 0
  const baseUrl = await fixture((_body, response) => { calls++; response.end() })
  const parent = await mkdtemp(join(tmpdir(), 'codexy-model-recording-collision-'))
  const sentinel = join(parent, 'sentinel.txt')
  await writeFile(sentinel, 'existing-data-must-survive', { flag: 'wx', mode: 0o600 })
  const out = kind === 'directory' ? parent : kind === 'file' ? sentinel : join(parent, 'existing-link')
  if (kind === 'symlink') await symlink(sentinel, out)
  const before = await readdir(parent)
  await expect(recordModelProbe({ baseUrl, model: 'fixture', actualModel: false, out })).rejects.toThrow('OUTPUT_EXISTS')
  expect(calls).toBe(0)
  expect(await readFile(sentinel, 'utf8')).toBe('existing-data-must-survive')
  expect(await readdir(parent)).toEqual(before)
})

it('rejects bad output/options/attestation before creating output or sending a request', async () => {
  let calls = 0
  const baseUrl = await fixture((_body, response) => { calls++; response.end() })
  const out = await newOutput()
  const base = { baseUrl, model: 'fixture', actualModel: false, out }
  await expect(recordModelProbe({ ...base, out: 'relative-new-directory' })).rejects.toThrow('ABSOLUTE_NEW_OUTPUT_REQUIRED')
  await expect(recordModelProbe({ ...base, actualModel: undefined } as unknown as Parameters<typeof recordModelProbe>[0])).rejects.toThrow('EXPLICIT_ACTUAL_MODEL_ATTESTATION_REQUIRED')
  await expect(recordModelProbe({ ...base, runs: 0 })).rejects.toThrow('INVALID_PROBE_OPTIONS')
  await expect(stat(out)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(calls).toBe(0)
})

it('CLI requires attestation, returns exit 1 for negative qualification, and never reads credential environment', async () => {
  let calls = 0
  const baseUrl = await fixture((_body, response, request) => {
    calls++
    expect(request.headers.authorization).toBeUndefined()
    expect(request.headers['x-api-key']).toBeUndefined()
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(wire([message('fixture text only')]))
  })
  const out = await newOutput()
  const args = [entry, '--base-url', baseUrl, '--model', 'fixture', '--actual-model', 'true', '--out', out]
  const outcome = await execute(process.execPath, args, { timeout: 10000, env: { LANG: 'C.UTF-8', OPENAI_API_KEY: 'fixture-environment-must-not-be-read' } }).then(
    result => ({ code: 0, stdout: result.stdout, stderr: result.stderr }),
    (error: { code: number; stdout: string; stderr: string }) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
  )
  expect(outcome.code).toBe(1)
  expect(outcome.stderr).toBe('')
  expect(JSON.parse(outcome.stdout)).toMatchObject({ passed: false, actualModel: true, fullCodexCompatibility: false, reportPath: join(await realpath(out), 'report.json') })
  expect(outcome.stdout).toContain('caller attestation')
  expect(outcome.stdout).not.toContain('fixture-environment-must-not-be-read')
  const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8')) as Json
  expect(report['endpointIdentityVerified']).toBe(false)
  const beforeCollision = hash(await readFile(join(out, 'report.json')))
  const callsBeforeCollision = calls
  const collision = await execute(process.execPath, args, { timeout: 10000, env: { LANG: 'C.UTF-8' } }).then(
    result => ({ code: 0, stdout: result.stdout }),
    (error: { code: number; stdout: string }) => ({ code: error.code, stdout: error.stdout }),
  )
  expect(collision.code).toBe(2)
  expect(JSON.parse(collision.stdout)).toMatchObject({ error: { code: 'OUTPUT_EXISTS' } })
  expect(hash(await readFile(join(out, 'report.json')))).toBe(beforeCollision)
  expect(calls).toBe(callsBeforeCollision)
  const missingOut = await newOutput()
  const missing = await execute(process.execPath, [entry, '--base-url', baseUrl, '--model', 'fixture', '--out', missingOut], { timeout: 10000, env: { LANG: 'C.UTF-8' } }).then(
    result => ({ code: 0, stdout: result.stdout }),
    (error: { code: number; stdout: string }) => ({ code: error.code, stdout: error.stdout }),
  )
  expect(missing.code).toBe(2)
  expect(JSON.parse(missing.stdout)).toMatchObject({ error: { code: 'MISSING_OR_INVALID_RECORDING_ARGUMENT' } })
  await expect(stat(missingOut)).rejects.toMatchObject({ code: 'ENOENT' })
})
