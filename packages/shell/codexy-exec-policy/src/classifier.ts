/** Codex-compatible POSIX forced-`rm` detection over Bash syntax. */

import { createRequire } from 'node:module'
import { Language, Parser, type Node } from 'web-tree-sitter'

/** The pinned Codex classifier treats excessive literal wrappers as dangerous. */
export type DangerousCommandMatch = 'forced-rm' | 'other'

const MAX_WRAPPER_DEPTH = 8
const require = createRequire(import.meta.url)
let languagePromise: Promise<Language> | undefined

/**
 * Load the published Bash grammar as WASM; neither native parser install script is needed.
 * @returns the Bash grammar shared by synchronous parses after initialization.
 */
export function loadBashLanguage(): Promise<Language> {
  languagePromise ??= Parser.init().then(() => Language.load(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm')))
  return languagePromise
}

function namedChildren(node: Node): Node[] {
  return node.namedChildren.filter((child): child is Node => child !== null)
}

function literalWord(node: Node): string | undefined {
  switch (node.type) {
    case 'word':
    case 'number': {
      const value = node.text
      return namedChildren(node).length === 0 && !value.startsWith('=')
        && !/[{}*?\[\]\\~^#$`]/u.test(value) ? value : undefined
    }
    case 'raw_string': {
      const value = node.text
      return value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1) : undefined
    }
    case 'string': {
      const value = node.text
      return value.startsWith('"') && value.endsWith('"')
        && namedChildren(node).every(child => child.type === 'string_content')
        && !/\\[$`"\\\n]/u.test(value.slice(1, -1)) ? value.slice(1, -1) : undefined
    }
    case 'concatenation': {
      const parts = namedChildren(node).map(literalWord)
      if (parts.length === 0 || !parts.every((part): part is string => part !== undefined)) return undefined
      const value = parts.join('')
      return value.length > 0 ? value : undefined
    }
    default:
      return undefined
  }
}

function literalCommand(node: Node): string[] | undefined {
  const words: string[] = []
  let foundName = false
  for (const child of namedChildren(node)) {
    if (child.type === 'command_name') {
      const name = child.firstNamedChild
      const literal = name === null ? undefined : literalWord(name)
      if (literal === undefined) return undefined
      words.push(literal)
      foundName = true
    } else if (foundName) {
      const literal = literalWord(child)
      if (literal !== undefined) words.push(literal)
    }
  }
  return foundName ? words : undefined
}

function executableName(raw: string): string | undefined {
  const name = raw.split('/').at(-1)
  return name === '' ? undefined : name
}

function shellScript(argv: readonly string[]): string | undefined {
  const [command, option, source] = argv
  if (argv.length !== 3 || command === undefined || source === undefined || option !== '-c' && option !== '-lc') return undefined
  const executable = executableName(command)
  const stem = executable?.replace(/\.[^.]+$/u, '')
  return stem === 'bash' || stem === 'sh' || stem === 'zsh' ? source : undefined
}

function forcedRm(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === '--') return false
    if (arg === '--force' || arg.startsWith('-') && !arg.startsWith('--') && arg.slice(1).includes('f')) return true
  }
  return false
}

function literalCommands(script: string, language: Language): string[][] | undefined {
  const parser = new Parser()
  parser.setLanguage(language)
  try {
    const tree = parser.parse(script)
    if (tree === null) return undefined
    try {
      if (tree.rootNode.hasError) return undefined
      const commands: string[][] = []
      const stack = [tree.rootNode]
      while (stack.length > 0) {
        const node = stack.pop()
        if (node === undefined) break
        if (node.type === 'command') {
          const command = literalCommand(node)
          if (command !== undefined) commands.push(command)
        }
        stack.push(...namedChildren(node))
      }
      return commands
    } finally {
      tree.delete()
    }
  } finally {
    parser.delete()
  }
}

function classify(argv: readonly string[], language: Language, depth: number): DangerousCommandMatch | undefined {
  if (depth > MAX_WRAPPER_DEPTH) return 'other'
  const command = executableName(argv[0] ?? '')
  switch (command) {
    case 'rm':
      if (forcedRm(argv.slice(1))) return 'forced-rm'
      break
    case 'sudo':
      return classify(argv.slice(1), language, depth + 1)
    case 'env': {
      let index = 1
      while (index < argv.length) {
        const argument = argv[index]
        if (argument === undefined) break
        if (argument === '--') { index += 1; break }
        if (argument === '-i' || argument === '--ignore-environment'
          || argument.indexOf('=') > 0 && !argument.startsWith('-')) { index += 1; continue }
        break
      }
      return classify(argv.slice(index), language, depth + 1)
    }
    case 'trap': {
      const index = argv[1] === '--' ? 2 : 1
      const action = argv[index]
      if (action !== undefined && !action.startsWith('-')) {
        return classify(['sh', '-c', action], language, depth + 1)
      }
      break
    }
    default:
      break
  }
  const script = shellScript(argv)
  if (script === undefined) return undefined
  for (const literal of literalCommands(script, language) ?? []) {
    const match = classify(literal, language, depth + 1)
    if (match !== undefined) return match
  }
  return undefined
}

/**
 * Classify an already-tokenized POSIX command as pinned Codex does for forced `rm`.
 * @param argv - shell executable, `-c`/`-lc`, and source, or another direct executable argv.
 * @returns `forced-rm`, depth-limit `other`, or no static dangerous match.
 */
export async function classifyPosixDangerousCommand(argv: readonly string[]): Promise<DangerousCommandMatch | undefined> {
  return classify(argv, await loadBashLanguage(), 0)
}
