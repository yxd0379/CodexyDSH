/** Conservative presentation classification of common POSIX inspection pipelines. */
import type { CodexExplorationEntry } from './codex-shell-model.ts'

/** Split literal shell words and connectors; executable substitutions remain ordinary runs. */
function commands(source: string): string[][] | null {
  const result: string[][] = []
  let words: string[] = []
  let word = ''
  let quote = ''
  let started = false
  const flush = () => { if (started) words.push(word); word = ''; started = false }
  for (let i = 0; i < source.length; i++) {
    const c = source[i] ?? ''
    if (c === '\\' && quote !== "'") {
      const next = source[++i]
      if (next === undefined) return null
      if (next !== '\n') { word += next; started = true }
      continue
    }
    if (quote) {
      if (c === quote) quote = ''
      else { if (quote === '"' && (c === '`' || c === '$' && source[i + 1] === '(')) return null; word += c }
      continue
    }
    if (c === "'" || c === '"') { quote = c; started = true; continue }
    if (c === '>' && (!started || word === '2')) {
      const redirect = /^>\s*(?:\/dev\/null(?=\s|$|[;&|])|&1(?=\s|$|[;&|]))/.exec(source.slice(i))
      if (redirect !== null) { word = ''; started = false; i += redirect[0].length - 1; continue }
    }
    if (c === '`' || c === '$' && source[i + 1] === '(' || c === '<' || c === '>' || c === '(' || c === ')') return null
    if (c === '#' && !started) { while (i < source.length && source[i] !== '\n') i++ }
    else if (c === '|' || c === '&' || c === ';' || c === '\n') {
      if (c === '&' && source[i + 1] !== '&') return null
      if (source[i + 1] === c && (c === '|' || c === '&')) i++
    } else if (/\s/.test(c)) { flush(); continue }
    else { word += c; started = true; continue }
    flush()
    if (words.length > 0) result.push(words)
    words = []
  }
  if (quote) return null
  flush()
  if (words.length > 0) result.push(words)
  return result
}

function operands(args: string[], valued: ReadonlySet<string>): string[] {
  const values: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''
    if (arg === '--') { values.push(...args.slice(i + 1)); break }
    if (valued.has(arg)) { i++; continue }
    if (!arg.startsWith('-')) values.push(arg)
  }
  return values
}

/**
 * Recognize browsing commands, including directory changes, assignments and read-only pipelines.
 * Unknown commands, executable substitutions and output redirections retain the Run presentation.
 * @param source - Recorded command, never executed by this classifier.
 * @returns Ordered inspection actions, or an empty list for an ordinary command.
 */
export function shellExploration(source: string): readonly CodexExplorationEntry[] {
  const groups = commands(source)
  if (groups === null) return []
  const entries: CodexExplorationEntry[] = []
  for (const original of groups) {
    const words = [...original]
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words.at(0) ?? '')) words.shift()
    if (words[0] === 'env') {
      words.shift()
      while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words.at(0) ?? '')) words.shift()
    }
    const name = words.shift()?.split('/').at(-1)
    if (name === 'cd' && words.length === 1 || name === 'pwd' || name === 'true'
      || name === 'echo' || name === 'printf') continue
    if (name === 'ls' || name === 'find' || name === 'tree' || name === 'rg' && words.includes('--files')) {
      if (name === 'find' && words.some(arg => /^-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(arg))) return []
      if (name === 'tree' && words.includes('-o')) return []
      const paths = operands(words, new Set(['-g', '--glob', '-t', '--type', '-L', '--max-depth']))
      entries.push({ kind: 'list', detail: paths.join(' ') || '.' })
    } else if (name === 'rg' || name === 'grep') {
      if (words.some(arg => /^--pre(?:=|$)/.test(arg))) return []
      const values = operands(words, new Set(['-g', '--glob', '-t', '--type', '-T', '--type-not', '-A', '-B', '-C', '-m', '--max-count', '--max-depth', '--encoding']))
      entries.push({ kind: 'search', detail: values.length > 1 ? `${values[0]} · ${values.slice(1).join(' ')}` : values[0] ?? '.' })
    } else if (name === 'cat' || name === 'head' || name === 'tail' || name === 'sed' || name === 'nl') {
      let files: string[]
      if (name === 'sed') {
        // Only a literal numeric print range is recognized; sed can execute or write files.
        if (words[0] !== '-n' || !/^\d+(?:,\d+|,\$)?p$/.test(words[1] ?? '')) return []
        files = words.slice(2)
      } else files = operands(words, new Set(['-n', '-c', '--lines', '--bytes', '-s', '-w', '-v']))
      if (files.length > 0) entries.push({ kind: 'read', detail: files.join(' ') })
      else if (entries.length === 0) return []
    } else if (name === 'wc' || name === 'sort' || name === 'uniq' || name === 'cut') {
      if (entries.length === 0 || words.some(arg => arg === '-o' || arg.startsWith('--output') || name === 'sort' && /^-o./.test(arg))) return []
    } else return []
  }
  return entries
}
