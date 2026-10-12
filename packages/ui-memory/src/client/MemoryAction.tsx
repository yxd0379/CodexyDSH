/** Public memory editor embedded in Settings, with an optional standalone dialog. */
import { Button, IconLoadingOutlineRegular, Input, Modal, Toast } from '@codexydsh/ui-primitives'
import { useEffect } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@codexydsh/ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { MemoryRefreshResult } from '@codexydsh/api-memory/types'
import type { MemoryView } from './model.ts'
import { editableMemory } from './model.ts'
import { NS } from './locales.ts'
import css from './MemoryAction.module.css'

/** Session-owned memory browser commands and observable state. */
export interface MemoryActionInjected {
  readonly hooks: { readonly memoryView: ObservableSnapshot<MemoryView> }
  /** Open the retained memory browser. */
  openMemory(): void
  /** Close the browser without discarding its draft. */
  closeMemory(): void
  /** @returns Disposer for background status observation while this dialog is mounted. */
  observeMemory(): () => void
  /** @returns Settlement of status/directory reload. */
  reloadMemory(): Promise<void>
  /** @param query - Literal substring to search. */
  setMemoryQuery(query: string): void
  /** @param cursor - Optional provider search continuation. @returns Search settlement. */
  searchMemory(cursor?: string): Promise<void>
  /** @param path - Public directory. @param cursor - Optional provider continuation. @returns Listing settlement. */
  listMemory(path: string, cursor?: string): Promise<void>
  /** @param path - Public document. @returns Read settlement. */
  readMemory(path: string): Promise<void>
  /** Enter the complete managed-document editor. */
  editMemory(): void
  /** @param content - Complete retained replacement text. */
  setMemoryDraft(content: string): void
  /** Restore the original read content locally. */
  discardMemory(): void
  /** @returns Compare-and-swap save settlement. */
  saveMemory(): Promise<void>
  /** @returns Explicit auxiliary extraction/consolidation settlement. */
  refreshMemory(): Promise<void>
}
/** Memory browser operations and locale; embedding uses the parent Settings scrollport. */
export type MemoryActionProps = PropsLocale<typeof NS> & InjectFace<MemoryActionInjected> & { embedded?: boolean }

/** Success notice retained by the root overlay while its initiating dialog closes. */
export interface MemoryNotice { readonly sequence: number; readonly outcome: 'saved' | MemoryRefreshResult }
/** Root-overlay state and dismissal injected into the success toast. */
export interface MemoryToastInjected {
  readonly hooks: { readonly memoryNotice: ObservableSnapshot<MemoryNotice | null> }
  /** Retire the displayed notice. */
  dismissMemoryNotice(): void
}
/** Full props for the globally retained memory success notice. */
export type MemoryToastProps = PropsRuntime<'shell.overlay'> & PropsLocale<typeof NS> & InjectFace<MemoryToastInjected>

/** Render a global operation-success notification.
 * @param props - Root-retained notice and localized copy.
 * @returns Success toast or no content.
 */
export function MemoryToast({ useMemoryNotice, dismissMemoryNotice, t }: MemoryToastProps): React.JSX.Element | null {
  const notice = useMemoryNotice(value => value)
  if (notice === null) return null
  const text = notice.outcome === 'saved' ? t('saved')
    : !notice.outcome.consolidated && notice.outcome.extracted === 0 ? t('refreshEmpty')
      : t('refreshed', { count: String(notice.outcome.extracted) })
  return <Toast key={notice.sequence} text={text} tone="success" onDone={dismissMemoryNotice} />
}

/** Render the embedded browser or its standalone dialog.
 * @param props - Session-owned memory operations, observable state, and localized copy.
 * @returns Settings content or a retained, body-portaled dialog.
 */
export function MemoryAction(props: MemoryActionProps): React.JSX.Element {
  const { t } = props
  const view = props.useMemoryView(value => value)
  useEffect(() => view.open ? props.observeMemory() : undefined, [view.open, props.observeMemory])
  useEffect(() => {
    if (!props.embedded) return
    props.openMemory()
    return props.closeMemory
  }, [props.embedded, props.openMemory, props.closeMemory])
  const busy = view.busy !== null
  const dirty = view.editing && view.draft !== view.document?.content
  const selected = view.document
  const selectedEditable = editableMemory(selected)
  const listing = view.listing
  const search = view.search
  const empty = view.status !== null && view.status.summary === '' && (listing?.entries.length ?? 0) === 0
  const currentPath = listing?.path ?? ''
  const parentPath = currentPath.split('/').slice(0, -1).join('/')
  const footer = <>

    {view.editing ? <>
      <Button size="sm" disabled={busy} onClick={props.discardMemory}>{t('discard')}</Button>
      <Button size="sm" variant="primary" disabled={busy || !dirty || !selectedEditable} onClick={() => { void props.saveMemory() }}>{t('save')}</Button>
    </> : <Button size="sm" disabled={busy || !selectedEditable} onClick={props.editMemory}>{t('edit')}</Button>}
    <Button size="sm" disabled={busy || dirty || view.status?.running === true} onClick={() => { void props.refreshMemory() }}>
      {t(view.busy === 'refresh' || view.status?.running === true ? 'refreshRunning' : 'refresh')}
    </Button>
  </>
  const content = <>
    <div className={css.status}>
      <div className={css.location}>
        {view.status !== null && <>
          <span>{t('root')}: <code>{view.status.root}</code></span>
          <span>{t('version')}: {view.status.version}</span>
        </>}
        {view.status?.running === true && <span>{t('running')}</span>}
      </div>
      <Button size="sm" disabled={busy} onClick={() => { void props.reloadMemory() }}>{t('reload')}</Button>
    </div>
    {view.status?.lastError !== undefined && <p className={css.notice}>{t('previousError')}: {view.status.lastError}</p>}
    {view.statusError !== null && <div role="alert" className={css.notice}>
      <p>{t('requestFailed')}</p><p className={css.details}>{view.statusError}</p>
    </div>}
    <form className={css.search} onSubmit={(event) => { event.preventDefault(); void props.searchMemory() }}>
      <Input aria-label={t('search')} placeholder={t('searchPlaceholder')} value={view.query}
        onChange={(event) => { props.setMemoryQuery(event.target.value) }} disabled={busy} />
      <Button type="submit" size="sm" disabled={busy || view.query.trim() === ''}>{t('search')}</Button>
    </form>
    {view.error !== null && <div role="alert" className={css.notice}>
      <p>{t(view.error.kind)}</p>
      {view.error.details !== undefined && <p className={css.details}>{view.error.details}</p>}
    </div>}
    {busy && <div className={css.progress} role="status" aria-label={t('loading')}><IconLoadingOutlineRegular className={css.spinner} /></div>}
    <div className={css.layout} aria-busy={busy}>
      <nav className={css.documents} aria-label={t(search === null ? 'files' : 'searchResults')}>
        {search === null ? <>
          {currentPath !== '' && <Button size="sm" disabled={busy} onClick={() => { void props.listMemory(parentPath) }}>{t('up')}</Button>}
          <h3>{currentPath === '' ? t('files') : currentPath}</h3>
          {listing?.entries.map(entry => <button type="button" key={entry.path} disabled={busy}
            className={css.entry} aria-current={selected?.path === entry.path ? 'page' : undefined}
            onClick={() => { if (entry.entry_type === 'directory') void props.listMemory(entry.path); else void props.readMemory(entry.path) }}>
            <span>{entry.path.split('/').at(-1)}{entry.entry_type === 'directory' ? '/' : ''}</span>
          </button>)}
          {listing !== null && listing.entries.length === 0 && <p className={css.empty}>{t('emptyDirectory')}</p>}
          {listing?.next_cursor != null && <Button size="sm" disabled={busy} onClick={() => { void props.listMemory(currentPath, listing.next_cursor ?? undefined) }}>{t('more')}</Button>}
        </> : <>
          <Button size="sm" disabled={busy} onClick={() => { void props.listMemory(currentPath) }}>{t('files')}</Button>
          <h3>{t('searchResults')}</h3>
          {search.matches.map((match, index) => <button type="button" key={`${match.path}:${match.match_line_number}:${index}`} className={css.entry} disabled={busy}
            onClick={() => { void props.readMemory(match.path) }}>
            <span>{match.path}</span>
            <span className={css.secondary}>{t('line', { line: String(match.match_line_number) })}</span>
            <span className={css.excerpt}>{match.content}</span>
          </button>)}
          {search.matches.length === 0 && <p className={css.empty}>{t('noMatches')}</p>}
          {search.next_cursor !== null && <Button size="sm" disabled={busy} onClick={() => { void props.searchMemory(search.next_cursor ?? undefined) }}>{t('more')}</Button>}
        </>}
      </nav>
      <section className={css.document} aria-label={selected?.path ?? t('summary')}>
        {selected === null ? <>
          <h3>{t('summary')}</h3>
          <p className={css.empty}>{t(empty ? 'empty' : 'choose')}</p>
          {view.status?.summary !== '' && <pre>{view.status?.summary}</pre>}
        </> : <>
          <h3>{selected.path}</h3>
          {selected.truncated && <p className={css.notice}>{t('truncated')}</p>}
          {!selectedEditable && !selected.truncated && <p className={css.secondary}>{t('readonly')}</p>}
          {view.editing ? <>
            <p className={css.secondary}>{t('editDescription')}</p>
            <textarea className={css.editor} aria-label={t('editorLabel')} value={view.draft} disabled={busy}
              onChange={(event) => { props.setMemoryDraft(event.target.value) }} />
          </> : <pre>{selected.content}</pre>}
        </>}
      </section>
    </div>
  </>
  if (props.embedded) return <section className={css.settingsBrowser}>
    {content}<div className={css.actions}>{footer}</div>
  </section>
  return <>
    <Button size="sm" variant="toolbar" onClick={props.openMemory}>{t('title')}</Button>
    <Modal open={view.open} title={t('title')} description={t('description')} closeLabel={t('close')}
      onClose={props.closeMemory} className={css.dialog ?? ''} contentClassName={css.content ?? ''} footer={footer}>{content}</Modal>
  </>
}
