// @vitest-environment jsdom
/** Child commands use public navigation and publish only display-safe catalog fields. */
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { installEmbeddedProjects } from '../src/client/embed.tsx'
import { BRIDGE } from '../src/client/projects.ts'

afterEach(cleanup)

async function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({ name: 'root', children: { sidebar: { kind: 'single', scope: 'root' }, 'shell.leading': { kind: 'single', scope: 'root' } } }, ({ renderSlot }: PropsRenderSlots<'sidebar' | 'shell.leading'>) => renderSlot('sidebar', { width: 56, collapsed: true }))
  const workspaces = createSnapshotStore({ items: [{ workspaceId: 'project', title: 'Engine', path: '/work/engine', sessionIds: ['session', 'archived', 'child'] }], archivedSessionIds: ['archived'], pinnedSessionIds: ['session'], phase: 'ready', error: null })
  const sessions = createSnapshotStore({ byId: {
    session: { id: 'session', displayTitle: 'Active task', retainedBy: { mainView: 1 }, running: true, updatedAt: 100, blank: false, secret: 'never project' },
    archived: { id: 'archived', displayTitle: 'Archive', retainedBy: {}, running: false, updatedAt: 50, blank: false },
    child: { id: 'child', displayTitle: 'Child', parentId: 'session', retainedBy: {}, running: true },
  }, phase: 'ready' })
  const create = vi.fn().mockResolvedValue({ workspaceId: 'created', title: 'Created', path: '/work/new project' })
  const rename = vi.fn().mockResolvedValue(undefined)
  const remove = vi.fn().mockResolvedValue(undefined)
  const renameSession = vi.fn().mockResolvedValue({ ok: true, value: undefined })
  const using = vi.fn(async (_id, _source, callback) => callback({ binding: { session: { rename: renameSession } } }))
  const navigation = { openSession: vi.fn(), openWorkspace: vi.fn().mockResolvedValue(undefined), startSession: vi.fn(),
    archiveSession: vi.fn().mockResolvedValue(undefined), unarchiveSession: vi.fn().mockResolvedValue(undefined),
    pinSession: vi.fn().mockResolvedValue(undefined), unpinSession: vi.fn().mockResolvedValue(undefined), forkSession: vi.fn().mockResolvedValue(undefined) }
  const toggleSidebar = vi.fn()
  ctx.provide('workspaces', { list: workspaces, create, rename, delete: remove } as never)
  ctx.provide('sessions', { list: sessions, using } as never)
  ctx.provide('uiWorkspace', navigation as never)
  ctx.provide('layout', { toggleSidebar } as never)
  const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
  onTestFinished(() => post.mockRestore())
  const channel = '0123456789abcdef'
  const parent = 'http://127.0.0.1:3000'
  installEmbeddedProjects(ctx, { parent, channel })
  const message = (command: unknown, changes = {}, requestId?: string): void => { window.dispatchEvent(new MessageEvent('message', { source: window, origin: parent,
    data: { bridge: BRIDGE, channel, type: 'command', command, requestId }, ...changes })) }
  return { ctx, workspaces, sessions, create, rename, remove, using, renameSession, navigation, toggleSidebar, post, channel, parent, message }
}

it('projects display-safe session metadata including archives and pins while excluding child sessions', async () => {
  const f = await fixture()
  expect(f.post).toHaveBeenCalledWith({ bridge: BRIDGE, channel: f.channel, type: 'catalog', catalog: {
    projects: [{ id: 'project', title: 'Engine', path: '/work/engine', sessions: [
      { id: 'session', title: 'Active task', running: true, archived: false, pinned: true, updatedAt: 100, blank: false },
      { id: 'archived', title: 'Archive', running: false, archived: true, pinned: false, updatedAt: 50, blank: false },
    ] }],
    current: 'session', ready: true, error: null,
  } }, f.parent)
})

it('opens only current remote identities and reports refused commands back to the parent', async () => {
  const f = await fixture()
  f.message({ action: 'openSession', id: 'session' }, { origin: 'http://evil.invalid' })
  f.message({ action: 'openSession', id: 'session' }, { source: null })
  f.message({ action: 'deleteWorkspace', id: 'project' })
  expect(f.navigation.openSession).not.toHaveBeenCalled()
  f.message({ action: 'openSession', id: 'session' })
  expect(f.navigation.openSession).toHaveBeenCalledWith('session')
  f.message({ action: 'openSession', id: 'missing' })
  expect(f.post).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: expect.stringContaining('no longer available') }), f.parent)
  f.message({ action: 'openWorkspace', id: 'project' })
  expect(f.navigation.openWorkspace).toHaveBeenCalledWith('project')
  f.message({ action: 'newSession', id: 'project' })
  expect(f.navigation.startSession).toHaveBeenCalledWith('project')
  f.message({ action: 'createWorkspace', path: '/work/new project' })
  await vi.waitFor(() => { expect(f.navigation.openWorkspace).toHaveBeenCalledWith('created') })
  expect(f.create).toHaveBeenCalledWith({ path: '/work/new project' })
  f.message({ action: 'openSession', id: 'archived' })
  expect(f.navigation.openSession).toHaveBeenCalledTimes(1)
})

it('acknowledges remote registration only after creation and returns correlated failures', async () => {
  const f = await fixture()
  let finish!: (project: { workspaceId: string; title: string; path: string }) => void
  f.create.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  f.message({ action: 'createWorkspace', path: '/work/new project' }, {}, 'create-request')
  expect(f.post.mock.calls.some(([payload]) => payload.type === 'result' && payload.requestId === 'create-request')).toBe(false)
  finish({ workspaceId: 'created', title: 'Created', path: '/work/new project' })
  await vi.waitFor(() => { expect(f.post).toHaveBeenCalledWith({ bridge: BRIDGE, channel: f.channel, type: 'result', requestId: 'create-request', result: { id: 'created', title: 'Created', path: '/work/new project', sessions: [] } }, f.parent) })
  f.create.mockRejectedValueOnce(new Error('Folder is unavailable'))
  f.message({ action: 'createWorkspace', path: '/work/missing' }, {}, 'failed-request')
  await vi.waitFor(() => { expect(f.post).toHaveBeenCalledWith({ bridge: BRIDGE, channel: f.channel, type: 'result', requestId: 'failed-request', error: 'Folder is unavailable' }, f.parent) })
})

it('routes workspace and session actions only to public controllers with catalog identity checks', async () => {
  const f = await fixture()
  f.message({ action: 'renameWorkspace', id: 'project', title: 'Renamed' })
  f.message({ action: 'removeWorkspace', id: 'project' })
  f.message({ action: 'renameSession', id: 'session', title: 'Renamed task' })
  f.message({ action: 'archiveSession', id: 'session' })
  f.message({ action: 'unarchiveSession', id: 'archived' })
  f.message({ action: 'pinSession', id: 'session' })
  f.message({ action: 'unpinSession', id: 'session' })
  f.message({ action: 'forkSession', id: 'session' })
  expect(f.rename).toHaveBeenCalledWith('project', 'Renamed')
  expect(f.remove).toHaveBeenCalledWith('project')
  expect(f.using).toHaveBeenCalledWith('session', { source: 'workspaceOperation' }, expect.any(Function))
  expect(f.renameSession).toHaveBeenCalledWith('Renamed task')
  expect(f.navigation.archiveSession).toHaveBeenCalledWith('session')
  expect(f.navigation.unarchiveSession).toHaveBeenCalledWith('archived')
  expect(f.navigation.pinSession).toHaveBeenCalledWith('session')
  expect(f.navigation.unpinSession).toHaveBeenCalledWith('session')
  expect(f.navigation.forkSession).toHaveBeenCalledWith('session')
  f.message({ action: 'removeWorkspace', id: 'missing' }, {}, 'unknown-workspace')
  f.message({ action: 'archiveSession', id: 'missing' }, {}, 'unknown-session')
  expect(f.remove).toHaveBeenCalledTimes(1)
  expect(f.navigation.archiveSession).toHaveBeenCalledTimes(1)
  expect(f.post).toHaveBeenCalledWith(expect.objectContaining({ type: 'result', requestId: 'unknown-workspace', error: expect.stringContaining('no longer available') }), f.parent)
  expect(f.post).toHaveBeenCalledWith(expect.objectContaining({ type: 'result', requestId: 'unknown-session', error: expect.stringContaining('no longer available') }), f.parent)
})

it('reports the public sidebar owner width and removes the embedded sidebar controls', async () => {
  const f = await fixture()
  const Sidebar = f.ctx.slots.entries('sidebar')[0]?.component as (props: { width: number; collapsed: boolean }) => null
  const ui = render(<Sidebar width={240} collapsed={false} />)
  expect(f.post).toHaveBeenCalledWith({ bridge: BRIDGE, channel: f.channel, type: 'inset', width: 240 }, f.parent)
  expect(f.toggleSidebar).toHaveBeenCalledOnce()
  act(() => { ui.rerender(<Sidebar width={56} collapsed />) })
  expect(f.post).toHaveBeenLastCalledWith({ bridge: BRIDGE, channel: f.channel, type: 'inset', width: 56 }, f.parent)
  expect(ui.container.innerHTML).toBe('')
})
