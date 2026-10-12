// @vitest-environment jsdom
/** Real Modal and injected observable hooks retain a failed human edit in the browser. */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@codexydsh/test-support/client'
import { commonZh } from '@codexydsh/test-support/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MemoryRevision } from '@codexydsh/api-memory/types'
import { MemoryAction } from '../src/client/MemoryAction.tsx'
import type { MemoryActionProps } from '../src/client/MemoryAction.tsx'
import { MemoryViewController } from '../src/client/model.ts'
import type { MemoryRemote } from '../src/client/model.ts'
import { zh } from '../src/client/locales.ts'

const owners: MemoryViewController[] = []
afterEach(() => { cleanup(); for (const owner of owners.splice(0)) owner.dispose(); vi.useRealTimers() })

async function fixture(empty = false, embedded = false) {
  const remote = {
    snapshot: vi.fn<MemoryRemote['snapshot']>().mockResolvedValue({ ok: true, value: { root: '/memory', version: 'v2', summary: empty ? '' : 'Concise summary', running: false } }),
    list: vi.fn<MemoryRemote['list']>().mockResolvedValue({ ok: true, value: { path: null, entries: empty ? [] : [{ path: 'MEMORY.md', entry_type: 'file' }], next_cursor: null, truncated: false } }),
    read: vi.fn<MemoryRemote['read']>().mockResolvedValue({ ok: true, value: { path: 'MEMORY.md', start_line_number: 1, content: 'Complete original memory', truncated: false, revision: 'initial' as MemoryRevision } }),
    search: vi.fn<MemoryRemote['search']>().mockResolvedValue({ ok: true, value: { queries: ['fact'], match_mode: { type: 'any' }, path: null, matches: [], next_cursor: null, truncated: false } }),
    edit: vi.fn<MemoryRemote['edit']>().mockResolvedValue({ ok: true, value: 'saved' as MemoryRevision }),
    refresh: vi.fn<MemoryRemote['refresh']>().mockResolvedValue({ ok: true, value: { extracted: 0, skipped: 1, consolidated: false } }),
  }
  const controller = new MemoryViewController(remote, 'dialog-session' as SessionId, vi.fn(), () => 1500)
  owners.push(controller)
  await controller.load()
  const props = {
    embedded,
    useMemoryView: bindSnapshotSelector(controller.state), t: makeTranslate(zh, commonZh),
    openMemory: () => { controller.open() }, closeMemory: () => { controller.close() },
    observeMemory: () => controller.observe(),
    reloadMemory: () => controller.load(), setMemoryQuery: (query: string) => { controller.setQuery(query) },
    searchMemory: (cursor?: string) => controller.search(cursor), listMemory: (path: string, cursor?: string) => controller.list(path, cursor),
    readMemory: (path: string) => controller.read(path), editMemory: () => { controller.beginEdit() },
    setMemoryDraft: (draft: string) => { controller.setDraft(draft) }, discardMemory: () => { controller.discard() },
    saveMemory: () => controller.save(), refreshMemory: () => controller.refresh(),
  } as MemoryActionProps
  const ui = render(<MemoryAction {...props} />)
  return { ui, remote, controller }
}

it('opens a body-portaled memory browser with empty-state guidance and refresh', async () => {
  const b = await fixture(true)
  fireEvent.click(b.ui.getByRole('button', { name: zh.title }))
  const modal = b.ui.getByRole('dialog', { name: zh.title })
  expect(modal.closest('[role="presentation"]')?.parentElement).toBe(document.body)
  expect(modal.textContent).toContain(zh.empty)
  expect(b.ui.getByRole('button', { name: zh.refresh }).hasAttribute('disabled')).toBe(false)
  expect(b.ui.getByRole('button', { name: zh.edit }).hasAttribute('disabled')).toBe(true)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(b.ui.queryByRole('dialog')).toBeNull()
})

it('shows a CAS conflict next to the editor and retains its text after closing and reopening', async () => {
  const b = await fixture()
  fireEvent.click(b.ui.getByRole('button', { name: zh.title }))
  await act(async () => { await b.controller.read('MEMORY.md') })
  fireEvent.click(b.ui.getByRole('button', { name: zh.edit }))
  fireEvent.change(b.ui.getByLabelText(zh.editorLabel), { target: { value: 'My complete correction' } })
  b.remote.edit.mockResolvedValueOnce({ ok: false, error: { code: 'memory/conflict', message: 'Document changed', details: { path: 'MEMORY.md' } } })
  await act(async () => { fireEvent.click(b.ui.getByRole('button', { name: zh.save })); await Promise.resolve() })
  expect(b.ui.getByRole('alert').textContent).toContain(zh.conflict)
  expect((b.ui.getByLabelText(zh.editorLabel) as HTMLTextAreaElement).value).toBe('My complete correction')
  fireEvent.click(b.ui.getByRole('button', { name: zh.close }))
  fireEvent.click(b.ui.getByRole('button', { name: zh.title }))
  expect((b.ui.getByLabelText(zh.editorLabel) as HTMLTextAreaElement).value).toBe('My complete correction')
  expect(b.ui.getByRole('button', { name: zh.refresh }).hasAttribute('disabled')).toBe(true)
})

it('marks truncated documents and consolidation details read-only', async () => {
  const b = await fixture()
  fireEvent.click(b.ui.getByRole('button', { name: zh.title }))
  b.remote.read.mockResolvedValueOnce({ ok: true, value: { path: 'MEMORY.md', start_line_number: 1, content: 'Partial document', truncated: true, revision: 'partial' as MemoryRevision } })
  await act(async () => { await b.controller.read('MEMORY.md') })
  expect(b.ui.getByText(zh.truncated)).toBeTruthy()
  expect(b.ui.getByRole('button', { name: zh.edit }).hasAttribute('disabled')).toBe(true)
  b.remote.read.mockResolvedValueOnce({ ok: true, value: { path: 'rollout_summaries/session.md', start_line_number: 1, content: 'Session detail', truncated: false, revision: 'detail' as MemoryRevision } })
  await act(async () => { await b.controller.read('rollout_summaries/session.md') })
  expect(b.ui.getByText(zh.readonly)).toBeTruthy()
  expect(b.ui.getByRole('button', { name: zh.edit }).hasAttribute('disabled')).toBe(true)
})

it('recovers the refresh button and selected document when background generation finishes', async () => {
  vi.useFakeTimers()
  const b = await fixture()
  b.remote.snapshot.mockResolvedValue({ ok: true, value: { root: '/memory', version: 'v2', summary: 'Earlier summary', revision: 'initial' as MemoryRevision, running: true } })
  await act(async () => { await b.controller.load(); await b.controller.read('MEMORY.md') })
  fireEvent.click(b.ui.getByRole('button', { name: zh.title }))
  expect(b.ui.getByRole('button', { name: zh.refreshRunning }).hasAttribute('disabled')).toBe(true)
  b.remote.snapshot.mockResolvedValue({ ok: true, value: { root: '/memory', version: 'v2', summary: 'Published summary', revision: 'published' as MemoryRevision, running: false } })
  b.remote.list.mockImplementation(async (...[_id, _request, signal]: Parameters<MemoryRemote['list']>): ReturnType<MemoryRemote['list']> => {
    signal?.throwIfAborted()
    return { ok: true, value: { path: null, entries: [{ path: 'MEMORY.md', entry_type: 'file' }, { path: 'memory_summary.md', entry_type: 'file' }], next_cursor: null, truncated: false } }
  })
  b.remote.read.mockImplementation(async (...[_id, _request, signal]: Parameters<MemoryRemote['read']>): ReturnType<MemoryRemote['read']> => {
    signal?.throwIfAborted()
    return { ok: true, value: { path: 'MEMORY.md', start_line_number: 1, content: 'New consolidated document', truncated: false, revision: 'published' as MemoryRevision } }
  })
  await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
  expect(b.ui.getByRole('button', { name: zh.refresh }).hasAttribute('disabled')).toBe(false)
  expect(b.ui.getByText('New consolidated document')).toBeTruthy()
  expect(b.controller.state.getSnapshot()).toMatchObject({ document: { revision: 'published' }, statusError: null })
  const requests = b.remote.snapshot.mock.calls.length
  await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
  expect(b.remote.snapshot).toHaveBeenCalledTimes(requests)
})

it('embeds browsing and editing directly in Settings without a second modal or launcher', async () => {
  const b = await fixture(false, true)
  expect(b.ui.queryByRole('dialog')).toBeNull()
  expect(b.ui.queryByRole('button', { name: zh.title })).toBeNull()
  await act(async () => { await b.controller.read('MEMORY.md') })
  fireEvent.click(b.ui.getByRole('button', { name: zh.edit }))
  expect(b.ui.getByLabelText(zh.editorLabel)).toBeTruthy()
})
