// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { afterEach, expect, it, vi } from 'vitest'
import { installEmbedded, snapshot } from '../src/client/embedded.ts'
import { snapshotSchema } from '../src/client/protocol.ts'

const id = (value: string): SessionId => value as SessionId
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
})

/** Real Context owns listeners and effects; each incomplete test service provides only the bridge's reads. */
function context(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}

it('uses native retained selection, stored titles and origin facts without losing forked Sessions', () => {
  const row = (name: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
    id: id(name), displayTitle: `fallback-${name}`, running: false, blank: false, updatedAt: 1,
    retainedBy: {}, ...extra,
  })
  const rows = [row('fork', { parentId: id('parent'), title: 'Forked conversation' }),
    row('child', { parentId: id('fork'), origin: 'subagent', running: true }),
    row('untitled'), row('current-blank', { blank: true, retainedBy: { mainView: 1 } }), row('other-blank', { blank: true })]
  const list: SessionListState = {
    ids: rows.map(value => value.id), byId: Object.fromEntries(rows.map(value => [value.id, value])), phase: 'ready',
    projectionsBySession: { [id('fork')]: { values: { subagentCatalog: [
      { id: id('child'), createdAt: 0, mode: 'one-shot' },
    ] } } as never },
  }
  const ctx = context()
  // Minimal test service fakes omit operations the metadata bridge never calls.
  ctx.provide('workspaces', { list: createSnapshotStore({ items: [{ workspaceId: 'w', path: '/home/u/repo',
      title: 'default-workspace', sessionIds: list.ids, createdAt: '2026-01-01T00:00:00.000Z' }],
    archivedSessionIds: [id('untitled')], pinnedSessionIds: [id('untitled'), id('fork')] }) } as never)
  ctx.provide('sessions', { list: createSnapshotStore(list) } as never)
  ctx.provide('uiSession', { adapter: { current: createSnapshotStore({ key: undefined }) }, sessionStatus: createSnapshotStore(new Map()) } as never)
  ctx.provide('remote', { $host: { home: '/home/u' } } as never)
  ctx.provide('locale', { bind: () => () => 'Default Workspace' } as never)
  const value = snapshotSchema.parse(snapshot(ctx))
  expect(value.selectedSessionId).toBe('current-blank')
  expect(value.home).toBe('/home/u')
  expect(value.groups[0]?.label).toBe('Default Workspace')
  expect(value.groups[0]?.sessions.map(session => session.id)).toEqual(['fork', 'untitled', 'current-blank'])
  expect(value.groups[0]?.sessions[0]).toMatchObject({ title: 'Forked conversation', pinned: true, runningSubagentCount: 1 })
  expect(value.groups[0]?.sessions[1]).toMatchObject({ title: '', pinned: false, archived: true })
})

it('dispatches only a catalogued native shortcut from the exact same-origin parent', async () => {
  const invoke = vi.fn()
  const sidebar = vi.fn()
  const post = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {})
  const ctx = context()
  // Minimal test service fakes omit operations outside shortcut dispatch and snapshot publication.
  ctx.provide('layout', { setSidebarVisible: sidebar } as never)
  ctx.provide('remote', { $host: {} } as never)
  ctx.provide('workspaces', { list: createSnapshotStore({ items: [], archivedSessionIds: [], pinnedSessionIds: [] }) } as never)
  ctx.provide('sessions', { list: createSnapshotStore({ ids: [], byId: {}, projectionsBySession: {} }) } as never)
  ctx.provide('uiSession', { adapter: { current: createSnapshotStore({ key: undefined }) }, sessionStatus: createSnapshotStore(new Map()) } as never)
  ctx.provide('shortcuts', { catalog: createSnapshotStore([{ id: 'session.stop' }]), invoke } as never)
  const send = (commandId: unknown, source: MessageEventSource | null = window.parent, origin = window.location.origin): void => {
    window.dispatchEvent(new MessageEvent('message', { source, origin,
      data: { source: 'codexydsh-native-shortcut', commandId } }))
  }
  try {
    installEmbedded(ctx)
    send('session.stop', null)
    send('session.stop', window.parent, 'https://unrelated.invalid')
    send('unknown.command')
    send({ id: 'session.stop' })
    expect(invoke).not.toHaveBeenCalled()
    send('session.stop')
    expect(invoke).toHaveBeenCalledExactlyOnceWith('session.stop')
    expect(sidebar).toHaveBeenCalledWith(false)
  } finally {
    await ctx.fiber.dispose()
    post.mockRestore()
  }
  expect(sidebar).toHaveBeenLastCalledWith(true)
})
