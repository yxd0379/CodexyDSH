/** Real Chromium execution of a packed product on one unchanged public DSH. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { accountReply, accountResumeReply, accountSelection, prepareBrowserAccountFixture } from './browser-account-fixture.mjs'

const [anchor, requestedHome, profileName = 'codexy'] = process.argv.slice(2)
if (!anchor || !requestedHome) throw new Error('usage: packed-browser-compat.mjs <DSH package.json> <temporary home> [profile=codexy]')
const home = await realpath(requestedHome)
const temporaryRoots = await Promise.all([tmpdir(), '/private/tmp', '/tmp'].map(path => realpath(path).catch(() => undefined)))
assert(temporaryRoots.some(root => {
  if (!root) return false
  const nested = relative(root, home)
  return nested.length > 0 && !isAbsolute(nested) && nested !== '..' && !nested.startsWith('../')
}), 'browser compatibility must not write to a persistent DSH home')
const playwrightAnchor = process.env.CODEXY_PLAYWRIGHT_PACKAGE
if (!playwrightAnchor) throw new Error('CODEXY_PLAYWRIGHT_PACKAGE must name an independently installed fixed Playwright package.json')
process.env.DSH_HOME = resolve(home)
const installation = createRequire(resolve(anchor))
const tools = createRequire(resolve(playwrightAnchor))
const published = name => import(pathToFileURL(installation.resolve(name)).href)
const sanitized = text => String(text).replace(/https?:\/\/[^\s"'<>]+/gu, '[local URL omitted]')
// Public profile boot may print its launch URL. Never expose authentication URLs,
// cookies, or transport state through the compatibility runner's log stream.
const stdout = process.stdout.write.bind(process.stdout)
process.stdout.write = (chunk, encoding, callback) => stdout(sanitized(Buffer.isBuffer(chunk) ? chunk.toString() : chunk), encoding, callback)
const stderr = process.stderr.write.bind(process.stderr)
process.stderr.write = (chunk, encoding, callback) => stderr(sanitized(Buffer.isBuffer(chunk) ? chunk.toString() : chunk), encoding, callback)

let ctx, browser, accountFixture
const pageErrors = [], consoleErrors = [], scriptFailures = []
try {
  const [{ runProfile }, { loadProfileDirectory }, { createLaunchEnvironmentSnapshot }, { chromium }] = await Promise.all([
    published('@deepseek-ai/dsh/profile-boot'), published('@deepseek-ai/dsh-app-boot'),
    published('@deepseek-ai/dsh-launch-environment'), import(pathToFileURL(tools.resolve('playwright')).href).then(module => module.default ?? module),
  ])
  const profileDir = join(home, 'profiles', profileName)
  const profile = loadProfileDirectory('dsh', profileDir, resolve(anchor))
  accountFixture = await prepareBrowserAccountFixture(home, installation)
  const environment = createLaunchEnvironmentSnapshot([{ source: 'process', values: { ...process.env } }])
  const result = await runProfile({ profile: profileName, resolvedProfile: { profile, installAnchor: resolve(anchor) }, patchFiles: [accountFixture.overlay],
    environment, args: ['--host', '127.0.0.1', '--port', '0', '--no-open'] })
  ctx = result.ctx
  assert(ctx.get('codexySessionController'), 'packed product Session controller did not activate')
  assert(ctx.get('clientModules'), 'public browser graph did not activate')
  assert(ctx.get('connection'), 'public browser authentication did not activate')
  assert.deepEqual(ctx.agentDefaultModel.currentSelection(), accountSelection, 'fixture did not retain the account-provider selection seen by the user')
  assert.equal((await ctx.deepseekAccount.getState()).status, 'credential-stored', 'public fixture account did not activate')
  const catalog = await ctx.codexySessionController.modelCatalog()
  // Test setup registers only an existing directory in this temporary home;
  // session creation, model choice and message submission still run in the UI.
  await ctx.workspaceRegistry.create(home, 'Browser account fixture')
  const beforeIds = new Set(ctx.sessions.list().map(session => session.id))
  const origin = `http://127.0.0.1:${ctx.webServer.port}`
  const graph = ctx.clientModules.graph()
  const productEntries = graph.entries.filter(entry => entry.id.startsWith('@codexydsh/')).map(entry => entry.id)
  assert(productEntries.length >= 15, 'packed product browser graph was incomplete')
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.CODEXY_CHROMIUM_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--no-first-run'],
  })
  const browserContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' })
  await browserContext.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      if (url.origin !== origin) return route.abort('blockedbyclient')
    }
    return route.continue()
  })
  const page = await browserContext.newPage()
  await page.addInitScript(() => {
    globalThis.__codexyModelFailures = []
    document.addEventListener('DOMContentLoaded', () => {
      const observe = () => {
        const text = document.body?.innerText ?? ''
        const match = text.match(/.{0,40}(?:session\/model-unavailable|no adapter serves provider|model.{0,25}unavailable|模型.{0,25}不可用|不可用.{0,25}模型).{0,100}/iu)
        if (match && !globalThis.__codexyModelFailures.includes(match[0])) globalThis.__codexyModelFailures.push(match[0])
      }
      new MutationObserver(observe).observe(document.documentElement, { subtree: true, childList: true, characterData: true })
      observe()
    }, { once: true })
  })
  page.on('pageerror', error => pageErrors.push(sanitized(error.message)))
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(sanitized(message.text())) })
  page.on('requestfailed', request => {
    if (request.resourceType() === 'script' && new URL(request.url()).origin === origin) {
      scriptFailures.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText })
    }
  })
  page.on('response', response => {
    if (response.request().resourceType() === 'script' && response.status() >= 400) {
      scriptFailures.push({ path: new URL(response.url()).pathname, status: response.status() })
    }
  })
  const response = await page.goto(ctx.connection.authenticatedUrl(origin), { waitUntil: 'domcontentloaded', timeout: 30000 })
  assert(response?.ok(), 'authenticated browser entry did not respond successfully')
  try {
    await page.locator('[data-composer-input][role="textbox"]').waitFor({ state: 'visible', timeout: 30000 })
    await page.locator('[data-dsh-boot]').waitFor({ state: 'detached', timeout: 5000 })
  } catch (error) {
    const boot = await page.locator('[data-dsh-boot]').textContent().catch(() => '')
    throw new Error(sanitized(JSON.stringify({ failure: error.message, boot, pageErrors, consoleErrors, scriptFailures })))
  }
  // Fresh isolated browser storage follows the same preview-notice step as a
  // new user; dismiss it through its real button, never force a covered click.
  const previewNotice = page.getByRole('dialog').filter({ hasText: /Preview Notice|预览须知|预览说明/iu })
  if (await previewNotice.count()) await previewNotice.getByRole('button', { name: /^Continue$|^继续$/iu }).click({ timeout: 5000 })
  const ui = await page.evaluate(() => ({
    composer: Boolean(document.querySelector('[data-composer-input][role="textbox"]')),
    newSession: [...document.querySelectorAll('button, [role="button"]')].some(node =>
      /new\s+(session|conversation)|新(?:建)?(会话|对话)/iu.test([node.textContent, node.getAttribute('aria-label'), node.getAttribute('title')].filter(Boolean).join(' '))),
    newSessionIndex: [...document.querySelectorAll('button, [role="button"]')].findIndex(node =>
      node.getClientRects().length > 0 && /new\s+(session|conversation)|新(?:建)?(会话|对话)/iu.test([node.textContent, node.getAttribute('aria-label'), node.getAttribute('title')].filter(Boolean).join(' '))),
    productStyles: [...document.querySelectorAll('style[data-codexy-css]')].map(node => node.getAttribute('data-codexy-css')),
    bootstrapVisible: Boolean(document.querySelector('[data-dsh-boot]')),
  }))
  assert(ui.composer, 'actual product composer did not mount')
  assert(!ui.bootstrapVisible, 'client bootstrap failure page remained visible')
  assert(ui.productStyles.some(name => name?.startsWith('@codexydsh/ui-conversation/')), 'the visible composer was not the product conversation UI')
  assert(ui.newSession, 'new-session action was not visible in the actual UI')
  assert(ui.newSessionIndex >= 0, 'new-session action was not visible')
  const composer = page.locator('[data-composer-input][role="textbox"]')
  // New-session navigation is fire-and-forget and the contenteditable is
  // resident: click completion/visibility can still expose the old editor.
  // Observe the selected sidebar identity and the session-bound composer
  // seats before writing anything. Its optional Codexful footer is another
  // identity check, not a prerequisite for the default first-run UI.
  async function waitForBoundComposer({ previousId, expectedId } = {}) {
    const state = await page.waitForFunction(({ previousId, expectedId }) => {
      const visible = node => node.getClientRects().length > 0
      const selected = [...document.querySelectorAll('[data-row-key^="session:"][aria-selected="true"]')].filter(visible)
      const threads = [...document.querySelectorAll('[data-thread-id]')].filter(visible)
      if (selected.length !== 1) return false
      const id = selected[0].getAttribute('data-row-key')?.slice('session:'.length)
      if (!id || id === previousId || (expectedId && id !== expectedId)) return false
      if (threads.length > 0 && (threads.length !== 1 || threads[0].getAttribute('data-thread-id') !== id)) return false
      const inputs = [...document.querySelectorAll('[data-composer-input][role="textbox"]')].filter(visible)
      if (inputs.length !== 1) return false
      const input = inputs[0], owner = input.closest('[data-composer-card]')
      if (!input || !visible(input) || input.getAttribute('contenteditable') !== 'true' || input.getAttribute('data-phase') !== 'plain') return false
      if (!owner) return false
      const buttons = [...owner.querySelectorAll('button')].filter(visible)
      const model = buttons.find(node => /^Select model, current|^选择模型，当前/iu.test(node.getAttribute('aria-label') ?? ''))
      const permission = buttons.find(node => /^Access mode, current:|^访问模式，当前：/iu.test(node.getAttribute('aria-label') ?? ''))
      if (!model || model.disabled || model.getAttribute('aria-busy') === 'true' || !permission || permission.disabled) return false
      return { id, editable: true, phase: input.getAttribute('data-phase'), model: model.getAttribute('aria-label'), footerChecked: threads.length === 1 }
    }, { previousId, expectedId }, { timeout: 5000 })
    try { return await state.jsonValue() } finally { await state.dispose() }
  }
  let initialBinding, newBinding
  let submission
  try {
    // First restore/create must finish before New session begins another
    // navigation. Otherwise both can race and clear the user's first draft.
    initialBinding = await waitForBoundComposer()
    await page.getByRole('button', { name: /new\s+(session|conversation)|新(?:建)?(会话|对话)/iu }).first().click({ timeout: 5000 })
    newBinding = await waitForBoundComposer({ previousId: initialBinding.id })
    await composer.fill('你好', { timeout: 5000 })
    submission = await composer.evaluate(node => ({ text: node.textContent, phase: node.getAttribute('data-phase'), editable: node.getAttribute('contenteditable') }))
    // A DOM input event precedes Lexical's published draft. Clicking the actual
    // send button waits for its enabled state instead of racing an Enter keymap.
    await page.getByRole('button', { name: /^Send message$|^发送消息$/iu }).click({ timeout: 5000 })
    await page.getByText(accountReply, { exact: false }).first().waitFor({ state: 'visible', timeout: 15000 })
  } catch (error) {
    accountFixture.assertTransport()
    const modelFailures = await page.evaluate(() => globalThis.__codexyModelFailures)
    throw new Error(JSON.stringify({ failure: 'actual UI account-model submission did not complete', selection: accountSelection,
      accountRoutable: catalog.routableProviders.includes('deepseek-account'), accountModels: catalog.groups.find(group => group.id === 'deepseek-account')?.models.map(model => model.id) ?? [],
      modelRequests: accountFixture.requests.length, modelFailures,
      initialBinding, newBinding,
      submission, composer: await composer.evaluate(node => ({ text: node.textContent, phase: node.getAttribute('data-phase'), editable: node.getAttribute('contenteditable') })),
      sessions: ctx.sessions.list().map(session => ({ id: session.id, events: session.snapshotEvents().map(event => event.type),
        savedHello: session.snapshotEvents().some(event => JSON.stringify(event.data).includes('你好')) })),
      pageErrors, consoleErrors, scriptFailures,
      dialogs: (await page.getByRole('dialog').allTextContents()).map(text => text.slice(0, 100)), cause: error.message }))
  }
  assert(catalog.routableProviders.includes('deepseek-account'), 'default account model used an unregistered provider')
  assert(catalog.groups.find(group => group.id === 'deepseek-account')?.models.some(model => model.id === accountSelection.model), 'default account model was absent from the public catalog')
  const created = ctx.sessions.list().filter(session => !beforeIds.has(session.id))
  // Fresh UI navigation can create an initial blank and a separate New session.
  // The public inference attribution identifies the one the user submitted.
  const submitted = created.filter(session => session.id === accountFixture.sessionIds[0])
  assert.equal(submitted.length, 1, 'UI did not submit a newly created ordinary session')
  const session = submitted[0], agent = ctx.agents.list().find(agent => agent.id === session.id)
  assert.equal(session.id, newBinding.id, 'UI submitted a different session than its visibly bound composer')
  assert(agent, 'UI-created session did not resume its real product agent')
  await agent.whenIdle()
  accountFixture.assertTransport()
  assert.equal(accountFixture.requests.length, 2, 'actual UI submission did not execute a tool and continue the account-model turn')
  assert(accountFixture.sessionIds.every(id => id === session.id), 'UI tool continuation used a different session')
  assert(accountFixture.requests[1].messages.some(message => message.content?.some(block => block.type === 'tool_result')), 'account inference did not receive the real tool result')
  await ctx.sessionPersistence.flush()
  const product = createRequire(join(profileDir, 'package.json'))
  const { decodeCodexyArtifact } = await import(pathToFileURL(product.resolve('@codexydsh/runtime/persistence')).href)
  const path = join(home, 'sessions/codexy', `${session.id}.codexy.jsonl`), before = await readFile(path)
  const artifact = decodeCodexyArtifact(before)
  const requestHeaders = artifact.events.filter(event => event.type === 'request/header')
  assert(requestHeaders.length > 0, 'UI account turn did not save its actual inference route')
  for (const event of requestHeaders) assert.deepEqual({ provider: event.data.header.config.provider, model: event.data.header.config.model,
    reasoningEffort: event.data.header.config.reasoningEffort }, accountSelection, 'UI silently changed the default account route')
  assert(artifact.events.some(event => event.type === 'tool/result'), 'UI tool result did not become durable')
  assert(artifact.events.some(event => event.type === 'turn/end' && event.data.reason?.kind === 'completed'), 'UI account turn did not finish successfully')
  assert.equal((await page.evaluate(() => globalThis.__codexyModelFailures)).length, 0, 'the UI displayed a model-unavailable failure')
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
  await composer.waitFor({ state: 'visible', timeout: 30000 })
  await page.getByText(accountReply, { exact: false }).first().waitFor({ state: 'visible', timeout: 15000 })
  await waitForBoundComposer({ expectedId: session.id })
  await composer.fill('继续')
  await page.getByRole('button', { name: /^Send message$|^发送消息$/iu }).click({ timeout: 5000 })
  await page.getByText(accountResumeReply, { exact: false }).first().waitFor({ state: 'visible', timeout: 15000 })
  const resumedAgent = ctx.agents.list().find(agent => agent.id === session.id)
  assert(resumedAgent, 'browser reload did not resume the same durable session')
  await resumedAgent.whenIdle()
  accountFixture.assertTransport()
  assert.equal(accountFixture.requests.length, 3, 'browser reload did not resume the account-model conversation')
  assert(accountFixture.sessionIds.every(id => id === session.id), 'browser reload submitted a different session')
  assert(accountFixture.requests[2].messages.some(message => message.role === 'assistant' && message.content?.some(block => block.type === 'text' && block.text === accountReply)), 'reloaded account request lost saved assistant history')
  await ctx.sessionPersistence.flush()
  const after = await readFile(path), restored = decodeCodexyArtifact(after)
  assert(after.subarray(0, before.length).equals(before), 'browser resume rewrote the saved session prefix')
  assert(restored.events.length > artifact.events.length, 'browser follow-up did not append durable events')
  assert.equal(restored.events.findLast(event => event.type === 'turn/end')?.data.reason?.kind, 'completed', 'reloaded UI account turn did not complete durably')
  const resumedHeader = restored.events.findLast(event => event.type === 'request/header')?.data.header.config
  assert.deepEqual({ provider: resumedHeader?.provider, model: resumedHeader?.model, reasoningEffort: resumedHeader?.reasoningEffort }, accountSelection, 'reload changed the saved account route')
  assert.equal((await page.evaluate(() => globalThis.__codexyModelFailures)).length, 0, 'reloaded UI displayed a model-unavailable failure')
  assert.equal(scriptFailures.length, 0, 'a product or platform browser script failed to load')
  assert.equal(pageErrors.length, 0, 'actual browser execution raised an exception')
  const bootstrapErrors = consoleErrors.filter(message => /web boot:|import failed|did not activate|Cannot find module|does not provide an export|ReferenceError|TypeError/iu.test(message))
  assert.equal(bootstrapErrors.length, 0, 'actual browser plugins failed to bootstrap')
  const manifest = JSON.parse(await readFile(anchor, 'utf8'))
  process.stdout.write(`CODEXY_BROWSER_REPORT ${JSON.stringify({ version: manifest.version, profile: profileName,
    chromium: browser.version(), actualClientExecution: true, productPlugins: productEntries.length,
    ui: { newSession: ui.newSession, composer: ui.composer, submitted: true, toolTurn: true, persistence: true, reloadResume: true,
      initialSessionReady: Boolean(initialBinding), newSessionBoundBeforeInput: Boolean(newBinding),
      defaultAccountModel: accountSelection, modelUnavailable: false, modelRequests: accountFixture.requests.length }, bootstrapErrors: bootstrapErrors.length,
    pageErrors: pageErrors.length, scriptFailures: scriptFailures.length, consoleErrors: consoleErrors.length,
  })}\n`)
} catch (error) {
  process.stderr.write(`CODEXY_BROWSER_FAILURE ${sanitized(error.stack || error.message || error)}\n`)
  process.exitCode = 1
} finally {
  await browser?.close()
  await ctx?.fiber.dispose()
  await accountFixture?.close()
}
