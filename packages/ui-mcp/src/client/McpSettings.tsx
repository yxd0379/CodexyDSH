/** MCP catalog editor inside the shared settings page. */
import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Button, Checkbox, Input, StateDot, Toast } from '@codexydsh/ui-primitives'
import { draftOf, type CatalogSettings, type ServerDraft } from './model.ts'
import css from './McpSettings.module.css'

/** Settings data and operations projected into the registered component. */
export interface McpSettingsInjected {
  hooks: { mcpSettings: ConfigForm<CatalogSettings> }
  saveMcp(draft: ServerDraft): Promise<void>
  deleteMcp(name: string, revision: number): Promise<void>
}

/** Shell-owned notice that survives closing the settings panel. */
export interface McpNotice { sequence: number; text: string; success: boolean }

/** Observable notice and dismissal callback for the shell overlay. */
export interface McpToastInjected {
  hooks: { mcpNotice: SnapshotStore<McpNotice | null> }
  dismissMcpNotice(): void
}

type SettingsProps = PropsRuntime<'settings.section'> & PropsLocale<'mcp'> & InjectFace<McpSettingsInjected>

/** Render saved servers and a revision-fenced draft editor.
 * @param props - Bound settings source, mutations, and localized copy.
 * @returns Catalog list and editor.
 */
export function McpSettings({ useMcpSettings, saveMcp, deleteMcp, t }: SettingsProps) {
  const state = useMcpSettings(value => value)
  const [draft, setDraft] = useState<ServerDraft>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [removing, setRemoving] = useState<string>()
  const servers = Object.values(state.value?.servers ?? {}).filter(server => server !== null)
  const revision = state.revision ?? 0
  const editable = state.status === 'ready' && state.writable && state.revision !== undefined
  const run = async (operation: () => Promise<void>, success: () => void): Promise<void> => {
    setBusy(true); setError('')
    try { await operation(); success() }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }
  return <div className={css.page}>
    <p className={css.secondary}>{t('description')}</p>
    {state.status === 'loading' ? <div className={css.loading}><StateDot state="ongoing" /></div> : <>
      {!editable && <p className={css.secondary}>{t('unavailable')}</p>}
      {servers.length === 0 && <p className={css.secondary}>{t('empty')}</p>}
      {servers.map(server => <div key={server.serverName} className={css.row}>
        <div className={css.identity}><strong>{server.serverName}</strong>
          <span className={css.secondary}>{server.transport} · {t(server.autoConnect ? 'autoOn' : 'autoOff')}</span></div>
        <Button size="sm" disabled={!editable || busy} onClick={() => {
          setDraft(draftOf(revision, server)); setError(''); setRemoving(undefined)
        }}>{t('edit')}</Button>
        <Button size="sm" disabled={!editable || busy} onClick={() => {
          if (removing !== server.serverName) { setRemoving(server.serverName); return }
          void run(() => deleteMcp(server.serverName, revision), () => { setRemoving(undefined) })
        }}>{t(removing === server.serverName ? 'confirmRemove' : 'remove')}</Button>
        {removing === server.serverName && <Button size="sm" disabled={busy} onClick={() => { setRemoving(undefined) }}>{t('cancel')}</Button>}
      </div>)}
      {draft === undefined ? <Button variant="outline" disabled={!editable || busy} onClick={() => {
        setDraft(draftOf(revision)); setError(''); setRemoving(undefined)
      }}>{t('add')}</Button> : <form className={css.editor} onSubmit={(event) => {
        event.preventDefault()
        void run(() => saveMcp(draft), () => { setDraft(undefined) })
      }}>
        <label className={css.field}>{t('name')}<Input required value={draft.serverName} disabled={busy || draft.originalName !== undefined}
          onChange={(event) => { setDraft({ ...draft, serverName: event.target.value }) }} /></label>
        <label className={css.field}>{t('transport')}<select aria-label={t('transport')} value={draft.transport} disabled={busy || draft.originalName !== undefined}
          onChange={(event) => { setDraft({ ...draft, transport: event.target.value === 'stdio' ? 'stdio' : 'streamable-http' }) }}>
          <option value="stdio">{t('stdio')}</option><option value="streamable-http">{t('http')}</option>
        </select></label>
        {draft.transport === 'stdio' ? <>
          <label className={css.field}>{t('command')}<Input required value={draft.command} disabled={busy} onChange={(event) => { setDraft({ ...draft, command: event.target.value }) }} /></label>
          <label className={css.field}>{t('args')}<Input value={draft.args} disabled={busy} onChange={(event) => { setDraft({ ...draft, args: event.target.value }) }} /></label>
          <label className={css.field}>{t('cwd')}<Input value={draft.cwd} disabled={busy} onChange={(event) => { setDraft({ ...draft, cwd: event.target.value }) }} /></label>
        </> : <label className={css.field}>{t('url')}<Input required type="url" value={draft.url} disabled={busy} onChange={(event) => { setDraft({ ...draft, url: event.target.value }) }} /></label>}
        <label className={css.field}>{t(draft.transport === 'stdio' ? 'env' : 'headers')}<Input type="password" autoComplete="off" value={draft.secrets} disabled={busy}
          onChange={(event) => { setDraft({ ...draft, secrets: event.target.value }) }} /></label>
        <p className={css.secondary}>{t('secretHint')}</p>
        <Checkbox label={t('autoConnect')} checked={draft.autoConnect} disabled={busy}
          onChange={(value) => { setDraft({ ...draft, autoConnect: value }) }} />
        <div className={css.actions}><Button type="submit" variant="primary" disabled={busy || !editable}>{busy && <StateDot state="ongoing" />}{t('save')}</Button>
          <Button disabled={busy} onClick={() => { setDraft(undefined); setError('') }}>{t('cancel')}</Button></div>
      </form>}
      {error && <p className={css.error} role="alert">{error}</p>}
    </>}
  </div>
}

/** Render the latest settings outcome at shell scope.
 * @param props - Observable notice and dismissal operation.
 * @returns Toast while a notice is present.
 */
export function McpToast({ useMcpNotice, dismissMcpNotice }: PropsRuntime<'shell.overlay'> & InjectFace<McpToastInjected>) {
  const notice = useMcpNotice(value => value)
  return notice && <Toast key={notice.sequence} text={notice.text} {...notice.success ? { tone: 'success' as const } : {}} onDone={dismissMcpNotice} />
}
