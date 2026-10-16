/** Saved SSH hosts inside the shared settings page. */
import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { IRemoteHosts } from '@codexydsh/remote/client'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Button, Input, StateDot, Toast } from '@codexydsh/ui-primitives'
import { draftOf, type HostDraft, type RemoteSettings } from './model.ts'
import css from './RemoteSettings.module.css'

/** Values and operations bound by the Remote settings registration. */
export interface RemoteSettingsInjected {
  hooks: { remoteSettings: ConfigForm<RemoteSettings>; remoteHosts: IRemoteHosts }
  saveHost(draft: HostDraft): Promise<void>
  removeHost(name: string, revision: number): Promise<void>
  connectHost(name: string): Promise<void>
  disconnectHost(name: string): Promise<void>
  openHost(name: string): void
  retryHosts(): void
}

/** Shell-scoped operation feedback. */
export interface RemoteNotice { sequence: number; text: string; success: boolean }

/** Notice source and dismissal callback. */
export interface RemoteToastInjected {
  hooks: { remoteNotice: SnapshotStore<RemoteNotice | null> }
  dismissRemoteNotice(): void
}

type SettingsProps = PropsRuntime<'settings.section'> & PropsLocale<'remote'> & InjectFace<RemoteSettingsInjected>

/** Render revision-fenced host editing and locally owned connection controls.
 * @param props - Settings, Host observations, operations, and locale.
 * @returns saved hosts, their connection states, and an optional editor.
 */
export function RemoteSettingsPage({
  useRemoteSettings, useRemoteHosts, saveHost, removeHost, connectHost, disconnectHost, openHost, retryHosts, t,
}: SettingsProps) {
  const settings = useRemoteSettings(value => value)
  const connections = useRemoteHosts(value => value)
  const [draft, setDraft] = useState<HostDraft>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [removing, setRemoving] = useState<string>()
  const hosts = Object.entries(settings.value?.hosts ?? {})
    .filter((entry): entry is [string, NonNullable<typeof entry[1]>] => entry[1] !== null)
  const revision = settings.revision ?? 0
  const editable = settings.status === 'ready' && settings.writable && settings.revision !== undefined
  const write = async (operation: () => Promise<void>, accepted: () => void): Promise<void> => {
    setBusy(true); setError('')
    try { await operation(); accepted() }
    catch (failure) { setError(failure instanceof Error ? failure.message : t('operationFailed', { message: String(failure) })) }
    finally { setBusy(false) }
  }
  const connect = (operation: () => Promise<void>): void => {
    void operation().catch((failure: unknown) => { void failure /* The shell notice retains connection outcomes. */ })
  }
  return <div className={css.page}>
    <p className={css.secondary}>{t('description')}</p>
    {settings.status === 'loading' || connections.items === null && connections.error === null ? <div className={css.loading}><StateDot state="ongoing" /></div> : <>
      {connections.error !== null && <div role="alert" className={css.error}>{t('observationFailed', { message: connections.error })}
        <Button size="sm" onClick={retryHosts}>{t('retry')}</Button></div>}
      {!editable && <p className={css.secondary}>{t('unavailable')}</p>}
      {hosts.length === 0 && <p className={css.secondary}>{t('empty')}</p>}
      {hosts.map(([name, host]) => {
        const status = connections.items?.find(item => item.name === name)
        const phase = status?.phase ?? 'disconnected'
        const url = status?.url
        return <div key={name} className={css.row}>
          <div className={css.identity}><strong>{name}</strong>
            <span className={css.secondary}>{host.host} · {host.profile} · {t(phase)}</span>
            {phase === 'connecting' && status?.progress && <span className={css.secondary} role="status">{status.progress}</span>}
            {status?.error && <span className={css.error}>{status.error}</span>}</div>
          {phase === 'connected' && url && <Button size="sm" onClick={() => { openHost(name) }}>{t('open')}</Button>}
          {phase === 'connected' || phase === 'connecting'
            ? <Button size="sm" disabled={!connections.connected} onClick={() => { connect(() => disconnectHost(name)) }}>{t(phase === 'connecting' ? 'cancelConnection' : 'disconnect')}</Button>
            : <Button size="sm" variant="outline" disabled={!connections.connected} onClick={() => { connect(() => connectHost(name)) }}>{t('connect')}</Button>}
          <Button size="sm" disabled={!editable || busy} onClick={() => { setDraft(draftOf(revision, name, host)); setError(''); setRemoving(undefined) }}>{t('edit')}</Button>
          <Button size="sm" disabled={!editable || busy} onClick={() => {
            if (removing !== name) { setRemoving(name); return }
            void write(() => removeHost(name, revision), () => { setRemoving(undefined) })
          }}>{t(removing === name ? 'confirmRemove' : 'remove')}</Button>
          {removing === name && <Button size="sm" disabled={busy} onClick={() => { setRemoving(undefined) }}>{t('cancel')}</Button>}
          {status?.log && <details className={css.logs}><summary>{t('connectionLog')}</summary><pre>{status.log}</pre></details>}
        </div>
      })}
      {draft === undefined ? <Button variant="outline" disabled={!editable || busy} onClick={() => { setDraft(draftOf(revision)); setError(''); setRemoving(undefined) }}>{t('add')}</Button>
        : <form className={css.editor} onSubmit={(event) => {
          event.preventDefault(); void write(() => saveHost(draft), () => { setDraft(undefined) })
        }}>
          <label className={css.field}>{t('name')}<Input required value={draft.name} disabled={busy || draft.originalName !== undefined} onChange={(event) => { setDraft({ ...draft, name: event.target.value }) }} /></label>
          <label className={css.field}>{t('deployment')}<select disabled={busy} value={draft.deployment ?? 'auto'} onChange={event => { setDraft({ ...draft, deployment: event.target.value as 'auto' | 'existing' }) }}>
            <option value="auto">{t('deploymentAuto')}</option><option value="existing">{t('deploymentExisting')}</option>
          </select></label>
          {(['host', 'profile', 'directory', ...(draft.deployment === 'existing' ? ['node', 'dsh'] as const : [])] as const).map(field => <label key={field} className={css.field}>{t(field)}
            <Input required={field !== 'directory'} value={draft[field]} disabled={busy} onChange={(event) => { setDraft({ ...draft, [field]: event.target.value }) }} /></label>)}
          <label className={css.field}>{t('proxyMode')}<select disabled={busy} value={draft.proxyMode ?? 'inherit'} onChange={event => { setDraft({ ...draft, proxyMode: event.target.value as NonNullable<HostDraft['proxyMode']> }) }}>
            <option value="inherit">{t('proxyInherit')}</option><option value="custom">{t('proxyCustom')}</option><option value="direct">{t('proxyDirect')}</option>
          </select></label>
          {draft.proxyMode === 'custom' && <>
            <label className={css.field}>{t('proxyUrl')}<Input required type="url" placeholder="http://127.0.0.1:7890" value={draft.proxyUrl ?? ''} disabled={busy} onChange={event => { setDraft({ ...draft, proxyUrl: event.target.value }) }} /></label>
            <label className={css.field}>{t('noProxy')}<Input placeholder=".example.com,10.0.0.1" value={draft.noProxy ?? ''} disabled={busy} onChange={event => { setDraft({ ...draft, noProxy: event.target.value }) }} /></label>
          </>}
          <p className={css.secondary}>{t('proxyHint')}</p>
          {error && <p className={css.error} role="alert">{error}</p>}
          <div className={css.actions}><Button type="submit" variant="primary" disabled={busy || !editable}>{busy && <StateDot state="ongoing" />}{t('save')}</Button>
            <Button disabled={busy} onClick={() => { setDraft(undefined); setError('') }}>{t('cancel')}</Button></div>
        </form>}
    </>}
  </div>
}

/** Render operation feedback outside the settings lifetime.
 * @param props - Bound notice and its dismissal callback.
 * @returns the active shell Toast.
 */
export function RemoteToast({ useRemoteNotice, dismissRemoteNotice }: PropsRuntime<'shell.overlay'> & InjectFace<RemoteToastInjected>) {
  const notice = useRemoteNotice(value => value)
  return notice && <Toast key={notice.sequence} text={notice.text} {...notice.success ? { tone: 'success' as const } : {}} onDone={dismissRemoteNotice} />
}
