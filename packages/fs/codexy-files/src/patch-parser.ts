/** Parse and apply Codex's Begin Patch text format without filesystem access. */

/** One file operation in a Codex patch. */
export type PatchChange =
  | { kind: 'add'; path: string; content: string }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo?: string; chunks: PatchChunk[] }

/** An ordered replacement with optional named context and end-of-file anchor. */
export interface PatchChunk {
  context?: string
  oldLines: string[]
  newLines: string[]
  endOfFile: boolean
}

/**
 * Parse a complete patch before any file is changed.
 * @param patch - Codex Begin Patch text.
 * @returns ordered file changes.
 */
export function parsePatch(patch: string): PatchChange[] {
  const lines = patch.trim().replaceAll('\r\n', '\n').split('\n')
  if (lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch') {
    throw new Error('Invalid patch: expected *** Begin Patch and *** End Patch')
  }
  const changes: PatchChange[] = []
  let index = 1
  while (index < lines.length - 1) {
    const header = lines[index++] as string
    if (header.startsWith('*** Add File: ')) {
      const path = pathFromHeader(header, '*** Add File: ')
      const content: string[] = []
      while (index < lines.length - 1 && !lines[index]?.startsWith('*** ')) {
        const line = lines[index++] as string
        if (!line.startsWith('+')) throw new Error(`Invalid Add File line: ${line}`)
        content.push(line.slice(1))
      }
      if (content.length === 0) throw new Error(`Invalid Add File: ${path} has no content lines`)
      changes.push({ kind: 'add', path, content: `${content.join('\n')}\n` })
      continue
    }
    if (header.startsWith('*** Delete File: ')) {
      changes.push({ kind: 'delete', path: pathFromHeader(header, '*** Delete File: ') })
      continue
    }
    if (!header.startsWith('*** Update File: ')) throw new Error(`Invalid patch hunk: ${header}`)
    const path = pathFromHeader(header, '*** Update File: ')
    let moveTo: string | undefined
    if (lines[index]?.startsWith('*** Move to: ')) moveTo = pathFromHeader(lines[index++] as string, '*** Move to: ')
    const chunks: PatchChunk[] = []
    let chunk: PatchChunk | undefined
    while (index < lines.length - 1) {
      const line = lines[index] as string
      if (line.startsWith('*** ') && line !== '*** End of File') break
      index++
      if (line === '@@' || line.startsWith('@@ ')) {
        if (chunk) chunks.push(chunk)
        chunk = { ...line === '@@' ? {} : { context: line.slice(3) }, oldLines: [], newLines: [], endOfFile: false }
      } else if (line === '*** End of File') {
        if (!chunk) throw new Error(`Invalid Update File: ${path} has no chunk before End of File`)
        chunk.endOfFile = true
      } else if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+')) {
        chunk ??= { oldLines: [], newLines: [], endOfFile: false }
        if (line[0] !== '+') chunk.oldLines.push(line.slice(1))
        if (line[0] !== '-') chunk.newLines.push(line.slice(1))
      } else {
        throw new Error(`Invalid Update File line: ${line}`)
      }
    }
    if (chunk) chunks.push(chunk)
    if (chunks.length === 0 || chunks.every(chunk => sameLines(chunk.oldLines, chunk.newLines))) {
      throw new Error(`Invalid Update File: ${path} has no changes`)
    }
    changes.push({ kind: 'update', path, ...moveTo ? { moveTo } : {}, chunks })
  }
  if (changes.length === 0) throw new Error('Invalid patch: no file changes')
  return changes
}

function pathFromHeader(header: string, prefix: string): string {
  const path = header.slice(prefix.length).trim()
  if (path.length === 0) throw new Error(`Invalid patch: empty path in ${prefix.trim()}`)
  return path
}

function sameLines(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index])
}

function findLines(lines: readonly string[], needle: readonly string[], from: number, eof: boolean): number {
  const start = eof ? lines.length - needle.length : from
  if (start < from) return -1
  for (const normalize of [(value: string) => value, (value: string) => value.trimEnd(), (value: string) => value.trim()]) {
    for (let index = start; index <= lines.length - needle.length; index++) {
      if (needle.every((line, offset) => normalize(lines[index + offset] as string) === normalize(line))) return index
    }
  }
  return -1
}

/**
 * Apply ordered update chunks to text; failures leave the caller's source unchanged.
 * @param content - original file text.
 * @param chunks - ordered context and replacement chunks.
 * @param path - path included in mismatch diagnostics.
 * @returns updated text with a final newline.
 */
export function applyUpdate(content: string, chunks: readonly PatchChunk[], path: string): string {
  const lines = content.replaceAll('\r\n', '\n').split('\n')
  if (lines.at(-1) === '') lines.pop()
  let cursor = 0
  for (const chunk of chunks) {
    if (chunk.context !== undefined) {
      const contextAt = findLines(lines, [chunk.context], cursor, false)
      if (contextAt < 0) throw new Error(`Failed to find context '${chunk.context}' in ${path}`)
      cursor = contextAt + 1
    }
    const at = findLines(lines, chunk.oldLines, cursor, chunk.endOfFile)
    if (at < 0) {
      throw new Error(`Failed to find expected lines in ${path}:\n${chunk.oldLines.join('\n')}`)
    }
    lines.splice(at, chunk.oldLines.length, ...chunk.newLines)
    cursor = at + chunk.newLines.length
  }
  return `${lines.join('\n')}\n`
}
