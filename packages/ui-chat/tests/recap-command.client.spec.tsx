// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@codexydsh/test-support/client'
import { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { commonEn } from '@codexydsh/test-support/client'
import { RecapCommandCard } from '../src/client/chat/RecapCommandCard.tsx'
import { en } from '../src/client/locale.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function props(text?: string, failed = false): Parameters<typeof RecapCommandCard>[0] {
  return {
    node: {
      kind: 'command', commandId: CommandId('recap-1'), name: 'recap', seq: 1, time: 1,
      args: '', outcome: text === undefined ? null : { kind: failed ? 'error' : 'success', text },
    },
    t: makeTranslate(en, commonEn),
  }
}

describe('task recap command', () => {
  it('shows the complete summary and next action immediately and copies both', async () => {
    const text = 'The file update is implemented. Validation is still pending.\n\nRun the agreed focused check.'
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const view = render(<RecapCommandCard {...props(text)} />)
    expect(view.getByRole('region', { name: 'Task recap' }).textContent).toContain('Validation is still pending.')
    expect(view.container.querySelector('p')?.textContent).toBe(text)
    expect(view.queryByRole('button', { expanded: false })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Copy task recap' }))
    await waitFor(() => { expect(writeText).toHaveBeenCalledWith(text) })
    expect(view.getByRole('button', { name: 'Copied' })).toBeTruthy()
  })

  it('updates pending feedback to an error without displaying a successful summary', () => {
    const view = render(<RecapCommandCard {...props()} />)
    expect(view.getByText('Generating task recap…')).toBeTruthy()
    view.rerender(<RecapCommandCard {...props('The conversation changed; run /recap again.', true)} />)
    expect(view.getByText('The conversation changed; run /recap again.')).toBeTruthy()
    expect(view.queryByRole('region', { name: 'Task recap' })).toBeNull()
  })
})
