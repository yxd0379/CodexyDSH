/** Older pages follow deliberate reader movement, retaining the reading anchor. */
import { expect, it, vi } from 'vitest'
import { ChatNavigation } from '../src/client/chat/use-chat-navigation.ts'
import type { ChatReading } from '../src/client/chat/use-chat-reading.ts'
import type { ChatViewport } from '../src/client/chat/use-chat-viewport.ts'

it('loads one page at the top, ignores layout motion, and rearms after settlement', () => {
  const beginPaging = vi.fn()
  const viewport = { stopPreserving: vi.fn(), beginPaging } as Partial<ChatViewport> as ChatViewport
  const reading = { pauseFollowing: vi.fn() } as Partial<ChatReading> as ChatReading
  const input = { firstSeq: 100, hasMore: true, loadingOlder: false, autoLoadEarlier: true,
    loadOlder: vi.fn(), loadThrough: vi.fn(async () => {}) }
  const navigation = new ChatNavigation(viewport, reading, input, vi.fn())
  const sample = { position: { scrollTop: 0, anchorKey: 'turn-4', anchorTop: 0 }, followingTail: false, movedByReader: false }
  navigation.readerSampled(sample)
  expect(input.loadOlder).not.toHaveBeenCalled()
  navigation.readerSampled({ ...sample, movedByReader: true })
  navigation.readerSampled({ ...sample, movedByReader: true })
  expect(input.loadOlder).toHaveBeenCalledOnce()
  expect(beginPaging).not.toHaveBeenCalled()
  navigation.setInput({ ...input, loadingOlder: true })
  navigation.readerSampled({ ...sample, movedByReader: true })
  expect(input.loadOlder).toHaveBeenCalledOnce()
  navigation.setInput({ ...input, firstSeq: 50 })
  navigation.readerSampled(sample)
  expect(input.loadOlder).toHaveBeenCalledOnce()
  navigation.readerSampled({ ...sample, movedByReader: true })
  expect(input.loadOlder).toHaveBeenCalledTimes(2)
  navigation.setInput({ ...input, hasMore: false, firstSeq: 1 })
  navigation.readerSampled({ ...sample, movedByReader: true })
  expect(input.loadOlder).toHaveBeenCalledTimes(2)
  navigation.dispose()
})

it('prefetches before reaching the top and leaves scroll anchoring to the browser', () => {
  const viewport = { stopPreserving: vi.fn(), beginPaging: vi.fn(), beginPreserving: vi.fn() } as Partial<ChatViewport> as ChatViewport
  const reading = { pauseFollowing: vi.fn(), followingTail: false } as Partial<ChatReading> as ChatReading
  const input = { firstSeq: 100, hasMore: true, loadingOlder: false, autoLoadEarlier: true,
    loadOlder: vi.fn(), loadThrough: vi.fn(async () => {}) }
  const navigation = new ChatNavigation(viewport, reading, input, vi.fn())
  navigation.readerScrolled({ metrics: { top: 601, height: 300, floor: 2000 }, movedByReader: true })
  navigation.readerScrolled({ metrics: { top: 500, height: 300, floor: 2000 }, movedByReader: false })
  expect(input.loadOlder).not.toHaveBeenCalled()
  navigation.readerScrolled({ metrics: { top: 500, height: 300, floor: 2000 }, movedByReader: true })
  navigation.readerScrolled({ metrics: { top: 300, height: 300, floor: 2000 }, movedByReader: true })
  expect(input.loadOlder).toHaveBeenCalledOnce()
  expect(viewport.beginPaging).not.toHaveBeenCalled()
  navigation.setInput({ ...input, loadingOlder: true })
  navigation.readerSettled()
  expect(viewport.beginPreserving).not.toHaveBeenCalled()
  navigation.setInput({ ...input, firstSeq: 50 })
  navigation.readerScrolled({ metrics: { top: 590, height: 300, floor: 4000 }, movedByReader: true })
  expect(input.loadOlder).toHaveBeenCalledTimes(2)
  navigation.dispose()
})
