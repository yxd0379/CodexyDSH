/** Plain native frame, SSH settings and row dialogs, supplied with instance-owned callbacks. */
import { useCallback, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { RemoteHostConfig, RemoteHostStatus } from '@codexydsh/remote/types'
import type { RemoteSettings, RemoteView, RemoteWorkspaceController } from './controller.ts'
import css from './views.module.css'

/** Data and commands bound by the owning Remote Client plugin. */
export interface RemoteInjected {
  hooks: { remoteView: HostObservable<RemoteView>; remoteForm: HostObservable<ConfigFormSnapshot<RemoteSettings>> }
  attach: RemoteWorkspaceController['attach']
  surface: RemoteWorkspaceController['surface']
  connect: RemoteWorkspaceController['connect']
  disconnect: RemoteWorkspaceController['disconnect']
  save: RemoteWorkspaceController['save']
  remove: RemoteWorkspaceController['remove']
  rename: RemoteWorkspaceController['rename']
  setVisible: RemoteWorkspaceController['setVisible']
  closeDialog: RemoteWorkspaceController['closeDialog']
  authenticate: RemoteWorkspaceController['authenticate']
  dismissError: RemoteWorkspaceController['dismissError']
  openSettings: RemoteWorkspaceController['openSettings']
  showDetails: RemoteWorkspaceController['showDetails']
}
type RemoteProps = InjectFace<RemoteInjected> & PropsLocale<'remoteWorkspace'>

/** Native main column's geometry anchor; the full remote document stays mounted elsewhere. */
export function RemotePanel({ surface, useRemoteView, connect, disconnect, t }: RemoteProps) {
  const state = useRemoteView(value => value)
  const host = state.hosts.find(item => item.name === state.selectedHost)
  return <div className={css.surface} ref={surface}>
    {host?.phase !== 'connected' && <div className={css.connectionCard}>
      <h2>{host?.name ?? t('title')}</h2><p role="status">{host === undefined ? t('empty') : t(host.phase)}</p>
      {host?.phase === 'connecting' && <p>{host.progress}</p>}
      {host !== undefined && <Button variant="outline" onClick={() => {
        if (host.phase === 'connecting') disconnect(host.name); else connect(host.name)
      }}>{t(host.phase === 'connecting' ? 'cancel' : 'connect')}</Button>}
      {host !== undefined && <details><summary>{t('log')}</summary><pre className={css.log}>{host.log || host.error || t('noLog')}</pre></details>}
    </div>}
  </div>
}

function HostFrame({ host, visible, rect, attach }: {
  host: RemoteHostStatus; visible: boolean; rect: RemoteView['rect']; attach: RemoteInjected['attach']
}) {
  const bind = useCallback((element: HTMLIFrameElement | null) => { attach(host.name, element) }, [attach, host.name])
  if (host.url === null) return null
  const url = new URL(host.url, document.baseURI)
  url.searchParams.set('codexydsh-embedded', '1')
  return <iframe ref={bind} className={css.frame} title={host.name} name={`codexydsh-remote-${host.name}`} src={url.href}
    data-codexydsh-remote-frame={host.name} aria-hidden={!visible} tabIndex={visible ? 0 : -1}
    allow="clipboard-read; clipboard-write"
    style={visible && rect !== null ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      : { left: -10000, top: 0, width: 1200, height: 800, visibility: 'hidden', pointerEvents: 'none' }} />
}

/** Persistent frame roster; switching local workspaces does not destroy remote terminals or drafts. */
export function RemoteFrames({ useRemoteView, attach }: Pick<RemoteProps, 'useRemoteView' | 'attach'>) {
  const state = useRemoteView(value => value)
  return <>{state.hosts.filter(host => host.phase === 'connected').map(host =>
    <HostFrame key={host.name} host={host} attach={attach} rect={state.rect}
      visible={state.rect !== null && state.selectedHost === host.name} />)}</>
}

function Editor({ name, value, save, close, t }: {
  name: string | null; value: RemoteHostConfig | undefined; save: RemoteInjected['save']; close(): void; t: RemoteProps['t']
}) {
  const [nextName, setName] = useState(name ?? '')
  const [host, setHost] = useState(value?.host ?? '')
  const [profile, setProfile] = useState(value?.profile ?? 'web')
  const [home, setHome] = useState(value?.home ?? '')
  const [proxyMode, setProxyMode] = useState<NonNullable<RemoteHostConfig['proxyMode']>>(value?.proxyMode ?? 'inherit')
  const [proxyUrl, setProxyUrl] = useState(value?.proxyUrl ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (): Promise<void> => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(nextName) || host.trim() === '') { setError(t('invalid')); return }
    setBusy(true); setError('')
    try {
      const accepted = await save(nextName, { host: host.trim(), profile, directory: value?.directory ?? '', node: value?.node ?? 'node',
        dsh: value?.dsh ?? 'codexydsh', deployment: value?.deployment ?? 'auto', proxyMode, proxyUrl,
        ...(value?.noProxy === undefined ? {} : { noProxy: value.noProxy }),
        ...(home.trim() === '' ? {} : { home: home.trim() }) }, name ?? undefined)
      if (accepted) close(); else setError(t('saveFailed'))
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  return <Modal open onClose={() => { if (!busy) close() }} title={t(name === null ? 'add' : 'edit')} closeLabel={t('close')}
    footer={<><Button disabled={busy} onClick={close}>{t('cancel')}</Button><Button variant="primary" disabled={busy} onClick={() => { void submit() }}>{t('save')}</Button></>}>
    <form className={css.fields} onSubmit={event => { event.preventDefault(); void submit() }}>
      <label>{t('name')}<input value={nextName} onChange={event => { setName(event.target.value) }} disabled={busy} data-modal-autofocus /></label>
      <label>{t('host')}<input value={host} onChange={event => { setHost(event.target.value) }} disabled={busy} /></label>
      <label>{t('profile')}<input value={profile} onChange={event => { setProfile(event.target.value) }} disabled={busy} /></label>
      <label>{t('home')}<input value={home} onChange={event => { setHome(event.target.value) }} disabled={busy} /></label>
      <label>{t('proxy')}<select aria-label={t('proxy')} value={proxyMode} onChange={event => { setProxyMode(event.target.value as typeof proxyMode) }} disabled={busy}>
        <option value="inherit">{t('inherit')}</option><option value="direct">{t('direct')}</option><option value="custom">{t('custom')}</option>
      </select></label>
      {proxyMode === 'custom' && <label>{t('proxyUrl')}<input value={proxyUrl} onChange={event => { setProxyUrl(event.target.value) }} disabled={busy} /></label>}
      {error !== '' && <p className={css.error} role="alert">{error}</p>}
    </form>
  </Modal>
}

/** Saved host catalog, inline connection phases/logs and reversible workspace visibility. */
export function RemoteSettingsSection(props: RemoteProps & SettingsSectionOwnerProps) {
  const { t, save, connect, disconnect } = props
  const state = props.useRemoteView(value => value)
  const form = props.useRemoteForm(value => value)
  const [editing, setEditing] = useState<{ name: string | null } | null>(null)
  const [error, setError] = useState('')
  return <section className={css.settings}>
    <p className={css.description}>{t('description')}</p>
    {state.hosts.map(host => <div key={host.name} className={css.host}>
      <div className={css.hostHeader}><div><h3>{host.name}</h3><p className={css.description}>{host.host} · {host.profile} · {t(host.phase)}</p></div>
        <div className={css.actions}>
          {host.phase === 'connected' || host.phase === 'connecting'
            ? <Button onClick={() => { disconnect(host.name) }}>{t(host.phase === 'connecting' ? 'cancel' : 'disconnect')}</Button>
            : <Button variant="outline" onClick={() => { connect(host.name) }}>{t('connect')}</Button>}
          <Button onClick={() => { setEditing({ name: host.name }) }}>{t('edit')}</Button>
          {host.phase === 'connected' && <Button onClick={() => { props.close(); props.openSettings(host.name) }}>{t('remoteSettings')}</Button>}
          <Button onClick={() => { void props.remove(host.name).catch(reason => { setError(String(reason)) }) }}>{t('remove')}</Button>
        </div>
      </div>
      {host.phase === 'connecting' && host.progress !== undefined && <p role="status">{host.progress}</p>}
      {host.error !== null && <p className={css.error} role="alert">{t('failed')}</p>}
      <details><summary>{t('log')}</summary><pre className={css.log}>{host.log || host.error || t('noLog')}</pre></details>
    </div>)}
    <Button variant="outline" disabled={!form.writable} onClick={() => { setEditing({ name: null }) }}>{t('add')}</Button>
    {(error || state.error) && <p className={css.error} role="alert">{error || state.error}</p>}
    {editing !== null && <Editor key={editing.name ?? 'new'} name={editing.name}
      value={editing.name === null ? undefined : form.value?.hosts[editing.name] ?? undefined}
      save={save} close={() => { setEditing(null) }} t={t} />}
  </section>
}

/** Remote visibility lives alongside local workspaces, not inside SSH connection settings. */
export function RemoteWorkspaceSettings({ useRemoteView, setVisible, showDetails, t }: RemoteProps) {
  const state = useRemoteView(value => value)
  const hosts = Object.entries(state.groups).filter(([, groups]) => groups.some(group => group.workspaceId !== undefined))
  return <>
    {hosts.map(([host, groups]) => <div key={host} className={css.workspaceList}>
      <h3 className={css.workspaceHeading}>{host}</h3>
      {groups.filter(group => group.workspaceId !== undefined).map(group =>
        <div key={group.key} className={css.workspaceRow}>
          <label className={css.workspace}><input type="checkbox" checked={!state.hidden[host]?.includes(group.key)}
            onChange={event => { setVisible(host, group.key, event.target.checked) }} aria-label={`${t('show')} ${host}: ${group.label}`} />
          <span>{group.label}<small>{group.cwd}</small></span></label>
          <Button onClick={() => { showDetails(host, group) }}>{t('properties')}</Button>
        </div>)}
    </div>)}
    {hosts.length === 0 && <p className={css.description}>{t('noWorkspaces')}</p>}
  </>
}

function RenameDialog({ title, rename, close, t }: { title: string; rename: RemoteInjected['rename']; close(): void; t: RemoteProps['t'] }) {
  const [text, setText] = useState(title)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const commit = async (): Promise<void> => {
    setBusy(true)
    try { await rename(text) } catch (reason) { setError(String(reason)) } finally { setBusy(false) }
  }
  return <Modal open onClose={() => { if (!busy) close() }} title={t('rename')} closeLabel={t('close')}
    footer={<><Button disabled={busy} onClick={close}>{t('cancel')}</Button><Button variant="primary" disabled={busy || !text.trim()} onClick={() => { void commit() }}>{t('save')}</Button></>}>
    <form className={css.fields} onSubmit={event => { event.preventDefault(); void commit() }}><input value={text} data-modal-autofocus onChange={event => { setText(event.target.value) }} />{error && <p role="alert">{error}</p>}</form>
  </Modal>
}

function Authentication({ host, authenticate, t }: { host: RemoteHostStatus; authenticate: RemoteInjected['authenticate']; t: RemoteProps['t'] }) {
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const challenge = host.authChallenge
  if (challenge === undefined) return null
  const respond = async (value: string | null): Promise<void> => {
    setBusy(true)
    try { await authenticate(host.name, challenge.id, value); setAnswer('') }
    catch (reason) { setError(String(reason)) } finally { setBusy(false) }
  }
  return <Modal open title={`${t('authentication')} · ${host.name}`} description={challenge.prompt} closeLabel={t('close')}
    onClose={() => { if (!busy) void respond(null) }} footer={<><Button disabled={busy} onClick={() => { void respond(null) }}>{t('cancel')}</Button><Button variant="primary" disabled={busy} onClick={() => { void respond(answer) }}>{t('submit')}</Button></>}>
    <form className={css.fields} onSubmit={event => { event.preventDefault(); void respond(answer) }}><label>{t('answer')}<input type="password" autoComplete="off" value={answer} data-modal-autofocus onChange={event => { setAnswer(event.target.value) }} disabled={busy} /></label>{error && <p role="alert">{error}</p>}</form>
  </Modal>
}

/** Frame-wide source-owned dialogs; no remote action reaches the local Session menu. */
export function RemoteDialogs(props: RemoteProps) {
  const state = props.useRemoteView(value => value)
  const dialog = state.dialog
  const auth = state.hosts.find(host => host.authChallenge !== undefined)
  return <>
    {state.error !== null && <div className={css.notice} role="alert"><p>{state.error}</p><Button onClick={props.dismissError}>{props.t('close')}</Button></div>}
    {dialog?.kind === 'details' && <Modal open onClose={props.closeDialog} title={props.t('details')} closeLabel={props.t('close')}>
      <dl className={css.details}><dt>{props.t('name')}</dt><dd>{dialog.group.label}</dd><dt>{props.t('machine')}</dt><dd>{dialog.host}</dd><dt>{props.t('path')}</dt><dd>{dialog.group.cwd}</dd></dl>
      <Button variant="outline" onClick={() => { props.openSettings(dialog.host) }}>{props.t('remoteSettings')}</Button>
    </Modal>}
    {dialog?.kind === 'rename' && <RenameDialog key={`${dialog.host}:${JSON.stringify(dialog.target)}`} title={dialog.title} rename={props.rename} close={props.closeDialog} t={props.t} />}
    {auth !== undefined && <Authentication key={auth.authChallenge?.id} host={auth} authenticate={props.authenticate} t={props.t} />}
  </>
}
