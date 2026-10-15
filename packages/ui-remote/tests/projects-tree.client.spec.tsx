// @vitest-environment jsdom
/** The existing sidebar shows host-qualified remote projects and forwards selections. */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@codexydsh/test-support/client'
import type { RemoteHostsSnapshot } from '@codexydsh/remote/client'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { RemoteProjectsTree, RemoteProjectFrames } from '../src/client/RemoteProjects.tsx'
import { RemoteProjects, REMOTE_PANEL } from '../src/client/projects.ts'
import { UnifiedWorkspaces, type UnifiedWorkspaceSnapshot, type UnifiedWorkspacesProps } from '../src/client/UnifiedWorkspaces.tsx'
import type { RemoteSettings } from '../src/client/model.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

function fixture() {
  const remote = { ...createSnapshotStore<RemoteHostsSnapshot>({ items: [{ name: 'dev', host: 'dev', profile: 'codexy', phase: 'connected', url: '/codexy-remote/dev/', error: null }], connected: true, error: null }), connect: vi.fn(), disconnect: vi.fn(), retry: vi.fn(), respondAuthentication: vi.fn() }
  const projects = new RemoteProjects(remote, 'http://localhost', vi.fn())
  projects.attach('dev', '/codexy-remote/dev/')
  const frame = projects.state.getSnapshot().frames[0]!
  projects.state.set({ frames: [{ ...frame, ready: true, catalog: { ready: true, current: 's1', error: null, projects: [{ id: 'p1', title: 'Engine', path: '/work/engine', sessions: [{ id: 's1', title: 'Investigate', running: true }] }] } }], active: 'dev' })
  const settings = createSnapshotStore<ConfigFormSnapshot<RemoteSettings>>({ status: 'ready', value: { hosts: { dev: { host: 'dev', profile: 'codexy', directory: '', node: 'node', dsh: 'dsh' } } }, revision: 1, writable: true, mode: 'host', base: {}, user: {} })
  const panel = createSnapshotStore({ activePanelId: REMOTE_PANEL })
  const command = vi.spyOn(projects, 'command')
  const props = { wide: true, useRemoteProjects: bindSnapshotSelector(projects.state), useRemoteSettings: bindSnapshotSelector(settings), useRemoteHosts: bindSnapshotSelector(remote), usePanelInfo: bindSnapshotSelector(panel), projects,
    connectHost: vi.fn(), disconnectHost: vi.fn(), t: makeTranslate(en) } as unknown as Parameters<typeof RemoteProjectsTree>[0]
  return { projects, panel, command, props, remote, settings }
}

it('opens a remote session, starts a fresh session, and adds an absolute remote project path', () => {
  const f = fixture()
  const ui = render(<RemoteProjectsTree {...f.props} />)
  const session = ui.getByRole('button', { name: /Investigate/ })
  expect(session.getAttribute('aria-current')).toBe('page')
  fireEvent.click(session)
  expect(f.command).toHaveBeenLastCalledWith('dev', { action: 'openSession', id: 's1' })
  fireEvent.click(ui.getByRole('button', { name: 'New remote session dev: Engine' }))
  expect(f.command).toHaveBeenLastCalledWith('dev', { action: 'newSession', id: 'p1' })
  fireEvent.click(ui.getByRole('button', { name: /Add remote project/ }))
  fireEvent.change(ui.getByLabelText(en.remoteProjectPath), { target: { value: 'relative/path' } })
  fireEvent.click(ui.getByRole('button', { name: en.add }))
  expect(ui.getByRole('alert').textContent).toBe(en.invalidDirectory)
  expect((ui.getByLabelText(en.remoteProjectPath) as HTMLInputElement).value).toBe('relative/path')
  fireEvent.change(ui.getByLabelText(en.remoteProjectPath), { target: { value: '/work/second' } })
  fireEvent.click(ui.getByRole('button', { name: en.add }))
  expect(f.command).toHaveBeenLastCalledWith('dev', { action: 'createWorkspace', path: '/work/second' })
  act(() => { f.panel.set({ activePanelId: 'conversation' }) })
  expect(session.getAttribute('aria-current')).toBeNull()
})

it('retains the same iframe node when switching between local and remote rows in the shared list', async () => {
  const f = fixture()
  const viewport = createSnapshotStore({ left: 250, top: 0, width: 800, height: 600 })
  const returnLocal = vi.fn(() => { f.panel.set({ activePanelId: 'conversation' }) })
  const props = { useRemoteProjects: bindSnapshotSelector(f.projects.state), useRemoteViewport: bindSnapshotSelector(viewport), usePanelInfo: bindSnapshotSelector(f.panel), projects: f.projects, returnLocal, t: makeTranslate(en) } as unknown as Parameters<typeof RemoteProjectFrames>[0]
  const workspaces = createSnapshotStore<UnifiedWorkspaceSnapshot>({ hosts: [], items: [
    { key: 'local:project', id: 'local', title: 'Local project', path: '/work/local', sessions: [{ key: 'local:session', id: 'local-session', title: 'Local conversation', active: false, running: false }] },
    { key: 'remote:project', id: 'p1', host: 'dev', title: 'Engine', path: '/work/engine', sessions: [{ key: 'remote:session', id: 's1', title: 'Investigate', active: true, running: true }] },
  ] })
  const openSession = vi.fn(row => { f.panel.set({ activePanelId: row.host ? REMOTE_PANEL : 'conversation' }) })
  const browser = { wide: true, useUnifiedWorkspaces: bindSnapshotSelector(workspaces), openSession } as unknown as UnifiedWorkspacesProps
  const ui = render(<><UnifiedWorkspaces {...browser} /><RemoteProjectFrames {...props} /></>)
  const iframe = ui.getByTitle('Remote workspace: dev')
  expect(ui.queryByRole('button', { name: en.returnLocal })).toBeNull()
  await act(async () => { fireEvent.click(ui.getByRole('button', { name: 'Local conversation' })); await Promise.resolve() })
  expect(openSession).toHaveBeenCalledWith(workspaces.getSnapshot().items[0], workspaces.getSnapshot().items[0]!.sessions[0])
  expect(returnLocal).not.toHaveBeenCalled()
  expect(ui.getByTitle('Remote workspace: dev')).toBe(iframe)
  expect(iframe.parentElement?.style.visibility).toBe('hidden')
  await act(async () => { fireEvent.click(ui.getByRole('button', { name: 'Investigate' })); await Promise.resolve() })
  expect(ui.getByTitle('Remote workspace: dev')).toBe(iframe)
  expect(iframe.parentElement?.style.visibility).toBe('visible')
})

it('uses the Host catalog when settings are unavailable and preserves configuration rows while observation is pending', () => {
  const f = fixture()
  act(() => { f.remote.set({ items: null, connected: true, error: null }) })
  const ui = render(<RemoteProjectsTree {...f.props} />)
  expect(ui.container.querySelector('[data-remote-host="dev"]')).not.toBeNull()
  act(() => {
    f.settings.set({ ...f.settings.getSnapshot(), status: 'unavailable', value: undefined, mode: 'memory', writable: false })
    f.remote.set({ items: [{ name: 'dev', host: 'dev', profile: 'codexy', phase: 'disconnected', url: null, error: null }], connected: true, error: null })
  })
  expect(ui.container.querySelector('[data-remote-host="dev"]')).not.toBeNull()
  expect(ui.getByRole('button', { name: 'Connect dev' })).not.toBeNull()
  expect(ui.queryByText(en.configureHosts)).toBeNull()
  act(() => { f.remote.set({ items: [], connected: true, error: null }) })
  expect(ui.container.querySelector('[data-remote-host="dev"]')).toBeNull()
  expect(ui.getByText(en.configureHosts)).not.toBeNull()
})
