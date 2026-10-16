import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentLoop } from '@codexydsh/runtime'
import { BasicCompactionEngine } from '@codexydsh/compaction'
import { mountAgentLoopTestDependencies } from '@codexydsh/runtime-testkit'
import TokenMeter from '@codexydsh/token-meter'
import { createUserMessage, LlmAdapter } from '@codexydsh/runtime/llm'
import type {
  GenerateOptions,
  LlmResolvedModelInfo,
  RequestMessage,
  StreamChunk,
} from '@codexydsh/runtime/llm'
import { SessionId } from '@deepseek-ai/dsh-session'

const MODEL = 'compaction-fixture'

/** A deterministic provider boundary; the loop, port, persistence, and engine stay real. */
class CompactionAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 32_768 },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const finalUserText = text(options.messages.at(-1))
    const response = finalUserText.includes('CONTEXT CHECKPOINT COMPACTION')
      ? 'checkpoint: retain the active task and its constraints'
      : 'initial answer'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: response } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function text(message: RequestMessage | undefined): string {
  return message?.content
    .map(block => block.type === 'text' ? block.text : '')
    .join('') ?? ''
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
})

describe('Codexy manual compaction', () => {
  it('uses the registered request port and replaces old history with a durable checkpoint', async () => {
    const context = new Context()
    contexts.push(context)
    await mountAgentLoopTestDependencies(context)
    context.on('session/flush', async () => {})
    await context.plugin(AgentLoop, { agents: [] })
    await context.plugin(TokenMeter)

    const adapter = new CompactionAdapter()
    context.codexyRequests.registerAdapter([MODEL], adapter)
    await context.plugin(BasicCompactionEngine, {
      auto: false,
      checkpointFormat: 'codex',
      codexUserMessageTokens: 0,
    })

    const agent = await context.agentLoop.create(SessionId('manual-compaction'), {
      provider: MODEL,
      model: MODEL,
    })
    const originalPrompt = 'Keep this original task context while compacting it.'
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: originalPrompt }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    const result = await context.compaction.compactNow(agent, new AbortController().signal)

    expect(result).not.toBeNull()
    expect(adapter.requests).toHaveLength(2)
    expect(text(adapter.requests[1]?.messages.at(-1))).toContain('CONTEXT CHECKPOINT COMPACTION')
    expect(agent.session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(true)
    const visibleHistory = agent.session.deriveMessages().map(text).join('\n')
    expect(visibleHistory).toContain('checkpoint: retain the active task and its constraints')
    expect(visibleHistory).not.toContain(originalPrompt)
  })
})
