/** UTF-8 middle truncation for Codexful tool-result history. */

import { freezeMessage } from '@codexydsh/runtime/llm'
import type { ContentBlock, ToolResultMessage } from '@codexydsh/runtime/llm'
import { codexfulToolProfile } from '@codexydsh/prompt'

type SourceTruncation = ReturnType<typeof codexfulToolProfile>['sourceTruncation']

/** Pinned Codex's allowance before truncating tool-result payload text. */
export const SERIALIZATION_ALLOWANCE = 1.2

/**
 * Count UTF-8 bytes in a tool result's text blocks.
 * @param blocks - result content; non-text blocks are excluded.
 * @returns total UTF-8 text bytes.
 */
export function textBytes(blocks: readonly ContentBlock[]): number {
  return blocks.reduce((sum, block) => sum + (block.type === 'text' ? Buffer.byteLength(block.text, 'utf8') : 0), 0)
}

function historyTokenLimit(policy: SourceTruncation): number {
  const allowed = Math.ceil(policy.limit * SERIALIZATION_ALLOWANCE)
  return policy.mode === 'tokens' ? allowed : Math.ceil(allowed / 4)
}

/** Apply the pinned string path: split retained bytes across both ends, then add the marker. */
function truncateMiddleText(text: string, budget: number): string {
  const chars = Array.from(text)
  const originalBytes = Buffer.byteLength(text, 'utf8')
  const headBudget = Math.floor(budget / 2)
  const tailBudget = budget - headBudget
  let headChars = 0
  let headBytes = 0
  for (const char of chars) {
    const bytes = Buffer.byteLength(char, 'utf8')
    if (headBytes + bytes > headBudget) break
    headBytes += bytes
    headChars++
  }
  let tailChars = 0
  let tailBytes = 0
  for (let index = chars.length - 1; index >= headChars; index--) {
    const char = chars[index]
    if (char === undefined) break
    const bytes = Buffer.byteLength(char, 'utf8')
    if (tailBytes + bytes > tailBudget) break
    tailBytes += bytes
    tailChars++
  }
  const count = Math.ceil((originalBytes - budget) / 4)
  const marker = `…${count} tokens truncated…`
  return chars.slice(0, headChars).join('') + marker + chars.slice(chars.length - tailChars).join('')
}

/**
 * Truncate one model-facing result using the originating model's pinned Codex source policy.
 * A single text block follows the pinned string path. For multiple blocks,
 * nonempty text consumes the budget in order; the first oversized block is
 * middle-truncated with its remaining budget, later text blocks are counted in
 * a final omitted-items marker, and non-text blocks retain their order.
 * Markers follow the retained payload budget, so final text can exceed it.
 * @param message - current result projected from the Session surface.
 * @param policy - profile selected from the result's originating request header.
 * @returns frozen replacement, or `null` when all text fits the source limit.
 */
export function truncateToolResult(message: ToolResultMessage, policy: SourceTruncation): ToolResultMessage | null {
  let remaining = historyTokenLimit(policy)
  let changed = false
  let omitted = 0
  const content: ContentBlock[] = []
  for (const block of message.content) {
    if (block.type !== 'text') {
      content.push(block)
      continue
    }
    if (block.text.length === 0) continue
    const bytes = Buffer.byteLength(block.text, 'utf8')
    const cost = Math.ceil(bytes / 4)
    if (cost <= remaining) {
      content.push(block)
      remaining -= cost
    } else if (remaining > 0) {
      const byteBudget = remaining * 4
      content.push({ ...block, text: truncateMiddleText(block.text, byteBudget) })
      remaining = 0
      changed = true
    } else {
      omitted++
      changed = true
    }
  }
  if (!changed) return null
  if (omitted > 0) content.push({ type: 'text', text: `[omitted ${omitted} text items ...]` })
  return freezeMessage({ ...message, content })
}
