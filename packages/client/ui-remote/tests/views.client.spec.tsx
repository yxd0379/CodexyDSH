// @vitest-environment jsdom
/** Focused view regressions; the real Remote user flow is exercised separately in a browser. */
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { RemoteHostConfig, RemoteHostStatus } from '@codexydsh/remote/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { RemoteSettings, RemoteView } from '../src/client/controller.ts'
import { zh } from '../src/client/locales.ts'
import { RemoteDialogs, RemoteFrames, RemotePanel, RemoteSettingsSection, RemoteWorkspaceSettings } from '../src/client/views.tsx'
import type { RemoteInjected } from '../src/client/views.tsx'

afterEach(cleanup)

function fixture() {
  const host: RemoteHostStatus = { name: 'ascend', host: 'user@ascend', profile: 'web',
    phase: 'disconnected', url: null, error: null }
  const view = createSnapshotStore<RemoteView>({ hosts: [host], selectedHost: 'ascend', rect: null,
    error: null, dialog: null, groups: {}, hidden: {} })
  const form = createSnapshotStore<ConfigFormSnapshot<RemoteSettings>>({ status: 'ready', value: { hosts: {} },
    base: {}, user: {}, revision: 1, writable: true })
  const callbacks = {
    attach: vi.fn<RemoteInjected['attach']>(), surface: vi.fn<RemoteInjected['surface']>(),
    connect: vi.fn<RemoteInjected['connect']>(), disconnect: vi.fn<RemoteInjected['disconnect']>(),
    save: vi.fn<RemoteInjected['save']>().mockResolvedValue(true),
    remove: vi.fn<RemoteInjected['remove']>().mockResolvedValue(),
    rename: vi.fn<RemoteInjected['rename']>().mockResolvedValue(),
    setVisible: vi.fn<RemoteInjected['setVisible']>(), closeDialog: vi.fn<RemoteInjected['closeDialog']>(),
    authenticate: vi.fn<RemoteInjected['authenticate']>().mockResolvedValue(),
    dismissError: vi.fn<RemoteInjected['dismissError']>(),
    openSettings: vi.fn<RemoteInjected['openSettings']>(), close: vi.fn(),
    showDetails: vi.fn<RemoteInjected['showDetails']>(),
  }
  const props: ComponentProps<typeof RemoteSettingsSection> = { ...callbacks,
    useRemoteView: bindSnapshotSelector(view), useRemoteForm: bindSnapshotSelector(form), t: key => zh[key] }
  return { host, view, form, props, ...callbacks }
}

it('keeps the main surface while showing connection progress, cancellation, retry and the connected document', () => {
  const f = fixture()
  render(<><RemotePanel {...f.props} /><RemoteFrames {...f.props} /></>)
  const surface = f.surface.mock.calls[0]![0]!
  expect(screen.getByRole('status').textContent).toBe(zh.disconnected)
  fireEvent.click(screen.getByRole('button', { name: zh.connect }))
  expect(f.connect).toHaveBeenCalledWith('ascend')
  act(() => { f.view.update(state => {
    state.hosts = [{ ...f.host, phase: 'connecting', progress: 'Opening SSH tunnel' }]
  }) })
  expect(screen.getByRole('status').textContent).toBe(zh.connecting)
  expect(screen.getByText('Opening SSH tunnel')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: zh.cancel }))
  expect(f.disconnect).toHaveBeenCalledWith('ascend')
  act(() => { f.view.update(state => {
    state.hosts = [{ ...f.host, phase: 'failed', error: 'SSH exited 255', log: 'Permission denied (publickey).' }]
  }) })
  expect(screen.getByRole('status').textContent).toBe(zh.failed)
  fireEvent.click(screen.getByRole('button', { name: zh.connect }))
  expect(f.connect).toHaveBeenCalledTimes(2)
  act(() => { f.view.update(state => {
    state.hosts = [{ ...f.host, phase: 'connected', url: '/codexy-remote/ascend/' }]
    state.rect = { left: 250, top: 80, width: 900, height: 600 }
  }) })
  expect(screen.queryByRole('status')).toBeNull()
  expect(surface.isConnected).toBe(true)
  const frame = screen.getByTitle<HTMLIFrameElement>('ascend')
  expect(frame.src).toContain('/codexy-remote/ascend/?codexydsh-embedded=1')
  expect(frame.name).toBe('codexydsh-remote-ascend')
  expect(frame.dataset.codexydshRemoteFrame).toBe('ascend')
  expect(frame.getAttribute('aria-hidden')).toBe('false')
  expect(frame.style.left).toBe('250px')
  act(() => { f.view.update(state => { state.selectedHost = null; state.rect = null }) })
  expect(screen.getByTitle('ascend')).toBe(frame)
  expect(frame.getAttribute('aria-hidden')).toBe('true')
  expect(frame.tabIndex).toBe(-1)
})

it('shows a short SSH failure label and keeps diagnostic output inside the connection log', () => {
  const f = fixture()
  const diagnostic = '** WARNING: post-quantum key exchange unavailable\nPermission denied (publickey).'
  f.view.update(state => { state.hosts = [{ ...f.host, phase: 'failed', error: diagnostic, log: diagnostic }] })
  render(<RemoteSettingsSection {...f.props} />)
  expect(screen.getByRole('alert').textContent).toBe(zh.failed)
  const log = screen.getByText(zh.log).closest('details')!
  expect(log.open).toBe(false)
  expect(log.querySelector('pre')?.textContent).toBe(diagnostic)
  fireEvent.click(screen.getByRole('button', { name: zh.connect }))
  expect(f.connect).toHaveBeenCalledWith('ascend')
})

it('saves an edited host without clearing its existing deployment paths or hidden network settings', async () => {
  const f = fixture()
  const saved: RemoteHostConfig = { host: 'old-host', profile: 'research', home: '/srv/user/codexy',
    directory: '/srv/repos/project', node: '/opt/node/bin/node', dsh: '/opt/codexy/bin/codexydsh',
    deployment: 'existing', proxyMode: 'custom', proxyUrl: 'http://127.0.0.1:7890', noProxy: '.internal.example' }
  f.form.update(state => { state.value = { hosts: { ascend: saved } } })
  render(<RemoteSettingsSection {...f.props} />)
  fireEvent.click(screen.getByRole('button', { name: zh.edit }))
  const dialog = screen.getByRole('dialog', { name: zh.edit })
  fireEvent.change(within(dialog).getByLabelText(zh.host), { target: { value: ' new-host ' } })
  fireEvent.click(within(dialog).getByRole('button', { name: zh.save }))
  await waitFor(() => { expect(f.save).toHaveBeenCalledWith('ascend', { ...saved, host: 'new-host' }, 'ascend') })
  expect(f.remove).not.toHaveBeenCalled()
  await waitFor(() => { expect(screen.queryByRole('dialog', { name: zh.edit })).toBeNull() })
})

it('retains the host edit and exposes a refused save so the user can retry', async () => {
  const f = fixture()
  f.save.mockResolvedValue(false)
  render(<RemoteSettingsSection {...f.props} />)
  fireEvent.click(screen.getByRole('button', { name: zh.add }))
  const dialog = screen.getByRole('dialog', { name: zh.add })
  fireEvent.change(within(dialog).getByLabelText(zh.name), { target: { value: 'new-host' } })
  fireEvent.change(within(dialog).getByLabelText(zh.host), { target: { value: 'user@new-host' } })
  fireEvent.click(within(dialog).getByRole('button', { name: zh.save }))
  expect((await within(dialog).findByRole('alert')).textContent).toBe(zh.saveFailed)
  expect((within(dialog).getByLabelText(zh.host) as HTMLInputElement).value).toBe('user@new-host')
  f.save.mockResolvedValue(true)
  fireEvent.click(within(dialog).getByRole('button', { name: zh.save }))
  await waitFor(() => { expect(screen.queryByRole('dialog', { name: zh.add })).toBeNull() })
})

it('exposes a source rename failure in its dialog and a separate operation error with dismissal', async () => {
  const f = fixture()
  f.view.update(state => { state.dialog = { kind: 'rename', host: 'ascend', target: { workspace: 'remote-workspace' }, title: 'Remote project' } })
  f.rename.mockRejectedValue(new Error('Remote rename denied'))
  render(<RemoteDialogs {...f.props} />)
  const dialog = screen.getByRole('dialog', { name: zh.rename })
  fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'New remote project' } })
  fireEvent.click(within(dialog).getByRole('button', { name: zh.save }))
  expect((await within(dialog).findByRole('alert')).textContent).toContain('Remote rename denied')
  expect(f.rename).toHaveBeenCalledWith('New remote project')
  expect(f.closeDialog).not.toHaveBeenCalled()
  act(() => { f.view.update(state => { state.dialog = null; state.error = 'Remote archive operation failed' }) })
  const notice = screen.getByRole('alert')
  expect(notice.textContent).toContain('Remote archive operation failed')
  fireEvent.click(within(notice).getByRole('button', { name: zh.close }))
  expect(f.dismissError).toHaveBeenCalledOnce()
})

it('closes local settings before opening settings on the clicked remote host', () => {
  const f = fixture()
  const actions: string[] = []
  f.close.mockImplementation(() => { actions.push('close-local') })
  f.openSettings.mockImplementation(host => { actions.push(`open-remote:${host}`) })
  f.view.update(state => {
    state.hosts = [{ ...f.host, phase: 'connected', url: '/codexy-remote/ascend/' }]
    state.selectedHost = 'another-host'
  })
  render(<RemoteSettingsSection {...f.props} />)
  fireEvent.click(screen.getByRole('button', { name: zh.remoteSettings }))
  expect(actions).toEqual(['close-local', 'open-remote:ascend'])
  expect(f.openSettings).toHaveBeenCalledExactlyOnceWith('ascend')
})

it('manages remote workspace visibility and properties on the workspace page, not the SSH page', () => {
  const f = fixture()
  const group = { key: 'remote-workspace', workspaceId: 'remote-workspace' as WorkspaceId,
    label: '远端项目', cwd: '/srv/project', sessionCount: 0, expanded: true, containsCurrent: false, sessions: [] }
  f.view.update(state => { state.groups = { ascend: [group] } })
  const ssh = render(<RemoteSettingsSection {...f.props} />)
  expect(screen.queryByRole('checkbox', { name: '在侧栏显示 ascend: 远端项目' })).toBeNull()
  ssh.unmount()
  render(<RemoteWorkspaceSettings {...f.props} />)
  const visible = screen.getByRole('checkbox', { name: '在侧栏显示 ascend: 远端项目' })
  expect((visible as HTMLInputElement).checked).toBe(true)
  fireEvent.click(visible)
  expect(f.setVisible).toHaveBeenCalledExactlyOnceWith('ascend', 'remote-workspace', false)
  fireEvent.click(screen.getByRole('button', { name: '属性' }))
  expect(f.showDetails).toHaveBeenCalledExactlyOnceWith('ascend', group)
  expect(f.connect).not.toHaveBeenCalled()
  expect(f.remove).not.toHaveBeenCalled()
})
