/** Exercise the shipped product through one unmodified installation's public profile boot. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { readFile, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [anchor, requestedHome, profileName = 'codexy'] = process.argv.slice(2)
if (!anchor || !requestedHome) throw new Error('usage: packed-runtime-compat.mjs <DSH package.json> <temporary home> [profile=codexy]')
const home = await realpath(requestedHome)
const temporaryRoots = await Promise.all([tmpdir(), '/private/tmp', '/tmp'].map(path => realpath(path).catch(() => undefined)))
assert(temporaryRoots.some(root => {
  if (!root) return false
  const nested = relative(root, home)
  return nested.length > 0 && !isAbsolute(nested) && nested !== '..' && !nested.startsWith('../')
}), 'runtime compatibility must not write to a persistent DSH home')
process.env.DSH_HOME = resolve(home)
const installation = createRequire(resolve(anchor))
const published = name => import(pathToFileURL(installation.resolve(name)).href)
/** Exchange the public connection URL for an in-memory browser cookie. */
async function browserPage(authenticatedUrl) {
  let url = new URL(authenticatedUrl), cookie = ''
  for (let redirects = 0; redirects < 5; redirects++) {
    const response = await fetch(url, { redirect: 'manual', headers: cookie ? { cookie } : {} })
    const cookies = response.headers.getSetCookie()
    if (cookies.length) cookie = cookies.map(value => value.split(';', 1)[0]).join('; ')
    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && location) {
      const next = new URL(location, url)
      assert.equal(next.origin, url.origin, 'browser authentication redirected off the local server')
      url = next
      continue
    }
    assert.equal(response.status, 200, 'authenticated product page was not available')
    return response.text()
  }
  throw new Error('too many browser authentication redirects')
}
const requests = []
const provider = createServer(async (request, response) => {
  try {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requests.push(body)
    const first = requests.length === 1
    const text = requests.length === 2 ? 'CODEXY_COMPAT_OK' : 'CODEXY_COMPAT_RESUMED'
    const events = first ? [
      { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'compat-plan', type: 'function', function: { name: 'update_plan', arguments: '' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ plan: [{ step: 'Validate the installed product', status: 'completed' }] }) } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 1 } },
    ] : [
      { choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } },
    ]
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`)
    response.end('data: [DONE]\n\n')
  } catch (error) { response.writeHead(500); response.end(String(error)) }
})
await new Promise((done, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', done) })
const address = provider.address()
assert(address && typeof address !== 'string')
const overlay = join(home, 'compatibility-fixture.yml')
await writeFile(overlay, `- id: codexy-llm-pi-ai\n  config:\n    providers:\n      compatibility-fixture:\n        api: openai-completions\n        baseURL: http://127.0.0.1:${address.port}/v1\n        apiKeyEnv: CODEXY_COMPAT_FIXTURE_KEY\n        retryPolicy:\n          mode: normal\n          maxRetries: 0\n        models:\n          - id: fixture\n            reasoningEfforts: false\n`)
process.env.CODEXY_COMPAT_FIXTURE_KEY = 'local-fixture-only'
let ctx
try {
  const [{ runProfile }, { loadProfileDirectory }, { createLaunchEnvironmentSnapshot }, sessions, llm] = await Promise.all([
    published('@deepseek-ai/dsh/profile-boot'), published('@deepseek-ai/dsh-app-boot'),
    published('@deepseek-ai/dsh-launch-environment'), published('@deepseek-ai/dsh-session'), published('@deepseek-ai/dsh-llm'),
  ])
  const profileDir = join(home, 'profiles', profileName)
  const profile = loadProfileDirectory('dsh', profileDir, resolve(anchor))
  const environment = createLaunchEnvironmentSnapshot([{ source: 'process', values: { ...process.env } }])
  const result = await runProfile({ profile: profileName, resolvedProfile: { profile, installAnchor: resolve(anchor) },
    environment, patchFiles: [overlay], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'] })
  ctx = result.ctx
  for (const service of ['agentLoop', 'codexyRequests', 'codexyTools', 'sessionPersistence', 'codexySessionController', 'webServer']) {
    assert(ctx.get(service), `product service ${service} did not activate`)
  }
  const origin = `http://127.0.0.1:${ctx.webServer.port}`
  assert(ctx.connection, 'public browser connection service did not activate')
  assert.match(await browserPage(ctx.connection.authenticatedUrl(origin)), /__DSH_BOOT__/)
  const product = createRequire(join(profileDir, 'package.json'))
  const { decodeCodexyArtifact } = await import(pathToFileURL(product.resolve('@codexydsh/runtime/persistence')).href)
  const id = sessions.SessionId(`codexy-compatibility-${randomUUID()}`)
  const options = { provider: 'compatibility-fixture', model: 'fixture' }
  const handle = await ctx.agents.create({ sessionId: id, meta: { cwd: home }, agentOptions: options })
  handle.agent.followup(llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Check the installed product using update_plan.' }] }))
  await handle.agent.whenIdle()
  assert.equal(requests.length, 2, 'expected a real tool turn and a second model request')
  assert(requests[1].messages.some(message => message.role === 'tool'), 'the provider did not receive the tool result')
  await ctx.sessionPersistence.flush()
  await handle.dispose()
  const path = join(home, 'sessions/codexy', `${id}.codexy.jsonl`)
  const before = await readFile(path)
  const artifact = decodeCodexyArtifact(before)
  assert(artifact.events.some(event => event.type === 'tool/result'), 'tool result was not durable')
  assert(artifact.events.some(event => event.type === 'turn/end' && event.data.reason?.kind === 'completed'), 'the turn did not finish successfully')
  const resumed = await ctx.agents.resume({ resumeSessionId: id, agentOptions: options })
  resumed.agent.followup(llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Resume the saved conversation.' }] }))
  await resumed.agent.whenIdle()
  assert.equal(requests.length, 3)
  assert(requests[2].messages.some(message => message.role === 'assistant' && message.content === 'CODEXY_COMPAT_OK'), 'model history was lost on resume')
  await ctx.sessionPersistence.flush()
  await resumed.dispose()
  const after = await readFile(path)
  assert(after.subarray(0, before.length).equals(before), 'resume rewrote the original session prefix')
  const restored = decodeCodexyArtifact(after)
  assert(restored.events.length > artifact.events.length)
  const manifest = JSON.parse(await readFile(anchor, 'utf8'))
  process.stdout.write(`CODEXY_COMPAT_REPORT ${JSON.stringify({ version: manifest.version, profile: profileName, web: true, toolTurn: true, persistence: true, resume: true, modelRequests: requests.length })}\n`)
} finally {
  await ctx?.fiber.dispose()
  await new Promise(done => provider.close(done))
}
