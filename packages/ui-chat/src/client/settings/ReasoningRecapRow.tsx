/** Settings control for the one-line reasoning preview. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { PreferenceRow } from './PreferenceRow.tsx'

/** Live preference and its persistence action. */
export interface ReasoningRecapInjected {
  hooks: { reasoningRecap: ObservableSnapshot<boolean> }
  /** @param enabled - Whether collapsed reasoning shows an excerpt. */
  setReasoningRecap: (enabled: boolean) => void
}

/**
 * Render the reasoning-summary preference without expanding recorded reasoning.
 * @param props - Settings slot, locale, and live preference.
 * @returns One compact settings selector.
 */
export function ReasoningRecapRow({ useReasoningRecap, setReasoningRecap, t }:
  PropsRuntime<'settings.general.item'> & PropsLocale<'chat'> & InjectFace<ReasoningRecapInjected>) {
  const enabled = useReasoningRecap(value => value)
  return <PreferenceRow title={t('settings.reasoning.title')} description={t('settings.reasoning.description')}
    value={enabled ? 'on' : 'off'} selectedLabel={t(enabled ? 'settings.reasoning.on' : 'settings.reasoning.off')}
    options={[{ id: 'on', label: t('settings.reasoning.on') }, { id: 'off', label: t('settings.reasoning.off') }]}
    onSelect={(value) => { setReasoningRecap(value === 'on') }} />
}
