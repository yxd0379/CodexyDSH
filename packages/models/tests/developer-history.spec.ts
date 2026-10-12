import { describe, expect, it } from 'vitest'
import { createDeveloperMessage, createUserMessage, LlmError } from '@codexydsh/runtime/llm'
import { prepareDeveloperHistory, restoreDeveloperInput } from '../src/developer-history.ts'

function developer(text: string) {
  return createDeveloperMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider: 'local', model: 'qwen3.8' },
  })
}

describe('native developer history transport', () => {
  it.each([false, true])('preserves each developer text block with Codexful item IDs %s', (codexfulItemIds) => {
    const message = createDeveloperMessage({
      content: [{ type: 'text', text: 'First fragment.' }, { type: 'text', text: 'Second fragment.' }],
      source: { kind: 'model', provider: 'local', model: 'qwen3.8' },
    })
    const prepared = prepareDeveloperHistory([message], true)
    const marker = prepared.messages[0]?.content[0]
    if (marker?.type !== 'text') throw new Error('missing developer marker')
    const request = restoreDeveloperInput({ input: [{ role: 'user', content: [{ type: 'input_text', text: marker.text }] }] },
      prepared.replacements, codexfulItemIds)
    expect(request).toEqual({ input: [{
      type: 'message', ...codexfulItemIds ? { id: `msg_${message.id}` } : {}, role: 'developer',
      content: [{ type: 'input_text', text: 'First fragment.' }, { type: 'input_text', text: 'Second fragment.' }],
    }] })
    expect(message.content).toEqual([{ type: 'text', text: 'First fragment.' }, { type: 'text', text: 'Second fragment.' }])
  })

  it('restores one exact message item and leaves no private marker on the wire', () => {
    const message = developer('permissions')
    const prepared = prepareDeveloperHistory([message], true)
    const actual = prepared.messages[0]?.content[0]
    if (actual?.type !== 'text') throw new Error('missing developer marker')
    const request = restoreDeveloperInput({ input: [{ role: 'user', content: [{ type: 'input_text', text: actual.text }] }] }, prepared.replacements)
    expect(request).toEqual({ input: [{
      type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'permissions' }],
    }] })
    expect(JSON.stringify(request)).not.toContain(actual.text)
    const codexful = restoreDeveloperInput(
      { input: [{ role: 'user', content: [{ type: 'input_text', text: actual.text }] }] },
      prepared.replacements, true,
    )
    expect(codexful).toHaveProperty('input.0.id', `msg_${message.id}`)
    const input = codexful['input']
    if (!Array.isArray(input)) throw new Error('missing restored developer input')
    const first: unknown = input[0]
    if (first === null || typeof first !== 'object') throw new Error('invalid restored developer input')
    expect(Object.keys(first)).toEqual(['type', 'id', 'role', 'content'])
  })

  it('refuses missing, duplicated, or modified markers before network I/O', () => {
    const prepared = prepareDeveloperHistory([developer('permissions')], true)
    const block = prepared.messages[0]?.content[0]
    if (block?.type !== 'text') throw new Error('missing developer marker')
    const exact = { role: 'user', content: [{ type: 'input_text', text: block.text }] }
    for (const input of [
      [],
      [exact, exact],
      [{ role: 'user', content: [{ type: 'input_text', text: `${block.text} extra` }] }],
      [{ ...exact, id: 'unexpected' }],
    ]) {
      expect(() => restoreDeveloperInput({ input }, prepared.replacements)).toThrow(LlmError)
    }
  })

  it('rejects a provider without native developer history and preserves ordinary user input', () => {
    expect(() => prepareDeveloperHistory([developer('permissions')], false)).toThrow(LlmError)
    const user = createUserMessage({ content: [{ type: 'text', text: 'task' }], source: { kind: 'user' } })
    expect(prepareDeveloperHistory([user], false)).toEqual({ messages: [user], replacements: [] })
  })
})
