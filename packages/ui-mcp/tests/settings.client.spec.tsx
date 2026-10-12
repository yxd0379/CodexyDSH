// @vitest-environment jsdom
/** Human MCP edits retain failed drafts, hide saved authentication, and confirm deletion. */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@codexydsh/test-support/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { McpSettings, McpToast, type McpNotice } from '../src/client/McpSettings.tsx'
import type { CatalogSettings } from '../src/client/model.ts'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })

function fixture(snapshot: Partial<ConfigFormSnapshot<CatalogSettings>> = {}) {
  const state = createSnapshotStore<ConfigFormSnapshot<CatalogSettings>>({
    status: 'ready', value: { servers: {} }, base: {}, user: {}, writable: true, revision: 3, mode: 'host', ...snapshot,
  })
  const saveMcp = vi.fn<Parameters<typeof McpSettings>[0]['saveMcp']>().mockResolvedValue(undefined)
  const deleteMcp = vi.fn<Parameters<typeof McpSettings>[0]['deleteMcp']>().mockResolvedValue(undefined)
  const props = {
    useMcpSettings: bindSnapshotSelector(state), saveMcp, deleteMcp, t: makeTranslate(zh),
  } as Parameters<typeof McpSettings>[0]
  return { state, saveMcp, deleteMcp, ui: render(<McpSettings {...props} />) }
}

it('shows loading and read-only states without allowing a write', () => {
  const f = fixture({ status: 'loading', value: undefined, revision: undefined })
  expect(f.ui.queryByRole('button', { name: zh.add })).toBeNull()
  act(() => { f.state.set({ ...f.state.getSnapshot(), status: 'unavailable', writable: false }) })
  expect(f.ui.getByText(zh.unavailable)).toBeTruthy()
  expect(f.ui.getByRole('button', { name: zh.add }).hasAttribute('disabled')).toBe(true)
})

it('saves a stdio draft with arguments, environment, and an automatic default', async () => {
  const f = fixture()
  fireEvent.click(f.ui.getByRole('button', { name: zh.add }))
  fireEvent.change(f.ui.getByLabelText(zh.transport), { target: { value: 'streamable-http' } })
  fireEvent.change(f.ui.getByLabelText(zh.transport), { target: { value: 'stdio' } })
  for (const [label, value] of [[zh.name, 'docs'], [zh.command, 'npx'], [zh.args, '["server"]'], [zh.cwd, '/project'], [zh.env, '{"KEY":"secret"}']]) {
    fireEvent.change(f.ui.getByLabelText(label!), { target: { value } })
  }
  fireEvent.click(f.ui.getByRole('checkbox', { name: zh.autoConnect }))
  await act(async () => { fireEvent.click(f.ui.getByRole('button', { name: zh.save })) })
  expect(f.saveMcp).toHaveBeenCalledWith(expect.objectContaining({
    revision: 3, serverName: 'docs', command: 'npx', args: '["server"]', cwd: '/project', secrets: '{"KEY":"secret"}', autoConnect: true,
  }))
  expect(f.ui.queryByLabelText(zh.command)).toBeNull()
})

it('retains HTTP edits after refusal, disables saving while pending, and allows cancellation', async () => {
  const f = fixture()
  fireEvent.click(f.ui.getByRole('button', { name: zh.add }))
  fireEvent.change(f.ui.getByLabelText(zh.transport), { target: { value: 'streamable-http' } })
  fireEvent.change(f.ui.getByLabelText(zh.name), { target: { value: 'docs' } })
  fireEvent.change(f.ui.getByLabelText(zh.url), { target: { value: 'https://example.com/mcp' } })
  fireEvent.change(f.ui.getByLabelText(zh.headers), { target: { value: '{"Authorization":"secret"}' } })
  const pending = Promise.withResolvers<undefined>()
  f.saveMcp.mockImplementationOnce(async () => { await pending.promise })
  fireEvent.click(f.ui.getByRole('button', { name: zh.save }))
  expect(f.ui.getByRole('button', { name: zh.save }).hasAttribute('disabled')).toBe(true)
  await act(async () => { pending.reject(new Error('Document changed')) })
  expect(f.ui.getByRole('alert').textContent).toBe('Document changed')
  expect((f.ui.getByLabelText(zh.headers) as HTMLInputElement).value).toContain('secret')
  f.saveMcp.mockRejectedValueOnce('Connection lost')
  await act(async () => { fireEvent.click(f.ui.getByRole('button', { name: zh.save })) })
  expect(f.ui.getByRole('alert').textContent).toBe('Connection lost')
  fireEvent.click(f.ui.getByRole('button', { name: zh.cancel }))
  expect(f.ui.queryByRole('alert')).toBeNull()
  expect(f.ui.queryByLabelText(zh.url)).toBeNull()
})

it('edits public fields with blank authentication and requires confirmation to delete', async () => {
  const f = fixture({ value: { servers: {
    docs: { serverName: 'docs', transport: 'streamable-http', url: 'https://example.com/mcp', autoConnect: true }, hidden: null,
  } } })
  expect(f.ui.getByText(zh.autoOn, { exact: false })).toBeTruthy()
  fireEvent.click(f.ui.getByRole('button', { name: zh.edit }))
  expect((f.ui.getByLabelText(zh.headers) as HTMLInputElement).value).toBe('')
  expect(f.ui.getByLabelText(zh.name).hasAttribute('disabled')).toBe(true)
  fireEvent.click(f.ui.getByRole('button', { name: zh.cancel }))
  fireEvent.click(f.ui.getByRole('button', { name: zh.remove }))
  expect(f.deleteMcp).not.toHaveBeenCalled()
  fireEvent.click(f.ui.getByRole('button', { name: zh.cancel }))
  fireEvent.click(f.ui.getByRole('button', { name: zh.remove }))
  await act(async () => { fireEvent.click(f.ui.getByRole('button', { name: zh.confirmRemove })) })
  expect(f.deleteMcp).toHaveBeenCalledWith('docs', 3)
  expect(f.ui.queryByRole('button', { name: zh.confirmRemove })).toBeNull()
  act(() => { f.state.set({ ...f.state.getSnapshot(), value: { servers: { docs: { serverName: 'docs', transport: 'stdio', autoConnect: false } } } }) })
  expect(f.ui.getByText(zh.autoOff, { exact: false })).toBeTruthy()
  fireEvent.click(f.ui.getByRole('button', { name: zh.edit }))
  expect(f.ui.getByLabelText(zh.command)).toBeTruthy()
})

it('renders shell notices for accepted and failed operations', async () => {
  vi.useFakeTimers()
  const notice = createSnapshotStore<McpNotice | null>(null)
  const dismiss = vi.fn()
  const props = { useMcpNotice: bindSnapshotSelector(notice), dismissMcpNotice: dismiss } as Parameters<typeof McpToast>[0]
  const ui = render(<McpToast {...props} />)
  expect(ui.container.textContent).toBe('')
  act(() => { notice.set({ sequence: 1, text: 'Saved', success: true }) })
  expect(ui.getByText('Saved')).toBeTruthy()
  act(() => { notice.set({ sequence: 2, text: 'Refused', success: false }) })
  expect(ui.getByText('Refused')).toBeTruthy()
  await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
  expect(dismiss).toHaveBeenCalledOnce()
})
