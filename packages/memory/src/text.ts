/** Pinned memory redaction and UTF-8-aware bounded text utilities. */

import { createHash } from 'node:crypto'
import { MemoryRevision } from './service.ts'
import type { MemoryRevision as Revision } from './service.ts'

/** Content identity shared by immutable revisions and human edit guards.
 * @param value - Exact text being identified.
 * @returns SHA-256 content revision.
 */
export function revisionOf(value: string): Revision {
  return MemoryRevision(createHash('sha256').update(value).digest('hex'))
}

/** Pinned Codex best-effort secret sanitizer, plus access-bearing URL query values.
 * @param text - Untrusted evidence or generated memory.
 * @returns Text with recognized credentials redacted.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\bBearer[ \t]+[A-Za-z0-9._~+/-]{16,}=*/gi, 'Bearer [REDACTED_SECRET]')
    .replace(/sk-[A-Za-z0-9]{20,}/g, '[REDACTED_SECRET]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_SECRET]')
    .replace(/\b(api[_-]?key|token|secret|password)\b(\s*[:=]\s*)(["']?)[^\s"']{8,}/gi, '$1$2$3[REDACTED_SECRET]')
    .replace(/([?&](?:access_token|api_key|token|key|signature|sig)=)[^&#\s]+/gi, '$1[REDACTED_SECRET]')
}

/** Preserve the largest complete UTF-8 prefix fitting a byte budget.
 * @param text - Text to bound without splitting a code point.
 * @param maxBytes - Non-negative complete byte budget.
 * @returns Retained prefix and omission flag.
 */
export function boundedText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false }
  const bytes = Buffer.from(text)
  let end = Math.min(bytes.length, Math.max(0, maxBytes))
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true }
}

/** Token-heuristic head/tail retention using Codex's four-byte approximation.
 * @param text - Exact input text.
 * @param tokens - Positive heuristic token allowance.
 * @returns Text bounded including the explicit omission marker.
 */
export function tokenBoundedText(text: string, tokens: number): string {
  const bytes = tokens * 4
  if (Buffer.byteLength(text) <= bytes) return text
  const marker = '\n[... memory text truncated ...]\n'
  const allowance = Math.max(0, bytes - Buffer.byteLength(marker))
  if (allowance === 0) return boundedText(marker, bytes).text
  const head = boundedText(text, Math.floor(allowance / 2)).text
  const reversed = Array.from(text).toReversed().join('')
  const tail = Array.from(boundedText(reversed, allowance - Buffer.byteLength(head)).text).toReversed().join('')
  return head + marker + tail
}
