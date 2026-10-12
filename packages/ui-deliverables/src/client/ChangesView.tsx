/** Recorded file changes in a dedicated Conversation view. */
import { useEffect, useMemo } from 'react'
import type { ConvViewProps } from '@codexydsh/ui-conversation/client'
import { Button, DiffBlock, diffTotals, IconLoadingOutlineRegular } from '@codexydsh/ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { changesSummaryUrl, type SessionChangesTurn } from '../changes.ts'
import type { ChangesHistoryState } from './changes-history.ts'
import type { DeliverablesInjected } from './Deliverables.tsx'
import type { RecordedFileDiff } from './turn-deliverables.ts'
import { ChangedFiles, ChangedFilesCard } from './ChangedFiles.tsx'
import type { NS } from './locales.ts'
import css from './ChangesView.module.css'

/** Shared history and file readers bound to the selected Session. */
export interface ChangesViewInjected extends DeliverablesInjected {
  hooks: DeliverablesInjected['hooks'] & { changesHistory: ObservableSnapshot<Record<string, ChangesHistoryState | undefined>> }
  /** Retain the independent inventory while this view is mounted. @returns release callback. */
  retainChangesHistory(): () => void
  /** Retry the inventory query. @returns after the requested read settles. */
  retryChangesHistory(): Promise<void>
}

type ChangesViewProps = ConvViewProps & InjectFace<ChangesViewInjected> & PropsLocale<typeof NS>

/** @param props - selected Session and recorded changes. @returns one scrolling file review. */
export function ChangesView(props: ChangesViewProps) {
  const history = props.useChangesHistory(state => state[props.sessionId])
  useEffect(() => props.retainChangesHistory(), [props.retainChangesHistory])
  const turns = history?.history?.turns ?? []
  const loading = history === undefined || history.phase === 'loading'
  return <div className={css.root} data-changes-view aria-busy={loading}>
    {loading && turns.length === 0 && <div className={css.loading} role="status" aria-label={props.t('changes.loading')}>
      <IconLoadingOutlineRegular className={css.spinner} />
    </div>}
    {history?.phase === 'error' && <div className={css.notice} role="alert">
      <span>{props.t('changes.error')}</span><Button variant="outline" size="sm" onClick={() => { void props.retryChangesHistory() }}>{props.t('changes.retry')}</Button>
    </div>}
    {history?.phase === 'ready' && turns.length === 0 && <p className={css.empty}>{props.t('changes.empty')}</p>}
    {turns.map(data => <section key={data.turn} className={css.turn}>
      <h3>{props.t('changes.turn', { turn: data.turn })}</h3>
      <TurnChanges {...props} data={data} />
    </section>)}
  </div>
}

function TurnChanges({ data, sessionId, useSessions, useChangesSummary, loadChangesSummary,
  openChangesReview, useChangesDiff, loadChangesDiff, inspectCall, t,
}: ChangesViewProps & { data: SessionChangesTurn }) {
  const seq = data.changes?.seq
  const cwd = useSessions(state => state.byId[sessionId]?.cwd)
  const summary = useChangesSummary(state => seq === undefined ? undefined : state[changesSummaryUrl(sessionId, seq)])
  useEffect(() => {
    if (seq !== undefined && summary === undefined) void loadChangesSummary(sessionId, seq)
  }, [seq, summary, loadChangesSummary, sessionId])
  if (seq !== undefined && typeof summary === 'object' && summary.files.length > 0) {
    return <ChangedFiles changes={{ seq, ...summary }} cwd={cwd} sessionId={sessionId} t={t}
      useChangesDiff={useChangesDiff} loadChangesDiff={loadChangesDiff}
      openReview={(index) => { openChangesReview({ sessionId, seq, turn: summary.turn }, index) }} />
  }
  if (data.diffs === undefined) return null
  return <RecordedChanges diffs={data.diffs} cwd={cwd} inspectCall={inspectCall} t={t} />
}

function RecordedChanges({ diffs, cwd, inspectCall, t }: {
  readonly diffs: readonly RecordedFileDiff[]
  readonly cwd: string | undefined
  readonly inspectCall: ConvViewProps['inspectCall']
  readonly t: ChangesViewProps['t']
}) {
  const files = useMemo(() => {
    const byPath = new Map<string, RecordedFileDiff[]>()
    for (const diff of diffs) {
      const edits = byPath.get(diff.path)
      if (edits === undefined) byPath.set(diff.path, [diff])
      else edits.push(diff)
    }
    return [...byPath].map(([path, edits]) => {
      const { added, removed } = diffTotals(edits)
      return { path, display: path, added, deleted: removed, edits }
    })
  }, [diffs])
  const open = inspectCall === undefined ? undefined : (index: number): void => {
    const callId = files[index]?.edits.at(-1)?.callId
    if (callId !== undefined) inspectCall(callId)
  }
  return <ChangedFilesCard changes={{ files, total: files.length,
    added: files.reduce((total, file) => total + file.added, 0),
    deleted: files.reduce((total, file) => total + file.deleted, 0),
  }} cwd={cwd} openReview={open} t={t} countsLabel={t('changes.operationCounts')}
  openReviewLabel={t('changes.openEdit')} fileReviewLabel={name => t('changes.viewEdit', { name })}
  previewLabel={t('changes.editPreview')}
  renderPreview={(_file, index) => <div className={css.preview} data-recorded-changes-preview>
    <DiffBlock diffs={files[index]?.edits ?? []} variant="inline" changesOnly controls labels={{
      codeLabel: t('view.changes'), copy: t('changes.copyDiff'), copied: t('copied'),
      wrapLabel: t('changes.wrapDiff'), unwrapLabel: t('changes.unwrapDiff'),
      expand: count => t('changes.moreRecorded', { count }), expandAria: count => t('changes.moreRecorded', { count }),
      collapse: t('changes.collapse'), collapseAria: t('changes.collapse'),
    }} />
  </div>} />
}
