import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SystemPrompt, ToolRuntime } from '@codexydsh/test-support/host-tools'
import { defineTool } from '@codexydsh/tool-schema'

describe('native string schema annotations', () => {
  it('retains encryption metadata in captured schemas while the public runtime validates strings', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, { mode: 'native' })
    const definition = defineTool({
      name: 'send_message', description: 'Send a message.',
      parameters: { message: { type: 'string', required: true, encrypted: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async args => args.message,
    })
    const dispose = ctx.codexyTools.register(definition)
    try {
      const captured = await ctx.codexyTools.prepareRequest({ context: {}, variables: {} })
      expect(captured.schemas[0]).toMatchObject({ parameters: { properties: { message: { type: 'string', encrypted: true } }, required: ['message'] } })
      const signal = new AbortController().signal
      const result = await ctx.codexyTools.execute({ callId: ToolCallId('annotation-valid'), signal, name: 'send_message', arguments: { message: 'hello' } })
      expect(result).toMatchObject({ isError: false, value: 'hello' })
      const rejected = await ctx.codexyTools.execute({ callId: ToolCallId('annotation-invalid'), signal, name: 'send_message', arguments: { message: 1 } })
      expect(rejected).toMatchObject({ isError: true, error: { info: { code: 'INVALID_ARGS' } } })
      expect(definition.parameters).toMatchObject({ properties: { message: { encrypted: true } } })
    } finally { dispose(); await ctx.fiber.dispose() }
  })

  it('keeps unrelated author-schema errors on the public compiler path', () => {
    expect(() => defineTool({
      name: 'invalid', description: 'Invalid definition.',
      parameters: { message: { type: 'string', unsupportedAnnotation: true } },
      output: { schema: { type: 'string' }, render: () => [] }, execute: async () => '',
    })).toThrow('unsupportedAnnotation is not supported')
  })
})
