/** Complete file changes from recorded tool results, independent of the workspace's current files. */
import { DiffBlock, type DiffHunk } from '@codexydsh/ui-primitives'
import type { TrajectoryCellProps } from './trajectory-record.ts'
import type { TrajectoryTranslate } from './locales.ts'
import css from './TrajectoryTable.module.css'

/**
 * Read applied file contents from durable tool metadata.
 * @param cell - Recorded tool result, including failure state.
 * @returns Validated file changes, or undefined when the raw result must be shown.
 */
export function recordedDiffs(cell: TrajectoryCellProps): DiffHunk[] | undefined {
  if (cell.isError || cell.resultMeta === null || typeof cell.resultMeta !== 'object') return undefined
  const diffs: unknown = 'diffs' in cell.resultMeta ? cell.resultMeta.diffs : undefined
  if (!Array.isArray(diffs) || diffs.length === 0) return undefined
  const result: DiffHunk[] = []
  for (const value of diffs) {
    if (value === null || typeof value !== 'object') return undefined
    const item = value as Record<string, unknown>
    if (typeof item.path !== 'string' || typeof item.newText !== 'string'
      || item.oldText !== null && typeof item.oldText !== 'string') return undefined
    result.push({ path: item.path, oldText: item.oldText, newText: item.newText })
  }
  return result
}

/**
 * Render every changed line in the inspector's single scroll area.
 * @param props - Recorded file changes and inspector locale.
 * @returns Full diff with copy and wrapping controls.
 */
export function PatchPreview({ diffs, t }: { diffs: DiffHunk[]; t: TrajectoryTranslate }) {
  return <section className={css.patchPreview} data-patch-preview>
    <DiffBlock diffs={diffs} variant="inline" changesOnly controls maxLines={Infinity} labels={{
      codeLabel: t('tab.diff'), copy: t('patch.copy'), copied: t('copied'),
      wrapLabel: t('record.wrapLines'), unwrapLabel: t('record.noWrap'),
      expand: count => t('patch.more', { count }), expandAria: count => t('patch.more', { count }),
      collapse: t('patch.collapse'), collapseAria: t('patch.collapse'),
    }} />
  </section>
}
