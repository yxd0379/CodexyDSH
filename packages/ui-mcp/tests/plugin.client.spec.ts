/** MCP configuration mutations and command callbacks retain the receiving Session. */
import { Context } from '@deepseek-ai/cordis'
import { TestSessions, RemoteError } from '@codexydsh/test-support/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@codexydsh/mcp/remote'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { CommandDecoration, CommandUiContract } from '@codexydsh/ui-commands/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CommandId } from '@deepseek-ai/dsh-commands'
import { expect, it, onTestFinished, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import type { McpSettingsInjected, McpToastInjected } from '../src/client/McpSettings.tsx'
import { draftOf, type CatalogSettings } from '../src/client/model.ts'
import { en } from '../src/client/locales.ts'

async function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const sessions = new TestSessions(async (operation) => { await operation() }, ctx)
  ctx.provide('sessions', sessions)
  onTestFinished(() => sessions.disposeScopes())
  const id = await sessions.add({ id: 'mcp-command-session' })
  const state = createSnapshotStore<ConfigFormSnapshot<CatalogSettings>>({
    status: 'ready', value: { servers: {} }, revision: 3, writable: true, mode: 'host', base: {}, user: {},
  })
  const mutate = vi.fn<ConfigForm<CatalogSettings>['mutate']>().mockResolvedValue(true)
  const form: ConfigForm<CatalogSettings> = { ...state, mutate, set: vi.fn(), unset: vi.fn() }
  ctx.provide('configForms', { get: () => form } as never)
  ctx.provide('codexySettingsSchema', {})
  ctx.slots.register({ name: 'root', children: {
    'settings.section': { kind: 'list', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' },
  } }, ({ renderSlot }: PropsRenderSlots<'settings.section' | 'shell.overlay'>) => [
    renderSlot('settings.section', { close: () => {} }), renderSlot('shell.overlay', {}),
  ])
  const catalog = vi.fn<Context['remote']['mcp']['catalog']>().mockResolvedValue({ ok: true, value: [
    { serverName: 'docs', transport: 'stdio', enabled: false, phase: 'disabled', toolCount: 0 },
    { serverName: 'search', transport: 'streamable-http', enabled: true, phase: 'failed', toolCount: 0 },
  ] })
  const execute = vi.fn<Context['remote']['commands']['execute']>().mockResolvedValue({
    ok: true, value: { commandId: 'mcp-command' as CommandId, result: { kind: 'success' } },
  })
  ctx.provide('remote.commands', { execute })
  const unmounted = vi.fn()
  const mount = vi.fn(async () => {
    const fiber = ctx.plugin((owner) => { owner.provide('remote.mcp', { catalog }) })
    await fiber.await()
    return async () => { unmounted(); await fiber.dispose() }
  })
  ctx.provide('remote', { $mount: mount, mcp: { catalog }, commands: { execute } } as never)
  const decorate = vi.fn<CommandUiContract['decorate']>(() => vi.fn())
  ctx.provide('commandUi', { decorate } as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const decoration = decorate.mock.calls[0]?.[0] as CommandDecoration
  if (decoration.ui.kind !== 'popupSelect') throw new Error('MCP popup did not register')
  const settingsEntry = ctx.slots.entries('settings.section')[0]
  const toastEntry = ctx.slots.entries('shell.overlay')[0]
  if (!settingsEntry?.inject || !toastEntry?.inject) throw new Error('MCP slots did not register')
  const settings: () => McpSettingsInjected = settingsEntry.inject as typeof settingsEntry.inject & (() => McpSettingsInjected)
  const toast: () => McpToastInjected = toastEntry.inject as typeof toastEntry.inject & (() => McpToastInjected)
  return {
    ctx, state, sessions, id, mutate, catalog, execute, fiber, unmounted, decoration,
    popup: decoration.ui, settings: settings(), toast: toast(),
  }
}

it('writes revision-fenced edits and publishes shell notices that can be dismissed', async () => {
  const f = await fixture()
  expect(resolveSlotLabel(f.ctx.slots.entries('settings.section')[0]!.options.label)).toBe(en.title)
  const draft = { ...draftOf(3), serverName: 'docs', command: 'node' }
  await f.settings.saveMcp(draft)
  expect(f.mutate).toHaveBeenCalledWith(expect.arrayContaining([{ op: 'set', path: ['servers', 'docs', 'command'], value: 'node' }]), 3)
  expect(f.toast.hooks.mcpNotice.getSnapshot()).toMatchObject({ text: en.saved, success: true })
  f.toast.dismissMcpNotice()
  expect(f.toast.hooks.mcpNotice.getSnapshot()).toBeNull()
  await f.settings.deleteMcp('docs', 3)
  expect(f.mutate).toHaveBeenLastCalledWith([{ op: 'set', path: ['servers', 'docs'], value: null }], 3)
  expect(f.toast.hooks.mcpNotice.getSnapshot()?.text).toBe(en.removed)
  await f.fiber.dispose()
  expect(f.ctx.slots.entries('settings.section')).toHaveLength(0)
  expect(f.ctx.slots.entries('shell.overlay')).toHaveLength(0)
  expect(f.unmounted).toHaveBeenCalledOnce()
})

it('refuses malformed drafts and duplicate names before writing and reports Host refusals', async () => {
  const f = await fixture()
  const draft = { ...draftOf(3), serverName: 'docs', command: 'node' }
  await expect(f.settings.saveMcp({ ...draft, serverName: 'invalid name' })).rejects.toThrow(en.invalidName)
  f.state.set({ ...f.state.getSnapshot(), value: { servers: { docs: { serverName: 'docs', transport: 'stdio', autoConnect: false } } } })
  await expect(f.settings.saveMcp(draft)).rejects.toThrow(en.duplicate)
  expect(f.mutate).not.toHaveBeenCalled()
  f.mutate.mockResolvedValueOnce(false)
  await expect(f.settings.saveMcp({ ...draft, originalName: 'docs' })).rejects.toThrow(en.rejected)
  expect(f.toast.hooks.mcpNotice.getSnapshot()?.success).toBe(false)
  f.mutate.mockResolvedValueOnce(false)
  await expect(f.settings.deleteMcp('docs', 3)).rejects.toThrow(en.rejected)
  f.mutate.mockRejectedValueOnce('Connection lost')
  await expect(f.settings.deleteMcp('docs', 3)).rejects.toBe('Connection lost')
  expect(f.toast.hooks.mcpNotice.getSnapshot()?.text).toContain('Connection lost')
  f.state.set({ ...f.state.getSnapshot(), value: undefined, status: 'loading' })
  f.mutate.mockRejectedValueOnce('Configuration reload failed')
  await expect(f.settings.saveMcp(draft)).rejects.toBe('Configuration reload failed')
  expect(f.toast.hooks.mcpNotice.getSnapshot()?.text).toContain('Configuration reload failed')
})

it('retains the exact Session until status and command acknowledgments settle', async () => {
  const f = await fixture()
  const pending = Promise.withResolvers<Awaited<ReturnType<Context['remote']['mcp']['catalog']>>>()
  f.catalog.mockReturnValueOnce(pending.promise)
  const loading = f.popup.options({ sessionId: f.id }, new AbortController().signal)
  await vi.waitFor(() => { expect(f.catalog).toHaveBeenCalled() })
  expect(f.sessions.retainInfo(f.id).getSnapshot().retainedBy.mcpCatalog).toBe(1)
  pending.resolve({ ok: true, value: [{ serverName: 'docs', transport: 'stdio', enabled: true, phase: 'connected', toolCount: 1 }] })
  expect(await loading).toMatchObject([{ id: 'off docs', label: 'Disconnect docs', badge: en.connected }])
  expect(f.sessions.retainInfo(f.id).getSnapshot().retainedBy.mcpCatalog).toBeUndefined()
  const options = await f.popup.options({ sessionId: f.id }, new AbortController().signal)
  expect(options).toMatchObject([{ id: 'on docs', badge: en.disabled }, { id: 'off search', badge: en.connectionFailed }])
  const selecting = Promise.withResolvers<Awaited<ReturnType<Context['remote']['commands']['execute']>>>()
  f.execute.mockReturnValueOnce(selecting.promise)
  const selected = f.popup.onSelect(options[0]!, { sessionId: f.id })
  await vi.waitFor(() => { expect(f.execute).toHaveBeenCalled() })
  expect(f.sessions.retainInfo(f.id).getSnapshot().retainedBy.mcpCatalog).toBe(1)
  selecting.resolve({ ok: true, value: { commandId: 'selected' as CommandId, result: { kind: 'success' } } })
  await selected
  expect(f.execute).toHaveBeenCalledWith(f.id, '/mcp on docs', [], expect.any(AbortSignal))
  expect(f.sessions.retainInfo(f.id).getSnapshot().retainedBy.mcpCatalog).toBeUndefined()
  expect(f.decoration.available({ sessionId: f.id })).toBe(true)
  vi.spyOn(f.sessions, 'subagentAddress').mockReturnValueOnce({ parentSessionId: f.id, childSessionId: 'child' as SessionId, mode: 'one-shot' })
  expect(f.decoration.available({ sessionId: 'child' as SessionId })).toBe(false)
})

it('shows empty-catalog, transport, execution, and unavailable-Session failures', async () => {
  const f = await fixture()
  const input = { sessionId: f.id }
  const signal = new AbortController().signal
  f.catalog.mockResolvedValueOnce({ ok: true, value: [] })
  await expect(f.popup.options(input, signal)).rejects.toThrow(en.noServers)
  const failure = new RemoteError('gateway/internal', 'Connection lost', {})
  f.catalog.mockResolvedValueOnce({ ok: false, error: failure })
  await expect(f.popup.options(input, signal)).rejects.toThrow('Connection lost')
  f.execute.mockResolvedValueOnce({ ok: false, error: failure })
  const option = { id: 'on docs', label: 'Connect docs' }
  await expect(f.popup.onSelect(option, input)).rejects.toThrow('Connection lost')
  f.execute.mockResolvedValueOnce({ ok: true, value: undefined })
  await expect(f.popup.onSelect(option, input)).rejects.toThrow(en.missingSession)
  f.execute.mockResolvedValueOnce({ ok: true, value: { commandId: 'refused' as CommandId, result: { kind: 'error', text: 'Server unavailable' } } })
  await expect(f.popup.onSelect(option, input)).rejects.toThrow('Server unavailable')
  await f.sessions.updateSessionSnapshot(f.id, (draft) => {
    draft.openState = 'error'; draft.openError = new RemoteError('gateway/internal', 'Opening failed', {})
  })
  await expect(f.popup.options(input, signal)).rejects.toThrow('Opening failed')
  await expect(f.popup.onSelect(option, input)).rejects.toThrow('Opening failed')
  await f.sessions.updateSessionSnapshot(f.id, (draft) => { draft.openState = 'cold'; draft.openError = null })
  await expect(f.popup.options(input, signal)).rejects.toThrow(en.missingSession)
  await expect(f.popup.onSelect(option, input)).rejects.toThrow(en.missingSession)
})
