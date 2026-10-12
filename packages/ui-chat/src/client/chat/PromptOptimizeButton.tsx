/** Composer control that rewrites the unsent draft and writes it back. */

import { useRef, useState } from 'react'
import { IconSparkleRegular, Tooltip } from '@codexydsh/ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@codexydsh/ui-conversation/client'
import type { NS } from '../locale.ts'
import css from './PromptOptimizeButton.module.css'

/** Rewrite the current draft through the session's selected model. */
export interface PromptOptimizeButtonInjected {
  /**
   * Rewrite one exact draft. The caller writes an accepted result back and
   * keeps it unsent.
   * @param text - exact draft text.
   * @param signal - caller cancellation.
   * @returns the replacement text, or a failure carrying its host-reported reason.
   */
  optimize: (text: string, signal: AbortSignal) => Promise<
    { ok: true; text: string } | { ok: false; reason: string | undefined }
  >
  /** Surface a failure on this session's composer. */
  reportError: (text: string) => void
}

/** Slot props: the session input face, the rewrite, and chat copy. */
export type PromptOptimizeButtonProps =
  PropsRuntime<'conversation.input.left'>
  & PromptOptimizeButtonInjected
  & PropsLocale<typeof NS>

/**
 * Rewrite the composer's current draft in place. An empty draft, a claimed
 * command, or a rewrite already in flight keeps the control inert; a second
 * click while busy cancels the rewrite.
 * @param props - scoped input face, rewrite, failure notice, and copy.
 * @returns the tool-row trigger.
 */
export function PromptOptimizeButton({
  optimize, reportError, useInput, inputActions, t,
}: PromptOptimizeButtonProps) {
  const draft = useInput(state => state.draft)
  const phase = useInput(state => state.phase)
  const [busy, setBusy] = useState(false)
  const flight = useRef<AbortController | null>(null)
  const disabled = draft.trim() === '' || phase !== 'plain'

  const run = (): void => {
    if (flight.current !== null) {
      flight.current.abort()
      flight.current = null
      setBusy(false)
      return
    }
    const text = draft
    if (text.trim() === '' || phase !== 'plain') return
    const controller = new AbortController()
    flight.current = controller
    setBusy(true)
    void optimize(text, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return
        if (!result.ok) {
          // The host states why the rewrite failed; a bare failure notice keeps
          // the reader from telling a model or timeout problem from a bug.
          reportError(result.reason === undefined || result.reason === ''
            ? t('input.optimizeFailed')
            : t('input.optimizeFailedReason', { reason: result.reason }))
          return
        }
        inputActions.setDraft(result.text)
      })
      .finally(() => {
        if (flight.current === controller) flight.current = null
        setBusy(false)
      })
  }

  return (
    <Tooltip label={busy ? t('input.optimizing') : t('input.optimize')} side="top" delayMs={500}>
      <button
        type="button"
        className={css.trigger}
        aria-label={t('input.optimize')}
        aria-busy={busy || undefined}
        data-busy={busy || undefined}
        disabled={disabled && !busy}
        onMouseDown={(event) => { event.preventDefault() }}
        onClick={run}
      >
        <IconSparkleRegular size={16} />
      </button>
    </Tooltip>
  )
}
