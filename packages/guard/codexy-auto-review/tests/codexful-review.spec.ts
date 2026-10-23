import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import ApprovalService from '@codexydsh/approval'
import {
  mountAgentLoopTestDependencies, mountAgentLoopTestHarness,
} from '../../../test-support/codexy-runtime-testkit/src/index.ts'
import { MockAdapter, textResponse } from '../../../test-support/codexy-runtime-testkit/src/mock-adapter.ts'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { installCodexfulReview, type CodexfulReviewConfig } from '../src/codexful.ts'

const provider = 'self-hosted-fixture'
const model = 'qwen3.8-27b-w8a8'
const config: CodexfulReviewConfig = {
  timeoutMs: 1_000, inputTokenBudget: 32_768, outputTokenBudget: 2_048,
  investigationTools: false, maxInspectionCalls: 4, inspectionReadBytes: 32_768,
  inspectionOutputCharacters: 8_000, inspectionDirectoryEntries: 100,
}

/** The real approval and tool services, with no filesystem or network effects. */
async function bench(script: ConstructorParameters<typeof MockAdapter>[0], timeoutMs = config.timeoutMs) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(ApprovalService, { policy: 'ask', reviewer: 'auto_review' })
  // Only the permission-menu contribution is replaced: decisions still go
  // through ApprovalService.request, the installed reviewer, and ToolRuntime.
  const registerApprovalReviewer = vi.fn(() => () => {})
  ctx.provide('codexyPermissions', { registerApprovalReviewer } as never)
  const adapter = new MockAdapter(script)
  ctx.codexyRequests.registerAdapter([provider], adapter)
  installCodexfulReview(ctx, { ...config, timeoutMs })
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('codexful-review-fixture'))
  const session = agent.session
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', { reason: 'initial', header: { config: { provider, model } } })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Run the harmless fixture action after reviewing its requested access.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const callId = ToolCallId('reviewed-fixture-call')
  session.append('assistant/message', {
    turn: 1, step: 1, stream: [], message: createAssistantMessage({
      source: { provider, model },
      content: [{ type: 'tool-call', id: callId, name: 'review_fixture', arguments: '{}' }],
    }),
  }, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId, name: 'review_fixture', arguments: '{}' })

  const body = vi.fn(() => Promise.resolve([{ type: 'text' as const, text: 'fixture executed' }]))
  ctx.tools.register(defineContentToolFixture({
    name: 'review_fixture', description: 'A harmless in-memory test action.', parameters: {}, execute: body,
  }))
  ctx.on('tools/pre-execute', async () => ({ kind: 'ask' as const, reason: 'fixture requires wider access' }))
  const execute = () => ctx.tools.execute({
    agent, callId, name: 'review_fixture', arguments: {}, signal: new AbortController().signal,
  })
  const review = () => {
    const asked = session.snapshotEvents().findLast(event => event.type === 'approval/asked')
    if (asked?.type !== 'approval/asked') throw new Error('fixture did not request approval')
    return ctx.codexyApproval.reviewOf(session, asked.data.id)
  }
  return { ctx, session, adapter, body, execute, review, registerApprovalReviewer }
}

describe('Codexful required-approval reviewer', () => {
  it.each(['allow', 'deny'] as const)('executes the pending action only after an %s assessment', async (outcome) => {
    const b = await bench([textResponse(JSON.stringify({
      outcome, risk_level: 'low', user_authorization: 'high', rationale: 'Fixture assessment.',
    }))])

    const result = await b.execute()

    expect(result.isError).toBe(outcome !== 'allow')
    expect(b.body).toHaveBeenCalledTimes(outcome === 'allow' ? 1 : 0)
    expect(b.review()).toMatchObject({
      status: outcome === 'allow' ? 'approved' : 'denied', assessment: { outcome },
    })
    expect(b.adapter.requests).toHaveLength(1)
    expect(b.adapter.requests[0]).toMatchObject({ provider, model })
    expect(b.registerApprovalReviewer).toHaveBeenCalledOnce()
    const decisions = b.session.snapshotEvents().filter(event => event.type === 'approval/decided')
    expect(decisions).toEqual([expect.objectContaining({ data: {
      id: b.review()?.id, outcome: outcome === 'allow' ? 'allowed-once' : 'rejected',
    } })])
  })

  it('does not execute the action when the model transport fails', async () => {
    const b = await bench([() => { throw new Error('self-hosted fixture is unavailable') }])

    expect((await b.execute()).isError).toBe(true)
    expect(b.body).not.toHaveBeenCalled()
    expect(b.review()).toMatchObject({ status: 'failed', error: expect.stringContaining('review could not be completed') })
  })

  it('cancels the model at the review deadline without executing the action', async () => {
    const b = await bench(['hang'], 50)

    expect((await b.execute()).isError).toBe(true)
    expect(b.body).not.toHaveBeenCalled()
    expect(b.adapter.requests).toHaveLength(1)
    expect(b.adapter.requests[0]?.signal?.aborted).toBe(true)
    expect(b.review()).toMatchObject({ status: 'failed', error: expect.stringContaining('deadline') })
  })

  it('inherits the latest Session model route rather than a fixed paid reviewer', async () => {
    const b = await bench([textResponse('{"outcome":"allow"}')])
    b.ctx.codexyRequests.registerAdapter(['second-self-hosted-fixture'], b.adapter)
    b.session.append('request/header', {
      reason: 'change', header: { config: { provider: 'second-self-hosted-fixture', model: 'local-model-next' } },
    })

    expect((await b.execute()).isError).toBe(false)
    expect(b.adapter.requests).toHaveLength(1)
    expect(b.adapter.requests[0]).toMatchObject({ provider: 'second-self-hosted-fixture', model: 'local-model-next' })
    expect(b.body).toHaveBeenCalledOnce()
  })
})
