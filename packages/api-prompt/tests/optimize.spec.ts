/** Auxiliary rewrites preserve the selected route and never schedule a Session turn. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { optimizePromptDraft } from '../src/optimize.ts'

function fixture(chunks: StreamChunk[]) {
  let request: GenerateOptions | undefined
  const stream = vi.fn(async function* (options: GenerateOptions) {
    request = options
    for (const chunk of chunks) yield chunk
  })
  const ctx = { llm: { stream } } as Context
  const session = { id: 'draft-session', requestHeader: () => ({ config: { provider: 'selected', model: 'current' } }) }
  const agent = { session, options: { provider: 'default', model: 'fallback' } } as Agent
  return { ctx, agent, stream, request: () => request }
}

const success: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: '  Fix the failing integration test.  ' },
  { type: 'block-end', index: 0, block: { type: 'text', text: '  Fix the failing integration test.  ' } },
  { type: 'finish', reason: { kind: 'stop' } },
]

describe('draft rewrite', () => {
  it('uses the latest selected route and returns an editable text result', async () => {
    const f = fixture(success)
    await expect(optimizePromptDraft(f.ctx, f.agent, ' fix the test ', new AbortController().signal,
      { maxOutputTokens: 123, timeoutMs: 5_000 })).resolves.toBe('Fix the failing integration test.')
    expect(f.request()).toMatchObject({ provider: 'selected', model: 'current', maxTokens: 123, temperature: 0 })
    expect(f.request()?.messages).toHaveLength(1)
    expect(f.request()?.messages[0]?.content).toEqual([{ type: 'text', text: 'fix the test' }])
    expect(f.stream).toHaveBeenCalledOnce()
  })

  it('rejects empty and incomplete rewrites without producing a replacement', async () => {
    const f = fixture([{ type: 'finish', reason: { kind: 'max-tokens' } }])
    await expect(optimizePromptDraft(f.ctx, f.agent, 'fix', new AbortController().signal)).rejects.toThrow('max-tokens')
    await expect(optimizePromptDraft(f.ctx, f.agent, ' ', new AbortController().signal)).rejects.toThrow('no draft')
    expect(f.stream).toHaveBeenCalledOnce()
  })

  it('honors caller cancellation before accepting output', async () => {
    const f = fixture(success)
    const abort = new AbortController()
    abort.abort(new Error('draft changed'))
    await expect(optimizePromptDraft(f.ctx, f.agent, 'fix', abort.signal)).rejects.toThrow('draft changed')
  })
})
