/** Reconnecting browser projection of locally managed remote hosts. */
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { RemoteStreamCarrierError, type ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import { TYPERT_REMOTE } from '@codexydsh/remote/remote'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { RemoteHostStatus } from '../types.ts'

/** Last accepted Host catalog and its observation state. */
export interface RemoteHostsSnapshot {
  items: RemoteHostStatus[] | null
  connected: boolean
  error: string | null
}

/** Browser model; all launch and disconnect decisions belong to the Host. */
export interface IRemoteHosts extends ObservableSnapshot<RemoteHostsSnapshot> {
  /** Connect a saved host.
   * @param name - human-selected catalog name.
   * @param signal - pending connection cancellation.
   * @returns the Host's connected state and embedded runtime path.
   */
  connect(name: string, signal: AbortSignal): Promise<RemoteHostStatus>
  /** Close a local tunnel, leaving the remote runtime alive.
   * @param name - saved host name.
   * @returns after Host cleanup is complete.
   */
  disconnect(name: string): Promise<void>
  /** Answer the current OpenSSH question; null cancels this connection attempt. */
  respondAuthentication(name: string, challengeId: string, response: string | null): Promise<void>
  /** Restart Host observation immediately. */
  retry(): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Browser projection and commands for remote hosts. */
    remoteHosts: IRemoteHosts
  }
}

/** Transport services used by this paired Client model. */
export const inject = ['remote', 'connection']

/** Mount the generated Remote namespace and its shared browser model.
 * @param ctx - Browser lifetime owner.
 * @returns joined generated namespace disposal.
 */
export async function apply(ctx: Context): Promise<() => void> {
  const unmount = await ctx.remote.$mount(TYPERT_REMOTE)
  ctx.inject(['remote.remoteHosts'], (scope) => { new RemoteHostsClient(scope) })
  // oxlint-disable-next-line typescript/no-misused-promises -- Cordis joins asynchronous effect disposal.
  return unmount
}

class RemoteHostsClient extends Service implements IRemoteHosts {
  private readonly remote: ClientRemote['remoteHosts']
  private readonly state = createSnapshotStore<RemoteHostsSnapshot>({ items: null, connected: false, error: null })
  private readonly reconnect: () => void

  constructor(ctx: Context) {
    super(ctx, 'remoteHosts')
    this.remote = ctx.remote.remoteHosts
    const connection = ctx.get('connection') as ConnectionHandle
    this.reconnect = () => { connection.reconnect() }
    let disposed = false
    const isDisposed = (): boolean => disposed
    const failed = (error: unknown): void => {
      this.state.set({ ...this.state.getSnapshot(), connected: false, error: error instanceof Error ? error.message : String(error) })
    }
    const stream = ctx.remote.$stream<RemoteHostStatus[]>({
      name: 'Remote hosts', open: signal => this.remote.follow(signal),
      ended: () => new RemoteStreamCarrierError('Remote host observation ended'), carrierFailed: failed,
    })
    const observing = (async () => {
      try {
        for await (const item of stream) {
          this.state.set({ items: item.value, connected: true, error: null })
          item.accept()
        }
      } catch (error) { if (!isDisposed()) failed(error) }
    })()
    ctx.effect(() => async () => { disposed = true; await stream.dispose(); await observing })
  }

  getSnapshot(): RemoteHostsSnapshot { return this.state.getSnapshot() }
  subscribe(listener: () => void): () => void { return this.state.subscribe(listener) }

  async connect(name: string, signal: AbortSignal): Promise<RemoteHostStatus> {
    const result = await this.remote.connect(name, signal)
    if (!result.ok) throw result.error
    return result.value
  }

  async disconnect(name: string): Promise<void> {
    const result = await this.remote.disconnect(name)
    if (!result.ok) throw result.error
  }

  async respondAuthentication(name: string, challengeId: string, response: string | null): Promise<void> {
    const result = await this.remote.respondAuthentication(name, challengeId, response)
    if (!result.ok) throw result.error
  }

  retry(): void { this.reconnect() }
}
