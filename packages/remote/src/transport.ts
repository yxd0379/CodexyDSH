/** OpenSSH startup and a private Unix-socket forward exposed on an allocated loopback port. */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, createConnection, type Socket } from 'node:net'
import { get } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import z from 'zod'
import type { RemoteHostConfig } from './types.ts'
import { remoteBootstrap } from './bootstrap.ts'
import { discoverDeploymentRelease } from './deployment-release.ts'
import { buildProvisionProbe, buildProvisionInstall, parseProvisionProbe } from './provision.ts'
import { remoteNetworkEnvironment } from './network.ts'

/** Deployment-selected SSH timing and retention limits. */
export interface TransportOptions {
  /** Local OpenSSH command or absolute executable path. */
  ssh: string
  /** Per-connection askpass environment; authentication responses stay in memory. */
  auth?: Record<string, string>
  /** Deadline for establishing SSH forwarding and authentication. */
  connectTimeoutMs: number
  /** Deadline for starting or rediscovering the remote Web profile. */
  startupTimeoutMs: number
  /** Deadline for probing and provisioning the managed remote runtime. */
  deployTimeoutMs?: number
  /** Grace period before forcefully terminating a local SSH child. */
  stopTimeoutMs: number
  /** Maximum retained bytes per diagnostic stream and remote log tail. */
  maxOutputBytes: number
  /** OpenSSH heartbeat interval in seconds. */
  serverAliveSeconds: number
  /** OpenSSH missed heartbeat limit. */
  serverAliveCount: number
  /** Interval for checking remote startup and local forwarding readiness. */
  readinessPollMs: number
  /** Live connection steps and diagnostics for the owning UI. */
  onProgress?: (message: string) => void
  onOutput?: (message: string) => void
}

/** Joined tunnel lifetime; closing it never stops the remote Harness. */
export interface Tunnel {
  /** Authenticated local loopback URL with remote-page identity. */
  url: string
  /** SSH exit diagnostic, after local resources are released. */
  done: Promise<string>
  /** Release local sockets and SSH.
   * @returns after all owned resources settle.
   */
  close(): Promise<void>
}

/** Remove browser launch tokens from diagnostics.
 * @param text - SSH or startup diagnostic.
 * @returns bounded caller text with URL tokens removed.
 */
export function redactTokens(text: string): string {
  return text.replace(/([?&]token=)[^\s&)]+/gu, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/"'<>]*@/giu, '$1[redacted]@')
}

function sshDiagnostic(text: string): string {
  return redactTokens(text).split(/\r?\n/u).filter(line => !/^\*\* (?:WARNING: connection is not using a post-quantum|This session may be vulnerable|The server may need to be upgraded)/u.test(line)
    && line !== 'setsockopt TCP_NODELAY: Operation not supported on socket').join('\n').trim()
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }

function sshArgs(options: TransportOptions): string[] {
  return ['-T', '-o', `BatchMode=${options.auth === undefined ? 'yes' : 'no'}`, '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no',
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
    '-o', `ConnectTimeout=${Math.ceil(options.connectTimeoutMs / 1000)}`,
    '-o', `ServerAliveInterval=${options.serverAliveSeconds}`, '-o', `ServerAliveCountMax=${options.serverAliveCount}`]
}

function ownedChild(args: string[], options: TransportOptions, input = false, executable?: string) {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/iu.test(key) && key !== 'NODE_OPTIONS' && key !== 'NODE_PATH')),
    ...(executable === undefined ? options.auth : {}), ...(executable === 'tar' ? { COPYFILE_DISABLE: '1' } : {}) }
  const child = spawn(executable ?? options.ssh, args, { stdio: ['pipe', 'pipe', 'pipe'], env })
  if (!input) child.stdin.end()
  let stdout: Buffer = Buffer.alloc(0)
  let stderr: Buffer = Buffer.alloc(0)
  let error: Error | undefined
  const append = (prior: Buffer, chunk: Buffer): Buffer => Buffer.concat([prior, chunk]).subarray(-options.maxOutputBytes)
  child.stdout.on('data', (chunk: Buffer) => {
    stdout = append(stdout, chunk)
    if (input) options.onOutput?.(redactTokens(chunk.toString('utf8')))
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = append(stderr, chunk)
    const text = sshDiagnostic(chunk.toString('utf8'))
    for (const line of text.split('\n')) {
      if (line.startsWith('DSH_REMOTE_PROGRESS ')) options.onProgress?.(line.slice(20))
      else if (line) options.onOutput?.(line)
    }
  })
  child.on('error', (failure) => { error = failure })
  const done = new Promise<{ code: number | null; error: string | null }>((resolve) => {
    child.once('close', (code) => { resolve({ code, error: error?.message ?? (sshDiagnostic(stderr.toString('utf8')) || null) }) })
  })
  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => stopping ??= (async () => {
    child.kill('SIGTERM')
    const force = setTimeout(() => { child.kill('SIGKILL') }, options.stopTimeoutMs)
    try { await done } finally { clearTimeout(force) }
  })()
  return { child, done, stop, output: () => stdout.toString('utf8') }
}

async function sshCommand(target: RemoteHostConfig, command: string, options: TransportOptions, signal: AbortSignal, action: string, input?: Readable): Promise<string> {
  if (signal.aborted) input?.destroy()
  signal.throwIfAborted()
  const args = [...sshArgs(options), '-o', 'ClearAllForwardings=yes', '--', target.host]
  // Embedded installer/bootstrap sources are long; show the real SSH options and name that script.
  options.onOutput?.('$ ' + [options.ssh, ...args].map(quote).join(' ') + ' <' + action + '>')
  const environment = Object.entries(remoteNetworkEnvironment(target)).map(([name, value]) => `${name}=${quote(value)}`).join(' ')
  const child = ownedChild([...args, (environment ? `export ${environment}; ` : '') + command], options, input !== undefined)
  const abort = (): void => { void child.stop() }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const uploaded = input === undefined ? Promise.resolve(undefined)
    : pipeline(input, child.child.stdin, { signal }).then(() => undefined, (error: unknown) => error)
  try {
    const result = await child.done
    const uploadError = await uploaded
    signal.throwIfAborted()
    if (result.code !== 0) throw new Error(result.error ?? `SSH command exited with code ${String(result.code)}`)
    if (uploadError !== undefined) throw uploadError
    return child.output()
  } finally {
    signal.removeEventListener('abort', abort)
    await child.stop()
    input?.destroy()
  }
}

async function provisionRemote(target: RemoteHostConfig, options: TransportOptions, signal: AbortSignal): Promise<RemoteHostConfig> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(options.deployTimeoutMs ?? 600_000)])
  const release = await discoverDeploymentRelease()
  options.onProgress?.('检查远端服务端版本')
  deadline.throwIfAborted()
  const found = parseProvisionProbe(await sshCommand(target, buildProvisionProbe(release.key, target.profile), options, deadline, '检查服务端版本脚本'))
  if (found.profile !== target.profile) throw new Error('Remote deployment reported an unexpected profile')
  if (found.installed) {
    options.onProgress?.('复用已安装的服务端，无需下载')
    return { ...target, node: found.node, dsh: found.dsh, profile: found.profile }
  }
  options.onProgress?.('同步服务端更新')
  const root = await mkdtemp(join(tmpdir(), 'codexy-remote-upload-'))
  try {
    const archive = join(root, 'release.tar.gz')
    const tar = ownedChild(['--no-xattrs', '-czf', archive, '-C', release.directory, ...release.files.map(file => file.file)], options, false, 'tar')
    const abort = (): void => { void tar.stop() }
    deadline.addEventListener('abort', abort, { once: true })
    if (deadline.aborted) abort()
    try {
      const result = await tar.done
      deadline.throwIfAborted()
      if (result.code !== 0) throw new Error(result.error ?? `Remote deployment archive creation exited with code ${String(result.code)}`)
    } finally { deadline.removeEventListener('abort', abort); await tar.stop() }
    const hash = createHash('sha256')
    await pipeline(createReadStream(archive), hash, { signal: deadline })
    const command = buildProvisionInstall({ releaseId: release.key, sha256: hash.digest('hex'), dshVersion: release.platformVersion, profile: target.profile })
    const installed = parseProvisionProbe(await sshCommand(target, command, options, deadline, '安装服务端脚本，发布包从标准输入上传', createReadStream(archive)))
    if (!installed.installed || installed.profile !== target.profile) throw new Error('Remote deployment did not report the installed profile')
    return { ...target, node: installed.node, dsh: installed.dsh, profile: installed.profile }
  } finally { await rm(root, { recursive: true, force: true }) }
}

const ready = z.object({ url: z.url() }).strict()

/** Start or rediscover the configured remote Web profile.
 * @param target - remote executables and initial workspace.
 * @param options - local OpenSSH configuration.
 * @param signal - caller cancellation; a launched remote server remains running.
 * @returns the remote authenticated loopback URL.
 */
export async function launchRemote(target: RemoteHostConfig, options: TransportOptions, signal: AbortSignal): Promise<URL> {
  signal.throwIfAborted()
  const networkEnv = remoteNetworkEnvironment(target)
  options.onOutput?.(target.proxyMode === 'custom' ? '远端网络：SSH 主机设置 → 指定代理 ' + redactTokens(target.proxyUrl ?? '')
    + (target.noProxy ? `；NO_PROXY=${target.noProxy}` : '')
    : target.proxyMode === 'direct' ? '远端网络：SSH 主机设置 → 直连'
      : '远端网络：继承远端 SSH 环境及 DSH home .env（由 DSH 上游解析）')
  if (target.deployment !== 'existing') target = await provisionRemote(target, options, signal)
  options.onProgress?.('启动或复用远端 DSH 服务')
  const request = JSON.stringify({ target, networkEnv, timeoutMs: options.startupTimeoutMs, maxOutputBytes: options.maxOutputBytes,
    readinessPollMs: options.readinessPollMs, probeTimeoutMs: options.connectTimeoutMs })
  const command = [target.node, '--input-type=module', '-e', remoteBootstrap, request].map(quote).join(' ')
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(options.startupTimeoutMs)])
  const output = await sshCommand(target, command, options, deadline, '启动或复用 DSH 脚本')
  const line = output.split('\n').find(row => row.startsWith('DSH_REMOTE_READY '))
  if (line === undefined) throw new Error('Remote dsh did not report readiness')
  const value = ready.parse(JSON.parse(line.slice('DSH_REMOTE_READY '.length)))
  const url = new URL(value.url)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/'
    || !url.searchParams.get('token') || url.username || url.password) throw new Error('Remote dsh readiness URL must be authenticated loopback HTTP')
  return url
}

function probe(url: URL, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = get(url, { signal }, (response) => {
      response.resume()
      if (response.statusCode === 303) resolve()
      else reject(new Error(`Remote authentication probe returned HTTP ${String(response.statusCode)}`))
    })
    request.on('error', reject)
  })
}

/** Open an authenticated, loopback-only forwarding endpoint with an OS-allocated port.
 * @param target - SSH destination.
 * @param remote - validated remote Web launch URL.
 * @param options - local OpenSSH timing and diagnostic limits.
 * @param signal - cancellation while establishing the tunnel.
 * @returns the local launch URL and joined tunnel cleanup.
 */
export async function openTunnel(target: RemoteHostConfig, remote: URL, options: TransportOptions, signal: AbortSignal): Promise<Tunnel> {
  signal.throwIfAborted()
  options.onProgress?.('建立 SSH 隧道')
  if (process.platform === 'win32') throw new Error('Remote SSH currently requires Linux or macOS on the local machine')
  const root = await mkdtemp(join(tmpdir(), 'codexy-remote-'))
  const socketPath = join(root, 'forward.sock')
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    const forwarded = createConnection(socketPath)
    for (const stream of [socket, forwarded]) {
      sockets.add(stream)
      stream.on('error', () => { socket.destroy(); forwarded.destroy() })
      stream.once('close', () => { sockets.delete(stream) })
    }
    socket.pipe(forwarded).pipe(socket)
  })
  const args = [...sshArgs(options), '-N', '-o', 'ClearAllForwardings=no', '-o', 'ExitOnForwardFailure=yes',
    '-L', `${socketPath}:127.0.0.1:${remote.port}`, '--', target.host]
  options.onOutput?.('$ ' + [options.ssh, ...args].map(quote).join(' '))
  const ssh = ownedChild(args, options)
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => closing ??= (async () => {
    const closed = new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    const drained = [...sockets].map(socket => new Promise<void>((resolve) => { socket.once('close', () => { resolve() }); socket.destroy() }))
    await Promise.all([closed, ...drained, ssh.stop()])
    await rm(root, { recursive: true, force: true })
  })()
  const done = ssh.done.then(async (result) => { await close(); return result.error ?? `SSH tunnel exited with code ${String(result.code)}` })
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(options.connectTimeoutMs)])
  const abort = (): void => { void close() }
  deadline.addEventListener('abort', abort, { once: true })
  try {
    await new Promise<void>((resolve, reject) => {
      const aborted = (): void => {
        cleanup(); reject(deadline.reason instanceof Error ? deadline.reason : new Error(String(deadline.reason)))
      }
      const cleanup = (): void => { server.removeListener('error', failed); deadline.removeEventListener('abort', aborted) }
      const failed = (error: Error): void => { cleanup(); reject(error) }
      deadline.addEventListener('abort', aborted, { once: true })
      server.once('error', failed)
      server.listen(0, '127.0.0.1', () => { cleanup(); resolve() })
    })
    for (;;) {
      deadline.throwIfAborted()
      if (closing !== undefined) throw new Error(await done)
      try { await stat(socketPath); break }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
      await delay(options.readinessPollMs, undefined, { signal: deadline })
    }
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Remote forwarding listener has no TCP address')
    const url = new URL(remote)
    url.port = String(address.port)
    await probe(url, deadline)
    deadline.throwIfAborted()
    url.hash = new URLSearchParams({ 'codexy-remote': target.host }).toString()
    return { url: url.href, done, close }
  } catch (error) {
    await close()
    throw error
  } finally { deadline.removeEventListener('abort', abort) }
}
