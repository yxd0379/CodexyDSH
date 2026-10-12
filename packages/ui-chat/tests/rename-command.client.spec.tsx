// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { makeTranslate } from '@codexydsh/test-support/client'
import { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { commonEn } from '@codexydsh/test-support/client'
import { RenameCommandCard } from '../src/client/chat/RenameCommandCard.tsx'
import { en } from '../src/client/locale.ts'

afterEach(cleanup)

function props(text?: string, failed = false): Parameters<typeof RenameCommandCard>[0] {
  return { node: { kind: 'command', commandId: CommandId('rename-suggestion'), name: 'rename', seq: 1, time: 1,
    args: '', outcome: text === undefined ? null : { kind: failed ? 'error' : 'success', text } },
  t: makeTranslate(en, commonEn) }
}

describe('suggested conversation name', () => {
  it('shows confirmed naming feedback without a duplicate editable form', () => {
    const view = render(<RenameCommandCard {...props('Renamed conversation to: Build fixes')} />)
    expect(view.getByText('Renamed conversation to: Build fixes')).toBeTruthy()
    expect(view.queryByRole('textbox')).toBeNull()
    expect(view.container.querySelector('[data-rename-suggestion]')).toBeNull()
  })

  it('shows generation feedback and failures without an editable candidate', () => {
    const view = render(<RenameCommandCard {...props()} />)
    expect(view.getByText('Suggesting a conversation name…')).toBeTruthy()
    expect(view.queryByRole('textbox')).toBeNull()
    view.rerender(<RenameCommandCard {...props('Model request failed', true)} />)
    expect(view.getByText('Model request failed')).toBeTruthy()
    expect(view.queryByRole('textbox')).toBeNull()
  })
})
