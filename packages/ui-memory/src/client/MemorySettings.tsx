/** Settings-owned memory browser; its selected Session supplies the refresh model. */
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { MemoryAction, type MemoryActionInjected } from './MemoryAction.tsx'
import { NS } from './locales.ts'
import css from './MemoryAction.module.css'

type MemorySettingsProps = PropsRuntime<'settings.section'> & PropsLocale<typeof NS> & {
  memoryFor: (id: SessionId) => MemoryActionInjected
}

/** Browse memory within Settings, retaining editor drafts in the Session-owned controller.
 * @param props - Session catalog, operation resolver and localized copy.
 * @returns Memory settings page or guidance when no Session exists.
 */
export function MemorySettings({ useSessions, memoryFor, t }: MemorySettingsProps) {
  const sessions = useSessions(value => value)
  const [selected, setSelected] = useState<SessionId>()
  const id = selected !== undefined && sessions.byId[selected] !== undefined ? selected : sessions.ids[0]
  return <>
    <p className={css.secondary}>{t('description')}</p>
    {id === undefined ? <p className={css.empty}>{t('noSession')}</p> : <>
      <label className={css.sessionSelect}>{t('session')}
        <select value={id} onChange={(event) => {
          const next = sessions.ids.find(candidate => candidate === event.target.value)
          if (next !== undefined) setSelected(next)
        }}>{sessions.ids.map(sessionId => <option key={sessionId} value={sessionId}>
            {sessions.byId[sessionId]?.displayTitle ?? sessionId}
          </option>)}</select>
      </label>
      <SessionMemory key={id} id={id} memoryFor={memoryFor} t={t} />
    </>}
  </>
}

function SessionMemory({ id, memoryFor, t }: Pick<MemorySettingsProps, 'memoryFor' | 't'> & { id: SessionId }) {
  const operations = useMemo(() => memoryFor(id), [id, memoryFor])
  const source = operations.hooks.memoryView
  const subscribe = useCallback((listener: () => void) => source.subscribe(listener), [source])
  const getSnapshot = useCallback(() => source.getSnapshot(), [source])
  const view = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return <MemoryAction {...operations} useMemoryView={selector => selector(view)} t={t} embedded />
}
