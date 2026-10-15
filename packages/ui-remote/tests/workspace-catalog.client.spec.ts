// @vitest-environment jsdom
/** Workspace identities survive transport lifetimes without retaining transport capabilities. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { IRemoteHosts, RemoteHostsSnapshot } from '@codexydsh/remote/client'
import { BRIDGE, REMOTE_WORKSPACES_KEY, RemoteProjects, parseCatalog, parseCommand, parseWorkspaceRefs, workspaceKey,
  type RemoteCatalog, type RemoteWorkspaceStorage } from '../src/client/projects.ts'

function fixture(storage?: RemoteWorkspaceStorage) {
  const hosts: IRemoteHosts = { ...createSnapshotStore<RemoteHostsSnapshot>({ items: [], connected: true, error: null }),
    connect: vi.fn<IRemoteHosts['connect']>().mockImplementation(async name => ({ name, host: name, profile: 'codexy', phase: 'connected', url: `/codexy-remote/${name}/`, error: null })),
    disconnect: vi.fn<IRemoteHosts['disconnect']>().mockResolvedValue(undefined), retry: vi.fn(),
    respondAuthentication: vi.fn<IRemoteHosts['respondAuthentication']>().mockResolvedValue(undefined),
  }
  const projects = new RemoteProjects(hosts, 'http://localhost:3000', vi.fn(), vi.fn(), storage)
  onTestFinished(() => projects.dispose())
  const targets = new Map<string, { postMessage: ReturnType<typeof vi.fn> }>()
  function bind(name: string) { const target = { postMessage: vi.fn() }; targets.set(name, target); projects.bind(name, target); return target }
  function receive(name: string, payload: Record<string, unknown>) {
    const frame = projects.state.getSnapshot().frames.find(item => item.name === name)!
    projects.receive({ source: targets.get(name) as unknown as Window, origin: frame.origin, data: { bridge: BRIDGE, channel: frame.channel, ...payload } })
  }
  return { projects, hosts, bind, receive }
}
function memoryStorage(seed?: unknown) {
  const values = new Map<string, string>(seed === undefined ? [] : [[REMOTE_WORKSPACES_KEY, JSON.stringify(seed)]])
  return { values, getItem: vi.fn((key: string) => values.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { values.set(key, value) }) }
}
const project = { id: 'workspace', title: 'Existing remote work', path: '/work/repo', sessions: [{ id: 'session', title: 'Existing task', running: false }] }
const catalog: RemoteCatalog = { projects: [project], current: 'session', ready: true, error: null }
const ref = { host: 'dev', workspaceId: project.id, title: project.title, path: project.path }
const tick = async () => { for (let index = 0; index < 8; index++) await Promise.resolve() }

it('imports existing catalogs as independent workspace rows and isolates identical remote ids by host', () => {
  const storage = memoryStorage()
  const f = fixture(storage)
  for (const name of ['dev', 'other']) { f.projects.attach(name, `/codexy-remote/${name}/`); f.bind(name); f.receive(name, { type: 'catalog', catalog }) }
  expect(f.projects.workspaces.getSnapshot()).toEqual(['dev', 'other'].map(host => ({ ...ref, host, key: workspaceKey(host, project.id), sessions: project.sessions, currentSession: 'session', connected: true, ready: true, error: null })))
  expect(workspaceKey('a:b', 'c')).not.toBe(workspaceKey('a', 'b:c'))
  expect(JSON.parse(storage.values.get(REMOTE_WORKSPACES_KEY)!)).toEqual({ version: 1, workspaces: ['dev', 'other'].map(host => ({ ...ref, host })) })
  const persisted = storage.values.get(REMOTE_WORKSPACES_KEY)!
  for (const transportField of ['url', 'channel', 'origin', 'session', 'token']) expect(persisted).not.toContain(`"${transportField}"`)
})

it('retains workspace registrations across disconnect and browser restarts', async () => {
  const storage = memoryStorage()
  const f = fixture(storage)
  f.projects.attach('dev', '/codexy-remote/dev/'); f.bind('dev'); f.receive('dev', { type: 'catalog', catalog })
  await f.projects.disconnect('dev')
  expect(f.projects.workspaces.getSnapshot()).toEqual([{ ...ref, key: workspaceKey('dev', project.id), sessions: [], currentSession: null, connected: false, ready: false, error: null }])
  const restarted = fixture(storage)
  expect(restarted.projects.workspaces.getSnapshot()).toEqual(f.projects.workspaces.getSnapshot())
  expect(restarted.hosts.connect).not.toHaveBeenCalled()
})

it('only reconciles removed remote registrations after an authoritative healthy catalog', () => {
  const f = fixture(memoryStorage({ version: 1, workspaces: [ref] }))
  f.projects.attach('dev', '/codexy-remote/dev/'); f.bind('dev')
  f.receive('dev', { type: 'catalog', catalog: { ...catalog, projects: [], ready: false } })
  expect(f.projects.workspaces.getSnapshot()).toHaveLength(1)
  f.receive('dev', { type: 'catalog', catalog: { ...catalog, projects: [], error: 'reconnecting' } })
  expect(f.projects.workspaces.getSnapshot()).toHaveLength(1)
  f.receive('dev', { type: 'catalog', catalog: { ...catalog, projects: [] } })
  expect(f.projects.workspaces.getSnapshot()).toEqual([])
})

it('reconnects a saved workspace once and queues navigation until a bound ready catalog exists', async () => {
  const f = fixture(memoryStorage({ version: 1, workspaces: [ref] }))
  const opening = f.projects.openSession(ref, 'session')
  const creating = f.projects.newSession(ref)
  await tick()
  expect(f.hosts.connect).toHaveBeenCalledTimes(1)
  const target = f.bind('dev')
  f.receive('dev', { type: 'catalog', catalog: { ...catalog, ready: false } })
  await tick()
  expect(target.postMessage).not.toHaveBeenCalled()
  f.receive('dev', { type: 'catalog', catalog })
  await Promise.all([opening, creating])
  expect(target.postMessage.mock.calls.map(([message]) => message.command)).toEqual([{ action: 'openSession', id: 'session' }, { action: 'newSession', id: 'workspace' }])
})

it('correlates remote creation with its fenced response before remembering the workspace', async () => {
  const f = fixture(memoryStorage())
  f.projects.attach('dev', '/codexy-remote/dev/'); const target = f.bind('dev'); f.receive('dev', { type: 'catalog', catalog: { ...catalog, projects: [] } })
  const created = f.projects.createWorkspace('dev', '/work/new')
  await tick()
  const command = target.postMessage.mock.calls[0]![0]
  expect(command).toMatchObject({ type: 'command', command: { action: 'createWorkspace', path: '/work/new' }, requestId: expect.any(String) })
  f.receive('dev', { type: 'result', requestId: 'unrelated', result: project })
  expect(f.projects.workspaces.getSnapshot()).toEqual([])
  const result = { ...project, id: 'new-workspace', path: '/work/new' }
  f.receive('dev', { type: 'result', requestId: command.requestId, result })
  expect(await created).toEqual({ ...ref, workspaceId: 'new-workspace', path: '/work/new' })
  expect(f.projects.workspaces.getSnapshot()[0]?.workspaceId).toBe('new-workspace')
})

it('rejects pending navigation and actions on close, and surfaces remote action failures', async () => {
  const f = fixture()
  f.projects.attach('dev', '/codexy-remote/dev/'); const target = f.bind('dev')
  const navigation = f.projects.openWorkspace(ref).catch(error => error.message)
  await f.projects.disconnect('dev')
  expect(await navigation).toContain('closed')
  f.projects.attach('dev', '/codexy-remote/dev/'); f.projects.bind('dev', target); f.receive('dev', { type: 'catalog', catalog })
  const request = f.projects.request('dev', { action: 'renameWorkspace', id: 'workspace', title: 'New name' }).catch(error => error.message)
  await tick()
  const requestId = target.postMessage.mock.calls.at(-1)![0].requestId
  f.receive('dev', { type: 'result', requestId, error: 'Name already used' })
  expect(await request).toBe('Name already used')
})

it('sanitizes persisted rows and optional display metadata without accepting arbitrary bridge actions', () => {
  expect(parseWorkspaceRefs({ version: 1, workspaces: [{ ...ref, token: 'secret', url: 'http://evil' }, null, { ...ref, workspaceId: '' }] })).toEqual([ref])
  expect(parseWorkspaceRefs({ version: 2, workspaces: [ref] })).toEqual([])
  const metadata = { ...project.sessions[0], pinned: true, archived: true, updatedAt: 1_792_022_400_000, blank: false }
  expect(parseCatalog({ ...catalog, projects: [{ ...project, sessions: [metadata] }] })?.projects[0]?.sessions).toEqual([metadata])
  expect(parseCatalog({ ...catalog, projects: [{ ...project, sessions: [{ ...metadata, pinned: 'yes' }] }] })).toBeUndefined()
  expect(parseCommand({ action: 'renameWorkspace', id: 'workspace', title: 'Renamed', arbitrary: true })).toEqual({ action: 'renameWorkspace', id: 'workspace', title: 'Renamed' })
  expect(parseCommand({ action: 'archiveSession', id: 'session' })).toEqual({ action: 'archiveSession', id: 'session' })
  expect(parseCommand({ action: 'eval', id: 'session' })).toBeUndefined()
})
