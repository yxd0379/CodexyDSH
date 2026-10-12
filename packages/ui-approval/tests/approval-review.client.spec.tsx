// @vitest-environment jsdom
/** Public automatic-review feedback and explicit authorization submission. */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@codexydsh/test-support/client'
import { commonEn } from '@codexydsh/test-support/client'
import type { ApprovalRequestId } from '@codexydsh/approval/types'
import { ApprovalReviewCard, type ApprovalReviewPresentation } from '../src/client/ApprovalReviewCard.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
const t = makeTranslate(en, commonEn)
const id = 'review-1' as ApprovalRequestId
const review = (status: ApprovalReviewPresentation['status']): ApprovalReviewPresentation => ({
  id, status, toolName: 'exec_command',
})

describe('Automatic approval feedback', () => {
  it.each([
    ['started', 'Reviewing permissions automatically'],
    ['inspecting', 'Checking the action scope'],
    ['approved', 'Approved automatically'],
    ['cancelled', 'Permission review cancelled'],
    ['manual', 'Automatic review did not finish; your decision is required'],
  ] as const)('shows %s without an automatic retry action', (status, label) => {
    const view = render(<ApprovalReviewCard review={review(status)} approve={vi.fn()} t={t} />)
    expect(view.getByRole('status').textContent).toContain(label)
    expect(view.queryByRole('button', { name: 'Approve this action' })).toBeNull()
    expect(view.container.querySelector('[data-approval-review]')?.getAttribute('aria-busy'))
      .toBe(String(status === 'started' || status === 'inspecting'))
  })

  it('shows product copy instead of the raw reviewer budget fallback', () => {
    const view = render(<ApprovalReviewCard
      review={{ ...review('manual'), error: 'the complete private review request exceeds the reviewer input budget' }}
      approve={vi.fn()} t={t} />)
    expect(view.getByText('The automatic review input exceeded its budget, so it returned no verdict')).toBeTruthy()
    expect(view.container.textContent).not.toContain('exceeds the reviewer input budget')
  })

  it('collapses approved rationale into the status row without losing its full text', () => {
    const rationale = 'The requested operation writes a small proof file outside the workspace.\nNo existing file is removed.'
    const approve = vi.fn()
    const view = render(<ApprovalReviewCard review={{ ...review('approved'), rationale }} approve={approve} t={t} />)
    const disclosure = view.container.querySelector('details')!
    const summary = disclosure.querySelector('summary')!
    expect(disclosure.open).toBe(false)
    expect(summary.textContent).toContain('Approved automatically')
    expect(summary.textContent).toContain('Run command')
    expect(summary.textContent).not.toContain('exec_command')
    expect(summary.textContent).toContain(rationale)
    expect(disclosure.querySelector('p')?.textContent).toBe(rationale)
    expect(view.queryByRole('button', { name: 'Approve this action' })).toBeNull()
    expect(approve).not.toHaveBeenCalled()
  })

  it('keeps denial rationale readable and requires a click before submitting the exact action', async () => {
    const completion = Promise.withResolvers<undefined>()
    const approve = vi.fn(() => completion.promise)
    const view = render(<ApprovalReviewCard review={{ ...review('denied'), rationale: 'This command writes outside your project.' }} approve={approve} t={t} />)
    expect(view.getByText('This command writes outside your project.')).toBeTruthy()
    expect(approve).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: 'Approve this action' }))
    expect(approve).toHaveBeenCalledExactlyOnceWith(id)
    expect(view.getByRole('button', { name: 'Sending…' }).hasAttribute('disabled')).toBe(true)
    completion.resolve(undefined)
    await waitFor(() => { expect(view.getByText('Your approval was sent. Waiting for another review.')).toBeTruthy() })
    expect(view.getByRole('button', { name: 'Approve this action' }).hasAttribute('disabled')).toBe(true)
    expect(view.getByText('Automatic review denied this action')).toBeTruthy()
  })

  it('shows review failure and command submission failure without granting permission', async () => {
    const approve = vi.fn().mockRejectedValueOnce(new Error('Connection closed')).mockResolvedValueOnce(undefined)
    const view = render(<ApprovalReviewCard review={{ ...review('failed'), error: 'Reviewer timed out' }} approve={approve} t={t} />)
    expect(view.getByText('Reviewer timed out')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Approve this action' }))
    await waitFor(() => { expect(view.getByRole('alert').textContent).toBe('Could not send approval: Connection closed') })
    expect(view.getByRole('button', { name: 'Approve this action' }).hasAttribute('disabled')).toBe(false)
    fireEvent.click(view.getByRole('button', { name: 'Approve this action' }))
    await waitFor(() => { expect(view.queryByRole('alert')).toBeNull() })
    expect(approve).toHaveBeenCalledTimes(2)
  })
})
