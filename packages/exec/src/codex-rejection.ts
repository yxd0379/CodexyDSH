/** Pinned Codex 0.162.1 review-denial text; never executes or rewrites argv. */
const REJECTION_PREVIEW_BYTES = 900
const DEBUG_ESCAPES = new Map([['\0', '\\0'], ['\t', '\\t'], ['\n', '\\n'], ['\r', '\\r'], ['"', '\\"'], ['\\', '\\\\']])

/** shlex 1.3.0 try_join display rules used by Codex's exec policy. */
function quotedWord(word: string): string {
  if (word === '') return "''"
  const characters = Array.from(word)
  let result = '', start = 0
  while (start < characters.length) {
    let strategies = 7, end = start
    if (characters[start] === '^') { strategies = 2; end++ }
    for (; end < characters.length; end++) {
      const character = characters[end]!
      let allowed = strategies
      if (!/^[+\-./:@\]_0-9A-Za-z]$/u.test(character)) allowed &= ~1
      if (character === "'" || character === '^' || character === '\\') allowed &= ~2
      if (character === '`' || character === '$' || character === '!' || character === '^') allowed &= ~4
      if (allowed === 0) break
      strategies = allowed
    }
    const chunk = characters.slice(start, end).join('')
    result += (strategies & 1) !== 0 ? chunk
      : (strategies & 2) !== 0 ? `'${chunk}'` : `"${chunk.replace(/["\\]/gu, '\\$&')}"`
    start = end
  }
  return result
}

/** Rust Debug string escaping, including its ASCII control spellings. */
function debugString(value: string): string {
  let result = '"'
  for (const character of value) {
    const escaped = DEBUG_ESCAPES.get(character)
    if (escaped !== undefined) result += escaped
    else if (/\p{C}|\p{Zl}|\p{Zp}|\p{Grapheme_Extend}/u.test(character) || character !== ' ' && /\p{Zs}/u.test(character)) result += `\\u{${character.codePointAt(0)!.toString(16)}}`
    else result += character
  }
  return result + '"'
}

/** Native middle preview counts removed Unicode scalars and cuts at UTF-8 boundaries. */
function rejectionPreview(value: string): string {
  const bytes = Buffer.byteLength(value)
  if (bytes <= REJECTION_PREVIEW_BYTES) return value
  const leftBudget = Math.floor(REJECTION_PREVIEW_BYTES / 2), rightStart = bytes - (REJECTION_PREVIEW_BYTES - leftBudget)
  let position = 0, removed = 0, left = '', right = ''
  for (const character of value) {
    const end = position + Buffer.byteLength(character)
    if (end <= leftBudget) left += character
    else if (position >= rightStart) right += character
    else removed++
    position = end
  }
  return `${left}…${removed} chars truncated…${right}`
}

/**
 * Match exec_policy::derive_forbidden_reason and ExecCommandHandler's Debug error
 * preview in openai/codex rust-v0.162.1; policy decisions remain owned by callers.
 */
export function formatCodexExecReviewDenied(argv: readonly string[], reason: string): string {
  const command = argv.some(word => word.includes('\0')) ? argv.join(' ') : argv.map(quotedWord).join(' ')
  const rejected = `Rejected(${debugString(`\`${command}\` rejected: ${reason}`)})`
  return rejectionPreview(`exec_command failed: CreateProcess { message: ${debugString(rejected)} }`)
}
