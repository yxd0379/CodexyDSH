/** Opt-in real SSH deployment check. Creates only the explicitly named remote test profile. */
import { launchRemote, openTunnel } from '../../packages/remote/lib/transport.js'

const [host, profile] = process.argv.slice(2)
if (!host || !profile || !/^codexy-auto-test-[A-Za-z0-9_-]+$/u.test(profile)) {
  throw new Error('Usage: node tests/fixtures/remote-auto-live.mjs SSH_HOST codexy-auto-test-UNIQUE_NAME')
}
const target = { host, profile, deployment: 'auto', directory: '', node: 'node', dsh: 'dsh' }
const options = { ssh: 'ssh', connectTimeoutMs: 30000, startupTimeoutMs: 120000,
  deployTimeoutMs: 600000, stopTimeoutMs: 5000, maxOutputBytes: 65536,
  serverAliveSeconds: 10, serverAliveCount: 3, readinessPollMs: 100 }
const controller = new AbortController()
const interrupt = () => controller.abort(new Error('Live validation interrupted'))
process.once('SIGINT', interrupt)
process.once('SIGTERM', interrupt)
try {
  for (const pass of ['first', 'reconnect']) {
    const start = Date.now()
    console.log(`${pass}: connecting to ${host}, profile ${profile}`)
    const remote = await launchRemote(target, options, controller.signal)
    const tunnel = await openTunnel(target, remote, options, controller.signal)
    try {
      // openTunnel already checks authenticated redirect. Never print token or cookies.
      const response = await fetch(tunnel.url, { redirect: 'manual', signal: controller.signal })
      if (response.status !== 303) throw new Error(`Authentication readiness returned ${response.status}`)
      const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
      await response.body?.cancel()
      const pageUrl = new URL(tunnel.url)
      pageUrl.search = ''; pageUrl.hash = ''
      const page = await fetch(pageUrl, { headers: { cookie }, signal: controller.signal })
      if (page.status !== 200 || !(await page.text()).includes('<html')) throw new Error('Authenticated Web page is unavailable')
      console.log(`${pass}: authenticated Web runtime reachable in ${Date.now() - start} ms`)
    } finally { await tunnel.close() }
  }
  console.log('Passed. Test profile and remote runtime retained; no model requests sent.')
} finally {
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', interrupt)
}
