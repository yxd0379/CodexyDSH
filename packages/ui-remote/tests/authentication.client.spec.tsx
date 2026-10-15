// @vitest-environment jsdom
/** SSH responses belong only to the current challenge and never survive its dialog. */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@codexydsh/test-support/client'
import type { IRemoteHosts, RemoteHostsSnapshot } from '@codexydsh/remote/client'
import type { RemoteHostStatus } from '@codexydsh/remote/types'
import { RemoteAuthentication } from '../src/client/RemoteAuthentication.tsx'
import { en } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const pending = (changes: Partial<RemoteHostStatus> = {}): RemoteHostStatus => ({
  name: 'ascend', host: 'developer@ascend', profile: 'codexy', phase: 'connecting', url: null, error: null,
  authChallenge: { id: 'first', prompt: 'Password:' }, ...changes,
})

function fixture(items = [pending()]) {
  const state = createSnapshotStore<RemoteHostsSnapshot>({ items, connected: true, error: null })
  const respond = vi.fn<IRemoteHosts['respondAuthentication']>().mockResolvedValue(undefined)
  const props = { useRemoteHosts: bindSnapshotSelector(state), respondAuthentication: respond, t: makeTranslate(en) } as Parameters<typeof RemoteAuthentication>[0]
  const ui = render(<RemoteAuthentication {...props} />)
  return { state, respond, ui }
}

it('identifies the saved host and SSH target, masks the response, clears it before submission, and never saves it', async () => {
  const save = vi.spyOn(Storage.prototype, 'setItem')
  const f = fixture()
  expect(f.ui.getByRole('dialog', { name: en.authenticationTitle })).toBeTruthy()
  expect(f.ui.getByText('ascend · SSH: developer@ascend')).toBeTruthy()
  const input = f.ui.getByLabelText('Password:') as HTMLInputElement
  expect(input.type).toBe('password')
  expect(input.autocomplete).toBe('off')
  fireEvent.change(input, { target: { value: 'a private response' } })
  f.respond.mockImplementationOnce(async (name, id, response) => {
    expect(input.value).toBe('')
    expect([name, id, response]).toEqual(['ascend', 'first', 'a private response'])
  })
  await act(async () => { fireEvent.click(f.ui.getByRole('button', { name: en.authenticationSubmit })) })
  expect(f.respond).toHaveBeenCalledOnce()
  expect(input.value).toBe('')
  expect(save).not.toHaveBeenCalled()
})

it('clears the response and sends null on explicit cancellation and Escape', async () => {
  const f = fixture()
  const input = f.ui.getByLabelText('Password:') as HTMLInputElement
  fireEvent.change(input, { target: { value: 'discard this response' } })
  await act(async () => { fireEvent.click(f.ui.getAllByRole('button', { name: en.cancelConnection }).at(-1)!) })
  expect(f.respond).toHaveBeenCalledWith('ascend', 'first', null)
  expect(input.value).toBe('')
  act(() => { f.state.set({ ...f.state.getSnapshot(), items: [pending({ authChallenge: { id: 'second', prompt: 'Verification code:' } })] }) })
  const code = f.ui.getByLabelText('Verification code:') as HTMLInputElement
  fireEvent.change(code, { target: { value: '123456' } })
  await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
  expect(f.respond).toHaveBeenLastCalledWith('ascend', 'second', null)
  expect(code.value).toBe('')
})

it('discards input when the challenge, host, prompt, or observation changes', () => {
  const f = fixture()
  const replace = (host: RemoteHostStatus): void => {
    const before = f.ui.getByLabelText(/Password:|Verification code:/u) as HTMLInputElement
    fireEvent.change(before, { target: { value: 'do not carry forward' } })
    act(() => { f.state.set({ ...f.state.getSnapshot(), items: [host] }) })
    expect(before.value).toBe('')
    const next = f.ui.getByLabelText(host.authChallenge!.prompt) as HTMLInputElement
    expect(next.value).toBe('')
    expect(next.type).toBe('password')
  }
  replace(pending({ authChallenge: { id: 'second', prompt: 'Verification code:' } }))
  replace(pending({ name: 'other', host: 'other-user@host', authChallenge: { id: 'second', prompt: 'Verification code:' } }))
  replace(pending({ name: 'other', host: 'other-user@host', authChallenge: { id: 'second', prompt: 'Password:' } }))
  const input = f.ui.getByLabelText('Password:') as HTMLInputElement
  fireEvent.change(input, { target: { value: 'another response' } })
  act(() => { f.state.set({ ...f.state.getSnapshot(), connected: false }) })
  expect(input.value).toBe('')
  expect(f.ui.queryByRole('dialog')).toBeNull()
  expect(f.respond).not.toHaveBeenCalled()
})

it('clears the detached input on unmount and ignores a stale rejected response after challenge replacement', async () => {
  const f = fixture()
  let reject!: (reason: Error) => void
  f.respond.mockImplementationOnce(() => new Promise((_accept, refuse) => { reject = refuse }))
  fireEvent.change(f.ui.getByLabelText('Password:'), { target: { value: 'old response' } })
  fireEvent.click(f.ui.getByRole('button', { name: en.authenticationSubmit }))
  act(() => { f.state.set({ ...f.state.getSnapshot(), items: [pending({ authChallenge: { id: 'second', prompt: 'Verification code:' } })] }) })
  await act(async () => { reject(new Error('old response must never appear')) })
  expect(f.ui.queryByRole('alert')).toBeNull()
  const input = f.ui.getByLabelText('Verification code:') as HTMLInputElement
  expect(input.value).toBe('')
  fireEvent.change(input, { target: { value: 'unmounted response' } })
  f.ui.unmount()
  expect(input.value).toBe('')
})

it('reports a generic reply failure and permits a fresh response without reflecting error details', async () => {
  const f = fixture()
  f.respond.mockRejectedValueOnce(new Error('secret backend error detail'))
  fireEvent.change(f.ui.getByLabelText('Password:'), { target: { value: 'private reply' } })
  await act(async () => { fireEvent.click(f.ui.getByRole('button', { name: en.authenticationSubmit })) })
  expect(f.ui.getByRole('alert').textContent).toBe(en.authenticationFailed)
  expect((f.ui.getByLabelText('Password:') as HTMLInputElement).value).toBe('')
  expect((f.ui.getByRole('button', { name: en.authenticationSubmit }) as HTMLButtonElement).disabled).toBe(false)
  expect(f.ui.queryByText('secret backend error detail')).toBeNull()
})
