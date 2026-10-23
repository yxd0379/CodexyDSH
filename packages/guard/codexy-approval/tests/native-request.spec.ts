import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import type { ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '../../../test-support/codexy-runtime-testkit/src/index.ts'
import ApprovalService from '../src/index.ts'

describe('product approval through the native UI event', () => {
  it.each(['allowed-once', 'rejected'] as const)('persists a native %s decision without exposing private grant fields', async (outcome) => {
    const root = await mkdtemp(join(tmpdir(), 'codexy-native-approval-'))
    const contexts: Context[] = []
    onTestFinished(async () => {
      try {
        for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: join(root, 'plugins') })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(ApprovalService)
    const sessionRoot = join(root, 'sessions')
    await ctx.plugin(JsonlSessionPersistence, { root: sessionRoot, compression: 'none' })
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId(`approval-${outcome}`), {}, { cwd: root })
    const session = agent.session
    session.append('turn/start', { turn: 1 })
    const callId = ToolCallId('not-executed')
    const displayReason = { en: 'Read the fixture file.', zh: '读取测试文件。' }
    let presented: ApprovalRequestEvent | undefined
    ctx.on('approval/request', (req) => {
      presented = req
      return Promise.resolve(outcome)
    })

    await expect(ctx.codexyApproval.request({
      agent, toolName: 'read_file', callId, reason: 'fixture approval', displayReason,
      sessionGrantKey: 'private-exact-fingerprint',
      prefixGrantKey: 'private-prefix-fingerprint', prefixRule: ['read_file'],
    })).resolves.toBe(outcome)
    expect(presented).toEqual({
      agent, toolName: 'read_file', callId, reason: 'fixture approval', displayReason,
      signal: expect.any(AbortSignal),
    })
    expect(ctx.codexyApproval.hasGrant(agent, 'read_file', 'private-exact-fingerprint')).toBe(false)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.sessions.flush(session)
    await ctx.fiber.dispose()

    const restarted = new Context()
    contexts.push(restarted)
    await restarted.plugin(JsonlSessionPersistence, { root: sessionRoot, compression: 'none' })
    const reader = await restarted.sessionPersistence.open(session.id, 'read')
    try {
      const { events } = await reader.read()
      const audit = events.filter(event => event.type === 'approval/asked' || event.type === 'approval/decided')
      expect(audit).toEqual([
        expect.objectContaining({ type: 'approval/asked', data: {
          id: expect.any(String), toolName: 'read_file', callId, reason: 'fixture approval',
        } }),
        expect.objectContaining({ type: 'approval/decided', data: { id: audit[0]?.data.id, outcome } }),
      ])
      expect(events.some(event => event.type === 'codexy/fact')).toBe(false)
    } finally {
      await reader.close()
    }
  })
})
