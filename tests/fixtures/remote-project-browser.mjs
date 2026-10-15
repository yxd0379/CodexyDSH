/** Real packed local/remote Web runtimes; only SSH is replaced by a local forwarding fixture. */
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { createRequire } from 'node:module'
import { cp, mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const [anchorArgument, homeArgument, role = 'driver', sshArgument] = process.argv.slice(2)
if (!anchorArgument || !homeArgument) throw new Error('usage: remote-project-browser.mjs <DSH package.json> <installed temporary home>')
const anchor = resolve(anchorArgument)
const installation = createRequire(anchor)
const published = name => import(pathToFileURL(installation.resolve(name)).href)

if (role !== 'driver') {
  const home = await realpath(homeArgument)
  assert(home.startsWith('/private/tmp/') || home.startsWith('/private/var/folders/') || home.startsWith('/var/folders/'))
  process.env.DSH_HOME = home
  let ctx
  try {
    const [{ runProfile }, { loadProfileDirectory }, { createLaunchEnvironmentSnapshot }] = await Promise.all([
      published('@deepseek-ai/dsh/profile-boot'), published('@deepseek-ai/dsh-app-boot'), published('@deepseek-ai/dsh-launch-environment'),
    ])
    const patchFiles = []
    if (role === 'local') {
      const overlay = join(home, 'remote-project-fixture.yml')
      await writeFile(overlay, `- id: codexy-remote\n  config:\n    ssh: ${JSON.stringify(sshArgument)}\n    hosts:\n      fixture:\n        host: fixture\n        deployment: existing\n        profile: codexy\n        directory: ''\n        node: node\n        dsh: dsh\n`)
      patchFiles.push(overlay)
    }
    const profile = loadProfileDirectory('dsh', join(home, 'profiles/codexy'), anchor)
    const boot = await runProfile({ profile: 'codexy', resolvedProfile: { profile, installAnchor: anchor }, patchFiles,
      environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: { ...process.env } }]),
      args: ['--host', '127.0.0.1', '--port', '0', '--no-open'] })
    ctx = boot.ctx
    const project = join(home, `${role}-project`)
    await mkdir(project)
    const workspace = await ctx.workspaceRegistry.create(project, `${role} project`)
    const created = await ctx.codexySessionController.create({ workspaceId: workspace.id })
    // A completed fixture turn makes the existing history visible without sending a model request.
    const session = ctx.sessions.get(created.sessionId)
    assert(session, 'Fixture Session was not created')
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.codexySessionController.rename({ sessionId: created.sessionId, title: `${role} conversation` })
    process.send({ type: 'ready', url: ctx.connection.authenticatedUrl(`http://127.0.0.1:${ctx.webServer.port}`), session: created, project })
    process.on('message', async message => {
      if (message === 'stop') { await ctx.fiber.dispose(); process.exit(0) }
      if (message?.action === 'disconnectRemote') {
        try { await ctx.remoteLauncher.disconnect('fixture'); process.send({ type: 'commandResult', id: message.id }) }
        catch (error) { process.send({ type: 'commandResult', id: message.id, error: String(error) }) }
      }
    })
  } catch (error) {
    process.send({ type: 'error', message: String(error).replace(/https?:\/\/\S+/g, '[URL]') })
    await ctx?.fiber.dispose()
    process.exit(1)
  }
} else {
  const toolAnchor = process.env.CODEXY_PLAYWRIGHT_PACKAGE
  assert(toolAnchor, 'CODEXY_PLAYWRIGHT_PACKAGE is required')
  const tools = createRequire(resolve(toolAnchor))
  const { chromium, _electron } = tools('playwright')
  const { sshFixture } = await import('../../packages/remote/tests/ssh-fixture.ts')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codexy-remote-browser-')))
  const children = []
  let browser, ssh, page
  async function boot(role, executable) {
    const home = join(root, role)
    await mkdir(home)
    await cp(join(homeArgument, 'profiles'), join(home, 'profiles'), { recursive: true })
    const child = fork(fileURLToPath(import.meta.url), [anchor, home, role, ...(executable ? [executable] : [])], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, DSH_HOME: home },
    })
    children.push(child)
    let log = ''
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { log = (log + data).slice(-8000) })
    return new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error(`${role} startup timeout`)), 60000)
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`${role} exited ${code}: ${log.replace(/https?:\/\/\S+/g, '[URL]')}`)) })
      child.on('message', message => {
        if (message.type === 'ready') { clearTimeout(timer); done({ ...message, child }) }
        if (message.type === 'error') { clearTimeout(timer); reject(new Error(message.message)) }
      })
    })
  }
  async function commandChild(runtime, action) {
    const id = crypto.randomUUID()
    await new Promise((done, reject) => {
      const receive = message => {
        if (message.type !== 'commandResult' || message.id !== id) return
        clearTimeout(timer); runtime.child.off('message', receive)
        if (message.error) reject(new Error(message.error)); else done()
      }
      const timer = setTimeout(() => { runtime.child.off('message', receive); reject(new Error(`${action} timed out`)) }, 10000)
      runtime.child.on('message', receive)
      runtime.child.send({ action, id })
    })
  }
  try {
    const remote = await boot('remote')
    console.log('Remote fixture ready')
    ssh = await sshFixture({ url: remote.url })
    const local = await boot('local', ssh.executable)
    console.log('Local fixture ready')
    const desktop = process.env.CODEXY_TEST_ELECTRON
    let context
    if (desktop) {
      browser = await _electron.launch({ executablePath: desktop,
        args: [fileURLToPath(new URL('./remote-project-electron.cjs', import.meta.url))],
        env: { ...process.env, CODEXY_REMOTE_BROWSER_URL: local.url, CODEXY_REMOTE_BROWSER_USER_DATA: join(root, 'electron-user-data') } })
      context = browser.context()
      page = await browser.firstWindow()
    } else {
      browser = await chromium.launch({ headless: true, executablePath: process.env.CODEXY_CHROMIUM_EXECUTABLE
        || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
      context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' })
      page = await context.newPage()
    }
    await context.route('**/*', route => {
      const url = new URL(route.request().url())
      return ['http:', 'https:'].includes(url.protocol) && url.hostname !== '127.0.0.1' ? route.abort() : route.continue()
    })
    const errors = []
    page.on('response', response => { if (response.status() >= 400) console.error('Failed resource:', response.status(), new URL(response.url()).pathname) })
    page.on('pageerror', error => { errors.push(error.message); console.error('Page error:', error.message) })
    page.on('console', entry => { if (entry.type() === 'error') console.error('Browser error:', entry.text().replace(/https?:\/\/\S+/g, '[URL]')) })
    if (!desktop) await page.goto(local.url, { waitUntil: 'domcontentloaded' })
    else await page.waitForLoadState('domcontentloaded')
    console.log('Browser document ready')
    await page.locator('[data-dsh-boot]').waitFor({ state: 'detached', timeout: 30000 })
    const notice = page.getByRole('dialog').filter({ hasText: /Preview Notice|预览须知|预览(?:版)?说明/iu })
    await notice.waitFor({ state: 'visible', timeout: 10000 })
    await notice.getByRole('button', { name: /^Continue$|^继续$/iu }).click()
    await page.evaluate(() => localStorage.setItem('codexy-fixture-isolation', 'local'))
    // The same add flow selects local and SSH locations; there is no host tree in the footer.
    const workspaces = page.getByRole('region', { name: '工作空间', exact: true })
    assert.equal(await workspaces.count(), 1)
    assert.equal(await page.locator('[data-remote-host], [data-remote-connect], [data-remote-return-local]').count(), 0)
    assert.equal(await page.getByText(/^(?:Remote projects|远端项目)$/u).count(), 0)
    await workspaces.getByRole('button', { name: '添加工作空间', exact: true }).click()
    const creation = page.getByRole('dialog', { name: '添加工作空间', exact: true })
    assert.equal(await creation.getByLabel('位置', { exact: true }).inputValue(), 'local')
    await page.screenshot({ path: join(root, 'workspace-location.png'), fullPage: true })
    await creation.getByLabel('位置', { exact: true }).selectOption('host:fixture')
    await creation.getByLabel('文件夹', { exact: true }).fill(remote.project)
    await creation.getByRole('button', { name: '添加', exact: true }).click()
    console.log('Remote workspace requested through shared add flow')
    await creation.waitFor({ state: 'detached', timeout: 30000 })
    const localSession = workspaces.getByRole('button', { name: 'local conversation', exact: true })
    const remoteSession = workspaces.getByRole('button', { name: 'remote conversation', exact: true })
    await remoteSession.waitFor({ timeout: 30000 })
    await remoteSession.click()
    const frame = page.frameLocator('iframe[data-remote-frame="fixture"]')
    const remoteNotice = frame.getByRole('dialog').filter({ hasText: /Preview Notice|预览须知|预览(?:版)?说明/iu })
    if (await remoteNotice.count()) await remoteNotice.getByRole('button', { name: /^Continue$|^继续$/iu }).click()
    await frame.locator('[data-composer-input][role="textbox"]').waitFor({ timeout: 30000 })
    assert.equal(await frame.locator('body').evaluate(() => globalThis.__DSH_TRANSPORT__?.ownsHost), true)
    assert.equal(await frame.locator('body').evaluate(() => localStorage.getItem('codexy-fixture-isolation')), null)
    await frame.locator('body').evaluate(() => localStorage.setItem('codexy-fixture-isolation', 'remote'))
    assert.equal(await page.evaluate(() => localStorage.getItem('codexy-fixture-isolation')), 'local')
    await frame.locator('[data-composer-input][role="textbox"]').fill('remote draft retained')
    await localSession.click()
    await page.locator('[data-composer-input][role="textbox"]').waitFor({ state: 'visible' })
    await page.locator('[data-composer-input][role="textbox"]').fill('local draft retained')
    assert.equal(await localSession.getAttribute('aria-current'), 'page')
    assert.equal(await workspaces.locator('[data-workspace]').count(), 2, 'Both hosts must share the same workspace list')
    await page.screenshot({ path: join(root, 'unified-local.png'), fullPage: true })
    await remoteSession.click()
    assert.equal(await frame.locator('[data-composer-input][role="textbox"]').innerText(), 'remote draft retained')
    assert.equal(await remoteSession.getAttribute('aria-current'), 'page')
    assert.equal(context.pages().length, 1, 'Remote must not open another window')
    assert.deepEqual(errors, [])
    await page.screenshot({ path: join(root, 'unified-remote.png'), fullPage: true })
    await page.screenshot({ path: join(root, 'remote-project.png'), fullPage: true })
    await commandChild(local, 'disconnectRemote')
    await page.locator('iframe[data-remote-frame="fixture"]').waitFor({ state: 'detached' })
    await page.locator('[data-composer-input][role="textbox"]').waitFor({ state: 'visible' })
    assert.equal(await page.locator('[data-composer-input][role="textbox"]').innerText(), 'local draft retained')
    assert.equal(await workspaces.locator('[data-workspace]').count(), 2, 'Disconnect must preserve the saved remote workspace')
    console.log(JSON.stringify({ success: true, independentHosts: true, unifiedWorkspaces: true, sharedCreateFlow: true, embeddedRemote: true, isolatedStorage: true, retainedDraft: true, disconnectReturnsLocal: true, windows: 1, evidence: root }))
  } catch (error) {
    await page?.screenshot({ path: join(root, 'failure.png'), fullPage: true }).catch(() => {})
    for (const [index, frame] of (page?.frames() ?? []).entries()) {
      console.error('Frame content:', (await frame.locator('body').innerText().catch(() => '')).slice(-3000))
      await writeFile(join(root, `frame-${index}.html`), await frame.content().catch(() => ''))
    }
    console.error(`Browser evidence retained at ${root}`)
    throw error
  } finally {
    await browser?.close()
    for (const child of children.reverse()) {
      if (child.exitCode !== null) continue
      child.send('stop')
      await new Promise(done => {
        const timer = setTimeout(() => { child.kill('SIGTERM'); done() }, 10000)
        child.once('exit', () => { clearTimeout(timer); done() })
      })
    }
    await ssh?.close()
  }
}
