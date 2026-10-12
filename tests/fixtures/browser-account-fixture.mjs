/** Isolated account-service and Messages transport fixtures; never use real grants. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const token = 'codexy-browser-account-fixture-only'
const inferenceOrigin = 'https://api.deepseek.com'
const inferencePath = '/anthropic/v1/messages'
export const accountSelection = { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' }
export const accountReply = '你好，CODEXY_ACCOUNT_UI_OK'
export const accountResumeReply = 'CODEXY_ACCOUNT_UI_RESUMED'

/** Use an unchanged runtime's public account service, and intercept only its official inference URL.
 * @param {string} home - Already validated temporary DSH home.
 * @param {import('node:module').NodeRequire} installation - Actual runtime resolver.
 */
export async function prepareBrowserAccountFixture(home, installation) {
  const accountModule = pathToFileURL(installation.resolve('@deepseek-ai/dsh-deepseek-account')).href
  const plugin = join(home, 'browser-account-fixture.mjs')
  // The public service is mocked, not the product registry or adapter. Account
  // credentials remain Host-only and are valid solely for the official origin.
  await writeFile(plugin, `import Account from ${JSON.stringify(accountModule)};
export default class BrowserAccountFixture extends Account {
  constructor(ctx) { super(ctx); this.closed=false; ctx.effect(()=>()=>{this.closed=true;}); }
  getState() { return Promise.resolve({status:'credential-stored',links:{usageUrl:'https://platform.deepseek.com/usage',topUpUrl:'https://platform.deepseek.com/topup'},attempt:null}); }
  getProfile() { return Promise.resolve({status:'ready',value:{id:'browser-fixture-account',name:'Local fixture account',contact:null,avatarUrl:null}}); }
  getBalance() { return Promise.resolve({status:'ready',value:[{currency:'USD',balance:'10.00'}],bonusWallets:[]}); }
  getUnnotifiedBonuses() { return Promise.resolve({accountId:'browser-fixture-account',bonuses:[]}); }
  ackBonusNotified() { return Promise.resolve(true); }
  startSignIn() { return this.getState(); }
  cancelSignIn() { return this.getState(); }
  signOut() { return Promise.resolve({status:'signed-out',links:{usageUrl:'https://platform.deepseek.com/usage',topUpUrl:'https://platform.deepseek.com/topup'},attempt:null}); }
  async *watch(signal) { while(!signal.aborted&&!this.closed){yield await this.getState();await new Promise(done=>{const timer=setTimeout(finish,100);function finish(){clearTimeout(timer);signal.removeEventListener('abort',finish);done();}signal.addEventListener('abort',finish,{once:true});if(signal.aborted)finish();});} }
  resolveToken(url) { return Promise.resolve(new URL(url).origin===${JSON.stringify(inferenceOrigin)}?${JSON.stringify(token)}:undefined); }
  rejectToken() { throw new Error('fixture account token was unexpectedly rejected'); }
  getPlatformSession() { return Promise.resolve({origin:'https://platform.deepseek.com',token:${JSON.stringify(token)},userId:'browser-fixture-account'}); }
  getDeviceIdentity() { return Promise.resolve({deviceId:'browser-fixture-device',userId:'browser-fixture-account',osVersion:'fixture'}); }
}
`)
  const overlay = join(home, 'browser-account-fixture.yml')
  await writeFile(overlay, `- id: deepseek-account\n  disabled: true\n- insert:\n    - id: browser-account-fixture\n      name: ${JSON.stringify(pathToFileURL(plugin).href)}\n- id: agent-default-model\n  config:\n    provider: deepseek-account\n    model: deepseek-flash\n    reasoningEffort: high\n`)
  const requests = []
  const sessionIds = []
  let transportFailure
  const provider = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST')
      assert.equal(request.url, inferencePath)
      assert.equal(request.headers['x-dsh-auth-token'], token, 'account request did not use its public service credential')
      assert.equal(request.headers['x-api-key'], undefined, 'account request incorrectly used an API key')
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      assert.equal(body.model, accountSelection.model)
      assert.equal(body.thinking?.type, 'enabled')
      assert.equal(body.output_config?.effort, accountSelection.reasoningEffort)
      const sessionId = request.headers['x-deepseek-harness-session-id']
      assert(typeof sessionId === 'string' && sessionId.length > 0, 'account inference did not identify its actual UI session')
      requests.push(body)
      sessionIds.push(sessionId)
      const first = requests.length === 1
      const content = first ? { type: 'tool_use', id: 'browser-account-plan', name: 'update_plan', input: {} } : { type: 'text', text: '' }
      const delta = first ? { type: 'input_json_delta', partial_json: JSON.stringify({ plan: [{ step: 'Verify default account UI submission', status: 'completed' }] }) }
        : { type: 'text_delta', text: requests.length === 2 ? accountReply : accountResumeReply }
      const events = [
        { type: 'message_start', message: { id: `browser-account-${requests.length}`, role: 'assistant', model: accountSelection.model, content: [], usage: { input_tokens: 3, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: content },
        { type: 'content_block_delta', index: 0, delta },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: first ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      ]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
    } catch (error) {
      transportFailure = error
      response.writeHead(500); response.end('local account fixture rejected a request')
    }
  })
  await new Promise((done, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', done) })
  const address = provider.address()
  assert(address && typeof address !== 'string')
  const localOrigin = `http://127.0.0.1:${address.port}`
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url)
    if (url.origin === inferenceOrigin && url.pathname === inferencePath && !url.search && !url.hash) {
      assert.equal(request.headers.get('x-dsh-auth-token'), token, 'official inference destination lacked fixture account credentials')
      return originalFetch(`${localOrigin}${inferencePath}`, { method: request.method, headers: request.headers,
        body: await request.arrayBuffer(), signal: request.signal, redirect: 'error' })
    }
    if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return originalFetch(input, init)
    throw new Error(`account browser fixture blocked external request to ${url.origin}${url.pathname}`)
  }
  return {
    overlay, requests, sessionIds,
    assertTransport() { if (transportFailure !== undefined) throw transportFailure },
    async close() {
      globalThis.fetch = originalFetch
      const closed = new Promise(done => provider.close(done)); provider.closeAllConnections(); await closed
    },
  }
}
