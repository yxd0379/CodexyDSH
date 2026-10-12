import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentLoop } from '@codexydsh/runtime'
import { ToolCallId, type LlmResolvedModelInfo } from '@codexydsh/runtime/llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TOOL_REQUEST_CAPTURE } from '@codexydsh/runtime/tools'
import { mountAgentLoopTestDependencies } from '@codexydsh/runtime-testkit'
import { MockAdapter } from '@codexydsh/runtime-testkit/mock-adapter'
import SubagentRuntime from '@codexydsh/delegation'
import * as Spawn from '@codexydsh/spawn'
import * as Fork from '@codexydsh/fork'
import { TestSessionQuery } from '../../delegation/tests/test-session-query.ts'
import * as CodexV1 from '../src/codex-v1.ts'

/** This route deliberately serves only one local test model, not the fallback catalog. */
class ExactNamespaceAdapter extends MockAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return model === 'mock'
      ? Promise.resolve({ provider, id: model, name: model, toolNamespaces: 'native' })
      : Promise.reject(new Error(`unknown model: ${model}`))
  }
}

describe('pinned spawn wording on an actual effect-owned registration', () => {
  it('captures the selected description without admitting unavailable catalog models', async () => {
    const ctx = new Context()
    try {
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(TestSessionQuery)
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(Spawn, { providerName: 'spawn' })
      await ctx.plugin(Fork, { providerName: 'fork' })
      const registration = await ctx.plugin(CodexV1, { spawnDescriptionWireProfile: 'codex-0.162.1' })
      const adapter = new ExactNamespaceAdapter([])
      ctx.codexyRequests.registerAdapter(['mock'], adapter)
      const parent = await ctx.agentLoop.create(SessionId('description-parent'), { provider: 'mock', model: 'mock' })
      const signal = new AbortController().signal
      const context = { agent: parent, scope: parent, signal }
      const preparation = await ctx.codexyPrompt.prepare(context)
      const capture = await ctx.codexyTools.prepareRequest({ context, variables: preparation.variables })
      const assembly = await ctx.codexyPrompt.assemble({ ...context, [TOOL_REQUEST_CAPTURE]: capture }, preparation)
      const binding = ctx.codexyTools.bindAssembly(capture, assembly.tools)
      const schemas = ctx.codexyTools.requestSchemas(binding)
      const spawn = schemas.find(schema => schema.namespace?.toolName === 'spawn_agent')
      expect(schemas).toHaveLength(5)
      expect(createHash('sha256').update(spawn?.description ?? '').digest('hex'))
        .toBe('5dfbcec2bbf5ba2d61f91aa41dfd93b47c9cffe6c88d1585d8b2358b38bd31e0')
      const start = vi.spyOn(ctx.codexySubagents, 'startContinuable')
      const result = await ctx.codexyTools.execute({ signal, agent: parent,
        callId: ToolCallId('unavailable-catalog-model'), name: 'multi_agent_v1__spawn_agent',
        arguments: { message: 'A test task', model: 'gpt-6.1-sol' }, requestBinding: binding })
      expect(result.isError).toBe(true)
      expect(result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''))
        .toContain('unknown model: gpt-6.1-sol')
      expect(start).not.toHaveBeenCalled()
      expect(adapter.requests).toHaveLength(0)
      await registration.dispose()
      expect(ctx.codexyTools.schemas().some(schema => schema.namespace?.name === 'multi_agent_v1')).toBe(false)
    } finally { await ctx.fiber.dispose() }
  })
})
