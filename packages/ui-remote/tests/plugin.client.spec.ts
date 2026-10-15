// @vitest-environment jsdom
/** Settings writes and same-window navigation use the shared Host model and shell feedback. */
import { Context } from '@deepseek-ai/cordis'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { bindSnapshotSelector, makeTranslate, stubConfigForm, workspaceSnapshot } from '@codexydsh/test-support/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { IRemoteHosts, RemoteHostsSnapshot } from '@codexydsh/remote/client'
import { apply, inject } from '../src/client/index.ts'
import { draftOf, type RemoteSettings } from '../src/client/model.ts'
import type { RemoteSettingsInjected, RemoteToastInjected } from '../src/client/RemoteSettings.tsx'
import { RemoteAuthentication, type RemoteAuthenticationInjected } from '../src/client/RemoteAuthentication.tsx'
import type { RemoteViewInjected } from '../src/client/RemoteProjects.tsx'
import type { UnifiedWorkspacesInjected } from '../src/client/UnifiedWorkspaces.tsx'
import { BRIDGE } from '../src/client/projects.ts'
import { en } from '../src/client/locales.ts'

afterEach(() => { cleanup(); localStorage.clear() })

async function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const form = stubConfigForm<RemoteSettings>()
  form.publish({ status: 'ready', writable: true, revision: 2, value: { hosts: {} } })
  ctx.provide('configForms', { get: () => form.scope } as never)
  ctx.provide('codexySettingsSchema', {})
  ctx.provide('connection', { state: createSnapshotStore('connected') } as never)
  const selectPanel = vi.fn()
  ctx.provide('layout', { selectPanel, panelInfo: createSnapshotStore({ activePanelId: 'codexy.remote.projects' }) } as never)
  ctx.provide('workspaces', { list: createSnapshotStore(workspaceSnapshot()) } as never)
  ctx.provide('sessions', { list: createSnapshotStore({ ids: [], byId: {}, phase: 'ready' }) } as never)
  ctx.provide('uiWorkspace', {} as never)
  const remoteState = createSnapshotStore<RemoteHostsSnapshot>({ items: [], connected: true, error: null })
  const remote: IRemoteHosts = {
    ...remoteState,
    connect: vi.fn<IRemoteHosts['connect']>().mockResolvedValue({ name: 'dev', host: 'example', profile: 'web',
      phase: 'connected', url: 'http://127.0.0.1:3080/?token=fixture', error: null }),
    disconnect: vi.fn<IRemoteHosts['disconnect']>().mockResolvedValue(undefined), retry: vi.fn(),
    respondAuthentication: vi.fn<IRemoteHosts['respondAuthentication']>().mockResolvedValue(undefined),
  }
  ctx.provide('remoteHosts', remote)
  ctx.slots.register({ name: 'root', children: {
    'settings.section': { kind: 'list', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' },
    'sidebar.footer.action': { kind: 'list', scope: 'root' }, 'sidebar.workspaces': { kind: 'single', scope: 'root' }, 'main': { kind: 'keyed', scope: 'root' },
  } }, ({ renderSlot }: PropsRenderSlots<'settings.section' | 'shell.overlay'>) => [
    renderSlot('settings.section', { close: () => {} }), renderSlot('shell.overlay', {}),
  ])
  const fiber = ctx.plugin({ inject, apply })
  await fiber.await()
  const settingsEntry = ctx.slots.entries('settings.section')[0]
  const noticeEntry = ctx.slots.entries('shell.overlay').find(entry => entry.options.id === 'remote.notice')
  if (!settingsEntry?.inject || !noticeEntry?.inject) throw new Error('Remote settings did not register')
  const settings = settingsEntry.inject as typeof settingsEntry.inject & (() => RemoteSettingsInjected)
  const notice = noticeEntry.inject as typeof noticeEntry.inject & (() => RemoteToastInjected)
  return { ctx, form, remote, remoteState, fiber, settings: settings(), notice: notice(), selectPanel }
}

it('writes against the editor revision and disconnects before deleting a host', async () => {
  const f = await fixture()
  await f.settings.saveHost({ ...draftOf(2), name: 'dev', host: 'example' })
  expect(f.form.mutate).toHaveBeenCalledWith(expect.arrayContaining([{ op: 'set', path: ['hosts', 'dev'],
    value: { host: 'example', profile: 'codexy', directory: '', node: 'node', dsh: 'dsh', deployment: 'auto' } }]), 2)
  expect(f.notice.hooks.remoteNotice.getSnapshot()).toMatchObject({ text: en.saved, success: true })
  await f.settings.removeHost('dev', 2)
  expect(f.remote.disconnect).toHaveBeenCalledWith('dev')
  expect(f.form.mutate).toHaveBeenLastCalledWith([{ op: 'set', path: ['hosts', 'dev'], value: null }], 2)
  f.notice.dismissRemoteNotice()
  expect(f.notice.hooks.remoteNotice.getSnapshot()).toBeNull()
  await f.fiber.dispose()
  expect(f.ctx.slots.entries('settings.section')).toHaveLength(0)
})

it('rejects invalid and duplicate drafts and reports refused writes in the shell', async () => {
  const f = await fixture()
  const draft = { ...draftOf(2), name: 'dev', host: 'example' }
  await expect(f.settings.saveHost({ ...draft, name: 'invalid name' })).rejects.toThrow(en.invalidName)
  f.form.publish({ value: { hosts: { dev: draft } } })
  await expect(f.settings.saveHost(draft)).rejects.toThrow(en.duplicate)
  expect(f.form.mutate).not.toHaveBeenCalled()
  f.form.mutate.mockResolvedValueOnce(false)
  await expect(f.settings.saveHost({ ...draft, originalName: 'dev' })).rejects.toThrow(en.rejected)
  expect(f.notice.hooks.remoteNotice.getSnapshot()?.success).toBe(false)
  f.form.mutate.mockResolvedValueOnce(false)
  await expect(f.settings.removeHost('dev', 2)).rejects.toThrow(en.rejected)
})

it('selects the remote project panel without opening a window and reports connection failures', async () => {
  const f = await fixture()
  const open = vi.spyOn(window, 'open').mockReturnValue(null)
  onTestFinished(() => open.mockRestore())
  await f.settings.connectHost('dev')
  expect(open).not.toHaveBeenCalled()
  expect(f.selectPanel).toHaveBeenCalledWith('codexy.remote.projects')
  expect(f.ctx.slots.entries('sidebar.footer.action')).toEqual([])
  expect(f.ctx.slots.entries('sidebar.workspaces')).toHaveLength(1)
  vi.mocked(f.remote.connect).mockRejectedValueOnce(new Error('SSH failed'))
  await expect(f.settings.connectHost('dev')).rejects.toThrow('SSH failed')
  expect(f.notice.hooks.remoteNotice.getSnapshot()?.text).toContain('SSH failed')
  await f.settings.connectHost('dev')
  f.settings.openHost('dev')
  expect(open).not.toHaveBeenCalled()
  await f.settings.disconnectHost('dev')
  f.settings.retryHosts()
  expect(f.remote.retry).toHaveBeenCalledOnce()
})

it('keeps the disconnect outcome when a cancelled connection returns late', async () => {
  const f = await fixture()
  let resolve!: (value: Awaited<ReturnType<IRemoteHosts['connect']>>) => void
  vi.mocked(f.remote.connect).mockImplementationOnce(() => new Promise(accept => { resolve = accept }))
  const connecting = f.settings.connectHost('dev')
  await f.settings.disconnectHost('dev')
  resolve({ name: 'dev', host: 'example', profile: 'web', phase: 'connected', url: '/codexy-remote/dev/', error: null })
  await connecting
  expect(f.notice.hooks.remoteNotice.getSnapshot()?.text).toBe(en.connectionClosed)
  expect(f.selectPanel).not.toHaveBeenCalled()
})

it('authenticates a sidebar connection in the shell overlay without opening Settings or saving the response', async () => {
  const f = await fixture()
  const overlayEntry = f.ctx.slots.entries('shell.overlay').find(entry => entry.options.id === 'remote.authentication')!
  const sidebarEntry = f.ctx.slots.entries('sidebar.workspaces')[0]!
  const frameEntry = f.ctx.slots.entries('shell.overlay').find(entry => entry.options.id === 'remote.frames')!
  expect(overlayEntry.component).toBe(RemoteAuthentication)
  const authentication = (overlayEntry.inject as () => RemoteAuthenticationInjected)()
  const sidebar = (sidebarEntry.inject as () => UnifiedWorkspacesInjected)()
  const frames = (frameEntry.inject as () => RemoteViewInjected)()
  const ui = render(createElement(RemoteAuthentication, {
    useRemoteHosts: bindSnapshotSelector(authentication.hooks.remoteHosts),
    respondAuthentication: authentication.respondAuthentication, t: makeTranslate(en),
  } as Parameters<typeof RemoteAuthentication>[0]))
  const connected = { name: 'dev', host: 'developer@ascend', profile: 'codexy', phase: 'connected' as const, url: '/codexy-remote/dev/', error: null }
  let finish!: (status: typeof connected) => void
  vi.mocked(f.remote.connect).mockImplementationOnce(() => {
    f.remoteState.set({ items: [{ ...connected, phase: 'connecting', url: null, authChallenge: { id: 'challenge', prompt: 'Password:' } }], connected: true, error: null })
    return new Promise(resolve => { finish = resolve })
  })
  vi.mocked(f.remote.respondAuthentication).mockImplementationOnce(async (name, id, response) => {
    expect([name, id, response]).toEqual(['dev', 'challenge', 'private SSH response'])
    f.remoteState.set({ items: [connected], connected: true, error: null })
    finish(connected)
  })
  let connecting!: Promise<void>
  act(() => { connecting = sidebar.createWorkspace({ host: 'dev', path: '/work/remote' }) })
  expect(ui.getByRole('dialog', { name: en.authenticationTitle })).toBeTruthy()
  expect(ui.getByText('dev · SSH: developer@ascend')).toBeTruthy()
  expect(ui.queryByText(en.description)).toBeNull()
  fireEvent.change(ui.getByLabelText('Password:'), { target: { value: 'private SSH response' } })
  await act(async () => {
    fireEvent.click(ui.getByRole('button', { name: en.authenticationSubmit }))
    await vi.waitFor(() => { expect(frames.projects.state.getSnapshot().frames).toHaveLength(1) })
    const frame = frames.projects.state.getSnapshot().frames[0]!
    const target = { postMessage: vi.fn() }
    frames.projects.bind('dev', target)
    const receive = (payload: Record<string, unknown>) => frames.projects.receive({ source: target as unknown as Window, origin: frame.origin, data: { bridge: BRIDGE, channel: frame.channel, ...payload } })
    receive({ type: 'catalog', catalog: { projects: [], current: null, ready: true, error: null } })
    await vi.waitFor(() => { expect(target.postMessage).toHaveBeenCalled() })
    const message = target.postMessage.mock.calls.at(-1)![0]
    expect(message).toMatchObject({ type: 'command', command: { action: 'createWorkspace', path: '/work/remote' }, requestId: expect.any(String) })
    receive({ type: 'result', requestId: message.requestId, result: { id: 'remote-project', title: 'Remote work', path: '/work/remote', sessions: [] } })
    await connecting
  })
  expect(ui.queryByRole('dialog')).toBeNull()
  expect(f.remote.respondAuthentication).toHaveBeenCalledOnce()
  expect(f.form.mutate).not.toHaveBeenCalled()
  expect(JSON.stringify(f.form.scope.getSnapshot())).not.toContain('private SSH response')
  expect(JSON.stringify(f.remoteState.getSnapshot())).not.toContain('private SSH response')
  expect(f.selectPanel).toHaveBeenCalledWith('codexy.remote.projects')
  expect(sidebar.hooks.unifiedWorkspaces.getSnapshot().items).toEqual([expect.objectContaining({ host: 'dev', id: 'remote-project', path: '/work/remote' })])
  expect(f.ctx.slots.entries('sidebar.footer.action')).toEqual([])
})
