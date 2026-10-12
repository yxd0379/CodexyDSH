// @vitest-environment jsdom
/** Full-change reads coalesce live edits and stop publishing after view or Host replacement. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MutableSessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'
import { createMessage } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import { ChangesHistoryStore } from '../src/client/changes-history.ts'
import type { SessionChangesHistory } from '../src/changes.ts'

const sessionId = SessionId('viewed')
const empty: SessionChangesHistory = { throughSeq: 0, turns: [] }
const stores: ChangesHistoryStore[] = []
const reads: Array<ReturnType<typeof Promise.withResolvers<Response>>> = []
afterEach(async () => {
  const disposal = Promise.all(stores.map(store => store.dispose()))
  for (const read of reads) read.resolve(Response.json(empty))
  await disposal
  stores.length = 0
  reads.length = 0
  vi.unstubAllGlobals()
})

function fixture() {
  const store = new ChangesHistoryStore()
  stores.push(store)
  const source = new MutableSessionEventSource()
  const fetcher = vi.fn<(url: string, options?: RequestInit) => Promise<Response>>(() => {
    const read = Promise.withResolvers<Response>()
    reads.push(read)
    return read.promise
  })
  vi.stubGlobal('fetch', fetcher)
  return { store, source, fetcher }
}

function edit(seq: number): SessionEvent<'tool/result'> {
  const callId = ToolCallId(`patch-${seq}`)
  return { type: 'tool/result', surfaceOp: 'append', seq: SessionSeq(seq), time: seq + 1, data: { turn: 1, step: 1,
    message: createMessage({ role: 'tool', toolCallId: callId, source: { kind: 'tool', callId }, content: [{ type: 'text', text: 'Applied' }] }),
    meta: { diffs: [{ path: 'src/a.ts', oldText: null, newText: 'a' }] },
  } }
}

describe('ChangesHistoryStore', () => {
  it('reads complete history without altering the event window or duplicating mounted-view requests', async () => {
    const { store, source, fetcher } = fixture()
    source.replace([], true)
    const window = source.getSnapshot()
    const unsubscribe = vi.fn(source.subscribe.bind(source))
    const releaseA = store.retain(sessionId, { getSnapshot: () => source.getSnapshot(), subscribe: unsubscribe })
    expect(fetcher.mock.calls[0]?.[0]).toBe('api/changes.history?sessionId=viewed')
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
    reads[0]!.resolve(Response.json({ throughSeq: 10, turns: [{ turn: 1, changes: { seq: 3 } }] }))
    await store.retry(sessionId)
    expect(store.state.getSnapshot()[sessionId]?.history?.turns).toEqual([{ turn: 1, changes: { seq: 3 } }])
    expect(source.getSnapshot()).toBe(window)
    releaseA()
    source.append({ type: 'event', event: edit(11) })
    expect(fetcher).toHaveBeenCalledTimes(1)
    const releaseB = store.retain(sessionId, source)
    const releaseC = store.retain(sessionId, source)
    expect(fetcher).toHaveBeenCalledTimes(2)
    const signal = fetcher.mock.calls[1]![1]!.signal!
    releaseB()
    expect(signal.aborted).toBe(false)
    releaseC()
    expect(signal.aborted).toBe(true)
  })

  it('coalesces concurrent live edits, skips irrelevant and prepend events, and refreshes a stale in-flight cut once', async () => {
    const { store, source, fetcher } = fixture()
    store.retain(sessionId, source)
    source.prepend([{ type: 'event', event: edit(1) }], false)
    source.append({ type: 'event', event: { type: 'turn/start', seq: SessionSeq(2), time: 3, data: { turn: 1 } } })
    source.append({ type: 'event', event: edit(3) })
    source.append({ type: 'event', event: edit(4) })
    expect(fetcher).toHaveBeenCalledTimes(1)
    const first = store.retry(sessionId)
    reads[0]!.resolve(Response.json(empty))
    await first
    expect(fetcher).toHaveBeenCalledTimes(2)
    reads[1]!.resolve(Response.json({ ...empty, throughSeq: 4 }))
    await store.retry(sessionId)
    expect(fetcher).toHaveBeenCalledTimes(2)
    source.append({ type: 'event', event: edit(4) })
    expect(fetcher).toHaveBeenCalledTimes(2)
    source.append({ type: 'event', event: { type: 'workspace/changes', seq: SessionSeq(5), time: 6, data: { turn: 1 } } })
    expect(fetcher).toHaveBeenCalledTimes(3)
    reads[2]!.resolve(Response.json({ throughSeq: 5, turns: [{ turn: 1, changes: { seq: 5 } }] }))
    await store.retry(sessionId)
    expect(store.state.getSnapshot()[sessionId]?.history?.turns).toEqual([{ turn: 1, changes: { seq: 5 } }])
  })

  it('does not re-read when the initial Host cut already contains a delayed live announcement', async () => {
    const { store, source, fetcher } = fixture()
    store.retain(sessionId, source)
    source.append({ type: 'event', event: edit(3) })
    reads[0]!.resolve(Response.json({ ...empty, throughSeq: 4 }))
    await store.retry(sessionId)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('retains prior changes through invalid or failed responses and exposes explicit retry', async () => {
    const { store, source, fetcher } = fixture()
    store.retain(sessionId, source)
    reads[0]!.resolve(Response.json({ throughSeq: 2, turns: [{ turn: 1, changes: { seq: 2 } }] }))
    await store.retry(sessionId)
    source.append({ type: 'event', event: edit(3) })
    reads[1]!.resolve(new Response('failed', { status: 500 }))
    await store.retry(sessionId)
    expect(store.state.getSnapshot()[sessionId]).toEqual({ phase: 'error', history: { throughSeq: 2, turns: [{ turn: 1, changes: { seq: 2 } }] } })
    const invalid = store.retry(sessionId)
    reads[2]!.resolve(Response.json({ turns: [] }))
    await invalid
    expect(store.state.getSnapshot()[sessionId]?.phase).toBe('error')
    const offline = store.retry(sessionId)
    reads[3]!.reject(new Error('offline'))
    await offline
    expect(store.state.getSnapshot()[sessionId]?.phase).toBe('error')
    const retry = store.retry(sessionId)
    reads[4]!.resolve(Response.json({ ...empty, throughSeq: 3 }))
    await retry
    expect(store.state.getSnapshot()[sessionId]?.phase).toBe('ready')
    expect(fetcher).toHaveBeenCalledTimes(5)
  })

  it('ignores old Host and unmounted-view completions, and disposes its live listener', async () => {
    const { store, source, fetcher } = fixture()
    const release = store.retain(sessionId, source)
    const old = store.retry(sessionId)
    const oldSignal = fetcher.mock.calls[0]![1]!.signal!
    store.reset()
    expect(oldSignal.aborted).toBe(true)
    reads[1]!.resolve(Response.json({ ...empty, throughSeq: 20 }))
    await store.retry(sessionId)
    reads[0]!.resolve(Response.json({ ...empty, throughSeq: 2 }))
    await old
    expect(store.state.getSnapshot()[sessionId]?.history?.throughSeq).toBe(20)
    source.append({ type: 'event', event: edit(21) })
    const late = store.retry(sessionId)
    release()
    reads[2]!.resolve(Response.json({ ...empty, throughSeq: 21 }))
    await late
    expect(store.state.getSnapshot()[sessionId]?.history?.throughSeq).toBe(20)
    await store.dispose()
    source.replace([], false)
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(store.retain(sessionId, source)).toBeTypeOf('function')
    store.reset()
    await store.retry(sessionId)
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
})
