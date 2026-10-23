/** Owner-only local memory documents; every replacement retains the complete predecessor. */

import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { lock } from 'proper-lockfile'
import { z } from 'zod'
import type { MemoryEntry, MemoryList, MemoryListRequest, MemoryMatchMode, MemoryRead, MemoryReadRequest, MemorySearch, MemorySearchMatch, MemorySearchRequest } from './service.ts'
import type { Config } from './config.ts'
import { boundedText, revisionOf } from './text.ts'

const publicationSchema = z.object({
  state: z.enum(['publishing', 'committed', 'rolled-back']),
  documents: z.array(z.object({ path: z.string(), previous: z.string().nullable(), next: z.string() }).strict()),
}).strict()
const activeDocumentsSchema = z.object({ documentHashes: z.record(z.string(), z.string()).optional() }).passthrough()

/** Error code of a Node filesystem failure. */
function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

/** Validate a relative memory path with no hidden or traversal components. */
function publicPath(path: string): string {
  if (isAbsolute(path) || path.includes('\\') || path.includes('\0') || path.split('/').some(part => part.startsWith('.'))) {
    throw new Error(`memory path '${path}' must be a relative public path without dot components`)
  }
  return path.replace(/\/$/, '')
}

/** Validate a Codex decimal result cursor. */
function cursorOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0
  if (!/^(0|[1-9][0-9]*)$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) throw new Error('memory cursor must be a non-negative integer')
  return Number(cursor)
}

/** Safe maximum-result selection; invalid model values do not become unbounded reads. */
function pageLimit(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('memory max_results must be a positive integer')
  return Math.min(value, maximum)
}

/** Codex optional separator normalization for substring searches. */
function normalize(value: string, normalized: boolean, sensitive: boolean): string {
  const text = normalized ? value.replace(/[-_./\\]+/g, ' ') : value
  return sensitive ? text : text.toLowerCase()
}

/** Private local store with immutable backups and a process-shared heartbeat writer lock. */
export class MemoryStore {
  /** Public namespace containing editable Markdown artifacts. */
  readonly root: string
  private initialized: Promise<void> | undefined
  private journalCache: { key: string; value: z.infer<typeof publicationSchema> } | undefined

  constructor(private readonly config: Config) {
    this.root = resolve(config.root, config.version === 'v1' ? 'memories' : 'memories_v2')
  }

  /** Initialize only the configured namespace with private permissions.
   * @returns Resolution after the root and internal state directories exist.
   */
  async ready(): Promise<void> {
    this.initialized ??= (async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      if ((await lstat(this.root)).isSymbolicLink()) throw new Error('memory root must not be a symbolic link')
      await this.directory('.state')
      await this.directory('.history')
    })()
    return this.initialized
  }

  /** Reject every symlink component before reading or creating managed paths. */
  private async safePath(path: string): Promise<string> {
    const target = resolve(this.root, path)
    const inside = relative(this.root, target)
    if (inside.startsWith('..' + sep) || inside === '..' || isAbsolute(inside)) throw new Error('memory path escapes its root')
    let current = this.root
    for (const component of inside.split(sep).filter(Boolean)) {
      current = join(current, component)
      let metadata
      try { metadata = await lstat(current) } catch (error) {
        if (errorCode(error) === 'ENOENT') continue
        throw error
      }
      if (metadata.isSymbolicLink()) throw new Error(`memory path '${path}' must not contain symbolic links`)
    }
    return target
  }

  /** Create a managed directory without following a symbolic link. */
  private async directory(path: string): Promise<void> {
    await mkdir(await this.safePath(path), { recursive: true, mode: 0o700 })
    await this.safePath(path)
  }

  /** Read a complete bounded file, returning absence distinctly from an I/O refusal.
   * @param path - Validated public or provider-owned relative path.
   * @returns UTF-8 contents or undefined when absent.
   */
  async text(path: string): Promise<string | undefined> {
    if (!path.startsWith('.') || path === '.state/current.json') {
      const state = await this.publication()
      if (state !== undefined) {
        if (state.state !== 'committed') {
          const document = state.documents.find(document => document.path === path)
          if (document !== undefined && state.state === 'publishing') return document.previous ?? undefined
          if (document !== undefined && document.previous === null && await this.physicalText(path) === document.next) return undefined
        }
      }
    }
    return this.physicalText(path)
  }

  /** Cache a complete immutable journal by inode and nanosecond mutation metadata. */
  private async publication(): Promise<z.infer<typeof publicationSchema> | undefined> {
    await this.ready()
    let metadata
    try { metadata = await stat(await this.safePath('.state/publishing.json'), { bigint: true }) } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined
      throw error
    }
    const key = `${metadata.dev}:${metadata.ino}:${metadata.mtimeNs}:${metadata.ctimeNs}:${metadata.size}`
    if (this.journalCache?.key === key) return this.journalCache.value
    const text = await this.physicalText('.state/publishing.json')
    if (text === undefined) return undefined
    const value = publicationSchema.parse(JSON.parse(text))
    this.journalCache = { key, value }
    return value
  }

  /** Read actual stored bytes; transaction recovery does not observe its read overlay. */
  private async physicalText(path: string): Promise<string | undefined> {
    await this.ready()
    const target = await this.safePath(path)
    let handle
    try { handle = await open(target, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)) } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined
      throw error
    }
    try {
      const metadata = await handle.stat()
      if (!metadata.isFile()) throw new Error(`memory path '${path}' is not a file`)
      if (metadata.size > this.config.maxArtifactBytes * (path.endsWith('publishing.json') || path.endsWith('.tmp') ? 4 : 1)) throw new Error(`memory file '${path}' exceeds maxArtifactBytes`)
      return await handle.readFile('utf8')
    } finally { await handle.close() }
  }

  /** Exclusively create one new managed artifact; never replaces an existing file.
   * @param path - Relative provider-owned or validated public path.
   * @param content - Complete UTF-8 artifact.
   */
  async create(path: string, content: string): Promise<void> {
    await this.ready()
    if (Buffer.byteLength(content) > this.config.maxArtifactBytes * (path.endsWith('publishing.json') || path.endsWith('.tmp') ? 4 : 1)) throw new Error('memory artifact exceeds maxArtifactBytes')
    await this.directory(dirname(path))
    const handle = await open(await this.safePath(path), 'wx', 0o600)
    try { await handle.writeFile(content, 'utf8'); await handle.sync() } finally { await handle.close() }
  }

  /** Preserve predecessor content and atomically replace a managed file.
   * @param path - Relative managed document.
   * @param content - Complete next content.
   * @param expected - Optional observed content revision; null requires absence.
   * @returns New content revision, or a stale-write rejection before publication.
   */
  async replace(path: string, content: string, expected?: ReturnType<typeof revisionOf> | null): Promise<ReturnType<typeof revisionOf>> {
    const previous = await this.physicalText(path)
    if (expected !== undefined && (previous === undefined ? null : revisionOf(previous)) !== expected) {
      throw new Error(`memory document '${path}' changed; reload it before retrying`)
    }
    if (previous === content) return revisionOf(content)
    if (previous !== undefined) {
      await this.create(`.history/${Date.now()}-${randomUUID()}/${path}`, previous)
    }
    const staging = `.state/staging/${randomUUID()}.tmp`
    await this.create(staging, content)
    await this.directory(dirname(path))
    await rename(await this.safePath(staging), await this.safePath(path))
    return revisionOf(content)
  }

  /** Serialize provider mutations across processes using a renewable writer lease.
   * @param operation - One extraction/consolidation or human mutation.
   * @returns The operation result; contention rejects without publishing.
   */
  async writing<T>(operation: () => Promise<T>): Promise<T> {
    await this.ready()
    const path = await this.safePath('.state/write.lock')
    const release = await lock(this.root, { lockfilePath: path, realpath: false, retries: 0, stale: this.config.writerLockStaleMs }).catch(error => {
      if (errorCode(error) === 'ELOCKED') throw new Error('memory refresh or edit is already running in another operation')
      throw error
    })
    try {
      await this.recoverPublication()
      return await operation()
    } finally { await release() }
  }

  /** Restore an incomplete generation while retaining newly staged files and all backups. */
  private async recoverPublication(): Promise<void> {
    const raw = await this.physicalText('.state/publishing.json')
    if (raw === undefined) return
    const journal = publicationSchema.parse(JSON.parse(raw))
    if (journal.state !== 'publishing') return
    for (const document of journal.documents.toReversed()) {
      const current = await this.physicalText(document.path)
      if (current === document.previous || current === undefined && document.previous === null) continue
      if (current !== document.next) { document.previous = current ?? null; continue }
      if (document.previous !== null) await this.replace(document.path, document.previous)
    }
    await this.replace('.state/publishing.json', JSON.stringify({ ...journal, state: 'rolled-back' }))
  }

  /** Publish a validated generation with a rollback journal and committed read overlay.
   * @param documents - Complete managed document set, with the commit metadata last.
   * @param expected - Observed primary documents whose human edits reject stale publication.
   * @returns Resolution after the generation commits; interrupted writes recover without deletion.
   */
  async publish(documents: ReadonlyMap<string, string>, expected?: ReadonlyMap<string, string | undefined>): Promise<void> {
    const journal = { state: 'publishing' as const,
      documents: await Promise.all([...documents].map(async ([path, next]) => ({ path, next, previous: await this.physicalText(path) ?? null }))),
    }
    for (const document of journal.documents) {
      if (expected?.has(document.path) && document.previous !== (expected.get(document.path) ?? null)) {
        throw new Error(`memory document '${document.path}' changed before publication; retained the human edit`)
      }
    }
    await this.replace('.state/publishing.json', JSON.stringify(journal))
    try {
      for (const document of journal.documents) await this.replace(document.path, document.next, document.previous === null ? null : revisionOf(document.previous))
      await this.replace('.state/publishing.json', JSON.stringify({ ...journal, state: 'committed' }))
    } catch (error) {
      await this.recoverPublication()
      throw error
    }
  }

  /** List provider-owned record names without exposing them to model tools.
   * @param path - Internal relative directory.
   * @returns Stable filenames; an absent directory is empty.
   */
  async internalNames(path: string): Promise<readonly string[]> {
    await this.ready()
    try { return (await readdir(await this.safePath(path))).sort() } catch (error) {
      if (errorCode(error) === 'ENOENT') return []
      throw error
    }
  }

  /** Retained inactive generated details stay readable by exact pointer but leave browse/search selection. */
  private async active(path: string): Promise<boolean> {
    if (!path.startsWith('rollout_summaries/') && !path.startsWith('skills/')) return true
    const state = await this.text('.state/current.json')
    if (state === undefined) return true
    const hashes = activeDocumentsSchema.parse(JSON.parse(state)).documentHashes
    if (hashes === undefined) return true
    return Object.keys(hashes).some(name => name === path || name.startsWith(path + '/'))
  }

  /** List safe immediate entries using pinned decimal cursor semantics.
   * @param request - Optional public directory and pagination.
   * @returns A bounded file/directory listing.
   */
  async list(request: MemoryListRequest): Promise<MemoryList> {
    await this.ready()
    const path = publicPath(request.path ?? '')
    const observed = (await readdir(await this.safePath(path), { withFileTypes: true }))
      .filter(entry => !entry.name.startsWith('.') && !entry.isSymbolicLink())
      .map((entry): MemoryEntry => ({ path: [path, entry.name].filter(Boolean).join('/'), entry_type: entry.isDirectory() ? 'directory' : 'file' }))
      .sort((a, b) => a.path.localeCompare(b.path, 'en'))
    const entries: MemoryEntry[] = []
    for (const entry of observed) {
      if (await this.active(entry.path) && (entry.entry_type !== 'file' || await this.text(entry.path) !== undefined)) entries.push(entry)
    }
    const offset = cursorOffset(request.cursor)
    if (offset > entries.length) throw new Error('memory cursor exceeds result count')
    const end = Math.min(entries.length, offset + pageLimit(request.max_results, this.config.maxListResults))
    return { path: request.path ?? null, entries: entries.slice(offset, end), next_cursor: end < entries.length ? String(end) : null, truncated: end < entries.length }
  }

  /** Read a public memory document with one-indexed line selection and complete byte cap.
   * @param request - Relative file and optional slice.
   * @returns Bounded contents and full-document revision.
   */
  async read(request: MemoryReadRequest): Promise<MemoryRead> {
    const path = publicPath(request.path)
    const text = await this.text(path)
    if (text === undefined) throw new Error(`memory path '${path}' was not found`)
    const offset = request.line_offset ?? 1
    if (!Number.isSafeInteger(offset) || offset < 1) throw new Error('line_offset must be a 1-indexed line number')
    if (request.max_lines !== undefined && (!Number.isSafeInteger(request.max_lines) || request.max_lines < 1)) throw new Error('max_lines must be a positive integer')
    const lines = text.split('\n')
    if (offset > lines.length) throw new Error('line_offset exceeds file length')
    const selected = lines.slice(offset - 1, request.max_lines === undefined ? undefined : offset - 1 + request.max_lines)
    const bounded = boundedText(selected.join('\n'), this.config.readTokens * 4)
    return { path, start_line_number: offset, content: bounded.text, truncated: bounded.truncated || offset - 1 + selected.length < lines.length, revision: revisionOf(text) }
  }

  /** Collect public files without following symlinks or scanning unbounded trees. */
  private async files(path: string): Promise<string[]> {
    const target = await this.safePath(path)
    if ((await lstat(target)).isFile()) return [path]
    const files: string[] = []
    const pending = [path]
    let visited = 0
    while (pending.length > 0) {
      const directory = pending.pop()!
      const entries = await readdir(await this.safePath(directory), { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
        if (++visited > this.config.maxSearchFiles) throw new Error('memory search exceeds maxSearchFiles; choose a narrower path')
        const child = [directory, entry.name].filter(Boolean).join('/')
        if (entry.isDirectory()) pending.push(child)
        else if (entry.isFile()) files.push(child)
      }
    }
    return files.sort()
  }

  /** Search bounded public documents with the pinned matching modes.
   * @param request - Substrings, normalization, line window, and pagination.
   * @returns Stable line-numbered matches with context.
   */
  async search(request: MemorySearchRequest): Promise<MemorySearch> {
    await this.ready()
    const queries = request.queries.map(value => value.trim())
    if (queries.length === 0 || queries.some(value => value === '')) throw new Error('queries must not be empty or contain empty strings')
    const mode: MemoryMatchMode = request.match_mode ?? { type: 'any' }
    if (mode.type === 'all_within_lines' && (!Number.isSafeInteger(mode.line_count) || mode.line_count < 1)) throw new Error('all_within_lines.line_count must be a positive integer')
    const context = request.context_lines ?? 0
    if (!Number.isSafeInteger(context) || context < 0) throw new Error('context_lines must be a non-negative integer')
    const sensitive = request.case_sensitive ?? true
    const normalized = request.normalized ?? false
    const wanted = queries.map(query => normalize(query, normalized, sensitive))
    const matches: MemorySearchMatch[] = []
    const path = publicPath(request.path ?? '')
    const start = cursorOffset(request.cursor)
    const limit = pageLimit(request.max_results, this.config.maxSearchResults)
    let hitCount = 0
    let outputBytes = 0
    const byteBudget = this.config.readTokens * 4
    for (const file of await this.files(path)) {
      if (!await this.active(file)) continue
      const text = await this.text(file)
      if (text === undefined) continue
      const lines = text.split('\n')
      const searchable = lines.map(line => normalize(line, normalized, sensitive))
      for (let index = 0; index < lines.length; index++) {
        const window = mode.type === 'all_within_lines' ? searchable.slice(index, index + mode.line_count).join('\n') : searchable[index]!
        const matched = wanted.map((query, queryIndex) => window.includes(query) ? queries[queryIndex] : undefined).filter((query): query is string => query !== undefined)
        if (matched.length === 0 || mode.type !== 'any' && matched.length !== queries.length) continue
        if (hitCount++ < start) continue
        if (matches.length === limit) return { queries, match_mode: mode, path: request.path ?? null, matches, next_cursor: String(hitCount - 1), truncated: true }
        const begin = Math.max(0, index - context)
        const end = Math.min(lines.length, index + (mode.type === 'all_within_lines' ? mode.line_count : 1) + context)
        const bounded = boundedText(lines.slice(begin, end).join('\n'), Math.max(0, byteBudget - outputBytes))
        if (bounded.text === '' && outputBytes > 0) return { queries, match_mode: mode, path: request.path ?? null, matches, next_cursor: String(hitCount - 1), truncated: true }
        let match: MemorySearchMatch = { path: file, match_line_number: index + 1, content_start_line_number: begin + 1, content: bounded.text, matched_queries: matched }
        const framedBytes = Buffer.byteLength(JSON.stringify(match))
        if (outputBytes + framedBytes > byteBudget) {
          match = { ...match, content: boundedText(match.content, Math.max(0, byteBudget - outputBytes - (framedBytes - Buffer.byteLength(match.content)))).text }
          if (Buffer.byteLength(JSON.stringify(match)) + outputBytes > byteBudget) throw new Error('memory search output budget is too small for result metadata')
        }
        outputBytes += Buffer.byteLength(JSON.stringify(match))
        matches.push(match)
        if (bounded.truncated || match.content !== bounded.text) return { queries, match_mode: mode, path: request.path ?? null, matches, next_cursor: String(hitCount), truncated: true }
      }
    }
    if (start > hitCount) throw new Error('memory cursor exceeds result count')
    return { queries, match_mode: mode, path: request.path ?? null, matches, next_cursor: null, truncated: false }
  }
}
