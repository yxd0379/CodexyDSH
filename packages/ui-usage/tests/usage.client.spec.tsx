// @vitest-environment jsdom
/** Usage presents exact model totals and owns cancellation across range changes and closing. */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@codexydsh/test-support/client'
import { commonZh } from '@codexydsh/test-support/client'
import type { UsageSnapshot } from '@codexydsh/api-usage/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { UsageController } from '../src/client/controller.ts'
import { UsageSection } from '../src/client/UsageSection.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

const snapshot: UsageSnapshot = {
  capturedAt: 1_700_000_000_000,
  totals: { requests: 4, reportedRequests: 3, inputTokens: 1200, outputTokens: 300,
    totalTokens: 1500, cacheReadTokens: 100, cacheWriteTokens: 50 },
  models: [
    { provider: 'deepseek', model: 'deepseek-chat', requests: 3, reportedRequests: 3, inputTokens: 1200,
      outputTokens: 300, totalTokens: 1500, cacheReadTokens: 100, cacheWriteTokens: 50 },
    { provider: null, model: null, requests: 1, reportedRequests: 0, inputTokens: 0,
      outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  ],
}

function fixture(dictionary = zh as Record<keyof typeof zh, string>) {
  const read = vi.fn<ConstructorParameters<typeof UsageController>[0]>().mockResolvedValue({ ok: true, value: snapshot })
  const controller = new UsageController(read, () => snapshot.capturedAt)
  const props = { useUsage: bindSnapshotSelector(controller.state), observe: controller.observe,
    refresh: controller.load, select: controller.select, t: makeTranslate(dictionary, commonZh) }
  return { read, controller, mount: () => render(<UsageSection {...props} />) }
}

it('shows exact request and token counts, per-model provider identity, cache reads, and missing usage', async () => {
  const f = fixture()
  const ui = f.mount()
  const table = await ui.findByRole('table', { name: zh.models })
  expect(table.textContent).toContain('deepseek-chatdeepseek31,2003001001,500')
  expect(table.textContent).toContain(zh.unknown)
  expect(table.textContent).toContain(zh.unknownProvider)
  const cards = ui.container.querySelector('dl')
  expect(cards?.textContent).toBe('请求数4总 token1,500输入 token1,200输出 token300')
  expect(ui.getByText('1 个请求未返回 token 用量，已计入请求数')).toBeTruthy()
  expect(ui.getByRole('tab', { name: zh.all }).getAttribute('aria-selected')).toBe('true')
  expect(ui.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(ui.getByRole('tab', { name: zh.all }).id)
})

it('queries rolling ranges, clears the prior range and retries failed refreshes without losing figures', async () => {
  const f = fixture()
  const ui = f.mount()
  await ui.findByRole('table')
  await act(async () => { fireEvent.click(ui.getByRole('tab', { name: zh.week })) })
  expect(f.read.mock.calls.at(-1)?.[0]).toEqual({ since: snapshot.capturedAt - 7 * 86_400_000, until: snapshot.capturedAt })
  await act(async () => { fireEvent.click(ui.getByRole('tab', { name: zh.month })) })
  expect(f.read.mock.calls.at(-1)?.[0]).toEqual({ since: snapshot.capturedAt - 30 * 86_400_000, until: snapshot.capturedAt })
  const calls = f.read.mock.calls.length
  fireEvent.click(ui.getByRole('tab', { name: zh.month }))
  expect(f.read.mock.calls).toHaveLength(calls)
  f.read.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'read failed', {}) })
  await act(async () => { fireEvent.click(ui.getByRole('button', { name: zh.refresh })) })
  expect(ui.getByRole('alert').textContent).toContain(zh.failed)
  expect(ui.getByRole('table').textContent).toContain('deepseek-chat')
  await act(async () => { fireEvent.click(ui.getByRole('button', { name: zh.retry })) })
  expect(ui.queryByRole('alert')).toBeNull()
  await act(async () => { fireEvent.click(ui.getByRole('tab', { name: zh.all })) })
  expect(f.read.mock.calls.at(-1)?.[0]).toEqual({})
})

it('renders a bare loading indicator, ignores stale queries and cancels when closed', async () => {
  const f = fixture()
  const first = Promise.withResolvers<RemoteResult<UsageSnapshot>>()
  f.read.mockReturnValueOnce(first.promise)
  const ui = f.mount()
  expect(ui.getByRole('status', { name: zh.loading })).toBeTruthy()
  expect(ui.queryByRole('table')).toBeNull()
  const firstSignal = f.read.mock.calls[0]![1]
  await act(async () => { fireEvent.click(ui.getByRole('tab', { name: zh.week })) })
  expect(firstSignal.aborted).toBe(true)
  expect(ui.queryByRole('status')).toBeNull()
  await act(async () => { first.resolve({ ok: true, value: { ...snapshot, models: [] } }); await first.promise })
  expect(ui.getByRole('table')).toBeTruthy()
  const pending = Promise.withResolvers<RemoteResult<UsageSnapshot>>()
  f.read.mockReturnValueOnce(pending.promise)
  await act(async () => { fireEvent.click(ui.getByRole('button', { name: zh.refresh })) })
  const signal = f.read.mock.calls.at(-1)![1]
  const beforeClose = f.controller.state.getSnapshot()
  ui.unmount()
  expect(signal.aborted).toBe(true)
  pending.reject(new Error('cancelled request'))
  await pending.promise.catch(() => undefined)
  expect(f.controller.state.getSnapshot()).toBe(beforeClose)
})

it('shows an initial query error and an empty result after Retry', async () => {
  const f = fixture()
  f.read.mockRejectedValueOnce(new Error('offline'))
  const ui = f.mount()
  await ui.findByRole('alert')
  expect(ui.queryByRole('table')).toBeNull()
  f.read.mockResolvedValueOnce({ ok: true, value: { ...snapshot,
    totals: { requests: 0, reportedRequests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    models: [] } })
  await act(async () => { fireEvent.click(ui.getByRole('button', { name: zh.retry })) })
  expect(ui.getByText(zh.empty)).toBeTruthy()
  expect(ui.queryByRole('alert')).toBeNull()
  expect(ui.queryByText(/个请求未返回/)).toBeNull()
})

it('uses the English dictionary for labels, statuses and units', async () => {
  const f = fixture(en)
  const ui = f.mount()
  await ui.findByRole('table', { name: en.models })
  expect(ui.getByRole('tablist', { name: en.range })).toBeTruthy()
  expect(ui.getByText(en.input, { selector: 'dt' })).toBeTruthy()
  expect(ui.getByText(en.note)).toBeTruthy()
})
