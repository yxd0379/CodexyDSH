/** Saved SSH deployments and locally owned launch/tunnel lifetimes. */
import { Context, type Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteHostConfig, RemoteHostStatus } from './types.ts'
import { launchRemote, openTunnel, redactTokens, type TransportOptions, type Tunnel } from './transport.ts'

export type { RemoteHostConfig, RemoteHostStatus } from './types.ts'

/** Remote catalog and deployment-owned OpenSSH limits. */
export interface Config extends TransportOptions {
  /** Human-named remote hosts; null removes an inherited definition. */
  hosts: Volatile<Record<string, RemoteHostConfig | null>>
}

const executable = z.string().pattern(/^(?=[^\0\r\n]*\S)[^\0\r\n]*(?![\s\S])/u)
const Host: z<RemoteHostConfig> = z.object({
  host: z.string().pattern(/^[^\s\0-][^\s\0]*(?![\s\S])/u).required(),
  profile: z.string().pattern(/^[A-Za-z0-9][A-Za-z0-9_-]*(?![\s\S])/u).default('codexy'),
  directory: z.string().pattern(/^(?:|\/[^\0\r\n]*)(?![\s\S])/u).default(''),
  node: executable.default('node'),
  dsh: executable.default('dsh'),
})
const Hosts = z.dict(z.union([Host, z.const(null)]), z.string().pattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?![\s\S])/u)).default({})

interface Attempt {
  target: RemoteHostConfig
  controller: AbortController
  phase: RemoteHostStatus['phase']
  error: string | null
  tunnel?: Tunnel
  ready: Promise<RemoteHostStatus>
  closing?: Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Remote host catalog and local SSH tunnel owner. */
    remoteLauncher: RemoteLauncher
  }
}

/** Connect remote Web profiles while keeping project and Session ownership on their hosts. */
export class RemoteLauncher extends TypertRemoteService {
  static inject = ['typert']
  static Config = z.object({
    hosts: Hosts.volatile(),
    ssh: executable.default('ssh'),
    connectTimeoutMs: z.natural().min(1).max(2_147_000_000).default(20_000),
    startupTimeoutMs: z.natural().min(1).max(2_147_000_000).default(60_000),
    stopTimeoutMs: z.natural().min(1).max(2_147_483_647).default(5_000),
    maxOutputBytes: z.natural().min(1024).default(65_536),
    serverAliveSeconds: z.natural().min(1).default(10),
    serverAliveCount: z.natural().min(1).default(3),
    readinessPollMs: z.natural().min(1).max(2_147_483_647).default(100),
  })
  private readonly attempts = new Map<string, Attempt>()
  private readonly followers = new Set<() => void>()
  private revision = 0
  private disposed = false

  /** @param ctx - Local Host services and lifetime owner.
   * @param config - Validated catalog and transport limits.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'remoteLauncher', { namespace: 'remoteHosts' })
    ctx.inject(['settings'], (scope) => { scope.effect(() => scope.settings.configure({ auto: false }, ctx.fiber)) })
    ctx.on('loader/volatile-update', () => {
      for (const [name, attempt] of this.attempts) {
        if (JSON.stringify(this.config.hosts.get()[name]) !== JSON.stringify(attempt.target)) {
          void this.disconnect(name).catch((error: unknown) => { ctx.logger.warn('Remote tunnel cleanup failed: %s', String(error)) })
        }
      }
      this.publish()
    })
    ctx.effect(() => async () => {
      this.disposed = true
      this.publish()
      await Promise.all([...this.attempts.values()].map(attempt => this.close(attempt)))
      this.attempts.clear()
    })
  }

  /** Read configured hosts and their local connection states.
   * @returns a complete catalog; launch URLs exist only for live tunnels.
   */
  @Remote
  list(): RemoteHostStatus[] {
    return Object.entries(this.config.hosts.get()).flatMap(([name, target]) => target === null ? [] : [this.status(name, target)])
  }

  /** Follow complete catalogs, coalescing intermediate updates for slow consumers.
   * @param signal - observation lifetime.
   * @returns the current catalog followed by replacements until cancellation or plugin disposal.
   */
  @Remote({ mode: 'stream' })
  async *follow(signal: AbortSignal): AsyncIterable<RemoteHostStatus[]> {
    let observed = -1
    while (!this.disposed && !signal.aborted) {
      if (observed !== this.revision) {
        observed = this.revision
        yield this.list()
        continue
      }
      await new Promise<void>((resolve) => {
        const wake = (): void => { this.followers.delete(wake); signal.removeEventListener('abort', wake); resolve() }
        this.followers.add(wake)
        signal.addEventListener('abort', wake, { once: true })
      })
    }
  }

  /** Start or rediscover a remote dsh and establish its local loopback tunnel.
   * @param name - saved host name.
   * @param signal - connection cancellation; already launched remote work continues.
   * @returns the connected host and its authenticated local URL.
   */
  @Remote
  async connect(name: string, signal: AbortSignal): Promise<RemoteHostStatus> {
    signal.throwIfAborted()
    if (this.disposed) throw new Error('Remote host manager is closed')
    if (process.platform === 'win32') throw new Error('Remote SSH currently requires Linux or macOS on the local machine')
    const target = this.config.hosts.get()[name]
    if (!target) throw new Error(`Unknown remote host ${JSON.stringify(name)}`)
    const prior = this.attempts.get(name)
    if (prior && prior.closing === undefined && JSON.stringify(prior.target) === JSON.stringify(target)) {
      if (prior.phase === 'connected') return this.status(name, target)
      if (prior.phase === 'connecting') return prior.ready
    }
    if (prior) {
      await this.close(prior)
      if (this.attempts.get(name) !== prior
        || JSON.stringify(this.config.hosts.get()[name]) !== JSON.stringify(target)) return this.connect(name, signal)
    }
    signal.throwIfAborted()
    if (this.isDisposed()) throw new Error('Remote host manager is closed')
    const controller = new AbortController()
    const attempt: Attempt = {
      target, controller, phase: 'connecting', error: null,
      ready: Promise.resolve().then(async () => {
        const lifetime = AbortSignal.any([signal, controller.signal])
        try {
          const remote = await launchRemote(target, this.config, lifetime)
          const tunnel = await openTunnel(target, remote, this.config, lifetime)
          attempt.tunnel = tunnel
          lifetime.throwIfAborted()
          attempt.phase = 'connected'
          this.publish()
          const ended = (reason: string): void => {
            if (attempt.closing !== undefined || this.disposed) return
            attempt.phase = 'failed'; attempt.error = redactTokens(reason)
            this.publish()
          }
          void tunnel.done.then(ended, (error: unknown) => { ended(error instanceof Error ? error.message : String(error)) })
          return this.status(name, target)
        } catch (error) {
          await attempt.tunnel?.close()
          if (!controller.signal.aborted) {
            attempt.phase = 'failed'; attempt.error = redactTokens(error instanceof Error ? error.message : String(error))
            this.publish()
          }
          throw new Error(redactTokens(error instanceof Error ? error.message : String(error)))
        }
      }),
    }
    this.attempts.set(name, attempt)
    this.publish()
    return attempt.ready
  }

  /** Close the locally owned connection without stopping the remote dsh.
   * @param name - saved host name or a connection whose definition was removed.
   * @returns after pending startup, SSH, sockets, and the local listener have settled.
   */
  @Remote
  async disconnect(name: string): Promise<void> {
    const attempt = this.attempts.get(name)
    if (!attempt) return
    await this.close(attempt)
    if (this.attempts.get(name) === attempt) this.attempts.delete(name)
    this.publish()
  }

  private close(attempt: Attempt): Promise<void> {
    return attempt.closing ??= (async () => {
      attempt.controller.abort(new Error('Remote connection closed'))
      await attempt.ready.catch((error: unknown) => { void error /* Startup failure is retained by the caller and catalog. */ })
      await attempt.tunnel?.close()
    })()
  }

  private status(name: string, target: RemoteHostConfig): RemoteHostStatus {
    const attempt = this.attempts.get(name)
    const current = attempt && JSON.stringify(attempt.target) === JSON.stringify(target) ? attempt : undefined
    return { name, host: target.host, profile: target.profile, phase: current?.phase ?? 'disconnected',
      url: current?.phase === 'connected' ? current.tunnel?.url ?? null : null, error: current?.error ?? null }
  }

  private publish(): void {
    this.revision++
    for (const wake of this.followers) wake()
  }

  private isDisposed(): boolean { return this.disposed }
}

export default RemoteLauncher
