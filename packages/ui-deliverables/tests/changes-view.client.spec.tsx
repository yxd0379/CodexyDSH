// @vitest-environment jsdom
/** Compact file cards select truthful Host comparisons or recorded edit inspections. */
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@codexydsh/test-support/client'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { ChangesView } from '../src/client/ChangesView.tsx'
import { changesSummaryUrl, type ChangesSummary, type SessionChangesHistory } from '../src/changes.ts'
import type { ChangesHistoryState } from '../src/client/changes-history.ts'
import { en } from '../src/client/locales.ts'
import { laterRecordedChangeFixture, recordedChangesFixture } from './fixtures/recorded-changes.ts'

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

const sessionId = SessionId('mixed-changes')
const inventory: SessionChangesHistory = { throughSeq: 8, turns: [
  { turn: 1, changes: { seq: 2 } },
  { turn: 2, diffs: [...recordedChangesFixture.map(diff => ({ ...diff, callId: ToolCallId('first-patch') })),
    ...laterRecordedChangeFixture.map(diff => ({ ...diff, callId: ToolCallId('last-patch') }))] },
] }

function mount(inspection = true, initial: ChangesHistoryState = { phase: 'ready', history: inventory }) {
  const summary: ChangesSummary = { turn: 1, total: 1, added: 2, deleted: 1,
    files: [{ path: 'src/host.ts', display: 'src/host.ts', added: 2, deleted: 1 }],
  }
  const summaries = { [changesSummaryUrl(sessionId, 2)]: summary }
  const sessions: SessionListState = { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }
  const inspectCall = vi.fn()
  const openChangesReview = vi.fn()
  const loadChangesSummary = vi.fn(async () => {})
  const loadChangesDiff = vi.fn(async () => {})
  const release = vi.fn()
  const retainChangesHistory = vi.fn(() => release)
  const retryChangesHistory = vi.fn(async () => {})
  type Props = Parameters<typeof ChangesView>[0]
  const props: Partial<Props> = {
    sessionId, t: makeTranslate(en), inspectCall: inspection ? inspectCall : undefined,
    useChangesHistory: select => select({ [sessionId]: initial }), useSessions: select => select(sessions),
    useChangesSummary: select => select(summaries), useChangesDiff: select => select({}),
    openChangesReview, loadChangesSummary, loadChangesDiff,
    retainChangesHistory, retryChangesHistory,
  }
  const view = render(<ChangesView {...props as Props} />)
  return { view, inspectCall, openChangesReview, loadChangesSummary, loadChangesDiff, release, retainChangesHistory, retryChangesHistory }
}

describe('Changed files across recorded turns', () => {
  it('uses the same compact card for Host summaries and long recorded patches', () => {
    const { view, inspectCall, openChangesReview, loadChangesSummary, loadChangesDiff } = mount()
    expect(view.container.querySelectorAll('[data-changed-files]')).toHaveLength(2)
    expect(view.container.querySelector('[data-diff-line]')).toBeNull()
    expect(view.queryByText('export const line119 = 119')).toBeNull()
    const edits = view.getByText('Turn 2').closest('section')
    if (edits === null) throw new Error('Recorded edit section is missing')
    expect(within(edits).getByText('Recorded edits')).toBeTruthy()
    expect(within(edits).getByText('Edited 2 files')).toBeTruthy()
    expect(within(edits).getAllByText('+122')).toHaveLength(1)
    expect(within(edits).getAllByText('-2')).toHaveLength(1)
    fireEvent.click(within(edits).getByRole('button', { name: 'Inspect the latest edit to src/long.ts' }))
    expect(inspectCall).toHaveBeenCalledExactlyOnceWith('last-patch')
    expect(openChangesReview).not.toHaveBeenCalled()
    expect(loadChangesSummary).not.toHaveBeenCalled()
    expect(loadChangesDiff).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: 'View changes to src/host.ts' }))
    expect(openChangesReview).toHaveBeenCalledWith({ sessionId, seq: 2, turn: 1 }, 0)
  })

  it('previews and copies every recorded operation after hover dwell without reading the Host', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn(async (_text: string) => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { view, loadChangesSummary, loadChangesDiff } = mount()
    fireEvent.pointerEnter(view.getByRole('button', { name: 'Inspect the latest edit to src/long.ts' }))
    act(() => { vi.advanceTimersByTime(500) })
    const preview = document.querySelector('[data-recorded-changes-preview]')
    if (preview === null) throw new Error('Recorded diff preview is missing')
    expect(preview.textContent).toContain('export const line0 = 0')
    expect(preview.textContent).toContain('export const line119 = 120')
    await act(async () => { fireEvent.click(within(preview as HTMLElement).getByRole('button', { name: 'Copy full diff' })) })
    expect(writeText).toHaveBeenCalledOnce()
    expect(writeText.mock.calls[0]?.[0]).toContain('export const line0 = 0')
    expect(writeText.mock.calls[0]?.[0]).toContain('export const line119 = 119')
    expect(writeText.mock.calls[0]?.[0]).toContain('export const line119 = 120')
    expect(loadChangesSummary).not.toHaveBeenCalled()
    expect(loadChangesDiff).not.toHaveBeenCalled()
  })

  it('leaves recorded edits compact and disables unavailable tool inspection', () => {
    const { view, inspectCall } = mount(false)
    expect((view.getByRole('button', { name: 'Inspect the latest edit to src/long.ts' }) as HTMLButtonElement).disabled).toBe(true)
    expect(view.container.querySelector('[data-diff-line]')).toBeNull()
    expect(inspectCall).not.toHaveBeenCalled()
  })

  it('keeps the full inventory while a refresh fails and offers retry', () => {
    const { view, retryChangesHistory, retainChangesHistory, release } = mount(true, { phase: 'error', history: inventory })
    expect(view.getByRole('alert').textContent).toContain('Could not load conversation changes')
    expect(view.container.querySelectorAll('[data-changed-files]')).toHaveLength(2)
    fireEvent.click(view.getByRole('button', { name: 'Retry' }))
    expect(retryChangesHistory).toHaveBeenCalledOnce()
    expect(retainChangesHistory).toHaveBeenCalledOnce()
    view.unmount()
    expect(release).toHaveBeenCalledOnce()
  })

  it('distinguishes a pending complete-history query from an empty Session', () => {
    const pending = mount(true, { phase: 'loading' }).view
    expect(pending.getByRole('status', { name: 'Loading conversation changes' })).toBeTruthy()
    expect(pending.queryByText('No file changes in this conversation')).toBeNull()
    pending.unmount()
    const empty = mount(true, { phase: 'ready', history: { throughSeq: -1, turns: [] } }).view
    expect(empty.getByText('No file changes in this conversation')).toBeTruthy()
    expect(empty.queryByRole('status')).toBeNull()
  })
})
