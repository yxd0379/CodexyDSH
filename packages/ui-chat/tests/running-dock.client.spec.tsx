// @vitest-environment jsdom
/** Codexful run status belongs to the composer and clears when the run ends. */
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@codexydsh/test-support/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { RunningDock } from '../src/client/chat/RunningDock.tsx'
import { derivePresentationPolicy } from '../src/client/presentation-policy.ts'
import { en } from '../src/client/locale.ts'
import { commonEn } from '@codexydsh/test-support/client'
import type { TranscriptViewMode } from '../src/chat-settings.ts'
import type { ChatSnapshot } from '../src/client/contract/snapshot.ts'
import { chatSnapshotFixture } from './chat-snapshot-fixture.client.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })
it('shows one live status in Codexful and removes it on completion', () => {
  const session = createSnapshotStore({ running: true })
  const app = createSnapshotStore(true)
  const usePresentation = bindSnapshotSelector(derivePresentationPolicy(createSnapshotStore<TranscriptViewMode>('standard'), app))
  const props = {
    useSession: bindSnapshotSelector(session), usePresentation,
    useRunningChat: bindSnapshotSelector(createSnapshotStore(undefined)),
    t: makeTranslate(en, commonEn),
  } as Parameters<typeof RunningDock>[0]
  const view = render(<RunningDock {...props} />)
  expect(view.getByRole('status').textContent).toContain(en['chat.deepDiving'])
  act(() => { session.set({ running: false }) })
  expect(view.queryByRole('status')).toBeNull()
  act(() => { session.set({ running: true }); app.set(false) })
  expect(view.queryByRole('status')).toBeNull()
})

it('updates the active turn clock, resets for the next run and stops ticking when idle', () => {
  vi.useFakeTimers()
  vi.setSystemTime(100_000)
  const session = createSnapshotStore({ running: true })
  const app = createSnapshotStore(true)
  const chat = createSnapshotStore<ChatSnapshot | undefined>(undefined)
  const usePresentation = bindSnapshotSelector(derivePresentationPolicy(createSnapshotStore<TranscriptViewMode>('standard'), app))
  const props = {
    useSession: bindSnapshotSelector(session), usePresentation,
    useRunningChat: bindSnapshotSelector(chat),
    t: makeTranslate(en, commonEn),
  } as Parameters<typeof RunningDock>[0]
  const view = render(<RunningDock {...props} />)
  expect(view.container.querySelector('[data-running-duration]')).toBeNull()
  act(() => { chat.set(chatSnapshotFixture({ turnTimings: new Map([[1, { startTime: 88_000 }]]) })) })
  const duration = () => view.container.querySelector('[data-running-duration]')?.textContent
  expect(duration()).toBe('12s')
  act(() => { vi.advanceTimersByTime(2000) })
  expect(duration()).toBe('14s')
  act(() => {
    chat.set(chatSnapshotFixture({
      turnTimings: new Map([[1, { startTime: 88_000, endTime: 101_000 }], [2, { startTime: 100_000 }]]),
      turnEnds: new Map([[1, 2]]),
    }))
  })
  expect(duration()).toBe('2s')
  act(() => { session.set({ running: false }) })
  expect(view.queryByRole('status')).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
})
