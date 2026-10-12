import { describe, expect, it } from 'vitest'
import { MessageId } from '@codexydsh/runtime/llm'
import { responseItemIdBase } from '../src/response-item-id.ts'

describe('Codexful Responses item IDs', () => {
  it('keeps persisted UUIDs and bounds repaired message IDs deterministically', () => {
    const uuid = MessageId('12345678-1234-1234-1234-123456789abc')
    expect(responseItemIdBase(uuid)).toBe(uuid)

    const repaired = MessageId(`interrupted-tool-result-${'x'.repeat(120)}`)
    const first = responseItemIdBase(repaired)
    expect(first).toMatch(/^h_[\da-f]{32}$/)
    expect(responseItemIdBase(repaired)).toBe(first)
    expect(responseItemIdBase(MessageId(`${repaired}2`))).not.toBe(first)
    expect(`ctco_${first}_4294967295`.length).toBeLessThanOrEqual(64)
  })
})
