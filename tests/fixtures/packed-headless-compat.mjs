/** Verify two real unmodified CLI invocations against an installed packed headless profile. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

const [anchor, requestedHome, profileName = 'codexy-headless', requestedCli] = process.argv.slice(2)
if (!anchor || !requestedHome) throw new Error('usage: packed-headless-compat.mjs <DSH package.json> <installed temporary home>')

/** Only a disposable home may receive fixture configuration and new Sessions. */
async function temporaryHome(value) {
  const home = await realpath(value)
  const roots = await Promise.all([tmpdir(), '/private/tmp', '/tmp'].map(path => realpath(path).catch(() => undefined)))
  assert(roots.some(root => {
    if (root === undefined) return false
    const nested = relative(root, home)
    return nested.length > 0 && !isAbsolute(nested) && nested !== '..' && !nested.startsWith('../')
  }), 'headless compatibility requires an existing temporary home')
  await readFile(join(home, 'profiles', profileName, 'package.json'), 'utf8')
  return home
}

const home = await temporaryHome(requestedHome)
const manifest = JSON.parse(await readFile(resolve(anchor), 'utf8'))
assert.equal(manifest.name, '@deepseek-ai/dsh')
assert.equal(typeof manifest.version, 'string')
const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
assert.equal(typeof entry, 'string', 'the installed DSH package has no public CLI entry')
const executable = resolve(dirname(resolve(anchor)), entry)
if (requestedCli) {
  const version = spawnSync(requestedCli, ['--version'], { encoding: 'utf8', timeout: 15000, env: { ...process.env, DSH_HOME: home } })
  assert.equal(version.status, 0, 'selected public CLI did not report its version')
  assert.equal(version.stdout.trim(), manifest.version, 'selected CLI differs from the runtime under verification')
}
const sessionRoot = join(home, 'sessions/codexy')
const overlay = join(home, 'headless-compatibility-fixture.yml')
const fixtureKey = 'headless-local-fixture-only'
const requests = []
let providerFailure

/** Retain diagnostics without leaking inherited credentials or launch-token URLs. */
function diagnostic(value) {
  return String(value).replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/gu, '$1?[redacted]')
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(/\b(?:authorization|cookie|token|api[_-]?key|client[_-]?secret|password)\s*["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, '[redacted credential]')
    .slice(-6000)
}

/** Bound real CLI runs, including their shutdown, without an in-process Agent shortcut. */
async function run(arguments_) {
  return new Promise((done, reject) => {
    const child = spawn(requestedCli ?? process.execPath, [...(requestedCli ? [] : [executable]), '--profile', profileName, '--patch', overlay, ...arguments_], {
      cwd: home, env: { ...process.env, DSH_HOME: home, CODEXY_HEADLESS_FIXTURE_KEY: fixtureKey },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = '', timedOut = false, killTimer
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2000)
      killTimer.unref()
    }, 60000)
    const collect = stream => bytes => {
      if (stream === 'stdout') stdout += bytes
      else stderr += bytes
      if (stdout.length + stderr.length > 4 * 1024 * 1024) child.kill('SIGTERM')
    }
    child.stdout.on('data', collect('stdout'))
    child.stderr.on('data', collect('stderr'))
    child.once('error', error => { clearTimeout(timer); clearTimeout(killTimer); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      if (code !== 0 || timedOut || providerFailure !== undefined) {
        reject(new Error(`packed headless CLI failed (code ${code}, signal ${signal ?? 'none'}, timeout ${timedOut}):\n${diagnostic(stdout)}\n${diagnostic(stderr)}${providerFailure === undefined ? '' : '\nprovider: ' + diagnostic(providerFailure)}`))
      } else done({ stdout, stderr })
    })
  })
}

/** Read the durable physical log independently of any runtime resolution hook. */
async function artifact(path) {
  const bytes = await readFile(path)
  assert.equal(bytes.at(-1), 10, 'headless exit did not flush the complete Session')
  const [metadata, ...events] = bytes.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line))
  assert.equal(metadata.kind, 'codexy-session')
  assert.equal(metadata.version, 1)
  assert(events.every((event, index) => event.seq === index), 'headless Session events are not contiguous')
  return { bytes, metadata, events }
}

const provider = createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST')
    assert.equal(new URL(request.url, 'http://127.0.0.1').pathname, '/v1/chat/completions')
    assert.equal(request.headers.authorization, `Bearer ${fixtureKey}`)
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requests.push(body)
    assert.equal(body.model, 'fixture')
    assert(requests.length <= 4, 'headless sent unexpected model requests')
    const toolStep = requests.length % 2 === 1
    const text = requests.length === 2 ? 'CODEXY_HEADLESS_OK' : 'CODEXY_HEADLESS_RESUMED'
    const events = toolStep ? [
      { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `headless-plan-${requests.length}`, type: 'function', function: { name: 'update_plan', arguments: '' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ plan: [{ step: 'Validate the packed headless CLI', status: 'completed' }] }) } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 1 } },
    ] : [
      { choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } },
    ]
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`)
    response.end('data: [DONE]\n\n')
  } catch (error) {
    providerFailure = error
    if (!response.headersSent) response.writeHead(500)
    response.end('local headless fixture failed')
  }
})

try {
  await new Promise((done, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', done) })
  const address = provider.address()
  assert(address && typeof address !== 'string')
  await writeFile(overlay, `- id: agent-default-model\n  config:\n    provider: headless-fixture\n    model: fixture\n- id: codexy-llm-pi-ai\n  config:\n    providers:\n      headless-fixture:\n        api: openai-completions\n        baseURL: http://127.0.0.1:${address.port}/v1\n        apiKeyEnv: CODEXY_HEADLESS_FIXTURE_KEY\n        retryPolicy:\n          mode: normal\n          maxRetries: 0\n        models:\n          - id: fixture\n            reasoningEfforts: false\n`)
  const priorFiles = new Set(await readdir(sessionRoot).catch(error => {
    if (error.code === 'ENOENT') return []
    throw error
  }))
  const first = await run(['Validate the packed headless profile using update_plan.'])
  assert.equal(first.stdout.trim(), 'CODEXY_HEADLESS_OK', 'default headless output is not the final answer')
  assert.equal(requests.length, 2, 'headless did not complete the tool turn')
  assert(requests[1].messages.some(message => message.role === 'tool'), 'headless provider did not receive the tool result')
  const created = (await readdir(sessionRoot)).filter(file => !priorFiles.has(file) && file.endsWith('.codexy.jsonl'))
  assert.equal(created.length, 1, 'headless did not create exactly one durable Session')
  const path = join(sessionRoot, created[0])
  const before = await artifact(path)
  const sessionId = before.metadata.session.id
  assert.equal(created[0], `${sessionId}.codexy.jsonl`)
  assert.equal(before.metadata.session.cwd, home)
  assert(before.events.some(event => event.type === 'tool/result' && event.data.message.isError !== true), 'headless tool result was not durable')
  assert(before.events.some(event => event.type === 'todo/write' && event.data.todos.some(todo => todo.content === 'Validate the packed headless CLI' && todo.status === 'completed')), 'the planning tool did not commit its real effect')
  assert(before.events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'completed'), 'headless turn did not durably complete')

  const second = await run(['--json', '--session-id', sessionId, 'Resume the saved headless conversation and validate update_plan again.'])
  const frames = second.stdout.trim().split('\n').map(line => JSON.parse(line))
  assert(frames.some(frame => frame.type === 'session' && frame.sessionId === sessionId), 'JSON mode did not report the resumed Session')
  const call = frames.find(frame => frame.type === 'tool_call' && frame.tool === 'update_plan')
  assert(call, 'JSON mode did not report a real tool call')
  assert(frames.some(frame => frame.type === 'tool_result' && frame.callId === call.callId && frame.status === 'completed'), 'JSON mode did not report the matching successful tool result')
  assert.equal(frames.at(-1)?.type, 'final')
  assert.equal(frames.at(-1)?.text, 'CODEXY_HEADLESS_RESUMED')
  assert(!frames.some(frame => frame.type === 'error'), 'JSON mode reported a failed run')
  assert.equal(requests.length, 4)
  assert(requests[2].messages.some(message => message.role === 'assistant' && message.content === 'CODEXY_HEADLESS_OK'), 'headless resume lost the original model history')
  const after = await artifact(path)
  assert(after.bytes.subarray(0, before.bytes.length).equals(before.bytes), 'headless resume rewrote the original Session prefix')
  assert.equal(after.metadata.session.id, sessionId)
  assert(after.events.length > before.events.length)
  assert.equal(after.events.filter(event => event.type === 'turn/end' && event.data.reason.kind === 'completed').length, 2)
  assert.equal(after.events.filter(event => event.type === 'todo/write').length, 2)
  process.stdout.write(`CODEXY_HEADLESS_REPORT ${JSON.stringify({ version: manifest.version, profile: profileName, headless: true, actualCli: true, finalText: true, json: true, toolTurn: true, persistence: true, resume: true, modelRequests: requests.length })}\n`)
} finally {
  provider.closeAllConnections()
  await new Promise(done => provider.close(done))
}
