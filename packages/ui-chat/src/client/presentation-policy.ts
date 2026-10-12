/**
 * Runtime vocabulary derived from the persisted work-details mode. Renderers
 * and seats select single fields of this policy; none of them compares the
 * mode enum, so adding a mode changes only the table below.
 */

import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { TranscriptViewMode } from '../chat-settings.ts'

/** Presentation capabilities that one work-details mode enables. */
export interface ChatPresentationPolicy {
  /** Direct, compact activity rows in the Codexful application. */
  readonly codexful?: true
  /** Whether reasoning disclosures show a compact text excerpt. */
  readonly reasoningRecap?: boolean
  /** Mode this policy was derived from; for diagnostics, never for branching in renderers. */
  readonly mode: TranscriptViewMode
  /** Whether a normally completed Turn folds its process rows behind the whole-Turn control. */
  readonly foldCompletedTurns: boolean
  /** Collapsible group headers for all Turns, historical Turns only, or no Turns. */
  readonly stepGrouping: 'collapsed' | 'history' | 'none'
  /** Show the running command, path, query, or reasoning detail in group titles. */
  readonly liveProcessDetail: boolean
  /** Whether a settled reasoning row previews its first line beside the Think title. */
  readonly settledReasoningPreview: boolean
}

const POLICIES: Readonly<Record<TranscriptViewMode, ChatPresentationPolicy>> = {
  compact: {
    mode: 'compact',
    foldCompletedTurns: true,
    stepGrouping: 'collapsed',
    liveProcessDetail: false,
    settledReasoningPreview: false,
  },
  standard: {
    mode: 'standard',
    foldCompletedTurns: true,
    stepGrouping: 'collapsed',
    liveProcessDetail: true,
    settledReasoningPreview: true,
  },
  detailed: {
    mode: 'detailed',
    foldCompletedTurns: true,
    stepGrouping: 'history',
    liveProcessDetail: true,
    settledReasoningPreview: true,
  },
  verbose: {
    mode: 'verbose',
    foldCompletedTurns: false,
    stepGrouping: 'none',
    liveProcessDetail: false,
    settledReasoningPreview: true,
  },
}

const CODEXFUL_POLICIES = Object.fromEntries(Object.entries(POLICIES)
  .map(([mode, policy]) => [mode, {
    ...policy, codexful: true as const, foldCompletedTurns: false, stepGrouping: 'none' as const,
  }])) as Record<TranscriptViewMode, ChatPresentationPolicy>

function withoutRecap(policies: Record<TranscriptViewMode, ChatPresentationPolicy>): Record<TranscriptViewMode, ChatPresentationPolicy> {
  return Object.fromEntries(Object.entries(policies)
    .map(([mode, policy]) => [mode, { ...policy, reasoningRecap: false }])) as Record<TranscriptViewMode, ChatPresentationPolicy>
}
const WITHOUT_RECAP = withoutRecap(POLICIES)
const CODEXFUL_WITHOUT_RECAP = withoutRecap(CODEXFUL_POLICIES)

/**
 * Resolve the policy constant for one mode. The same mode always yields the
 * same object, so selectors over a policy see stable identities.
 * @param mode - persisted work-details mode.
 * @returns the mode's presentation policy.
 */
export function presentationPolicyFor(mode: TranscriptViewMode): ChatPresentationPolicy {
  return POLICIES[mode]
}

/**
 * Derive a policy observable from work-details and application settings.
 * Reads use stable policy constants; subscribers receive both settings' changes.
 * @param mode - live work-details mode.
 * @param codexful - optional application presentation setting.
 * @param recap - optional reasoning-summary preference.
 * @returns observable policy forwarding work-details and application changes.
 */
export function derivePresentationPolicy(
  mode: ObservableSnapshot<TranscriptViewMode>,
  codexful?: ObservableSnapshot<boolean>,
  recap?: ObservableSnapshot<boolean>,
): ObservableSnapshot<ChatPresentationPolicy> {
  return {
    getSnapshot: () => (recap?.getSnapshot() === false
      ? codexful?.getSnapshot() === true ? CODEXFUL_WITHOUT_RECAP : WITHOUT_RECAP
      : codexful?.getSnapshot() === true ? CODEXFUL_POLICIES : POLICIES)[mode.getSnapshot()],
    subscribe: (listener) => {
      const offMode = mode.subscribe(listener)
      const offApplication = codexful?.subscribe(listener)
      const offRecap = recap?.subscribe(listener)
      return () => { offMode(); offApplication?.(); offRecap?.() }
    },
  }
}
