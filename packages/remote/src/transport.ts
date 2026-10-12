/** OpenSSH startup and a private Unix-socket forward exposed on an allocated loopback port. */
import { spawn } from 'node:child_process'
import { mkdtemp, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, createConnection, type Socket } from 'node:net'
import { get } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import z from 'zod'
import type { RemoteHostConfig } from './types.ts'
import { remoteBootstrap } from './bootstrap.ts'

/** Deployment-selected SSH timing and retention limits. */
export interface TransportOptions {
  /** Local OpenSSH command or absolute executable path. */
  ssh: string
  /** Deadline for establishing SSH forwarding and authentication. */
  connectTimeoutMs: number
  /** Deadline for starting or rediscovering the remote Web profile. */
  startupTimeoutMs: number
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
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }

function sshArgs(options: TransportOptions): string[] {
  return ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no',
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
    '-o', `ConnectTimeout=${Math.ceil(options.connectTimeoutMs / 1000)}`,
    '-o', `ServerAliveInterval=${options.serverAliveSeconds}`, '-o', `ServerAliveCountMax=${options.serverAliveCount}`]
}

function ownedChild(args: string[], options: TransportOptions) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/iu.test(key) && key !== 'NODE_OPTIONS' && key !== 'NODE_PATH'))
  const child = spawn(options.ssh, args, { stdio: ['ignore', 'pipe', 'pipe'], env })
  let stdout: Buffer = Buffer.alloc(0)
  let stderr: Buffer = Buffer.alloc(0)
  let error: Error | undefined
  const append = (prior: Buffer, chunk: Buffer): Buffer => Buffer.concat([prior, chunk]).subarray(-options.maxOutputBytes)
  child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk) })
  child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk) })
  child.on('error', (failure) => { error = failure })
  const done = new Promise<{ code: number | null; error: string | null }>((resolve) => {
    child.once('close', (code) => { resolve({ code, error: error?.message ?? (stderr.length ? redactTokens(stderr.toString('utf8')) : null) }) })
  })
  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => stopping ??= (async () => {
    child.kill('SIGTERM')
    const force = setTimeout(() => { child.kill('SIGKILL') }, options.stopTimeoutMs)
    try { await done } finally { clearTimeout(force) }
  })()
  return { child, done, stop, output: () => stdout.toString('utf8') }
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
  const request = JSON.stringify({ target, timeoutMs: options.startupTimeoutMs, maxOutputBytes: options.maxOutputBytes,
    readinessPollMs: options.readinessPollMs, probeTimeoutMs: options.connectTimeoutMs })
  const command = [target.node, '--input-type=module', '-e', remoteBootstrap, request].map(quote).join(' ')
  const child = ownedChild([...sshArgs(options), '-o', 'ClearAllForwardings=yes', '--', target.host, command], options)
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(options.startupTimeoutMs)])
  const abort = (): void => { void child.stop() }
  deadline.addEventListener('abort', abort, { once: true })
  try {
    const result = await child.done
    deadline.throwIfAborted()
    if (result.code !== 0) throw new Error(result.error ?? `SSH startup exited with code ${String(result.code)}`)
    const line = child.output().split('\n').find(row => row.startsWith('DSH_REMOTE_READY '))
    if (line === undefined) throw new Error('Remote dsh did not report readiness')
    const value = ready.parse(JSON.parse(line.slice('DSH_REMOTE_READY '.length)))
    const url = new URL(value.url)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/'
      || !url.searchParams.get('token') || url.username || url.password) throw new Error('Remote dsh readiness URL must be authenticated loopback HTTP')
    return url
  } finally {
    deadline.removeEventListener('abort', abort)
    await child.stop()
  }
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
  const ssh = ownedChild([...sshArgs(options), '-N', '-o', 'ClearAllForwardings=no', '-o', 'ExitOnForwardFailure=yes',
    '-L', `${socketPath}:127.0.0.1:${remote.port}`, '--', target.host], options)
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
