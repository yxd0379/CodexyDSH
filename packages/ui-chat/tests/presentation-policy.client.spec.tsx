// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@codexydsh/test-support/client'
import type { TranscriptViewMode } from '../src/chat-settings.ts'
import { derivePresentationPolicy, presentationPolicyFor } from '../src/client/presentation-policy.ts'

afterEach(cleanup)

describe('Chat presentation policy', () => {
  it.each([
    ['compact', true, 'collapsed', false, false],
    ['standard', true, 'collapsed', true, true],
    ['detailed', true, 'history', true, true],
    ['verbose', false, 'none', true, false],
  ] as const)('maps %s to stable presentation capabilities', (mode, foldCompletedTurns, stepGrouping, settledReasoningPreview, liveProcessDetail) => {
    const policy = presentationPolicyFor(mode)
    expect(policy).toEqual({ mode, foldCompletedTurns, stepGrouping, settledReasoningPreview, liveProcessDetail })
    expect(presentationPolicyFor(mode)).toBe(policy)
  })

  it('forwards mode notifications and removes the subscription on disposal', () => {
    const mode = createSnapshotStore<TranscriptViewMode>('compact')
    const policy = derivePresentationPolicy(mode)
    const listener = vi.fn()
    const dispose = policy.subscribe(listener)
    expect(policy.getSnapshot()).toBe(presentationPolicyFor('compact'))
    mode.set('detailed')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(policy.getSnapshot()).toBe(presentationPolicyFor('detailed'))
    dispose()
    mode.set('verbose')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('tracks the Codexful application setting independently of the work-details mode', () => {
    const mode = createSnapshotStore<TranscriptViewMode>('standard')
    const codexful = createSnapshotStore(false)
    const policy = derivePresentationPolicy(mode, codexful)
    const listener = vi.fn()
    const off = policy.subscribe(listener)
    expect(policy.getSnapshot().codexful).toBeUndefined()
    codexful.set(true)
    expect(policy.getSnapshot().codexful).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
    off()
    codexful.set(false)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it.each(['compact', 'standard', 'detailed', 'verbose'] as const)('keeps completed Codexful activity visible in %s mode', (mode) => {
    const source = createSnapshotStore<TranscriptViewMode>(mode)
    const codexful = createSnapshotStore(true)
    const policy = derivePresentationPolicy(source, codexful)
    expect(policy.getSnapshot()).toEqual({ ...presentationPolicyFor(mode), codexful: true, foldCompletedTurns: false, stepGrouping: 'none' })
    codexful.set(false)
    expect(policy.getSnapshot()).toBe(presentationPolicyFor(mode))
  })

  it('renders only consumers whose selected field changes', () => {
    const mode = createSnapshotStore<TranscriptViewMode>('compact')
    const usePresentation = bindSnapshotSelector(derivePresentationPolicy(mode))
    const foldRender = vi.fn()
    const previewRender = vi.fn()
    function Fold() {
      const fold = usePresentation(policy => policy.foldCompletedTurns)
      foldRender(fold)
      return <span>{String(fold)}</span>
    }
    function Preview() {
      const preview = usePresentation(policy => policy.settledReasoningPreview)
      previewRender(preview)
      return <span>{String(preview)}</span>
    }
    render(<><Fold /><Preview /></>)
    expect(foldRender).toHaveBeenCalledTimes(1)
    expect(previewRender).toHaveBeenCalledTimes(1)
    act(() => { mode.set('detailed') })
    expect(foldRender).toHaveBeenCalledTimes(1)
    expect(previewRender).toHaveBeenCalledTimes(2)
    act(() => { mode.set('standard') })
    expect(foldRender).toHaveBeenCalledTimes(1)
    expect(previewRender).toHaveBeenCalledTimes(2)
    act(() => { mode.set('compact') })
    expect(foldRender).toHaveBeenCalledTimes(1)
    expect(previewRender).toHaveBeenCalledTimes(3)
  })
})


it('toggles reasoning excerpts independently and disposes its subscription', () => {
  const mode = createSnapshotStore<TranscriptViewMode>('standard')
  const recap = createSnapshotStore(true)
  const policy = derivePresentationPolicy(mode, createSnapshotStore(true), recap)
  const original = policy.getSnapshot()
  const listener = vi.fn()
  const off = policy.subscribe(listener)
  recap.set(false)
  expect(policy.getSnapshot().reasoningRecap).toBe(false)
  expect(policy.getSnapshot().codexful).toBe(true)
  expect(listener).toHaveBeenCalledOnce()
  const hidden = policy.getSnapshot()
  expect(policy.getSnapshot()).toBe(hidden)
  recap.set(true)
  expect(policy.getSnapshot()).toBe(original)
  off()
  recap.set(false)
  expect(listener).toHaveBeenCalledTimes(2)
})
