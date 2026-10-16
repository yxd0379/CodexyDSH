/** Saved SSH deployments and locally owned launch/tunnel lifetimes. */
import { Context, type Volatile } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteHostConfig, RemoteHostStatus } from './types.ts'
import { launchRemote, openTunnel, redactTokens, type TransportOptions, type Tunnel } from './transport.ts'
import { EmbeddedRemoteProxy, embeddedRemotePath } from './proxy.ts'
import { createSshAuthentication } from './askpass.ts'

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
  deployment: z.union([z.const('auto'), z.const('existing')]).default('auto'),
  dsh: executable.default('dsh'),
  proxyMode: z.union([z.const('inherit'), z.const('custom'), z.const('direct')]).default('inherit'),
  proxyUrl: z.string().pattern(/^(?:|https?:\/\/[^\s\0]+)(?![\s\S])/u).default(''),
  noProxy: z.string().pattern(/^[^\0\r\n]*(?![\s\S])/u).default(''),
})
const Hosts = z.dict(z.union([Host, z.const(null)]), z.string().pattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?![\s\S])/u)).default({})

interface Attempt {
  target: RemoteHostConfig
  controller: AbortController
  phase: RemoteHostStatus['phase']
  error: string | null
  progress?: string
  log?: string
  tunnel?: Tunnel
  ready: Promise<RemoteHostStatus>
  closing?: Promise<void>
  authentication?: { challenge: { id: string; prompt: string }; respond(response: string): void }
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
    deployTimeoutMs: z.natural().min(1).max(2_147_000_000).default(600_000),
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
  private proxy?: EmbeddedRemoteProxy

  /** @param ctx - Local Host services and lifetime owner.
   * @param config - Validated catalog and transport limits.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'remoteLauncher', { namespace: 'remoteHosts' })
    ctx.inject(['settings'], (scope) => { scope.effect(() => scope.settings.configure({ auto: false }, ctx.fiber)) })
    ctx.inject(['webServer', 'connection'], (scope) => {
      const proxy = new EmbeddedRemoteProxy(scope, (name) => {
        const attempt = this.attempts.get(name)
        return attempt?.phase === 'connected' && attempt.closing === undefined
          && JSON.stringify(this.config.hosts.get()[name]) === JSON.stringify(attempt.target) ? attempt.tunnel?.url : undefined
      })
      this.proxy = proxy
      proxy.update(Object.keys(this.config.hosts.get()).filter(name => this.config.hosts.get()[name] !== null))
      scope.effect(() => () => { if (this.proxy === proxy) this.proxy = undefined })
      this.publish()
    })
    ctx.on('loader/volatile-update', () => {
      for (const [name, attempt] of this.attempts) {
        if (JSON.stringify(this.config.hosts.get()[name]) !== JSON.stringify(attempt.target)) {
          void this.disconnect(name).catch((error: unknown) => { ctx.logger.warn('Remote tunnel cleanup failed: %s', String(error)) })
        }
      }
      this.proxy?.update(Object.keys(this.config.hosts.get()).filter(name => this.config.hosts.get()[name] !== null))
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
   * @returns the connected host and its local browser runtime path.
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
        let authentication: Awaited<ReturnType<typeof createSshAuthentication>> | undefined
        try {
          authentication = await createSshAuthentication((prompt, questionSignal) => this.authenticate(name, attempt, prompt, AbortSignal.any([lifetime, questionSignal])), lifetime)
          const options = { ...this.config, auth: authentication.env,
            onProgress: (message: string) => {
              attempt.progress = message
              this.appendLog(attempt, message)
            },
            onOutput: (message: string) => { this.appendLog(attempt, message) },
          }
          const remote = await launchRemote(target, options, lifetime)
          const tunnel = await openTunnel(target, remote, options, lifetime)
          attempt.tunnel = tunnel
          this.proxy?.invalidate(name)
          lifetime.throwIfAborted()
          attempt.phase = 'connected'
          attempt.progress = 'SSH 隧道已连接'
          this.appendLog(attempt, attempt.progress)
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
            this.appendLog(attempt, attempt.error)
            this.publish()
          }
          throw new Error(redactTokens(error instanceof Error ? error.message : String(error)))
        } finally {
          await authentication?.close()
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
    this.proxy?.invalidate(name)
    this.publish()
  }

  /** Answer only the active question from this exact connection attempt.
   * @param name - Saved host name.
   * @param challengeId - Current ephemeral question identifier.
   * @param response - Secret answer, or null to cancel connecting.
   */
  @Remote
  async respondAuthentication(name: string, challengeId: string, response: string | null): Promise<void> {
    const attempt = this.attempts.get(name)
    const question = attempt?.authentication
    if (!attempt || attempt.phase !== 'connecting' || attempt.closing !== undefined || attempt.controller.signal.aborted
      || !question || question.challenge.id !== challengeId
      || JSON.stringify(this.config.hosts.get()[name]) !== JSON.stringify(attempt.target)) throw new Error('SSH authentication request is no longer active')
    if (response === null) {
      attempt.controller.abort(new Error('SSH authentication cancelled'))
      await this.disconnect(name)
      return
    }
    if (typeof response !== 'string' || Buffer.byteLength(response) > 4096 || /[\0\r\n]/u.test(response)) throw new Error('Invalid SSH authentication response')
    question.respond(response)
  }

  private authenticate(name: string, attempt: Attempt, prompt: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    if (this.attempts.get(name) !== attempt || attempt.phase !== 'connecting' || attempt.closing !== undefined) throw new Error('SSH authentication request is no longer active')
    if (attempt.authentication) throw new Error('Another SSH authentication question is already pending')
    return new Promise<string>((resolve, reject) => {
      const finish = (): void => {
        signal.removeEventListener('abort', cancelled)
        if (attempt.authentication === question) {
          delete attempt.authentication
          this.publish()
        }
      }
      const cancelled = (): void => { finish(); reject(new Error('SSH authentication cancelled')) }
      const question = { challenge: { id: randomUUID(), prompt }, respond(response: string): void { finish(); resolve(response) } }
      attempt.authentication = question
      signal.addEventListener('abort', cancelled, { once: true })
      this.publish()
    })
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
      url: current?.phase === 'connected' ? this.proxy ? embeddedRemotePath(name) : current.tunnel?.url ?? null : null,
      error: current?.error ?? null,
      ...(current?.progress ? { progress: current.progress } : {}),
      ...(current?.log ? { log: current.log } : {}),
      ...(current?.authentication ? { authChallenge: { ...current.authentication.challenge } } : {}) }
  }

  private publish(): void {
    this.revision++
    for (const wake of this.followers) wake()
  }

  private appendLog(attempt: Attempt, message: string): void {
    const line = redactTokens(message).trim()
    if (!line) return
    attempt.log = `${attempt.log ?? ''}[${new Date().toLocaleTimeString('en-GB', { hour12: false })}] ${line}\n`.slice(-this.config.maxOutputBytes)
    this.publish()
  }

  private isDisposed(): boolean { return this.disposed }
}

export default RemoteLauncher
