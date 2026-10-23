// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { RemoteStream, RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import type { RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import type { ConnectionGeneration } from '@deepseek-ai/dsh-client-connection/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { WorkspaceSource } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { RemoteHostStatus } from '@codexydsh/remote/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, expect, it, vi } from 'vitest'
import { RemoteWorkspaceController } from '../src/client/controller.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.useRealTimers()
  localStorage.clear()
})

async function bench() {
  const ctx = new Context(); contexts.push(ctx)
  const sources = new Map<string, WorkspaceSource>()
  const panelInfo = createSnapshotStore<PanelInfo>({ activePanelId: null })
  ctx.provide('configForms', { get: () => ({ getSnapshot: () => ({ value: { hosts: {} } }), set: vi.fn(async () => true) }) } as never)
  ctx.provide('locale', { bind: () => (key: string) => key } as never)
  ctx.provide('layout', { panelInfo, selectPanel: (activePanelId: PanelInfo['activePanelId']) => { panelInfo.set({ activePanelId }) } } as never)
  ctx.provide('uiWorkspace', { registerSource: (source: WorkspaceSource) => {
    sources.set(source.id, source); return () => { sources.delete(source.id) }
  } } as never)
  ctx.provide('directoryPickerLocations', { register: () => () => {} } as never)
  let hosts: RemoteHostStatus[] = ['a', 'b'].map(name => ({
    name, host: name, profile: 'web', phase: 'connected', url: `/codexy-remote/${name}/`, error: null,
  }))
  const generation = createSnapshotStore<ConnectionGeneration | undefined>({ id: 1, host: { home: '/home/test' } })
  let interrupt: ((reason: Error) => void) | undefined
  let openings = 0
  ctx.provide('remote', {
    $stream: <Item>(options: RemoteStreamOptions<Item>) => new RemoteStream({ generation }, options),
    remoteHosts: {
      async *follow(signal: AbortSignal) {
        openings++
        yield hosts
        await new Promise<void>((resolve, reject) => {
          const aborted = (): void => { resolve() }
          signal.addEventListener('abort', aborted, { once: true })
          interrupt = reason => { signal.removeEventListener('abort', aborted); reject(reason) }
        })
      },
    },
  } as never)
  const controller = new RemoteWorkspaceController(ctx)
  await vi.waitFor(() => { expect(sources.size).toBe(2) })
  const iframe = (): HTMLIFrameElement => {
    const element = document.createElement('iframe'); document.body.append(element)
    vi.spyOn(element.contentWindow!, 'postMessage').mockImplementation(() => {})
    return element
  }
  const a = iframe(); const b = iframe()
  // Let the initial blank document load before binding the owned Client document.
  await new Promise(resolve => { setTimeout(resolve, 0) })
  controller.attach('a', a); controller.attach('b', b)
  const receive = (element: HTMLIFrameElement, data: object, origin = window.location.origin): void => {
    window.dispatchEvent(new MessageEvent('message', { data, origin, source: element.contentWindow }))
  }
  const snapshot = (element: HTMLIFrameElement, frameId: string): void => {
    receive(element, { source: 'codexydsh-child', kind: 'snapshot', frameId,
      value: { groups: [], selectedSessionId: 'remote-session' } })
  }
  return { ctx, controller, sources, panelInfo, a, b, receive, snapshot,
    addHost: (host: RemoteHostStatus) => { hosts = [...hosts, host] },
    openings: () => openings,
    interrupt: (reason: Error) => { if (interrupt === undefined) throw new Error('Catalog is not open'); interrupt(reason) },
  }
}

it('keeps following host additions after the transport reconnects without reporting a connection failure', async () => {
  const b = await bench()
  b.addHost({ name: 'c', host: 'offline.invalid', profile: 'web', phase: 'disconnected', url: null, error: null })
  b.interrupt(new RemoteStreamCarrierError('api gateway: Remote stream reconnect requested'))
  await vi.waitFor(() => { expect(b.openings()).toBe(2) })
  expect(b.controller.view.getSnapshot().hosts.map(host => host.name)).toEqual(['a', 'b', 'c'])
  expect(b.controller.view.getSnapshot().error).toBeNull()
  await b.ctx.fiber.dispose()
  expect(b.sources.size).toBe(0)
})

it('waits for readiness and binds operation receipts to the exact frame and native document', async () => {
  const b = await bench()
  const operation = b.controller.request('a', { kind: 'listDirectory' })
  expect(vi.mocked(b.a.contentWindow!.postMessage).mock.calls).toHaveLength(1)
  b.snapshot(b.a, 'a-document')
  const request = vi.mocked(b.a.contentWindow!.postMessage).mock.calls.at(-1)![0] as { id: string; frameId: string }
  expect(request.frameId).toBe('a-document')
  const result = { source: 'codexydsh-child', kind: 'result', id: request.id, ok: true, value: '/home/a', frameId: 'a-document' }
  const settled = vi.fn(); void operation.then(settled)
  b.receive(b.b, result)
  b.receive(b.a, { ...result, frameId: 'old-document' })
  b.receive(b.a, result, 'https://unrelated.invalid')
  await Promise.resolve()
  expect(settled).not.toHaveBeenCalled()
  // A repeated render binding must not lose readiness or the pending operation.
  b.controller.attach('a', b.a)
  b.receive(b.a, result)
  await expect(operation).resolves.toBe('/home/a')
})

it('clears external selection on local navigation and preserves each source as a separate owner', async () => {
  const b = await bench()
  b.snapshot(b.a, 'a-document')
  b.sources.get('ssh:a')!.actions.openSession('remote-session' as SessionId)
  const request = vi.mocked(b.a.contentWindow!.postMessage).mock.calls.at(-1)![0] as { id: string }
  b.receive(b.a, { source: 'codexydsh-child', frameId: 'a-document', kind: 'result', id: request.id, ok: true, value: null })
  expect(b.sources.get('ssh:a')!.state.getSnapshot().selectedSessionId).toBe('remote-session')
  expect(b.sources.get('ssh:b')!.state.getSnapshot()).not.toHaveProperty('selectedSessionId')
  b.panelInfo.set({ activePanelId: null })
  expect(b.sources.get('ssh:a')!.state.getSnapshot()).not.toHaveProperty('selectedSessionId')
})

it('cleans an aborted readiness wait and rejects requests when its document detaches', async () => {
  const b = await bench()
  const abort = new AbortController()
  const operation = b.controller.request('a', { kind: 'listDirectory' }, abort.signal)
  const rejected = expect(operation).rejects.toThrow('cancelled')
  abort.abort(new Error('cancelled'))
  await rejected
  b.snapshot(b.a, 'a-document')
  expect(vi.mocked(b.a.contentWindow!.postMessage).mock.calls).toHaveLength(1)
  const inFlight = b.controller.request('a', { kind: 'listDirectory' })
  const detached = expect(inFlight).rejects.toThrow('detached')
  b.controller.attach('a', null)
  await detached
})

it('bounds startup waiting and releases sources and requests when the owning Client leaves', async () => {
  const b = await bench()
  vi.useFakeTimers()
  const waiting = b.controller.request('a', { kind: 'listDirectory' })
  const expired = expect(waiting).rejects.toThrow('unavailable')
  await vi.advanceTimersByTimeAsync(30_000)
  await expired
  const pending = b.controller.request('b', { kind: 'listDirectory' })
  const closed = expect(pending).rejects.toThrow('closed')
  await b.ctx.fiber.dispose()
  await closed
  expect(b.sources.size).toBe(0)
})
