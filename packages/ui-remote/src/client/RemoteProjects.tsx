/** Projects in the existing left column and persistent remote runtime viewports. */
import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { IRemoteHosts } from '@codexydsh/remote/client'
import { Button, Input, StateDot } from '@codexydsh/ui-primitives'
import type { RemoteSettings } from './model.ts'
import { REMOTE_PANEL, parseCommand, type RemoteProjects, type RemoteProjectsSnapshot } from './projects.ts'
import css from './RemoteProjects.module.css'

export interface RemoteProjectsInjected {
  hooks: { remoteProjects: SnapshotStore<RemoteProjectsSnapshot>; remoteSettings: ConfigForm<RemoteSettings>; remoteHosts: IRemoteHosts }
  projects: RemoteProjects
  connectHost(name: string): Promise<void>
  disconnectHost(name: string): Promise<void>
}
type TreeProps = PropsRuntime<'sidebar.footer.action'> & PropsLocale<'remote'> & InjectFace<RemoteProjectsInjected>

/** Additive registration preserves every local WorkspaceBrowser action and extension. */
export function RemoteProjectsTree({ wide, useRemoteProjects, useRemoteSettings, useRemoteHosts, projects, connectHost, disconnectHost, usePanelInfo, t }: TreeProps) {
  const state = useRemoteProjects(value => value)
  const settings = useRemoteSettings(value => value)
  const connections = useRemoteHosts(value => value)
  const active = usePanelInfo(value => value.activePanelId === REMOTE_PANEL)
  const [expanded, setExpanded] = useState(true)
  const [adding, setAdding] = useState<string>()
  const [path, setPath] = useState('')
  const [error, setError] = useState('')
  // null means the Host catalog is still arriving; [] is an authoritative empty catalog.
  const hosts = connections.items === null
    ? Object.entries(settings.value?.hosts ?? {}).filter(([, host]) => host !== null).map(([name]) => name)
    : connections.items.map(host => host.name)
  const run = (action: () => Promise<void>): void => { void action().catch(failure => { setError(failure instanceof Error ? failure.message : String(failure)) }) }
  if (!wide) return <button className={css.compact} type="button" title={t('remoteProjects')} aria-label={t('remoteProjects')} onClick={() => { const name = state.active ?? state.frames[0]?.name; if (name) projects.activate(name) }}>⇄</button>
  return <section className={css.tree} aria-label={t('remoteProjects')}>
    <button type="button" className={css.heading} aria-expanded={expanded} onClick={() => { setExpanded(!expanded) }}><span aria-hidden="true">{expanded ? '⌄' : '›'}</span> {t('remoteProjects')}</button>
    {expanded && <div className={css.scroll}>
      {hosts.length === 0 && <p className={css.hint}>{t('configureHosts')}</p>}
      {connections.error && <p className={css.error} role="alert">{connections.error}</p>}
      {hosts.map(name => {
        const status = connections.items?.find(item => item.name === name)
        const frame = state.frames.find(item => item.name === name)
        const phase = status?.phase ?? 'disconnected'
        return <div className={css.host} key={name} data-remote-host={name}>
          <div className={css.hostHeader}><button type="button" className={css.hostName} onClick={() => { if (frame) projects.activate(name); else run(() => connectHost(name)) }} title={name}>{name}<span className={css.phase}>{t(phase)}</span></button>
            {phase === 'connected' || phase === 'connecting' ? <button type="button" className={css.icon} aria-label={`${t('disconnect')} ${name}`} onClick={() => { run(() => disconnectHost(name)) }}>×</button>
              : <button type="button" className={css.icon} data-remote-connect={name} disabled={!connections.connected} aria-label={`${t('connect')} ${name}`} onClick={() => { run(() => connectHost(name)) }}>⇄</button>}
          </div>
          {status?.error && <p className={css.error}>{status.error}</p>}
          {frame && <>
            {!frame.ready && <p className={css.hint}><StateDot state="ongoing" /> {t('loadingProjects')}</p>}
            {frame.error && <p className={css.error} role="alert">{frame.error}</p>}
            {frame.catalog?.error && <p className={css.error} role="alert">{frame.catalog.error}</p>}
            {frame.catalog?.projects.map(project => <div className={css.project} key={`${name}:${project.id}`} data-remote-project={project.id}>
              <div className={css.projectHeader}><button type="button" className={css.projectName} title={`${name}: ${project.path}`} onClick={() => { projects.command(name, { action: 'openWorkspace', id: project.id }) }}>▱ {project.title || project.path}</button>
                <button type="button" className={css.icon} aria-label={`${t('newRemoteSession')} ${name}: ${project.title}`} onClick={() => { projects.command(name, { action: 'newSession', id: project.id }) }}>+</button></div>
              {project.sessions.map(session => <button type="button" className={css.session} data-remote-session={session.id} key={`${name}:${project.id}:${session.id}`} aria-current={active && state.active === name && frame.catalog?.current === session.id ? 'page' : undefined}
                title={`${name}: ${session.title}`} onClick={() => { projects.command(name, { action: 'openSession', id: session.id }) }}><span className={css.running} aria-label={session.running ? t('runningSession') : undefined}>{session.running ? '●' : '·'}</span>{session.title}</button>)}
              {project.sessions.length === 0 && <p className={css.hint}>{t('noRemoteSessions')}</p>}
            </div>)}
            {frame.catalog?.ready && frame.catalog.projects.length === 0 && <p className={css.hint}>{t('noRemoteProjects')}</p>}
            {adding === name ? <form className={css.addForm} onSubmit={event => {
              event.preventDefault()
              const command = parseCommand({ action: 'createWorkspace', path })
              if (!command) { setError(t('invalidDirectory')); return }
              projects.command(name, command); setAdding(undefined); setPath(''); setError('')
            }}>
              <Input aria-label={t('remoteProjectPath')} placeholder={t('remoteProjectPath')} required value={path} onChange={event => { setPath(event.target.value) }} />
              <div className={css.formActions}><Button size="sm" type="submit">{t('add')}</Button><Button size="sm" onClick={() => { setAdding(undefined) }}>{t('cancel')}</Button></div>
            </form> : <button type="button" className={css.addProject} disabled={!frame.ready} onClick={() => { setAdding(name); setPath(''); setError('') }}>+ {t('addRemoteProject')}</button>}
          </>}
        </div>
      })}
      {error && <p className={css.error} role="alert">{error}</p>}
    </div>}
  </section>
}

export interface RemoteViewport { left: number; top: number; width: number; height: number }
export interface RemoteViewInjected { hooks: { remoteProjects: SnapshotStore<RemoteProjectsSnapshot> }; projects: RemoteProjects; viewport: SnapshotStore<RemoteViewport | null>; returnLocal(): void }

/** The keyed main seat supplies geometry; iframe lifetimes belong to the persistent shell. */
export function RemoteProjectsPanel({ viewport }: PropsRuntime<'main'> & InjectFace<Pick<RemoteViewInjected, 'viewport'>>) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    const update = (): void => { const { left, top, height } = node.getBoundingClientRect(); viewport.set({ left, top, width: Math.max(0, window.innerWidth - left), height }) }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node); window.addEventListener('resize', update)
    return () => { observer.disconnect(); window.removeEventListener('resize', update); viewport.set(null) }
  }, [viewport])
  return <div ref={ref} className={css.panel} />
}

/** Mounted once per connected host, including while the local conversation is selected. */
export function RemoteProjectFrames({ useRemoteProjects, projects, useRemoteViewport, usePanelInfo, returnLocal, t }: PropsRuntime<'shell.overlay'> & PropsLocale<'remote'> & InjectFace<Omit<RemoteViewInjected, 'viewport'> & { hooks: RemoteViewInjected['hooks'] & { remoteViewport: SnapshotStore<RemoteViewport | null> } }>) {
  const state = useRemoteProjects(value => value)
  const viewport = useRemoteViewport(value => value)
  const selected = usePanelInfo(value => value.activePanelId === REMOTE_PANEL)
  return <>{state.frames.map(frame => {
    const visible = selected && state.active === frame.name && viewport !== null
    return <div key={`${frame.name}:${frame.channel}`} className={css.viewport} style={{ left: viewport?.left ?? 0, top: viewport?.top ?? 0, width: viewport?.width ?? 800, height: viewport?.height ?? 600,
      visibility: visible ? 'visible' : 'hidden', pointerEvents: visible ? 'auto' : 'none' }} aria-hidden={!visible}>
      <iframe data-remote-frame={frame.name} title={t('remoteFrameTitle', { host: frame.name })} className={css.frame} src={projects.frameUrl(frame)} ref={node => { projects.bind(frame.name, node?.contentWindow ?? null) }}
        onLoad={() => { projects.loaded(frame.name) }} referrerPolicy="no-referrer" style={{ width: `calc(100% + ${frame.inset}px)`, marginLeft: -frame.inset }} />
      {!frame.ready && <div className={css.waiting} role={frame.error ? 'alert' : 'status'}>{frame.error ? <><span>{frame.error}</span><Button size="sm" onClick={() => { projects.reload(frame.name) }}>{t('retry')}</Button></> : <><StateDot state="ongoing" /> {t('loadingProjects')}</>}</div>}
    </div>
  })}</>
}
