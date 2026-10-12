/** Best-effort shell artifact classification and exact memory citation attribution. */

import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Classify simple read/search commands without treating arbitrary shell text as a read.
 * @param command - The successfully executed shell command.
 * @param root - Exact local memory namespace.
 * @param cwd - Resolved command working directory.
 * @returns Public relative paths explicitly read or searched; ambiguous scripts return none.
 */
export function memoryPathsFromCommand(command: string, root: string, cwd: string): readonly string[] {
  if (/[`$]|[<>]|\|/.test(command)) return []
  const paths = new Set<string>()
  for (const part of command.split(/&&|;/)) {
    const words = part.trim().match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g) ?? []
    const executable = words[0]?.replace(/^.*\//, '')
    if (executable === undefined || !['cat', 'head', 'tail', 'sed', 'rg', 'grep'].includes(executable)) return []
    for (const raw of words.slice(1)) {
      const word = raw.replace(/^(['"])(.*)\1$/, '$2')
      if (word.startsWith('-')) continue
      const path = relative(root, resolve(cwd, word))
      if (isAbsolute(path) || path === '..' || path.startsWith('..' + sep)) continue
      const normalized = path.split(sep).join('/')
      if (normalized === 'MEMORY.md' || normalized === 'memory_summary.md' || normalized === 'raw_memories.md'
        || normalized.startsWith('rollout_summaries/') || normalized.startsWith('skills/')) paths.add(normalized)
    }
  }
  return [...paths]
}

/** Parse only complete final-answer memory citation blocks.
 * @param text - Completed assistant answer, excluding private reasoning.
 * @returns Explicit relative cited files and exact source thread identifiers.
 */
export function memoryCitation(text: string): { paths: readonly string[]; sessionIds: readonly string[] } {
  const paths = new Set<string>()
  const sessionIds = new Set<string>()
  for (const block of text.matchAll(/<oai-mem-citation>([\s\S]*?)<\/oai-mem-citation>/g)) {
    const content = block[1]!
    const entries = content.match(/<citation_entries>([\s\S]*?)<\/citation_entries>/)?.[1]
    for (const line of entries?.split('\n') ?? []) {
      const entry = line.trim().match(/^([^:]+):([0-9]+)-([0-9]+)\|note=\[[^\r\n]*\]$/)
      if (entry !== null && Number(entry[2]) > 0 && Number(entry[3]) >= Number(entry[2])
        && !entry[1]!.split('/').some(part => part.startsWith('.'))) paths.add(entry[1]!)
    }
    const ids = content.match(/<(?:rollout_ids|thread_ids)>([\s\S]*?)<\/(?:rollout_ids|thread_ids)>/)?.[1]
    for (const id of ids?.split('\n').map(value => value.trim()).filter(Boolean) ?? []) sessionIds.add(id)
  }
  return { paths: [...paths], sessionIds: [...sessionIds] }
}
