// @vitest-environment jsdom
/** Host editing and connection controls use independent settings and connection observations. */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@codexydsh/test-support/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { RemoteHostsSnapshot } from '@codexydsh/remote/client'
import { RemoteSettingsPage } from '../src/client/RemoteSettings.tsx'
import { draftOf, draftOperations, DraftError, type RemoteSettings } from '../src/client/model.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

function fixture() {
  const settings = createSnapshotStore<ConfigFormSnapshot<RemoteSettings>>({
    status: 'ready', value: { hosts: { dev: { host: 'developer@host', profile: 'codexy', node: 'node', dsh: 'dsh', directory: '' } } },
    revision: 2, writable: true, mode: 'host', base: {}, user: {},
  })
  const connections = createSnapshotStore<RemoteHostsSnapshot>({ items: [], connected: true, error: null })
  const saveHost = vi.fn<Parameters<typeof RemoteSettingsPage>[0]['saveHost']>().mockResolvedValue(undefined)
  const removeHost = vi.fn<Parameters<typeof RemoteSettingsPage>[0]['removeHost']>().mockResolvedValue(undefined)
  const connectHost = vi.fn<Parameters<typeof RemoteSettingsPage>[0]['connectHost']>().mockResolvedValue(undefined)
  const disconnectHost = vi.fn<Parameters<typeof RemoteSettingsPage>[0]['disconnectHost']>().mockResolvedValue(undefined)
  const openHost = vi.fn<Parameters<typeof RemoteSettingsPage>[0]['openHost']>()
  const retryHosts = vi.fn()
  const props = { useRemoteSettings: bindSnapshotSelector(settings), useRemoteHosts: bindSnapshotSelector(connections),
    saveHost, removeHost, connectHost, disconnectHost, openHost, retryHosts, t: makeTranslate(zh),
  } as Parameters<typeof RemoteSettingsPage>[0]
  return { settings, connections, saveHost, removeHost, connectHost, disconnectHost, openHost, retryHosts,
    ui: render(<RemoteSettingsPage {...props} />) }
}

it('validates host drafts and writes one revision-fenced definition', () => {
  const draft = { ...draftOf(4), name: 'dev', host: 'developer@host', directory: '/work/a b' }
  expect(draftOperations(draft)).toEqual([{ op: 'set', path: ['hosts', 'dev'], value: { host: 'developer@host', directory: '/work/a b', profile: 'codexy', node: 'node', dsh: 'dsh', deployment: 'auto' } }])
  for (const changes of [{ name: '-option' }, { host: 'host name' }, { host: '-oOption' }, { profile: 'a b' }, { directory: '~/' }, { node: '\n' }, { dsh: '' }]) {
    expect(() => draftOperations({ ...draft, ...changes })).toThrow(DraftError)
  }
})

it('retains failed edits, makes names immutable, and confirms deletion', async () => {
  const f = fixture()
  fireEvent.click(f.ui.getByRole('button', { name: zh.edit }))
  expect(f.ui.getByLabelText(zh.name).hasAttribute('disabled')).toBe(true)
  fireEvent.change(f.ui.getByLabelText(zh.directory), { target: { value: '/work/project' } })
  f.saveHost.mockRejectedValueOnce(new Error('Host refused write'))
  await act(async () => { fireEvent.click(f.ui.getByRole('button', { name: zh.save })) })
  expect((f.ui.getByLabelText(zh.directory) as HTMLInputElement).value).toBe('/work/project')
  expect(f.ui.getByRole('alert').textContent).toBe('Host refused write')
  await act(async () => { fireEvent.click(f.ui.getByRole('button', { name: zh.save })) })
  expect(f.saveHost).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'dev', revision: 2, directory: '/work/project' }))
  expect(f.ui.queryByRole('alert')).toBeNull()
  fireEvent.click(f.ui.getByRole('button', { name: zh.remove }))
  expect(f.removeHost).not.toHaveBeenCalled()
  await act(async () => { fireEvent.click(f.ui.getByRole('button', { name: zh.confirmRemove })) })
  expect(f.removeHost).toHaveBeenCalledWith('dev', 2)
})

it('connects, cancels startup, opens a live tunnel, and preserves rows after observation failure', async () => {
  const f = fixture()
  await act(async () => { fireEvent.click(f.ui.getByRole('button', { name: zh.connect })) })
  expect(f.connectHost).toHaveBeenCalledWith('dev')
  act(() => { f.connections.set({ items: [{ name: 'dev', host: 'developer@host', profile: 'codexy', phase: 'connecting', url: null, error: null }], connected: true, error: null }) })
  await act(async () => { fireEvent.click(f.ui.getByRole('button', { name: zh.cancelConnection })) })
  expect(f.disconnectHost).toHaveBeenCalledWith('dev')
  act(() => { f.connections.set({ ...f.connections.getSnapshot(), items: [{ name: 'dev', host: 'developer@host', profile: 'codexy', phase: 'connected', url: 'http://127.0.0.1:3080/', error: null }] }) })
  fireEvent.click(f.ui.getByRole('button', { name: zh.open }))
  expect(f.openHost).toHaveBeenCalledWith('dev')
  await act(async () => { fireEvent.click(f.ui.getByRole('button', { name: zh.disconnect })) })
  act(() => { f.connections.set({ ...f.connections.getSnapshot(), connected: false, error: 'Connection lost' }) })
  expect(f.ui.getByText('dev')).toBeTruthy()
  expect(f.ui.getByRole('alert').textContent).toContain('Connection lost')
  fireEvent.click(f.ui.getByRole('button', { name: zh.retry }))
  expect(f.retryHosts).toHaveBeenCalledOnce()
})
