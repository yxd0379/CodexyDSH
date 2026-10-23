/** Stable Codexful Responses item IDs derived from durable Session messages. */
import { createHash } from 'node:crypto'
import type { MessageId } from '@codexydsh/runtime/llm'

/**
 * Keep generated UUID message IDs readable; hash repaired or imported IDs so
 * a Responses item with a block suffix stays below the API's 64-character cap.
 * @param id - the Session-persisted message identity.
 * @returns a stable, bounded suffix for one or more Responses items.
 */
export function responseItemIdBase(id: MessageId): string {
  const value = String(id)
  return /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value)
    ? value
    : `h_${createHash('sha256').update(value).digest('hex').slice(0, 32)}`
}
