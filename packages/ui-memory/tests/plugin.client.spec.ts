/** Memory namespace and header/toast contributions unwind with their Cordis plugin. */
import { Context } from '@deepseek-ai/cordis'
import { TestSessions } from '@codexydsh/test-support/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { expect, it, onTestFinished, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import type { MemoryActionInjected } from '../src/client/MemoryAction.tsx'
import type { MemoryRemote } from '../src/client/model.ts'

async function fixture() {
  const ctx = new Context()
  const sessions = new TestSessions(async (action) => { await action() }, ctx)
  ctx.provide('sessions', sessions)
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const configuration = createSnapshotStore({ value: { statusPollMs: 1500 } })
  ctx.provide('configForms', { get: (namespace: string) => {
    expect(namespace).toBe('codexy-ui-memory')
    return configuration
  } } as never)
  ctx.slots.register({ name: 'root', children: {
    'settings.section': { kind: 'list', scope: 'root' },
    'shell.overlay': { kind: 'list', scope: 'root' },
  } }, ({ renderSlot }: PropsRenderSlots<'settings.section' | 'shell.overlay'>) => [
    renderSlot('settings.section', { close: () => {} }), renderSlot('shell.overlay', {}),
  ])
  const memory = {
    snapshot: vi.fn<MemoryRemote['snapshot']>().mockResolvedValue({ ok: true, value: { root: '/memory', version: 'v2', summary: '', running: false } }),
    list: vi.fn<MemoryRemote['list']>().mockResolvedValue({ ok: true, value: { path: null, entries: [], next_cursor: null, truncated: false } }),
  }
  const unmounted = vi.fn()
  const mount = vi.fn(async (_contribution: TypertRemoteContribution) => {
    const fiber = ctx.plugin((owner) => { owner.provide('remote.memory', memory) })
    await fiber.await()
    return async () => { unmounted(); await fiber.dispose() }
  })
  ctx.provide('remote', { $mount: mount, memory } as never)
  const id = 'memory-plugin-session' as SessionId
  const opened = Promise.withResolvers<undefined>()
  await sessions.add({ id, initialOpen: () => opened.promise })
  const reference = sessions.retain(id, { source: 'testView' })
  onTestFinished(async () => {
    opened.resolve(undefined)
    reference.release()
    await sessions.disposeScopes()
    await ctx.fiber.dispose()
  })
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const entry = ctx.slots.entries('settings.section')[0]
  if (entry?.inject === undefined) throw new Error('Memory header entry missing')
  const resolve = entry.inject as NonNullable<typeof entry.inject> & (() => { memoryFor: (sessionId: SessionId) => MemoryActionInjected })
  const input = resolve().memoryFor(id)
  return { ctx, sessions, memory, unmounted, id, opened, fiber, input }
}

it('waits for Session history, retains the operation, and removes every contribution on unload', async () => {
  const { ctx, sessions, memory, unmounted, id, opened, fiber, input } = await fixture()
  const loading = input.reloadMemory()
  expect(memory.snapshot).not.toHaveBeenCalled()
  expect(sessions.retainInfo(id).getSnapshot().retainedBy.memoryBrowser).toBe(2)
  opened.resolve(undefined)
  await loading
  expect(input.hooks.memoryView.getSnapshot().error).toBeNull()
  expect(memory.snapshot).toHaveBeenCalledExactlyOnceWith(id, expect.any(AbortSignal))
  expect(memory.list).toHaveBeenCalledExactlyOnceWith(id, { path: '' }, expect.any(AbortSignal))
  expect(sessions.retainInfo(id).getSnapshot().retainedBy.memoryBrowser).toBeUndefined()
  expect(ctx.slots.entries('shell.overlay')).toHaveLength(1)
  await fiber.dispose()
  expect(ctx.slots.entries('settings.section')).toHaveLength(0)
  expect(ctx.slots.entries('shell.overlay')).toHaveLength(0)
  expect(unmounted).toHaveBeenCalledOnce()
})

it('releases history-waiting leases on unload without starting a memory request', async () => {
  const { ctx, sessions, memory, unmounted, id, fiber, input } = await fixture()
  const loading = input.reloadMemory()
  expect(sessions.retainInfo(id).getSnapshot().retainedBy.memoryBrowser).toBe(2)
  await fiber.dispose()
  await loading
  expect(sessions.retainInfo(id).getSnapshot().retainedBy.memoryBrowser).toBeUndefined()
  expect(memory.snapshot).not.toHaveBeenCalled()
  expect(memory.list).not.toHaveBeenCalled()
  expect(ctx.slots.entries('settings.section')).toHaveLength(0)
  expect(unmounted).toHaveBeenCalledOnce()
})
