import { useCallback, useMemo, useState } from 'react'
import clsx from 'clsx'
import { structuredPatch } from 'diff'
import { FoldToggle } from './FoldToggle.tsx'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { CodeToolbar, type CodeToolbarLabels } from './CodeToolbar.tsx'
import { languageForPath } from '@deepseek-ai/dsh-client-ui-primitives'
import cardCss from './CodeCard.module.css'
import css from './DiffBlock.module.css'

/** Output lines shown before the height cap collapses the middle. */
export const DEFAULT_DIFF_MAX_LINES = 16

/**
 * One file change in the form {@link DiffBlock} renders. It is declared here
 * so this primitive stays independent of the tool contract.
 */
export interface DiffHunk {
  /** The changed file's path, drawn verbatim as the hunk's header (the tool's model-facing path). */
  path: string
  /** Prior content including context, or `null` when no prior content is available. */
  oldText: string | null
  /** Content after the change, including any shared context. */
  newText: string
}

export interface DiffBlockProps {
  /** One entry per applied hunk, in file order; empty renders nothing. */
  diffs: DiffHunk[]
  /** Localized chrome supplied by the owning render site. */
  labels: DiffBlockLabels
  /** Height cap in body lines before the middle collapses (default {@link DEFAULT_DIFF_MAX_LINES}). */
  maxLines?: number | undefined
  /** Extra class merged onto the wrapper (callers position; this component draws). */
  className?: string | undefined
  /** Inline transcript excerpts omit the card chrome; full cards retain copy and wrapping controls. */
  variant?: 'card' | 'inline' | undefined
  /** Show copy and wrapping controls below an inline diff. Cards always show their toolbar. */
  controls?: boolean | undefined
  /** Show only changed lines, with their old/new source line numbers. */
  changesOnly?: boolean | undefined
  /** Suppress a single file heading when the parent row already names it. */
  hideSinglePath?: boolean | undefined
  /** Navigate to full details instead of nesting another disclosure. */
  onOpenDetails?: (() => void) | undefined
}

/** Localized chrome for {@link DiffBlock}. */
export interface DiffBlockLabels extends CodeToolbarLabels {
  copy: string
  copied: string
  collapseAria: string
  expandAria: (hidden: number) => string
  collapse: string
  expand: (hidden: number) => string
}

/** A single rendered body line and its role, so the height cap slices a flat list. */
interface DiffRow {
  kind: 'path' | 'del' | 'add' | 'context' | 'gap'
  text: string
  oldLine?: number | undefined
  newLine?: number | undefined
}

/** Local exhaustiveness helper — this package does not depend on `dsh-llm`. */
/* v8 ignore next 3 -- closed-union backstop; only reached if a row kind is forged */
function assertNever(value: never): never {
  throw new Error(`unreachable diff row kind: ${String(value)}`)
}

/** The dim class per row kind (path/gap chrome vs the diff's own +/- colors). */
const ROW_CLASS: Record<DiffRow['kind'], string | undefined> = {
  path: css.path,
  del: css.del,
  add: css.add,
  context: css.context,
  gap: css.gap,
}

/** Bound synchronous edit-graph search; one replacement consumes two edits. */
const MAX_DIFF_EDIT_LENGTH = 256

/** Derive exact local patches or a whole-fragment replacement when search exceeds the limit. */
function localHunks(diff: DiffHunk, context = 3) {
  const oldLines = contentLines(diff.oldText ?? '')
  const newLines = contentLines(diff.newText)
  const normalize = (lines: string[]): string => lines.map(line => `${line}\n`).join('')
  return structuredPatch('', '', normalize(oldLines), normalize(newLines),
    undefined, undefined, { context, maxEditLength: MAX_DIFF_EDIT_LENGTH })?.hunks
    ?? [{ oldStart: 1, newStart: 1, lines: [...oldLines.map(line => `-${line}`), ...newLines.map(line => `+${line}`)] }]
}

/**
 * Count displayed additions and deletions. Exact patches exclude shared context;
 * comparisons exceeding the edit limit count both complete fragments as replaced.
 * Text follows {@link contentLines}'s terminator rule.
 * @param diffs - the hunks to count.
 * @returns the +/- totals for tool summaries.
 */
export function diffTotals(diffs: DiffHunk[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const diff of diffs) {
    for (const hunk of localHunks(diff)) {
      for (const line of hunk.lines) {
        if (line.startsWith('+')) added++
        if (line.startsWith('-')) removed++
      }
    }
  }
  return { added, removed }
}

/**
 * Flatten local patches into rows.
 * A path header opens each new file. A `⋯` gap separates consecutive same-file
 * fragments and distant patches within a fragment.
 * @param diffs - the hunks to render.
 * @returns the body rows.
 */
function buildRows(diffs: DiffHunk[], changesOnly: boolean, hideSinglePath: boolean): DiffRow[] {
  const rows: DiffRow[] = []
  let prevPath: string | undefined
  for (const diff of diffs) {
    if (diff.path !== prevPath) {
      if (!hideSinglePath || diffs.some(item => item.path !== diff.path)) rows.push({ kind: 'path', text: diff.path })
    }
    else rows.push({ kind: 'gap', text: '⋯' })
    prevPath = diff.path
    for (const [index, hunk] of localHunks(diff, changesOnly ? 0 : 3).entries()) {
      if (index > 0) rows.push({ kind: 'gap', text: '⋯' })
      let oldLine = hunk.oldStart
      let newLine = hunk.newStart
      for (const line of hunk.lines) {
        const kind = line.startsWith('-') ? 'del' : line.startsWith('+') ? 'add' : 'context'
        rows.push({ kind, text: line.slice(1), oldLine: kind === 'add' ? undefined : oldLine, newLine: kind === 'del' ? undefined : newLine })
        if (kind !== 'add') oldLine++
        if (kind !== 'del') newLine++
      }
    }
  }
  return rows
}

/**
 * Split a side's text into its content lines. Empty text is zero lines (a full
 * deletion's `newText` or a create's absent `oldText` side draws nothing), and a
 * single trailing newline is a line terminator rather than an extra empty line —
 * the same terminator rule TerminalBlock applies to command output. An interior
 * blank line (a genuine `\n\n`) survives.
 * @param text - the removed or added side's text.
 * @returns the content lines, without the terminating newline.
 */
function contentLines(text: string): string[] {
  if (text === '') return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n')
}

/**
 * Copy the full local diff, including folded rows: removed/added lines have
 * `- `/`+ ` prefixes, context has two spaces, and paths and gaps stay verbatim.
 * @param rows - the flattened body rows.
 * @returns the diff as plain text.
 */
function copyText(rows: DiffRow[]): string {
  return rows.map((row) => {
    switch (row.kind) {
      case 'del': return `- ${row.text}`
      case 'add': return `+ ${row.text}`
      case 'context': return `  ${row.text}`
      case 'path': return row.text
      case 'gap': return row.text
      /* v8 ignore next -- closed-union backstop; only reached if a row kind is forged */
      default: return assertNever(row.kind)
    }
  }).join('\n')
}

/**
 * Render a file mutation as an inline diff surface.
 * @param props - see {@link DiffBlockProps}.
 * @returns the diff block element.
 */
export function DiffBlock({ diffs, labels, maxLines = DEFAULT_DIFF_MAX_LINES, className, variant = 'card', controls = false, changesOnly = false, hideSinglePath = false, onOpenDetails }: DiffBlockProps) {
  const rows = useMemo(() => buildRows(diffs, changesOnly, hideSinglePath), [diffs, changesOnly, hideSinglePath])
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const [wrapped, setWrapped] = useState(changesOnly)
  const firstLanguage = diffs[0] === undefined ? undefined : languageForPath(diffs[0].path)
  const language = diffs.every(diff => languageForPath(diff.path) === firstLanguage) ? firstLanguage : undefined

  const onCopy = useCallback(() => {
    if (copied) return
    void writeClipboard(copyText(rows)).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 1000)
    })
  }, [copied, rows])

  const onToggle = useCallback(() => { setExpanded(value => !value) }, [])

  if (rows.length === 0) return null

  const hidden = rows.length - maxLines
  const capped = hidden > 0 && !expanded
  // Same split arithmetic as TerminalBlock and the TUI transcript's collapsed
  // card, so a body's head and tail slices agree across the front ends.
  const headLines = Math.ceil(maxLines / 2)
  const tailLines = maxLines - headLines
  const head = capped ? rows.slice(0, headLines) : rows
  const tail = capped ? rows.slice(rows.length - tailLines) : []

  return (
    <div className={clsx(variant === 'card' && cardCss.card, css.block, className)} data-diff="" data-variant={variant} data-code-wrap={wrapped} data-changes-only={changesOnly || undefined}>
      {variant === 'card' && <CodeToolbar lang={language} labels={labels} copyLabel={labels.copy} copiedLabel={labels.copied}
        copied={copied} wrapped={wrapped} onCopy={onCopy} onWrap={() => { setWrapped(value => !value) }} />}
      <div className={css.body}>
        {head.map((row, index) => (
          <div key={index} className={clsx(css.line, ROW_CLASS[row.kind])}>
            {changesOnly && row.kind !== 'path' && row.kind !== 'gap' && <>
              <span className={css.lineNumber} data-old-line={row.oldLine}>{row.oldLine ?? ''}</span>
              <span className={css.lineNumber} data-new-line={row.newLine}>{row.newLine ?? ''}</span>
              <span className={css.sign} aria-hidden>{row.kind === 'add' ? '+' : '−'}</span>
            </>}
            <span className={css.lineText}>{row.text}</span>
          </div>
        ))}
        {hidden > 0 && (onOpenDetails === undefined
          ? <FoldToggle className={css.expand} expanded={expanded} hidden={hidden} labels={labels} onToggle={onToggle} />
          : <button type="button" className={css.expand} onClick={onOpenDetails} aria-label={labels.expandAria(hidden)}>
            {labels.expand(hidden)}
          </button>)}
        {tail.map((row, index) => (
          <div key={index} className={clsx(css.line, ROW_CLASS[row.kind])}>
            {changesOnly && row.kind !== 'path' && row.kind !== 'gap' && <>
              <span className={css.lineNumber} data-old-line={row.oldLine}>{row.oldLine ?? ''}</span>
              <span className={css.lineNumber} data-new-line={row.newLine}>{row.newLine ?? ''}</span>
              <span className={css.sign} aria-hidden>{row.kind === 'add' ? '+' : '−'}</span>
            </>}
            <span className={css.lineText}>{row.text}</span>
          </div>
        ))}
      </div>
      {variant === 'inline' && controls && <CodeToolbar showLanguage={false} labels={labels} copyLabel={labels.copy} copiedLabel={labels.copied}
        copied={copied} wrapped={wrapped} onCopy={onCopy} onWrap={() => { setWrapped(value => !value) }} />}
    </div>
  )
}
