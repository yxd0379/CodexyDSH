/** Exercise the installed, unmodified macOS Desktop Host without opening a GUI. */
import { fork, spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { open, readFile, realpath } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DESKTOP_PORT = 19387
const REQUIRED_MODULES = ['ui-chat', 'ui-conversation', 'ui-commands', 'ui-approval', 'ui-tool', 'ui-trajectory', 'ui-settings', 'ui-remote', 'ui-mcp'].map(name => `@codexydsh/${name}`)

/** Do not emit launch-token URLs, cookie material, or arbitrary IPC diagnostics.
 * @param {unknown} value - A bounded error message, not response bodies or headers.
 */
export function sanitizedDiagnostic(value) {
  return String(value instanceof Error ? value.message : value)
    .replace(/\bhttps?:\/\/[^\s<>"']+/giu, value => {
      try { const url = new URL(value); return `${url.origin}${url.pathname}` } catch { return '[redacted URL]' }
    })
    .replace(/\bBearer\s+[^\s,;]+/giu, '[redacted bearer]')
    .replace(/\b(?:authToken|access_token|authorization|cookie|token|api[_-]?key|client[_-]?secret|password)\s*["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, '[redacted credential]')
    .slice(0, 2048)
}

/** Reject the user's persistent DSH home; this probe may only start in an owned temporary home.
 * @param {string} home - Existing installed temporary DSH home.
 */
async function temporaryHome(home) {
  const actual = await realpath(home)
  const roots = await Promise.all([tmpdir(), '/private/tmp', '/tmp'].map(path => realpath(path).catch(() => undefined)))
  if (!roots.some(root => {
    if (root === undefined) return false
    const nested = relative(root, actual)
    return nested.length > 0 && !isAbsolute(nested) && nested !== '..' && !nested.startsWith('../')
  })) throw new Error('desktop compatibility probe requires an existing temporary DSH home')
  await readFile(join(actual, 'profiles/desktop/package.json'), 'utf8')
  return actual
}

/** Read just one runtime metadata file; the application archive remains untouched.
 * @param {string} archive - Installed Electron application archive.
 */
async function runtimeVersion(archive) {
  const file = await open(archive, 'r')
  try {
    const prefix = Buffer.alloc(16)
    if ((await file.read(prefix, 0, 16, 0)).bytesRead !== 16) throw new Error('truncated desktop ASAR')
    const size = prefix.readUInt32LE(12), headerSize = prefix.readUInt32LE(4)
    if (size < 2 || size > 16 * 1024 * 1024 || headerSize < size + 8) throw new Error('invalid desktop ASAR')
    const header = Buffer.alloc(size)
    if ((await file.read(header, 0, size, 16)).bytesRead !== size) throw new Error('truncated desktop ASAR header')
    let entry = JSON.parse(header.toString('utf8'))
    for (const part of ['dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json']) entry = entry?.files?.[part]
    if (entry?.unpacked || !Number.isSafeInteger(entry?.size) || entry.size < 2 || entry.size > 1024 * 1024 || !/^\d+$/u.test(entry.offset ?? '')) throw new Error('missing desktop runtime manifest')
    const bytes = Buffer.alloc(entry.size), offset = Number(entry.offset)
    if (!Number.isSafeInteger(offset) || (await file.read(bytes, 0, bytes.length, 8 + headerSize + offset)).bytesRead !== bytes.length) throw new Error('truncated desktop runtime manifest')
    const manifest = JSON.parse(bytes.toString('utf8'))
    if (manifest.name !== '@deepseek-ai/dsh' || typeof manifest.version !== 'string') throw new Error('unexpected desktop runtime manifest')
    return manifest.version
  } finally { await file.close() }
}

/** Briefly bind the Host's fixed loopback port; never terminate another application's listener.
 * @param {number} port - Port to test (exported helper permits ephemeral unit-test ports).
 */
export async function requireAvailablePort(port = DESKTOP_PORT) {
  const server = createServer()
  await new Promise((resolveReady, reject) => {
    server.once('error', error => reject(new Error(error.code === 'EADDRINUSE' ? `desktop Host port ${port} is occupied; fully quit the existing client before validation` : `cannot check desktop Host port ${port}: ${error.code ?? 'unknown error'}`)))
    server.listen(port, '127.0.0.1', () => server.close(error => error === undefined ? resolveReady(undefined) : reject(error)))
  })
}

/** Only the expected loopback origin may be fetched, including authentication redirects.
 * @param {string | URL} value - IPC or graph URL.
 * @param {URL} base - Known Host origin.
 */
function localUrl(value, base) {
  const url = new URL(value, base)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== String(DESKTOP_PORT) || url.origin !== base.origin || url.username !== '' || url.password !== '') throw new Error('desktop Host advertised a non-local URL')
  return url
}

/** Keep credential exchange entirely in memory; never return its URL, cookies, or bodies.
 * @param {string} authenticatedUrl - Host launch URL received over private IPC.
 */
async function browserTransport(authenticatedUrl) {
  const base = new URL(`http://127.0.0.1:${DESKTOP_PORT}/`)
  let current = localUrl(authenticatedUrl, base), cookie = ''
  for (let redirect = 0; redirect < 4; redirect++) {
    const response = await fetch(current, { redirect: 'manual', headers: cookie === '' ? {} : { cookie }, signal: AbortSignal.timeout(10000) })
    const cookies = response.headers.getSetCookie()
    if (cookies.length > 0) cookie = cookies.map(value => value.split(';', 1)[0]).join('; ')
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      await response.arrayBuffer()
      if (location === null) throw new Error('desktop authentication redirect has no location')
      current = localUrl(location, current)
      continue
    }
    if (response.status !== 200) { await response.arrayBuffer(); throw new Error(`desktop HTML returned HTTP ${response.status}`) }
    const html = await response.text()
    if (!response.headers.get('content-type')?.includes('text/html')) throw new Error('desktop endpoint did not serve HTML')
    return { html, async script(path) {
      const result = await fetch(localUrl(path, base), { headers: cookie === '' ? {} : { cookie }, signal: AbortSignal.timeout(10000) })
      if (result.status !== 200) { await result.arrayBuffer(); throw new Error(`desktop browser asset returned HTTP ${result.status}`) }
      if (!result.headers.get('content-type')?.includes('javascript')) throw new Error('desktop browser asset has an unexpected content type')
      return result.text()
    } }
  }
  throw new Error('desktop authentication exceeded the bounded redirect count')
}

/** Start only an owned child process and exercise the desktop Host IPC contract.
 * @param {string} appPath - Installed macOS .app directory.
 * @param {string} home - Packed product installed under a temporary DSH home.
 * @param {number} timeoutMilliseconds - Bounded startup/IPC timeout.
 */
export async function verifyDesktopHost(appPath, home, timeoutMilliseconds = 45000) {
  const dshHome = await temporaryHome(home), app = resolve(appPath), resources = join(app, 'Contents/Resources')
  const executable = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', join(app, 'Contents/Info.plist')], { encoding: 'utf8' })
  if (executable.error !== undefined || executable.status !== 0 || executable.stdout.trim() === '' || /[\/\\\r\n]/u.test(executable.stdout.trim())) throw new Error('cannot resolve the installed desktop executable')
  const actualRuntime = await runtimeVersion(join(resources, 'app.asar'))
  await requireAvailablePort()
  const runtime = join(resources, 'app.asar/dsh'), child = fork(join(runtime, 'node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js'), [
    runtime, join(dshHome, 'profiles/desktop'), join(resources, 'runtime/primary-runtime'), join(resources, 'runtime/pnpm/bin/pnpm.mjs'), join(resources, 'runtime/bin'),
  ], { execPath: join(app, 'Contents/MacOS', executable.stdout.trim()), execArgv: ['--expose-internals'], cwd: dshHome,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: dshHome }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let diagnostic = '', exited = false, shutdownComplete = false
  /** @type {Set<{ type: string, requestId?: number, resolve: (value: any) => void, reject: (error: Error) => void }>} */
  const pending = new Set()
  const exitedPromise = new Promise(resolveExit => {
    child.once('exit', (code, signal) => {
      exited = true
      for (const request of pending) request.reject(new Error(`desktop Host exited before ${request.type} (code ${code ?? 'none'}, signal ${signal ?? 'none'}): ${sanitizedDiagnostic(diagnostic)}`))
      resolveExit({ code, signal })
    })
    child.once('error', () => { exited = true; resolveExit({ code: null, signal: null }) })
  })
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => { diagnostic = (diagnostic + String(chunk)).slice(-8192) })
  child.on('error', error => { for (const request of pending) request.reject(new Error(sanitizedDiagnostic(error))) })
  child.on('message', message => {
    if (typeof message !== 'object' || message === null || !('type' in message)) return
    if (message.type === 'shutdown-complete') shutdownComplete = true
    if (message.type === 'fatal') {
      const error = new Error(`desktop Host startup failed: ${sanitizedDiagnostic('message' in message ? message.message : 'no diagnostic')}`)
      for (const request of pending) request.reject(error)
      return
    }
    for (const request of pending) if (message.type === request.type && (request.requestId === undefined || 'requestId' in message && message.requestId === request.requestId)) request.resolve(message)
  })
  /** @param {string} type @param {number | undefined} requestId */
  const waitMessage = (type, requestId = undefined) => new Promise((resolveMessage, reject) => {
    const request = { type, requestId, resolve: resolveMessage, reject }
    const timeout = setTimeout(() => request.reject(new Error(`desktop Host timed out waiting for ${type}: ${sanitizedDiagnostic(diagnostic)}`)), timeoutMilliseconds)
    const finish = () => { clearTimeout(timeout); pending.delete(request) }
    request.resolve = value => { finish(); resolveMessage(value) }
    request.reject = error => { finish(); reject(error) }
    pending.add(request)
    if (exited) request.reject(new Error(`desktop Host already exited before ${type}`))
  })
  const send = message => new Promise((resolveSent, reject) => child.send(message, error => error === null ? resolveSent(undefined) : reject(new Error(sanitizedDiagnostic(error)))))
  const boundedExit = async duration => Promise.race([exitedPromise, new Promise(resolveTimeout => { const timer = setTimeout(() => resolveTimeout(undefined), duration); timer.unref() })])
  const exercise = async () => {
    const ready = await waitMessage('ready')
    if (typeof ready.url !== 'string' || !Array.isArray(ready.injections)) throw new Error('desktop Host ready IPC lacks its boot inputs')
    const boot = ready.injections.find(row => row?.kind === 'global' && row.name === '__DSH_BOOT__')?.value
    const roster = boot?.entries ?? boot?.modules
    if (!Array.isArray(roster)) throw new Error('desktop Host has no browser module roster')
    const product = roster.filter(row => typeof row?.id === 'string' && row.id.startsWith('@codexydsh/'))
    if (product.length < 15 || REQUIRED_MODULES.some(name => !product.some(row => row.id === name))) throw new Error('desktop Host browser graph is missing required product UI modules')
    const transport = await browserTransport(ready.url)
    if (!transport.html.includes('__DSH_BOOT__') || REQUIRED_MODULES.some(name => !transport.html.includes(name))) throw new Error('desktop HTML does not contain the product browser graph')
    const scripts = new Map()
    for (const row of product) {
      if (typeof row.url !== 'string') throw new Error('desktop product browser module lacks an asset URL')
      if (!scripts.has(row.url)) scripts.set(row.url, await transport.script(row.url))
      if (!scripts.get(row.url).includes(row.id)) throw new Error(`desktop browser asset is missing product registration ${row.id}`)
    }
    const inspected = waitMessage('quit-inspection', 1); inspected.catch(() => undefined); await send({ type: 'quit-inspection', requestId: 1 })
    const inspection = await inspected
    if (typeof inspection.activeTasks !== 'boolean' || typeof inspection.scheduledTasks !== 'boolean' || inspection.error !== undefined) throw new Error('desktop quit-inspection IPC did not complete normally')
    const shutdown = waitMessage('shutdown-complete'); shutdown.catch(() => undefined); await send({ type: 'shutdown' }); await shutdown
    const exit = await boundedExit(10000)
    if (exit === undefined) throw new Error('desktop Host did not exit after shutdown-complete')
    if (exit.code !== 0 || exit.signal !== null) throw new Error('desktop Host did not exit cleanly after shutdown-complete')
    return { desktop: true, actualRuntime, productModules: product.length, browserAssets: scripts.size, html: true, quitInspection: true, shutdownComplete }
  }
  let deadline
  try {
    return await Promise.race([exercise(), new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error('desktop compatibility probe exceeded its overall deadline')), timeoutMilliseconds)
    })])
  } catch (error) { throw new Error(sanitizedDiagnostic(error)) }
  finally {
    clearTimeout(deadline)
    if (!exited && child.connected) await send({ type: 'shutdown' }).catch(() => undefined)
    if (!exited) await boundedExit(3000)
    if (!exited) { child.kill('SIGTERM'); await boundedExit(2000) }
    if (!exited) { child.kill('SIGKILL'); await boundedExit(2000) }
    for (const request of pending) request.reject(new Error('desktop probe closed'))
  }
}

function isEntrypoint(argument) {
  if (argument === undefined) return false
  try { return realpathSync(argument) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
}
if (isEntrypoint(process.argv[1])) {
  try {
    if (process.argv.length !== 4) throw new Error('usage: desktop-compat.mjs <macOS app path> <temporary DSH home>')
    process.stdout.write(JSON.stringify(await verifyDesktopHost(process.argv[2], process.argv[3])) + '\n')
  } catch (error) { process.stderr.write(sanitizedDiagnostic(error) + '\n'); process.exitCode = 1 }
}
