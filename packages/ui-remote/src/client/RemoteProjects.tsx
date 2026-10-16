/** Mount the active remote Client tree into the ordinary keyed main panel. */
import { useEffect, useRef } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Button, StateDot } from '@codexydsh/ui-primitives'
import type { RemoteRuntimeState } from './runtime.tsx'
import css from './RemoteProjects.module.css'

export interface RemoteViewInjected {
  hooks: { remoteView: SnapshotStore<(RemoteRuntimeState & { name: string }) | null> }
  mountRemote(container: HTMLElement): () => void
  retryRemote(name: string): void
}

export function RemoteProjectsPanel({ useRemoteView, mountRemote, retryRemote, t }: PropsRuntime<'main'> & PropsLocale<'remote'> & InjectFace<RemoteViewInjected>) {
  const active = useRemoteView(value => value)
  const mount = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (mount.current) return mountRemote(mount.current)
  }, [mountRemote])
  return <div className={css.panel} data-remote-project-panel={active?.name ?? ''}>
    <div ref={mount} className={css.runtime} />
    {active?.phase !== 'ready' && <div className={css.waiting} role={active?.phase === 'failed' ? 'alert' : 'status'}>
      {active?.phase === 'failed' ? <><span>{active.error}</span><Button size="sm" onClick={() => { retryRemote(active.name) }}>{t('retry')}</Button></>
        : <><StateDot state="ongoing" /> {t('loadingProjects')}</>}
    </div>}
  </div>
}
