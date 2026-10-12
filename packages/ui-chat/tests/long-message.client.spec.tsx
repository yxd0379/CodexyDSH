// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { makeTranslate } from '@codexydsh/test-support/client'
import { commonEn } from '@codexydsh/test-support/client'
import { PendingSteeringBubble } from '../src/client/chat/MessageItem.tsx'
import { en } from '../src/client/locale.ts'

afterEach(cleanup)

function bubble(text: string) {
  return <PendingSteeringBubble content={[{ type: 'text', text }]} renderMessageImages={() => null} t={makeTranslate(en, commonEn)} />
}

describe('Long human messages', () => {
  it('folds a long paste, preserves the full text, and supports keyboard-native disclosure', () => {
    const text = Array.from({ length: 40 }, (_, index) => `line ${index}: ${'source '.repeat(20)}`).join('\n')
    const view = render(bubble(text))
    const toggle = view.getByRole('button', { name: 'Show full message' })
    const full = view.container.querySelector('[data-message-full]')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(full.getAttribute('hidden')).toBe('until-found')
    expect(full.textContent).toBe(text)
    expect(toggle.getAttribute('aria-controls')).toBe(full.id)
    fireEvent.click(toggle)
    expect(full.hasAttribute('hidden')).toBe(false)
    expect(view.getByRole('button', { name: 'Collapse message' }).getAttribute('aria-expanded')).toBe('true')
    expect(toggle.compareDocumentPosition(full) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(document.activeElement).toBe(toggle)
    fireEvent.click(toggle)
    expect(full.getAttribute('hidden')).toBe('until-found')
    expect(view.getByRole('button', { name: 'Copy' })).toBeTruthy()
  })

  it('reveals retained content when browser find matches it', () => {
    const text = 'A long paragraph '.repeat(100)
    const view = render(bubble(text))
    const full = view.container.querySelector('[data-message-full]')!
    fireEvent(full, new Event('beforematch'))
    expect(full.hasAttribute('hidden')).toBe(false)
    expect(view.getByRole('button', { name: 'Collapse message' })).toBeTruthy()
  })

  it('keeps short messages unchanged without a disclosure button', () => {
    const view = render(bubble('Please fix this bug.'))
    expect(view.queryByRole('button', { name: 'Show full message' })).toBeNull()
    expect(view.container.querySelector('[data-message-full]')?.hasAttribute('hidden')).toBe(false)
    expect(view.getByText('Please fix this bug.')).toBeTruthy()
  })
})
