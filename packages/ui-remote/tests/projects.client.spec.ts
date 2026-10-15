// @vitest-environment jsdom
/** Runtime isolation, origin fences, cancellation, and proxy capabilities. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { IRemoteHosts, RemoteHostsSnapshot } from '@codexydsh/remote/client'
import { BRIDGE, RemoteProjects, browserOrigin, parseCatalog, parseCommand } from '../src/client/projects.ts'
import { embeddedLocation } from '../src/client/embed.tsx'

function fixture(parent = 'http://127.0.0.1:3000') {
  const hosts: IRemoteHosts = { ...createSnapshotStore<RemoteHostsSnapshot>({ items: [], connected: true, error: null }),
    connect: vi.fn<IRemoteHosts['connect']>().mockResolvedValue({ name: 'dev', host: 'dev', profile: 'codexy', phase: 'connected', url: '/codexy-remote/dev/', error: null }),
    disconnect: vi.fn<IRemoteHosts['disconnect']>().mockResolvedValue(undefined), retry: vi.fn(),
    respondAuthentication: vi.fn<IRemoteHosts['respondAuthentication']>().mockResolvedValue(undefined),
  }
  const select = vi.fn()
  const returnLocal = vi.fn()
  const projects = new RemoteProjects(hosts, parent, select, returnLocal)
  onTestFinished(() => projects.dispose())
  const target = { postMessage: vi.fn() }
  return { hosts, select, projects, target, returnLocal }
}
const catalog = { projects: [{ id: 'project', title: 'Workspace', path: '/work/a', sessions: [{ id: 'session', title: 'Task', running: true }] }], current: 'session', ready: true, error: null }

it('uses a same-origin proxy and keeps host identities separate from remote project and session ids', async () => {
  const f = fixture()
  await f.projects.connect('dev')
  f.projects.attach('other', '/codexy-remote/other/')
  const first = f.projects.state.getSnapshot().frames[0]!
  f.projects.bind('dev', f.target)
  f.projects.command('dev', { action: 'openSession', id: 'session' })
  expect(f.select).toHaveBeenCalled()
  expect(f.target.postMessage).toHaveBeenCalledWith({ bridge: BRIDGE, channel: first.channel, type: 'command', command: { action: 'openSession', id: 'session' } }, 'http://127.0.0.1:3000')
  const frameUrl = new URL(f.projects.frameUrl(first))
  expect(frameUrl.pathname).toBe('/codexy-remote/dev/')
  expect(new URLSearchParams(frameUrl.hash.slice(1)).get('codexy-parent')).toBe('http://127.0.0.1:3000')
  f.projects.attach('dev', '/codexy-remote/dev/')
  expect(f.projects.state.getSnapshot().frames.find(frame => frame.name === 'dev')?.channel).toBe(first.channel)
  expect(f.projects.state.getSnapshot().frames).toHaveLength(2)
})

it('accepts messages only from the bound iframe, exact origin, and current channel', async () => {
  const f = fixture()
  await f.projects.connect('dev')
  f.projects.bind('dev', f.target)
  const frame = f.projects.state.getSnapshot().frames[0]!
  const event = { origin: frame.origin, source: f.target as unknown as Window, data: { bridge: BRIDGE, channel: frame.channel, type: 'catalog', catalog } }
  for (const changes of [{ origin: 'http://attacker.invalid' }, { source: {} as Window }, { data: { ...event.data, channel: 'stale' } }, { data: { ...event.data, catalog: { ...catalog, projects: [{ id: 'bad' }] } } }]) {
    f.projects.receive({ ...event, ...changes })
    expect(f.projects.state.getSnapshot().frames[0]?.catalog).toBeNull()
  }
  f.projects.receive(event)
  expect(f.projects.state.getSnapshot().frames[0]?.catalog).toEqual(catalog)
  f.projects.attach('dev', '/codexy-remote/dev/?generation=2')
  f.projects.receive(event)
  expect(f.projects.state.getSnapshot().frames[0]?.catalog).toBeNull()
})

it('retains runtimes during observation loss and removes only an authoritative disconnected host', async () => {
  const f = fixture()
  await f.projects.connect('dev')
  f.projects.reconcile({ items: null, connected: false, error: 'lost' })
  expect(f.projects.state.getSnapshot().frames).toHaveLength(1)
  await f.projects.disconnect('dev')
  expect(f.projects.state.getSnapshot().frames).toEqual([])
  expect(f.hosts.disconnect).toHaveBeenCalledWith('dev')
  expect(f.returnLocal).toHaveBeenCalledOnce()
})

it('cancels connection waiters and ignores late results after disconnect or disposal', async () => {
  const f = fixture()
  let resolve!: (value: Awaited<ReturnType<IRemoteHosts['connect']>>) => void
  vi.mocked(f.hosts.connect).mockImplementationOnce((_name, signal) => new Promise(accept => { resolve = accept; expect(signal.aborted).toBe(false) }))
  const connected = f.projects.connect('dev')
  const signal = vi.mocked(f.hosts.connect).mock.calls[0]![1]
  await f.projects.disconnect('dev')
  expect(signal.aborted).toBe(true)
  resolve({ name: 'dev', host: 'dev', profile: 'codexy', phase: 'connected', url: '/codexy-remote/dev/', error: null })
  expect(await connected).toBe(false)
  expect(f.projects.state.getSnapshot().frames).toEqual([])
  f.projects.dispose()
})

it('shows a handshake timeout and rotates the channel when retrying an unresponsive runtime', async () => {
  vi.useFakeTimers()
  onTestFinished(() => vi.useRealTimers())
  const f = fixture()
  await f.projects.connect('dev')
  const before = f.projects.state.getSnapshot().frames[0]!
  f.projects.bind('dev', f.target)
  f.projects.loaded('dev')
  vi.advanceTimersByTime(20_000)
  expect(f.projects.state.getSnapshot().frames[0]?.error).toContain('did not respond')
  f.projects.reload('dev')
  const after = f.projects.state.getSnapshot().frames[0]!
  expect(after.channel).not.toBe(before.channel)
  expect(after).toMatchObject({ error: null, ready: false, catalog: null })
  f.projects.bind('dev', f.target)
  f.projects.receive({ source: f.target as unknown as Window, origin: before.origin, data: { bridge: BRIDGE, channel: before.channel, type: 'catalog', catalog } })
  expect(f.projects.state.getSnapshot().frames[0]?.catalog).toBeNull()
  f.projects.loaded('dev')
  f.projects.receive({ source: f.target as unknown as Window, origin: after.origin, data: { bridge: BRIDGE, channel: after.channel, type: 'catalog', catalog } })
  vi.advanceTimersByTime(20_000)
  expect(f.projects.state.getSnapshot().frames[0]?.error).toBeNull()
  expect(f.projects.state.getSnapshot().frames[0]?.catalog).toEqual(catalog)
})

it('supports the desktop origin and rejects untrusted origins, paths, and arbitrary bridge methods', () => {
  const f = fixture('dsh-app://app')
  f.projects.attach('dev', '/codexy-remote/dev/')
  expect(f.projects.state.getSnapshot().frames[0]?.origin).toBe('dsh-app://app')
  expect(browserOrigin(new URL('dsh-app://app/'))).toBe('dsh-app://app')
  expect(() => f.projects.attach('evil', 'https://attacker.invalid/')).toThrow()
  expect(parseCommand({ action: 'eval', source: 'evil' })).toBeUndefined()
  expect(parseCommand({ action: 'createWorkspace', path: 'relative' })).toBeUndefined()
  expect(parseCommand({ action: 'createWorkspace', path: '/work/a b' })).toEqual({ action: 'createWorkspace', path: '/work/a b' })
  expect(parseCatalog({ ...catalog, projects: [...catalog.projects, ...catalog.projects] })).toBeUndefined()
  const hash = '#codexy-embed=1&codexy-channel=0123456789abcdef&codexy-parent=dsh-app%3A%2F%2Fapp'
  expect(embeddedLocation({ hash } as Location, true)).toEqual({ parent: 'dsh-app://app', channel: '0123456789abcdef' })
  expect(embeddedLocation({ hash } as Location, false)).toBeUndefined()
  expect(embeddedLocation({ hash: hash.replace('dsh-app%3A%2F%2Fapp', 'https%3A%2F%2Fevil.invalid') } as Location, true)).toBeUndefined()
})
