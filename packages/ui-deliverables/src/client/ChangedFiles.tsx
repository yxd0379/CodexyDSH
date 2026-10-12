/** The changed-files card: a header and per-file rows that open the turn's review, and a four-row fold. */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import { HoverCard, IconChevronDownOutlineRegular, IconChevronUpOutlineRegular } from '@codexydsh/ui-primitives'
import type { InjectFace, PropsLocale, SessionStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { changesDiffUrl, type ChangesSummary } from '../changes.ts'
import type { DeliverablesInjected } from './Deliverables.tsx'
import { FileDiff } from './FileDiff.tsx'
import diffCss from './FileDiff.module.css'
import { IconCodeBracketsOutline16 } from './icons.tsx'
import type { NS } from './locales.ts'
import css from './ChangedFiles.module.css'

type PreviewProps = Pick<InjectFace<DeliverablesInjected>, 'useChangesDiff' | 'loadChangesDiff'>
  & Pick<SessionStandardProps, 'sessionId'>

/** Rows shown before the fold; the design's summary height for a closing message. */
const COLLAPSED_ROWS = 4

const GROUPED = new Intl.NumberFormat('en-US')

/** Added and deleted line counts in the card's colors. */
function Counts({ added, deleted, t }: { added: number; deleted: number } & PropsLocale<typeof NS>) {
  return <>
    <span className={css.added}>{t('changes.added', { count: GROUPED.format(added) })}</span>
    <span className={css.deleted}>{t('changes.deleted', { count: GROUPED.format(deleted) })}</span>
  </>
}

/** Plain recorded rows and presentation callbacks, independent of Host comparison routes. */
export interface ChangedFilesCardProps extends PropsLocale<typeof NS> {
  readonly changes: Pick<ChangesSummary, 'files' | 'total' | 'added' | 'deleted'>
  readonly cwd: string | undefined
  readonly openReview: ((index: number) => void) | undefined
  readonly renderPreview: (file: ChangesSummary['files'][number], index: number) => ReactNode
  readonly openReviewLabel?: string
  readonly fileReviewLabel?: (name: string) => string
  readonly previewLabel?: string
  readonly countsLabel?: string
}

/**
 * Render served workspace comparisons using the shared changed-files card.
 * @param props - Host summary coordinates, cached comparison readers, and localized copy.
 * @returns compact rows with lazy hover previews and Sidebar navigation.
 */
export function ChangedFiles({ changes, cwd, openReview, t, sessionId, useChangesDiff, loadChangesDiff }: {
  changes: Pick<ChangesSummary, 'files' | 'total' | 'added' | 'deleted'> & { seq: number }
  cwd: string | undefined
  openReview: (index: number) => void
} & PropsLocale<typeof NS> & PreviewProps) {
  return <ChangedFilesCard changes={changes} cwd={cwd} openReview={openReview} t={t}
    renderPreview={(file, index) => <ChangedFilePreview sessionId={sessionId} seq={changes.seq} index={index}
      display={resolveWorkspacePath(cwd, file.path)}
      useChangesDiff={useChangesDiff} loadChangesDiff={loadChangesDiff} t={t} />} />
}

/**
 * Render one compact file list with operation counts and a four-row fold.
 * @param props - recorded rows, detail opener, preview renderer, and localized labels.
 * @returns the same card for workspace comparisons and recorded tool edits.
 */
export function ChangedFilesCard({ changes, cwd, openReview, renderPreview, openReviewLabel,
  fileReviewLabel, previewLabel, countsLabel, t,
}: ChangedFilesCardProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  const pathDescriptionId = useId()
  const [expanded, setExpanded] = useState(false)
  const foldable = changes.files.length > COLLAPSED_ROWS
  const rows = foldable && !expanded ? changes.files.slice(0, COLLAPSED_ROWS) : changes.files
  return <div ref={cardRef} className={css.card} data-changed-files>
    <button type="button" className={css.header} aria-label={openReviewLabel ?? t('changes.openReview')} disabled={openReview === undefined}
      onClick={() => { openReview?.(0) }}>
      <span className={css.tile}>
        <span className={css.tileMark}><IconCodeBracketsOutline16 size={10} /></span>
      </span>
      <span className={css.titles}>
        <span className={css.title}>{t('changes.title', { count: String(changes.total) })}</span>
        <span className={css.stat}>
          <span className={css.statCounts}>
            {countsLabel !== undefined && <span>{countsLabel}</span>}
            <Counts t={t} added={changes.added} deleted={changes.deleted} />
          </span>
          <span className={css.previewHint}>{previewLabel ?? t('presented.preview')}</span>
        </span>
      </span>
    </button>
    <ul className={css.list}>
      {rows.map((file, index) => (
        <li key={file.display}>
          <HoverCard variant="preview" widthAnchorRef={cardRef} openDelayMs={500}
            content={renderPreview(file, index)}
            anchor={<button type="button" className={css.row}
              aria-label={fileReviewLabel?.(file.display) ?? t('changes.viewDiff', { name: file.display })}
              disabled={openReview === undefined}
              aria-describedby={`${pathDescriptionId}-${index}`}
              onClick={() => { openReview?.(index) }}>
              <span className={css.path}>{file.display}</span>
              <span className={css.counts}>
                {file.binary === true ? t('changes.binary')
                  : file.oversized === true ? t('changes.oversized')
                    : <Counts t={t} added={file.added} deleted={file.deleted} />}
              </span>
            </button>} />
          <span id={`${pathDescriptionId}-${index}`} hidden>{resolveWorkspacePath(cwd, file.path)}</span>
        </li>
      ))}
    </ul>
    {foldable && <button type="button" className={css.toggle}
      aria-expanded={expanded}
      aria-label={t(expanded ? 'changes.collapseAria' : 'changes.expandAria', { count: String(changes.files.length) })}
      onClick={() => { setExpanded(value => !value) }}>
      <span>{t(expanded ? 'changes.collapse' : 'changes.all', { count: String(changes.files.length) })}</span>
      {expanded ? <IconChevronUpOutlineRegular /> : <IconChevronDownOutlineRegular />}
    </button>}
  </div>
}

/** Mounted only while its hover card is open, so passing over a row does not read a comparison. */
function ChangedFilePreview({ sessionId, seq, index, display, useChangesDiff, loadChangesDiff, t }: PreviewProps & {
  seq: number
  index: number
  display: string
} & PropsLocale<typeof NS>) {
  const state = useChangesDiff(value => value[changesDiffUrl(sessionId, seq, index)])
  useEffect(() => {
    if (state === undefined) void loadChangesDiff(sessionId, seq, index)
  }, [state, sessionId, seq, index, loadChangesDiff])
  return <div className={`${diffCss.root} ${css.preview}`} data-changes-hover-preview>
    <div className={diffCss.header}><span className={css.previewPath} data-changes-preview-path>{display}</span></div>
    <FileDiff state={state} split={false} wrap={false} t={t} retry={() => { void loadChangesDiff(sessionId, seq, index) }} />
  </div>
}
