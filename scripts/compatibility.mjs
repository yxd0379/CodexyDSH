/** Validate packed candidates in an owned temporary home, never in a user's installation. */
import { cp, mkdir, mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { installProduct, installerOptions } from './install.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const options = { release: join(root, '.artifacts'), dsh: join(root, 'node_modules/.bin/dsh'), desktopApp: undefined, keep: false }
for (let index = 0; index < args.length; index++) {
  const option = args[index]
  if (option === '--keep') { options.keep = true; continue }
  if (!['--release', '--dsh', '--desktop-app'].includes(option) || args[index + 1] === undefined) throw new Error('usage: compatibility.mjs [--release path] [--dsh path] [--desktop-app path] [--keep]')
  options[option === '--desktop-app' ? 'desktopApp' : option.slice(2)] = resolve(args[++index])
}
const temporary = await mkdtemp(join(tmpdir(), 'codexy-packed-compat-'))
const home = join(temporary, 'home'), release = join(temporary, 'candidate')
process.env.PATH = join(root, 'node_modules/.bin') + ':' + process.env.PATH

/** Bound each owned subprocess and retain diagnostic output on failure only. */
async function run(command, argv, timeoutMs = 90000) {
  return new Promise((done, reject) => {
    const child = spawn(command, argv, { cwd: root, env: { ...process.env, DSH_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', bytes => { stdout += bytes })
    child.stderr.on('data', bytes => { stderr += bytes })
    const timer = setTimeout(() => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 2000).unref() }, timeoutMs)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => {
      clearTimeout(timer)
      const sanitize = output => output.replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/gu, '$1?[redacted]')
      code === 0 ? done(stdout) : reject(new Error(`${command} failed (${code}):\n${sanitize(stdout.slice(-16000))}\n${sanitize(stderr.slice(-16000))}`))
    })
  })
}
try {
  await cp(options.release, release, { recursive: true })
  const manifest = JSON.parse(await readFile(join(release, 'release.json'), 'utf8'))
  // The copied candidate is solely for verification and is never published.
  // Production installation remains blocked until this run's evidence promotes the source matrix.
  for (const entry of manifest.platform.compatibility ?? []) entry.status = 'verified'
  await writeFile(join(release, 'release.json'), JSON.stringify(manifest, null, 2) + '\n')
  await mkdir(home)
  await installProduct(installerOptions(['--web', '--release', release, '--home', home, '--dsh', options.dsh]))
  const installation = createRequire(await realpath(options.dsh))
  const anchor = installation.resolve('@deepseek-ai/dsh/package.json')
  const output = await run(process.execPath, [join(root, 'tests/fixtures/packed-runtime-compat.mjs'), anchor, home])
  const line = output.split('\n').find(line => line.startsWith('CODEXY_COMPAT_REPORT '))
  if (line === undefined) throw new Error('packed runtime did not publish its validation report')
  const report = JSON.parse(line.slice('CODEXY_COMPAT_REPORT '.length))
  const headlessOutput = await run(process.execPath, [join(root, 'tests/fixtures/packed-headless-compat.mjs'), anchor, home], 150000)
  const headlessLine = headlessOutput.split('\n').find(line => line.startsWith('CODEXY_HEADLESS_REPORT '))
  if (headlessLine === undefined) throw new Error('packed headless CLI did not publish its validation report')
  report.headless = JSON.parse(headlessLine.slice('CODEXY_HEADLESS_REPORT '.length))
  if (report.headless.version !== report.version) throw new Error('headless verification used a different runtime version')
  async function verifyBrowser(profileName) {
    if (!process.env.CODEXY_PLAYWRIGHT_PACKAGE) return undefined
    const browserOutput = await run(process.execPath, [join(root, 'tests/fixtures/packed-browser-compat.mjs'), anchor, home, profileName])
    const browserLine = browserOutput.split('\n').find(line => line.startsWith('CODEXY_BROWSER_REPORT '))
    if (browserLine === undefined) throw new Error('actual browser did not publish its validation report')
    const browser = JSON.parse(browserLine.slice('CODEXY_BROWSER_REPORT '.length))
    if (browser.version !== report.version) throw new Error('browser verification used a different runtime version')
    return browser
  }
  report.browser = await verifyBrowser('codexy')
  if (options.desktopApp !== undefined) {
    const profile = join(home, 'profiles/desktop')
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-desktop', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }, null, 2) + '\n')
    await installProduct(installerOptions(['--all', '--desktop-app', options.desktopApp, '--release', release, '--home', home]))
    const standardWebOutput = await run(process.execPath, [join(root, 'tests/fixtures/packed-runtime-compat.mjs'), anchor, home, 'web'])
    const standardWebLine = standardWebOutput.split('\n').find(line => line.startsWith('CODEXY_COMPAT_REPORT '))
    if (standardWebLine === undefined) throw new Error('standard Web profile did not publish its validation report')
    const carrier = join(options.desktopApp, 'Contents/Resources/runtime/cli/bin/dsh')
    const standardHeadlessOutput = await run(process.execPath, [join(root, 'tests/fixtures/packed-headless-compat.mjs'), anchor, home, 'headless', carrier], 150000)
    const standardHeadlessLine = standardHeadlessOutput.split('\n').find(line => line.startsWith('CODEXY_HEADLESS_REPORT '))
    if (standardHeadlessLine === undefined) throw new Error('standard headless profile did not publish its validation report')
    report.standardProfiles = { web: JSON.parse(standardWebLine.slice('CODEXY_COMPAT_REPORT '.length)),
      headless: JSON.parse(standardHeadlessLine.slice('CODEXY_HEADLESS_REPORT '.length)), browser: await verifyBrowser('web') }
    const desktop = await run(process.execPath, [join(root, 'tests/fixtures/desktop-compat.mjs'), options.desktopApp, home])
    report.desktop = JSON.parse(desktop.trim())
    if (report.desktop.actualRuntime !== report.version) throw new Error('desktop verification used a different runtime version')
  }
  process.stdout.write(`CODEXY_MATRIX_RESULT ${JSON.stringify(report)}\n`)
} finally {
  if (options.keep) process.stdout.write(`Validation home retained at ${home}\n`)
  else await rm(temporary, { recursive: true, force: true })
}
