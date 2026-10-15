// @vitest-environment jsdom
/** Local and SSH workspaces share navigation, row actions, and one creation flow. */
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@codexydsh/test-support/client'
import { UnifiedWorkspaces, type UnifiedWorkspaceSnapshot, type UnifiedWorkspacesProps } from '../src/client/UnifiedWorkspaces.tsx'

afterEach(cleanup)

function fixture() {
  const snapshot = createSnapshotStore<UnifiedWorkspaceSnapshot>({
    hosts: [{ name: 'dev' }],
    items: [
      { key: 'local:project', id: 'project', title: 'Local project', path: '/work/local', sessions: [{ key: 'local:session', id: 'session', title: 'Local conversation', running: false, active: false }] },
      { key: 'dev:project', id: 'project', title: 'Remote project', path: '/work/remote', host: 'dev', connected: true, sessions: [{ key: 'dev:session', id: 'session', title: 'Remote conversation', running: true, active: true }] },
    ],
  })
  const actions = {
    openWorkspace: vi.fn(), openSession: vi.fn(), newSession: vi.fn(), renameWorkspace: vi.fn(), removeWorkspace: vi.fn(),
    renameSession: vi.fn(), forkSession: vi.fn(), pinSession: vi.fn(), archiveSession: vi.fn(),
    pickLocalDirectory: vi.fn(async () => '/chosen/local'), createWorkspace: vi.fn(async (_input: unknown) => {}),
  }
  const props = { wide: true, expandSidebar: vi.fn(), useUnifiedWorkspaces: bindSnapshotSelector(snapshot), ...actions } as unknown as UnifiedWorkspacesProps
  return { props, actions, snapshot }
}

it('uses one workspace section and the same actions for local and remote sessions with colliding IDs', async () => {
  const f = fixture()
  const ui = render(<UnifiedWorkspaces {...f.props} />)
  expect(ui.getAllByRole('region', { name: '工作区' })).toHaveLength(1)
  const remote = ui.getByRole('button', { name: 'Remote conversation' })
  expect(remote.getAttribute('aria-current')).toBe('page')
  fireEvent.click(ui.getByRole('button', { name: '收起 Remote project' }))
  expect(ui.queryByRole('button', { name: 'Remote conversation' })).toBeNull()
  fireEvent.click(within(ui.getAllByTestId('workspace-group')[1]!).getByTestId('workspace-open'))
  await waitFor(() => { expect(f.actions.openWorkspace).toHaveBeenCalledWith(f.snapshot.getSnapshot().items[1]) })
  expect(ui.getByRole('button', { name: 'Remote conversation' })).not.toBeNull()
  fireEvent.click(ui.getByRole('button', { name: 'Remote conversation' }))
  await waitFor(() => { expect(f.actions.openSession).toHaveBeenCalledWith(f.snapshot.getSnapshot().items[1], f.snapshot.getSnapshot().items[1]!.sessions[0]) })
  fireEvent.click(ui.getByRole('button', { name: '新会话 Local project' }))
  fireEvent.click(ui.getByRole('button', { name: '新会话 Remote project' }))
  await waitFor(() => { expect(f.actions.newSession).toHaveBeenCalledTimes(2) })
  fireEvent.click(ui.getByRole('button', { name: 'Remote conversation的操作' }))
  fireEvent.click(ui.getByRole('menuitem', { name: '置顶' }))
  await waitFor(() => { expect(f.actions.pinSession).toHaveBeenCalledWith(f.snapshot.getSnapshot().items[1], f.snapshot.getSnapshot().items[1]!.sessions[0], true) })
  fireEvent.click(ui.getByRole('button', { name: 'Local conversation的操作' }))
  fireEvent.click(ui.getByRole('menuitem', { name: '分支会话' }))
  await waitFor(() => { expect(f.actions.forkSession).toHaveBeenCalledWith(f.snapshot.getSnapshot().items[0], f.snapshot.getSnapshot().items[0]!.sessions[0]) })
  expect(ui.queryByText('Remote projects')).toBeNull()
})

it('chooses local or saved SSH location in the same add dialog and preserves a failed remote path', async () => {
  const f = fixture()
  const ui = render(<UnifiedWorkspaces {...f.props} />)
  fireEvent.click(ui.getByRole('button', { name: '添加工作区' }))
  let dialog = within(ui.getByRole('dialog', { name: '添加工作区' }))
  fireEvent.click(dialog.getByRole('button', { name: '选择文件夹' }))
  await waitFor(() => { expect((dialog.getByLabelText('文件夹') as HTMLInputElement).value).toBe('/chosen/local') })
  fireEvent.click(dialog.getByRole('button', { name: '添加' }))
  await waitFor(() => { expect(f.actions.createWorkspace).toHaveBeenCalledWith({ path: '/chosen/local' }) })
  await waitFor(() => { expect(ui.queryByRole('dialog')).toBeNull() })
  fireEvent.click(ui.getByRole('button', { name: '添加工作区' }))
  dialog = within(ui.getByRole('dialog', { name: '添加工作区' }))
  fireEvent.change(dialog.getByLabelText('位置'), { target: { value: 'host:dev' } })
  expect(dialog.queryByRole('button', { name: '选择文件夹' })).toBeNull()
  fireEvent.change(dialog.getByLabelText('文件夹'), { target: { value: 'relative/path' } })
  fireEvent.click(dialog.getByRole('button', { name: '添加' }))
  expect(dialog.getByRole('alert').textContent).toContain('绝对路径')
  f.actions.createWorkspace.mockRejectedValueOnce(new Error('Remote folder unavailable'))
  fireEvent.change(dialog.getByLabelText('文件夹'), { target: { value: '/work/remote' } })
  fireEvent.click(dialog.getByRole('button', { name: '添加' }))
  await waitFor(() => { expect(dialog.getByRole('alert').textContent).toBe('Remote folder unavailable') })
  expect((dialog.getByLabelText('文件夹') as HTMLInputElement).value).toBe('/work/remote')
  expect(f.actions.createWorkspace).toHaveBeenLastCalledWith({ host: 'dev', path: '/work/remote' })
  fireEvent.click(dialog.getByRole('button', { name: '添加' }))
  await waitFor(() => { expect(ui.queryByRole('dialog')).toBeNull() })
})

it('passes a new SSH host through the add flow and never removes a registration before confirmation', async () => {
  const f = fixture()
  const ui = render(<UnifiedWorkspaces {...f.props} />)
  fireEvent.click(ui.getByRole('button', { name: '添加工作区' }))
  let dialog = within(ui.getByRole('dialog', { name: '添加工作区' }))
  fireEvent.change(dialog.getByLabelText('位置'), { target: { value: 'new' } })
  fireEvent.change(dialog.getByLabelText('SSH 主机'), { target: { value: 'user@build' } })
  fireEvent.change(dialog.getByLabelText('文件夹'), { target: { value: '/srv/project' } })
  fireEvent.click(dialog.getByRole('button', { name: '添加' }))
  await waitFor(() => { expect(f.actions.createWorkspace).toHaveBeenCalledWith({ newHost: 'user@build', path: '/srv/project' }) })
  await waitFor(() => { expect(ui.queryByRole('dialog')).toBeNull() })
  fireEvent.click(ui.getByRole('button', { name: 'Remote project的操作' }))
  fireEvent.click(ui.getByRole('menuitem', { name: '移除工作区' }))
  expect(f.actions.removeWorkspace).not.toHaveBeenCalled()
  dialog = within(ui.getByRole('dialog', { name: '移除工作区' }))
  expect(dialog.getByText(/文件夹和会话记录会保留/)).not.toBeNull()
  fireEvent.click(dialog.getByRole('button', { name: '移除' }))
  await waitFor(() => { expect(f.actions.removeWorkspace).toHaveBeenCalledWith(f.snapshot.getSnapshot().items[1]) })
})
