/** Original Anko completed-output facts at the verified TRANSPORT recovery boundary. */
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it } from 'vitest'
import { resolveRetryPolicy } from '@codexydsh/runtime/llm'
import { Session, deriveProductMessages, snapshotProductEvents } from '@codexydsh/runtime/session'
import { decodeCodexyArtifact, encodeArtifactEvents, encodeArtifactHeader } from '../../runtime/src/persistence-codec.ts'
import * as Retry from '../src/index.ts'

const sessionPath = process.env.CODEXY_NATIVE_ANKO_SESSION

describe('native recovery of already committed real tool history', () => {
  it('admits the native five-retry policy without HTTP retries, rerunning tools or removing completed model facts', {
    skip: sessionPath === undefined,
  }, async () => {
    if (sessionPath === undefined) throw new Error('explicit retained Anko candidate session required')
    const bytes = await readFile(sessionPath)
    const decoded = decodeCodexyArtifact(bytes)
    const failed = decoded.events.findLastIndex(row => row.type === 'turn/end' && row.data.reason.kind === 'error')
    if (failed < 1) throw new Error('missing original failed turn boundary')
    // Recover at the request-error hook, before its old zero-budget caller
    // closed the step/turn. The original artifact is never rewritten.
    const cut = decoded.events[failed - 1]?.type === 'step/end' ? failed - 1 : failed
    const prefix = decoded.events.slice(0, cut)
    const restored = Session.fromRestore(decoded.metadata.session.id, prefix, decoded.metadata.session,
      decoded.metadata.inheritedEventCount, 'detached')
    const before = snapshotProductEvents(restored)
    const current = before.findLast(row => row.type === 'step/start')
    if (current?.type !== 'step/start') throw new Error('missing failed request step')
    const history = deriveProductMessages(restored)
    const assistant = history.findLast(message => message.role === 'assistant')
    expect(assistant?.content.map(block => block.type)).toEqual(['reasoning', 'text', 'tool-call'])
    const result = history.findLast(message => message.role === 'tool')
    expect(result?.content.some(block => block.type === 'text' && block.text.length > 0)).toBe(true)
    expect(before.filter(row => row.type === 'assistant/output-item').slice(-3).map(row => row.data.block.type))
      .toEqual(['reasoning', 'text', 'tool-call'])
    const calls = before.filter(row => row.type === 'tool/call')
    const results = before.filter(row => row.type === 'tool/result')
    const ctx = new Context()
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(SessionProjections)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(Retry)
      // Only the recovery policy service is invoked: no adapter, model or tool
      // is registered. The completed tool/result came from the retained real run.
      const owner = { id: restored.id, session: restored } as Agent
      const action = await ctx.waterfall('agent/request-error', {
        agent: owner, turn: current.data.turn, step: current.data.step, provider: 'codexy-eval',
        failure: { code: 'TRANSPORT', message: 'terminated' },
        retryPolicy: resolveRetryPolicy({ mode: 'normal', maxRetries: 5 }, 'native fixture'),
        signal: new AbortController().signal,
      }, async () => undefined)
      expect(action).toEqual({ kind: 'retry' })
      const after = snapshotProductEvents(restored)
      expect(after.filter(row => row.type === 'llm/retry')).toMatchObject([{ data: {
        retry: 1, maxRetries: 5, failure: { code: 'TRANSPORT', message: 'terminated' },
      } }])
      expect(after.filter(row => row.type === 'llm/retry-started')).toHaveLength(1)
      expect(after.filter(row => row.type === 'tool/call')).toEqual(calls)
      expect(after.filter(row => row.type === 'tool/result')).toEqual(results)
      expect(after.slice(0, before.length)).toEqual(before)
      expect(deriveProductMessages(restored)).toEqual(history)
      expect(encodeArtifactHeader(decoded.metadata) + encodeArtifactEvents(decoded.events)).toBe(bytes.toString())
      expect(await readFile(sessionPath)).toEqual(bytes)
    } finally { await ctx.fiber.dispose() }
  })
})
