/** A failed memory operation preserves public data and the user's complete draft. */
import { afterEach, expect, it, vi } from 'vitest'
import type { MemoryRead, MemoryRevision } from '@codexydsh/api-memory/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { editableMemory, MemoryViewController } from '../src/client/model.ts'
import type { MemoryRemote } from '../src/client/model.ts'

const revision = 'read-version' as MemoryRevision
const document: MemoryRead = { path: 'MEMORY.md', start_line_number: 1, content: 'Original complete memory', truncated: false, revision }
const owners: MemoryViewController[] = []
afterEach(() => { for (const owner of owners.splice(0)) owner.dispose(); vi.useRealTimers() })

function fixture() {
  const remote = {
    snapshot: vi.fn<MemoryRemote['snapshot']>().mockResolvedValue({ ok: true, value: { root: '/memory', version: 'v2', summary: 'Summary', running: false } }),
    list: vi.fn<MemoryRemote['list']>().mockResolvedValue({ ok: true, value: { path: null, entries: [{ path: 'MEMORY.md', entry_type: 'file' }], next_cursor: null, truncated: false } }),
    read: vi.fn<MemoryRemote['read']>().mockResolvedValue({ ok: true, value: document }),
    search: vi.fn<MemoryRemote['search']>().mockResolvedValue({ ok: true, value: { queries: ['fact'], match_mode: { type: 'any' }, path: null, matches: [], next_cursor: null, truncated: false } }),
    edit: vi.fn<MemoryRemote['edit']>().mockResolvedValue({ ok: true, value: 'saved-version' as MemoryRevision }),
    refresh: vi.fn<MemoryRemote['refresh']>().mockResolvedValue({ ok: true, value: { extracted: 0, skipped: 1, consolidated: false } }),
  }
  const notify = vi.fn()
  const id = 'memory-view-session' as SessionId
  const controller = new MemoryViewController(remote, id, notify, () => 1500)
  owners.push(controller)
  return { remote, notify, controller, id }
}

it('browses through one captured Session identity without dispatching a refresh', async () => {
  const b = fixture()
  await b.controller.load()
  await b.controller.read('MEMORY.md')
  expect(b.remote.snapshot).toHaveBeenCalledWith(b.id, expect.any(AbortSignal))
  expect(b.remote.list).toHaveBeenCalledWith(b.id, { path: '' }, expect.any(AbortSignal))
  expect(b.remote.read).toHaveBeenCalledWith(b.id, { path: 'MEMORY.md' }, expect.any(AbortSignal))
  expect(b.controller.state.getSnapshot().document).toEqual(document)
  expect(b.remote.refresh).not.toHaveBeenCalled()
})

it('keeps a stale edit draft through a conflict and closing/reopening the browser', async () => {
  const b = fixture()
  await b.controller.load()
  await b.controller.read('MEMORY.md')
  b.controller.beginEdit()
  b.controller.setDraft('My complete correction')
  b.remote.edit.mockResolvedValueOnce({ ok: false, error: { code: 'memory/conflict', message: 'Changed by another editor', details: { path: 'MEMORY.md' } } })
  await b.controller.save()
  expect(b.remote.edit).toHaveBeenCalledExactlyOnceWith(b.id, { path: 'MEMORY.md', content: 'My complete correction', expectedRevision: revision }, expect.any(AbortSignal))
  expect(b.controller.state.getSnapshot()).toMatchObject({ editing: true, draft: 'My complete correction', error: { kind: 'conflict' } })
  b.controller.close()
  b.controller.open()
  expect(b.controller.state.getSnapshot().draft).toBe('My complete correction')
  expect(b.notify).not.toHaveBeenCalled()
})

it('keeps an unsaved draft when reads and saves fail', async () => {
  const b = fixture()
  await b.controller.read('MEMORY.md')
  b.controller.beginEdit()
  b.controller.setDraft('My draft')
  await b.controller.read('memory_summary.md')
  expect(b.controller.state.getSnapshot()).toMatchObject({ draft: 'My draft', error: { kind: 'unsaved' } })
  expect(b.remote.read).toHaveBeenCalledTimes(1)
  b.remote.edit.mockRejectedValueOnce(new Error('Connection lost'))
  await b.controller.save()
  expect(b.controller.state.getSnapshot()).toMatchObject({ draft: 'My draft', editing: true, document, error: { kind: 'requestFailed' } })
})

it('never edits truncated, sliced, or consolidation-managed detail documents', async () => {
  const b = fixture()
  for (const value of [{ ...document, truncated: true }, { ...document, start_line_number: 2 }, { ...document, path: 'rollout_summaries/one.md' }]) {
    b.remote.read.mockResolvedValueOnce({ ok: true, value })
    await b.controller.read(value.path)
    expect(editableMemory(value)).toBe(false)
    b.controller.beginEdit()
    b.controller.setDraft('A fragment must not replace the file')
    await b.controller.save()
    expect(b.controller.state.getSnapshot().editing).toBe(false)
  }
  expect(b.remote.edit).not.toHaveBeenCalled()
})

it('publishes a saved revision before notifying the root overlay', async () => {
  const b = fixture()
  await b.controller.read('MEMORY.md')
  b.controller.beginEdit()
  b.controller.setDraft('New complete memory')
  b.remote.read.mockResolvedValueOnce({ ok: true, value: { ...document, content: 'New complete memory', revision: 'saved-version' as MemoryRevision } })
  await b.controller.save()
  expect(b.controller.state.getSnapshot()).toMatchObject({ draft: 'New complete memory', editing: false,
    document: { content: 'New complete memory', revision: 'saved-version' }, error: null })
  expect(b.notify).toHaveBeenCalledExactlyOnceWith('saved')
})

it('shows the stored sanitized content after a successful edit', async () => {
  const b = fixture()
  await b.controller.read('MEMORY.md')
  b.controller.beginEdit()
  b.controller.setDraft('API_KEY=private-secret')
  b.remote.read.mockResolvedValueOnce({ ok: true, value: { ...document, content: 'API_KEY=[REDACTED]', revision: 'saved-version' as MemoryRevision } })
  await b.controller.save()
  expect(b.controller.state.getSnapshot()).toMatchObject({ draft: 'API_KEY=[REDACTED]', editing: false,
    document: { content: 'API_KEY=[REDACTED]', revision: 'saved-version' } })
})

it('reports a committed edit separately from a failed stored-content read and retains the draft', async () => {
  const b = fixture()
  await b.controller.read('MEMORY.md')
  b.controller.beginEdit()
  b.controller.setDraft('My correction')
  b.remote.read.mockRejectedValueOnce(new Error('Read transport unavailable'))
  await b.controller.save()
  expect(b.controller.state.getSnapshot()).toMatchObject({ draft: 'My correction', editing: true,
    document: { revision: 'saved-version' }, error: { kind: 'savedReadFailed' } })
  expect(b.notify).toHaveBeenCalledExactlyOnceWith('saved')
})

it('refuses a refresh over an unsaved correction and reports an empty eligible-session result', async () => {
  const b = fixture()
  await b.controller.read('MEMORY.md')
  b.controller.beginEdit()
  b.controller.setDraft('Unsaved memory')
  await b.controller.refresh()
  expect(b.remote.refresh).not.toHaveBeenCalled()
  b.controller.discard()
  await b.controller.refresh()
  expect(b.remote.refresh).toHaveBeenCalledExactlyOnceWith(b.id, expect.any(AbortSignal))
  expect(b.notify).toHaveBeenCalledExactlyOnceWith({ extracted: 0, skipped: 1, consolidated: false })
})

it('rereads the selected document after refreshing and displays its published revision', async () => {
  const b = fixture()
  await b.controller.read('MEMORY.md')
  b.remote.read.mockResolvedValueOnce({ ok: true, value: { ...document, content: 'Consolidated memory', revision: 'refresh-version' as MemoryRevision } })
  await b.controller.refresh()
  expect(b.remote.read).toHaveBeenLastCalledWith(b.id, { path: 'MEMORY.md' }, expect.any(AbortSignal))
  expect(b.controller.state.getSnapshot()).toMatchObject({ editing: false, draft: 'Consolidated memory',
    document: { content: 'Consolidated memory', revision: 'refresh-version' }, error: null })
})

it('preserves the selected document when refresh or its reread fails', async () => {
  const b = fixture()
  await b.controller.read('MEMORY.md')
  b.remote.refresh.mockRejectedValueOnce(new Error('Generation unavailable'))
  await b.controller.refresh()
  expect(b.controller.state.getSnapshot()).toMatchObject({ document, draft: document.content, error: { kind: 'requestFailed' } })
  expect(b.remote.read).toHaveBeenCalledTimes(1)
  b.remote.read.mockRejectedValueOnce(new Error('Published document unavailable'))
  await b.controller.refresh()
  expect(b.controller.state.getSnapshot()).toMatchObject({ document, draft: document.content, error: { kind: 'requestFailed' } })
  expect(b.notify).not.toHaveBeenCalled()
})

it('cancels a disposed view and ignores its delayed response', async () => {
  const b = fixture()
  const pending = Promise.withResolvers<Awaited<ReturnType<MemoryRemote['read']>>>()
  b.remote.read.mockReturnValueOnce(pending.promise)
  const reading = b.controller.read('MEMORY.md')
  const signal = b.remote.read.mock.calls[0]?.[2]
  b.controller.dispose()
  expect(signal?.aborted).toBe(true)
  pending.resolve({ ok: true, value: document })
  await reading
  expect(b.controller.state.getSnapshot().document).toBeNull()
})

it('searches the literal query and preserves the current document', async () => {
  const b = fixture()
  await b.controller.read('MEMORY.md')
  b.controller.setQuery('fact')
  await b.controller.search()
  expect(b.remote.search).toHaveBeenCalledExactlyOnceWith(b.id, { queries: ['fact'] }, expect.any(AbortSignal))
  expect(b.controller.state.getSnapshot()).toMatchObject({ document, search: { queries: ['fact'] } })
})

it('updates background status without changing an editor, selection, or search', async () => {
  vi.useFakeTimers()
  const b = fixture()
  b.remote.snapshot.mockResolvedValue({ ok: true, value: { root: '/memory', version: 'v2', summary: 'Summary', running: true } })
  await b.controller.load()
  await b.controller.read('MEMORY.md')
  b.controller.setQuery('fact')
  await b.controller.search()
  b.controller.beginEdit()
  b.controller.setDraft('Retained human correction')
  b.controller.open()
  const stop = b.controller.observe()
  b.remote.snapshot.mockResolvedValue({ ok: true, value: { root: '/memory', version: 'v2', summary: 'Published summary', running: false } })
  await vi.advanceTimersByTimeAsync(1500)
  expect(b.controller.state.getSnapshot()).toMatchObject({ status: { running: false, summary: 'Published summary' },
    document, editing: true, draft: 'Retained human correction', query: 'fact', search: { queries: ['fact'] } })
  expect(b.remote.list).toHaveBeenCalledTimes(1)
  expect(b.remote.read).toHaveBeenCalledTimes(1)
  stop()
  await vi.advanceTimersByTimeAsync(6000)
  expect(b.remote.snapshot).toHaveBeenCalledTimes(2)
})

it('pauses a failed status observation, retries on Reload, and aborts mounted or unloading requests', async () => {
  vi.useFakeTimers()
  const b = fixture()
  const running = { ok: true as const, value: { root: '/memory', version: 'v2', summary: 'Summary', running: true } }
  b.remote.snapshot.mockResolvedValue(running)
  await b.controller.load()
  b.controller.open()
  const stop = b.controller.observe()
  b.remote.snapshot.mockRejectedValueOnce(new Error('Status connection lost'))
  await vi.advanceTimersByTimeAsync(1500)
  expect(b.controller.state.getSnapshot().statusError).toBe('Status connection lost')
  await vi.advanceTimersByTimeAsync(10_000)
  expect(b.remote.snapshot).toHaveBeenCalledTimes(2)
  await b.controller.load()
  expect(b.controller.state.getSnapshot().statusError).toBeNull()
  const pending = Promise.withResolvers<Awaited<ReturnType<MemoryRemote['snapshot']>>>()
  b.remote.snapshot.mockImplementationOnce(async (...[_id, signal]: Parameters<MemoryRemote['snapshot']>): ReturnType<MemoryRemote['snapshot']> => {
    const response = await pending.promise
    signal?.throwIfAborted()
    return response
  })
  await vi.advanceTimersByTimeAsync(1500)
  const signal = b.remote.snapshot.mock.calls.at(-1)?.[1]
  stop()
  expect(signal?.aborted).toBe(true)
  pending.resolve({ ok: true, value: { ...running.value, running: false } })
  await vi.advanceTimersByTimeAsync(6000)
  expect(b.controller.state.getSnapshot().status?.running).toBe(true)
  expect(b.remote.snapshot).toHaveBeenCalledTimes(4)
  const stopAgain = b.controller.observe()
  b.remote.snapshot.mockImplementationOnce(async (...[_id, disposeSignal]: Parameters<MemoryRemote['snapshot']>): ReturnType<MemoryRemote['snapshot']> => {
    await new Promise<void>((_resolve, reject) => { disposeSignal?.addEventListener('abort', () => { reject(disposeSignal.reason) }, { once: true }) })
    return running
  })
  await vi.advanceTimersByTimeAsync(1500)
  const disposeSignal = b.remote.snapshot.mock.calls.at(-1)?.[1]
  b.controller.dispose()
  expect(disposeSignal?.aborted).toBe(true)
  stopAgain()
  await vi.advanceTimersByTimeAsync(6000)
  expect(b.remote.snapshot).toHaveBeenCalledTimes(5)
})
