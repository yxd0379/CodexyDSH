// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@codexydsh/test-support/client'
import { ContextInjectionRow } from '../src/client/chat/ContextInjectionRow.tsx'
import { en } from '../src/client/locale.ts'

afterEach(cleanup)

describe('developer message row', () => {
  it('shows its model role and preserves text beside an unsupported content block', () => {
    const { container } = render(<ContextInjectionRow
      content={[
        { type: 'text', text: 'Follow these permissions.' },
        { type: 'tool-addition', toolName: 'search' },
      ]}
      source={{ kind: 'tool-registry' }}
      producer={{ role: 'inject', label: 'tool-registry' }}
      form={null}
      messageRole="developer"
      t={makeTranslate(en)}
    />)
    fireEvent.click(screen.getByRole('button', { name: /Developer instructions/ }))

    expect(container.querySelector('[data-context-text]')?.textContent).toBe('Follow these permissions.')
    fireEvent.click(screen.getByRole('button', { name: /Unknown content block/ }))
    expect(container.textContent).toContain('"toolName": "search"')
  })
})
