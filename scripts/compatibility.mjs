/** Validate packed candidates in an owned temporary home, never in a user's installation. */
import { cp, mkdir, mkdtemp, readFile, rm, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { installProduct, installerOptions } from './install.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const options = { release: join(root, '.artifacts'), dsh: join(root, 'node_modules/.bin/dsh'), keep: false }
for (let index = 0; index < args.length; index++) {
  const option = args[index]
  if (option === '--keep') { options.keep = true; continue }
  if (!['--release', '--dsh'].includes(option) || args[index + 1] === undefined) throw new Error('usage: compatibility.mjs [--release path] [--dsh path] [--keep]')
  options[option.slice(2)] = resolve(args[++index])
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
  process.stdout.write(`CODEXY_MATRIX_RESULT ${JSON.stringify(report)}\n`)
} finally {
  if (options.keep) process.stdout.write(`Validation home retained at ${home}\n`)
  else await rm(temporary, { recursive: true, force: true })
}
