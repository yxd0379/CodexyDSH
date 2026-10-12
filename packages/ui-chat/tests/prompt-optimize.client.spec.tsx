// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@codexydsh/test-support/client'
import type { InputState } from '@codexydsh/ui-conversation/client'
import { PromptOptimizeButton, type PromptOptimizeButtonProps } from '../src/client/chat/PromptOptimizeButton.tsx'
import { zh } from '../src/client/locale.ts'

afterEach(cleanup)

const t: PromptOptimizeButtonProps['t'] = makeTranslate(zh)

function inputState(draft: string, phase: InputState['phase'] = 'plain'): InputState {
  return {
    draft, attachmentIds: [], draftRev: 1, phase, occurrences: [],
    queue: { 'next-turn': [], 'next-step': [] },
  }
}

function setup(options: {
  draft?: string
  phase?: InputState['phase']
  optimize?: PromptOptimizeButtonProps['optimize']
} = {}) {
  const state = createSnapshotStore(inputState(options.draft ?? 'fix the flaky test', options.phase))
  const setDraft = vi.fn((text: string) => { state.set({ ...state.getSnapshot(), draft: text }) })
  const reportError = vi.fn()
  const optimize = vi.fn(options.optimize ?? (() => Promise.resolve({ ok: true as const, text: 'Rewrite the failing test so it is deterministic.' })))
  const props = {
    useInput: bindSnapshotSelector(state),
    inputActions: { setDraft },
    optimize,
    reportError,
    t,
  } as unknown as PromptOptimizeButtonProps
  render(<PromptOptimizeButton {...props} />)
  return { optimize, reportError, setDraft, state }
}

function trigger(): HTMLButtonElement {
  return screen.getByRole('button', { name: '优化提示词' }) as HTMLButtonElement
}

describe('PromptOptimizeButton', () => {
  it('replaces the draft with the rewrite and leaves it unsent', async () => {
    const { optimize, setDraft } = setup()
    fireEvent.click(trigger())
    expect(trigger().getAttribute('aria-busy')).toBe('true')
    await act(async () => {})
    expect(optimize).toHaveBeenCalledOnce()
    expect(setDraft).toHaveBeenCalledExactlyOnceWith('Rewrite the failing test so it is deterministic.')
    expect(trigger().disabled).toBe(false)
  })

  it('stays inert for an empty draft and a claimed command', () => {
    const empty = setup({ draft: '   ' })
    expect(trigger().disabled).toBe(true)
    cleanup()
    const claimed = setup({ phase: 'claimed' })
    expect(trigger().disabled).toBe(true)
    fireEvent.click(trigger())
    expect(empty.optimize).not.toHaveBeenCalled()
    expect(claimed.optimize).not.toHaveBeenCalled()
  })

  it('reports a failed rewrite without touching the draft', async () => {
    const { reportError, setDraft } = setup({ optimize: () => Promise.resolve({ ok: false, reason: undefined }) })
    fireEvent.click(trigger())
    await act(async () => {})
    expect(reportError).toHaveBeenCalledExactlyOnceWith('提示词优化失败')
    expect(setDraft).not.toHaveBeenCalled()
  })

  it('reports the host reason when a rewrite fails for a stated cause', async () => {
    const { reportError, setDraft } = setup({
      optimize: () => Promise.resolve({ ok: false, reason: 'The rewrite ended with max-tokens' }),
    })
    fireEvent.click(trigger())
    await act(async () => {})

    expect(reportError).toHaveBeenCalledExactlyOnceWith(
      '提示词优化失败：The rewrite ended with max-tokens',
    )
    expect(setDraft).not.toHaveBeenCalled()
  })

  it('cancels an in-flight rewrite on a second click', async () => {
    let signal: AbortSignal | undefined
    const { setDraft } = setup({ optimize: (_text, next) => {
      signal = next
      return new Promise(() => {})
    } })
    fireEvent.click(trigger())
    fireEvent.click(trigger())
    expect(signal?.aborted).toBe(true)
    await act(async () => {})
    expect(setDraft).not.toHaveBeenCalled()
    expect(trigger().getAttribute('data-busy')).toBeNull()
  })
})
