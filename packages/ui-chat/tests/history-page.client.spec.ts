/** Product page sizes compose stock Session reads and stop after a failed page. */
import { describe, expect, it, vi } from 'vitest'
import { loadHistoryPage, type HistoryBinding } from '../src/client/history-page.ts'

function fixture(pageSize: number, failed = false) {
  let low = 500
  const entries = () => Array.from({ length: 501 - low }, (_, index) => ({
    type: 'event' as const, event: { seq: low + index, type: 'user/message' as const },
  }))
  const session = {
    getSnapshot: () => ({ hasMore: low > 0 }),
    loadOlder: vi.fn(async () => { if (!failed) low = Math.max(0, low - pageSize) }),
  }
  const binding = { session, eventSource: { getSnapshot: () => ({ entries: entries() }) } } as HistoryBinding
  return { binding, session }
}

describe('product history pages', () => {
  it('loads enough stock pages to honor the selected product size', async () => {
    const f = fixture(50)
    await loadHistoryPage(f.binding, 200)
    expect(f.session.loadOlder).toHaveBeenCalledTimes(4)
  })

  it('stops when the stock reader makes no progress', async () => {
    const f = fixture(50, true)
    await loadHistoryPage(f.binding, 200)
    expect(f.session.loadOlder).toHaveBeenCalledOnce()
  })

  it('reads the older page when a retained window is empty', async () => {
    let entries: readonly { type: 'event'; event: { seq: number; type: 'user/message' } }[] = []
    const loadOlder = vi.fn(async () => { entries = [{ type: 'event', event: { seq: 1, type: 'user/message' } }] })
    const binding = { session: { getSnapshot: () => ({ hasMore: true }), loadOlder },
      eventSource: { getSnapshot: () => ({ entries }) } } as HistoryBinding
    await loadHistoryPage(binding, 1)
    expect(loadOlder).toHaveBeenCalledOnce()
  })

  it('shares concurrent requests for one exact Session generation', async () => {
    const f = fixture(50)
    const first = loadHistoryPage(f.binding, 200)
    const second = loadHistoryPage(f.binding, 200)
    expect(second).toBe(first)
    await Promise.all([first, second])
    expect(f.session.loadOlder).toHaveBeenCalledTimes(4)
  })
})
