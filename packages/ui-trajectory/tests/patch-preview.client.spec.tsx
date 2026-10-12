// @vitest-environment jsdom
/** Complete recorded edits remain readable beyond the Chat preview limit. */
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { PatchPreview, recordedDiffs } from '../src/client/PatchPreview.tsx'
import { t } from './locale.client.ts'

afterEach(cleanup)

it('renders every changed line with numbers and a complete-copy control', () => {
  const newText = Array.from({ length: 80 }, (_, index) => `const line${index + 1} = ${index + 1}`).join('\n')
  const diffs = recordedDiffs({ index: 1, kind: 'tool', text: 'apply_patch',
    resultMeta: { diffs: [{ path: 'example.ts', oldText: null, newText }] } })!
  const view = render(<PatchPreview diffs={diffs} t={t} />)
  expect(view.container.textContent).toContain('const line40 = 40')
  expect(view.container.textContent).toContain('const line80 = 80')
  expect(view.container.querySelectorAll('[data-new-line]')).toHaveLength(80)
  expect(view.getByRole('button', { name: 'Copy full diff' })).toBeTruthy()
})

it('keeps errors and malformed metadata on the raw result path', () => {
  const cell = { index: 1, kind: 'tool' as const, text: 'apply_patch' }
  expect(recordedDiffs({ ...cell, isError: true, resultMeta: { diffs: [] } })).toBeUndefined()
  expect(recordedDiffs({ ...cell, resultMeta: { diffs: [{ path: 'test.ts', newText: 3 }] } })).toBeUndefined()
})
