import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { Session, SessionId, appendProductEvent } from '@codexydsh/runtime/session'
import type { EpochHeader } from '@codexydsh/runtime/types'
import { RetryId } from '@codexydsh/retry'
import TokenMeter from '@codexydsh/token-meter'
import { estimateToolsTokens } from '@codexydsh/token-meter/estimate'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

function harness(preferProviderUsage = false): { ctx: Context; meter: TokenMeter; session: Session } {
  const ctx = new Context()
  contexts.push(ctx)
  new SessionProjectionRegistry(ctx)
  return { ctx, meter: new TokenMeter(ctx, { preferProviderUsage }), session: Session.create(SessionId('product-meter')) }
}

const nativeHeader: EpochHeader = {
  config: { provider: 'codex', model: 'native', codexfulResponses: { omitDefaultMaxTokens: true, reasoningSummary: 'auto' } },
  tools: [{
    name: 'apply_patch', kind: 'freeform', description: 'Apply an exact patch.',
    format: { type: 'grammar', syntax: 'lark', definition: 'start: /[\\s\\S]+/' },
    namespace: { name: 'files', description: 'Workspace changes.', toolName: 'apply_patch' },
  }],
}

function successfulCall(session: Session, usage: TokenUsage): void {
  session.append('step/start', { turn: 1, step: 1 })
  appendProductEvent(session, 'request/header', { header: nativeHeader, reason: 'initial' })
  session.append('assistant/message', {
    turn: 1, step: 1, usage,
    stream: [
      { type: 'chunk', time: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
      { type: 'chunk', time: 2, chunk: { type: 'text-delta', index: 0, text: 'done' } },
      { type: 'chunk', time: 3, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } } },
      { type: 'chunk', time: 4, chunk: { type: 'usage', usage } },
      { type: 'chunk', time: 5, chunk: { type: 'finish', reason: { kind: 'stop' } } },
    ],
    message: createAssistantMessage({ content: [{ type: 'text', text: 'done' }], source: { provider: 'codex', model: 'native' } }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
}

describe('token metering through public Session product carriers', () => {
  it('prices the complete native grammar and namespace in service and wire projections', () => {
    const { ctx, meter, session } = harness()
    appendProductEvent(session, 'request/header', { header: nativeHeader, reason: 'initial' })
    const tokens = estimateToolsTokens(nativeHeader)
    expect(meter.measure(session)).toMatchObject({ totalTokens: tokens, baseline: { kind: 'estimated', tokens } })
    expect(ctx.sessionProjections.snapshot(session).values.contextBreakdown?.toolsTokens).toBe(tokens)
    expect(ctx.tokenMeter.measure(session)).toEqual(meter.measure(session))
  })

  it('uses lower provider usage when the native product header matches', () => {
    const { meter, session } = harness(true)
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'long input '.repeat(100) }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    successfulCall(session, { inputTokens: 2, outputTokens: 1 })
    expect(meter.measure(session, nativeHeader)).toMatchObject({ totalTokens: 3, baseline: { kind: 'usage', tokens: 3 } })
  })

  it('clears the provider anchor after successful product compaction but retains it after failure', () => {
    const { meter, session } = harness(true)
    successfulCall(session, { inputTokens: 7300, outputTokens: 100 })
    const compactionId = CompactionId('product-compaction')
    appendProductEvent(session, 'compaction/end', { compactionId, turn: null, error: 'failed' })
    expect(meter.measure(session).baseline).toMatchObject({ kind: 'usage', tokens: 7400 })
    appendProductEvent(session, 'compaction/end', { compactionId, turn: null })
    expect(meter.measure(session)).toMatchObject({ baseline: { kind: 'estimated' }, surfaceDeltaTokens: 0 })
    expect(meter.measure(session).totalTokens).toBeLessThan(7400)
  })

  it('adds retry attempts rather than replacing their usage through product retry records', () => {
    const { ctx, session } = harness()
    const attempt = (inputTokens: number): void => {
      session.append('assistant/attempt', { turn: 1, step: 1, stream: [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage: { inputTokens, outputTokens: 1 } } }] })
    }
    attempt(10)
    appendProductEvent(session, 'llm/retry-started', { retryId: RetryId('native-retry'), turn: 1, step: 1, retry: 1 })
    attempt(20)
    expect(ctx.sessionProjections.snapshot(session).values.tokenUsage).toEqual({ uncachedInputTokens: 30, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 })
  })
})
