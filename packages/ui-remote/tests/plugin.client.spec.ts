// @vitest-environment jsdom
/** Settings writes and popup navigation use the shared Host model and shell feedback. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { stubConfigForm } from '@codexydsh/test-support/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { IRemoteHosts, RemoteHostsSnapshot } from '@codexydsh/remote/client'
import { apply, inject } from '../src/client/index.ts'
import { draftOf, type RemoteSettings } from '../src/client/model.ts'
import type { RemoteSettingsInjected, RemoteToastInjected } from '../src/client/RemoteSettings.tsx'
import { en } from '../src/client/locales.ts'

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
  const remote: IRemoteHosts = {
    ...createSnapshotStore<RemoteHostsSnapshot>({ items: [], connected: true, error: null }),
    connect: vi.fn<IRemoteHosts['connect']>().mockResolvedValue({ name: 'dev', host: 'example', profile: 'web',
      phase: 'connected', url: 'http://127.0.0.1:3080/?token=fixture', error: null }),
    disconnect: vi.fn<IRemoteHosts['disconnect']>().mockResolvedValue(undefined), retry: vi.fn(),
  }
  ctx.provide('remoteHosts', remote)
  ctx.slots.register({ name: 'root', children: {
    'settings.section': { kind: 'list', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' },
  } }, ({ renderSlot }: PropsRenderSlots<'settings.section' | 'shell.overlay'>) => [
    renderSlot('settings.section', { close: () => {} }), renderSlot('shell.overlay', {}),
  ])
  const fiber = ctx.plugin({ inject, apply })
  await fiber.await()
  const settingsEntry = ctx.slots.entries('settings.section')[0]
  const noticeEntry = ctx.slots.entries('shell.overlay')[0]
  if (!settingsEntry?.inject || !noticeEntry?.inject) throw new Error('Remote settings did not register')
  const settings = settingsEntry.inject as typeof settingsEntry.inject & (() => RemoteSettingsInjected)
  const notice = noticeEntry.inject as typeof noticeEntry.inject & (() => RemoteToastInjected)
  return { ctx, form, remote, fiber, settings: settings(), notice: notice() }
}

it('writes against the editor revision and disconnects before deleting a host', async () => {
  const f = await fixture()
  await f.settings.saveHost({ ...draftOf(2), name: 'dev', host: 'example' })
  expect(f.form.mutate).toHaveBeenCalledWith(expect.arrayContaining([{ op: 'set', path: ['hosts', 'dev'],
    value: { host: 'example', profile: 'codexy', directory: '', node: 'node', dsh: 'dsh' } }]), 2)
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

it('opens a pending page during the gesture, navigates on readiness, and closes it on failure', async () => {
  const f = await fixture()
  const popup = { opener: {}, closed: false, document: { title: '', body: { textContent: '' } },
    location: { replace: vi.fn() }, close: vi.fn() }
  const open = vi.spyOn(window, 'open').mockReturnValue(popup as never)
  onTestFinished(() => open.mockRestore())
  await f.settings.connectHost('dev')
  expect(open).toHaveBeenCalledWith('about:blank', '_blank')
  expect(popup.opener).toBeNull()
  expect(popup.location.replace).toHaveBeenCalledWith('http://127.0.0.1:3080/?token=fixture')
  vi.mocked(f.remote.connect).mockRejectedValueOnce(new Error('SSH failed'))
  await expect(f.settings.connectHost('dev')).rejects.toThrow('SSH failed')
  expect(popup.close).toHaveBeenCalledOnce()
  expect(f.notice.hooks.remoteNotice.getSnapshot()?.text).toContain('SSH failed')
  open.mockReturnValueOnce(null)
  await f.settings.connectHost('dev')
  f.settings.openHost('http://127.0.0.1:3080/')
  expect(open).toHaveBeenLastCalledWith('http://127.0.0.1:3080/', '_blank', 'noopener')
  await f.settings.disconnectHost('dev')
  f.settings.retryHosts()
  expect(f.remote.retry).toHaveBeenCalledOnce()
})
