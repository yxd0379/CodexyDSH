/** Prepare a production CLI closure, then seal its Linux ARM64 runtime on that platform. */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  renameSync, statSync, writeFileSync,
} from 'node:fs'
import { createReadStream } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const repository = resolve(import.meta.dirname, '..')

interface CommandOptions {
  readonly cwd: string
  readonly env?: NodeJS.ProcessEnv
}

async function command(executable: string, args: string[], options: CommandOptions): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${executable} exited with ${String(code ?? signal)}`))
    })
  })
}

function manifest(path: string): { name: string; version: string } {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof value !== 'object' || value === null || !('name' in value) || typeof value.name !== 'string'
    || !('version' in value) || typeof value.version !== 'string') throw new Error(`Missing package identity: ${path}`)
  return { name: value.name, version: value.version }
}

/**
 * Omit build metadata and non-Linux native artifacts when copying the deployed runtime.
 * @param path - Path within the production deployment.
 * @param root - Deployment root.
 * @returns Whether the entry belongs in the Linux ARM64 payload.
 */
export function remoteRuntimeFileIncluded(path: string, root: string): boolean {
  const name = relative(root, path).replaceAll('\\', '/')
  const parts = name.split('/')
  if (parts.some(part => ['.bin', '.pnpm', '.modules.yaml', '.pnpm-workspace-state-v1.json'].includes(part))) return false
  if (/\.(?:[cm]?[jt]s|css)\.map$|\.d\.[cm]?ts$|\.tsbuildinfo$/u.test(name)) return false
  if (/\/@codexydsh\/remote\/server(?:\/|$)/u.test('/' + name)) return false
  if (/\/node-pty\/prebuilds\/(?!linux-arm64(?:\/|$))/u.test('/' + name)) return false
  if (/\/node-pty\/third_party\/conpty(?:\/|$)/u.test('/' + name)) return false
  if (/\/node-pty\/build(?:\/|$)/u.test('/' + name)) return false
  if (name.endsWith('.node') && statSync(path).isFile()) {
    const bytes = readFileSync(path)
    if (bytes.length >= 20) {
      // ELF e_machine is the actual executable architecture, not a directory label.
      return bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) && bytes.readUInt16LE(18) === 183
    }
    return false
  }
  return true
}

async function prepare(output: string): Promise<void> {
  if (!existsSync(join(repository, 'apps/cli/lib/bin.js'))) throw new Error('Build the local application artifacts before preparing Remote.')
  const pnpm = process.env.npm_execpath ?? join(repository, 'node_modules/pnpm/bin/pnpm.cjs')
  if (!existsSync(pnpm)) throw new Error('Invoke through the pinned pnpm installation or install repository dependencies first.')
  mkdirSync(output, { recursive: true })
  const root = mkdtempSync(join(output, 'linux-arm64-'))
  const deployed = join(root, 'deployed')
  await command(process.execPath, [pnpm, '--filter', '@deepseek-ai/dsh', 'deploy', '--prod', '--ignore-scripts',
    '--os=linux', '--cpu=arm64', '--libc=glibc', '--config.node-linker=hoisted',
    '--config.enable-global-virtual-store=false', '--config.side-effects-cache=false', deployed], { cwd: repository })
  const payload = join(root, 'payload')
  mkdirSync(payload)
  cpSync(deployed, join(payload, 'dsh'), { recursive: true, dereference: true,
    filter: path => remoteRuntimeFileIncluded(path, deployed) })
  mkdirSync(join(payload, 'bin'))
  cpSync(join(repository, 'packages/ssh/codexy-remote/server-launcher.sh'), join(payload, 'bin/codexydsh'))
  chmodSync(join(payload, 'bin/codexydsh'), 0o755)
  cpSync(fileURLToPath(import.meta.url), join(root, 'build-remote-server.ts'))
  writeFileSync(join(root, 'prepare.json'), JSON.stringify({ format: 1, platform: 'linux-arm64', cli: manifest(join(payload, 'dsh/package.json')) }, null, 2) + '\n')
  const archive = join(root, 'prepared-linux-arm64.tar.gz')
  await command('tar', ['--no-xattrs', '-czf', archive, '-C', root, 'payload', 'build-remote-server.ts', 'prepare.json'], {
    cwd: root, env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
  console.log(`Remote prepared payload: ${archive}`)
  console.log('Finalize inside Linux ARM64 with: node --experimental-strip-types build-remote-server.ts finalize --directory ./payload')
}

interface RegistryArtifact {
  readonly name: string
  readonly version: string
  readonly dist: { readonly tarball: string; readonly integrity: string }
}

function registryArtifact(value: unknown, name: string, version: string): RegistryArtifact {
  if (typeof value !== 'object' || value === null || !('name' in value) || value.name !== name
    || !('version' in value) || value.version !== version || !('dist' in value)
    || typeof value.dist !== 'object' || value.dist === null || !('tarball' in value.dist)
    || typeof value.dist.tarball !== 'string' || !('integrity' in value.dist) || typeof value.dist.integrity !== 'string'
    || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(value.dist.integrity)) throw new Error('Invalid pinned native package metadata')
  return { name, version, dist: { tarball: value.dist.tarball, integrity: value.dist.integrity } }
}

async function nativeSystemPrebuild(payload: string): Promise<void> {
  const directory = join(payload, 'dsh/node_modules/@deepseek-ai/node-addon-system-linux-arm64')
  const pkg = manifest(join(directory, 'package.json'))
  if (existsSync(join(directory, 'bin/landlock-run')) && existsSync(join(directory, 'bin/glibc/system.node'))) return
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${pkg.version}`)
  if (!response.ok) throw new Error(`Cannot read ${pkg.name}@${pkg.version}: HTTP ${response.status}`)
  const artifact = registryArtifact(await response.json(), pkg.name, pkg.version)
  const archiveResponse = await fetch(artifact.dist.tarball)
  if (!archiveResponse.ok) throw new Error(`Cannot download pinned native prebuild: HTTP ${archiveResponse.status}`)
  const bytes = Buffer.from(await archiveResponse.arrayBuffer())
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64')
  if (integrity !== artifact.dist.integrity) throw new Error('Native prebuild package checksum mismatch')
  const cache = mkdtempSync(join(dirname(payload), 'native-prebuild-'))
  const archive = join(cache, 'package.tar.gz')
  writeFileSync(archive, bytes)
  await command('tar', ['-xzf', archive, '-C', cache], { cwd: cache })
  const unpacked = join(cache, 'package')
  if (JSON.stringify(manifest(join(unpacked, 'package.json'))) !== JSON.stringify(pkg)) throw new Error('Native prebuild package identity mismatch')
  cpSync(join(unpacked, 'bin'), join(directory, 'bin'), { recursive: true })
  chmodSync(join(directory, 'bin/landlock-run'), 0o755)
  writeFileSync(join(cache, 'verified.json'), JSON.stringify(artifact, null, 2) + '\n')
}

const nativeSmoke = String.raw`
import { createRequire } from 'node:module';
import { open, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const [root, home] = process.argv.slice(1);
await mkdir(home, { recursive: true });
const require = createRequire(join(root, 'dsh/package.json'));
const pty = require('node-pty');
const terminal = pty.spawn('/bin/sh', ['-c', 'printf CODEXY_REMOTE_PTY_OK'], { cols: 80, rows: 24, cwd: home, env: process.env });
let output = '';
terminal.onData(data => { output += data; });
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => { terminal.kill(); reject(new Error('Remote PTY smoke timed out')); }, 10000);
  terminal.onExit(({ exitCode }) => { clearTimeout(timeout); if (exitCode === 0 && output.includes('CODEXY_REMOTE_PTY_OK')) resolve(); else reject(new Error('Remote PTY smoke failed: ' + output)); });
});
const koffi = require('koffi');
if (koffi.load('libc.so.6').func('int getpid()')() !== process.pid) throw new Error('Remote Koffi smoke failed');
const flock = await import(pathToFileURL(require.resolve('@deepseek-ai/node-addon-system/flock')));
const file = await open(join(home, 'flock-smoke'), 'a', 0o600);
try { await flock.tryLockExclusive(file.fd); } finally { await file.close(); }
console.log('REMOTE_NATIVE_SMOKE_OK linux-arm64 PTY Koffi flock');
`

async function finalize(payload: string, archive: string): Promise<void> {
  if (process.platform !== 'linux' || process.arch !== 'arm64') throw new Error('Finalize must run natively on Linux ARM64.')
  if (!existsSync(join(payload, 'dsh/lib/bin.js')) || !existsSync(join(payload, 'bin/codexydsh'))) throw new Error('Prepared Remote payload is incomplete.')
  if (existsSync(archive)) throw new Error('The output archive already exists; choose a new build directory instead of overwriting it.')
  mkdirSync(join(payload, 'node/bin'), { recursive: true })
  cpSync(process.execPath, join(payload, 'node/bin/node'))
  const nodeLicense = resolve(dirname(process.execPath), '../LICENSE')
  if (existsSync(nodeLicense)) cpSync(nodeLicense, join(payload, 'node/LICENSE'))
  await nativeSystemPrebuild(payload)
  const smokeHome = mkdtempSync(join(dirname(payload), 'runtime-smoke-'))
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/KEY|SECRET|TOKEN|PASSWORD/iu.test(name))),
    DSH_HOME: smokeHome, DSH_TELEMETRY_DISABLED: '1' }
  await command(process.execPath, ['--input-type=module', '-e', nativeSmoke, payload, smokeHome], { cwd: payload, env })
  await command(process.execPath, [join(payload, 'dsh/lib/bin.js'), '--version'], { cwd: payload, env })
  await command(process.execPath, [join(payload, 'dsh/lib/bin.js'), 'web', '--dump-default-config'], { cwd: payload, env })
  await command(process.execPath, [join(payload, 'dsh/lib/bin.js'), 'web', '--help'], { cwd: payload, env })
  const release = { format: 1, platform: 'linux-arm64', node: process.version, cli: manifest(join(payload, 'dsh/package.json')) }
  writeFileSync(join(payload, 'remote-server.json'), JSON.stringify(release, null, 2) + '\n')
  const pending = archive + '.pending-' + randomUUID()
  await command('tar', ['-czf', pending, '-C', payload, 'bin', 'node', 'dsh', 'remote-server.json'], { cwd: payload })
  renameSync(pending, archive)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(archive)) hash.update(chunk)
  writeFileSync(archive + '.sha256', hash.digest('hex') + '  ' + archive.split('/').at(-1) + '\n')
  console.log(`Remote server archive: ${archive}`)
}

/**
 * Prepare on the source machine or finalize in the isolated Linux ARM64 builder.
 * @returns After the requested build stage completes; preserves every intermediate on failure.
 */
export async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ options: { output: { type: 'string' }, directory: { type: 'string' }, archive: { type: 'string' } }, allowPositionals: true })
  const mode = positionals[0]
  if (mode === 'prepare' && values.output !== undefined) {
    if (!isAbsolute(values.output)) throw new Error('--output must be an absolute build directory.')
    await prepare(values.output)
    return
  }
  if (mode === 'finalize' && values.directory !== undefined) {
    const directory = resolve(values.directory)
    await finalize(directory, resolve(values.archive ?? join(dirname(directory), 'codexydsh-server-linux-arm64.tar.gz')))
    return
  }
  throw new Error('Usage: build-remote-server.ts prepare --output /absolute/builds | finalize --directory ./payload [--archive ./server.tar.gz]')
}

if (import.meta.main) main().catch(error => { console.error(error); process.exitCode = 1 })
