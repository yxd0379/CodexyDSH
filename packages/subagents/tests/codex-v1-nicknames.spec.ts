import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { AgentLoop } from '@codexydsh/runtime'
import { mountAgentLoopTestDependencies } from '@codexydsh/runtime-testkit'
import { ToolCallId, createToolResultMessage } from '@codexydsh/runtime/llm'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@codexydsh/runtime/types'
import SubagentRuntime from '@codexydsh/delegation'
import {
  acquireCodexV1NicknameRegistry, CODEX_V1_NICKNAMES, CodexV1NicknamePool,
  codexV1ClosedAgentsFromLog, codexV1LiveNicknames, codexV1LiveRoster, codexV1NicknamesFromLog,
} from '../src/codex-v1-nicknames.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function registryHarness() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  const first = await ctx.agents.create({ sessionId: SessionId('nickname-root-first') })
  const second = await ctx.agents.create({ sessionId: SessionId('nickname-root-second') })
  return { ctx, first, second }
}

/** Pin successful and failed durable tool facts independently of allocation. */
function spawnEvents(
  name: string, callId: string, result: string, isError = false, argumentsText = '{"message":"Task"}',
): SessionEvent[] {
  const id = ToolCallId(callId)
  return [
    { type: 'tool/call', seq: SessionSeq(0), time: 0, data: {
      turn: 1, step: 1, name, callId: id, arguments: argumentsText,
    } },
    { type: 'tool/result', seq: SessionSeq(1), time: 0, surfaceOp: 'append', data: {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId: id, content: [{ type: 'text', text: result }], isError }),
    } },
  ]
}

describe('Codex v1 nickname reservations', () => {
  it('uses every pinned candidate before starting the second ordinal pool', () => {
    expect(CODEX_V1_NICKNAMES).toHaveLength(101)
    expect(createHash('sha256').update(`${CODEX_V1_NICKNAMES.join('\n')}\n`).digest('hex'))
      .toBe('f6ae12de892a2543bd109cd4da292e98f41c58ce29f0756f5e1eb8ef477e75f9')
    const pool = new CodexV1NicknamePool()
    const first = Array.from({ length: CODEX_V1_NICKNAMES.length }, () => pool.reserve(CODEX_V1_NICKNAMES))
    expect(new Set(first)).toEqual(new Set(CODEX_V1_NICKNAMES))
    const second = pool.reserve(CODEX_V1_NICKNAMES)
    expect(CODEX_V1_NICKNAMES).toContain(second.replace(/ the 2nd$/, ''))
    expect(second).toMatch(/ the 2nd$/)
  })

  it('keeps failed reservations consumed and formats ordinal exceptions', () => {
    const pool = new CodexV1NicknamePool()
    const names = ['Euclid']
    const reserved = Array.from({ length: 23 }, () => pool.reserve(names))
    expect(reserved).toEqual([
      'Euclid', 'Euclid the 2nd', 'Euclid the 3rd', 'Euclid the 4th',
      'Euclid the 5th', 'Euclid the 6th', 'Euclid the 7th', 'Euclid the 8th',
      'Euclid the 9th', 'Euclid the 10th', 'Euclid the 11th', 'Euclid the 12th',
      'Euclid the 13th', 'Euclid the 14th', 'Euclid the 15th', 'Euclid the 16th',
      'Euclid the 17th', 'Euclid the 18th', 'Euclid the 19th', 'Euclid the 20th',
      'Euclid the 21st', 'Euclid the 22nd', 'Euclid the 23rd',
    ])
    expect(pool.snapshot().size).toBe(0)
  })

  it('restores the original child nickname without reallocating it', () => {
    const pool = new CodexV1NicknamePool()
    pool.remember(SessionId('old-child'), 'Euclid')
    expect(pool.reserve(['Euclid', 'Hypatia'])).toBe('Hypatia')
    pool.remember(SessionId('new-child'), 'Hypatia')
    const detached = pool.snapshot()
    detached.clear()
    expect(pool.snapshot().get(SessionId('old-child'))).toBe('Euclid')
    expect(pool.reserve(['Euclid', 'Hypatia'])).toMatch(/ the 2nd$/)
    pool.remember(SessionId('old-child'), 'Euclid')
    expect(pool.snapshot().get(SessionId('old-child'))).toBe('Euclid')
  })

  it('rejects an empty source candidate list', () => {
    expect(() => new CodexV1NicknamePool().reserve([])).toThrow('no available agent nicknames')
  })

  it('rejects a second nickname for one child without consuming or replacing it', () => {
    const pool = new CodexV1NicknamePool()
    pool.remember(SessionId('child'), 'Euclid')
    expect(() => { pool.remember(SessionId('child'), 'Hypatia') }).toThrow('Conflicting Codex v1 nickname')
    expect(pool.snapshot()).toEqual(new Map([[SessionId('child'), 'Euclid']]))
    expect(pool.reserve(['Euclid', 'Hypatia'])).toBe('Hypatia')
  })
})

describe('Codex v1 nickname registry lifetime', () => {
  it('shares remaining leases after one lease is disposed repeatedly', async () => {
    const { ctx, first } = await registryHarness()
    const a = acquireCodexV1NicknameRegistry(ctx.codexySubagents)
    const b = acquireCodexV1NicknameRegistry(ctx.codexySubagents)
    const rootEffects = () => first.agent.ctx.fiber.getEffects()
      .filter(effect => effect.label === 'codexV1NicknameRegistry.root()')
    expect(rootEffects()).toHaveLength(0)
    const pool = a.pool(first.agent)
    pool.remember(SessionId('retained-child'), 'Euclid')
    pool.mark(SessionId('retained-child'), 'closed')
    expect(b.pool(first.agent)).toBe(pool)
    expect(rootEffects()).toHaveLength(1)
    a.dispose()
    a.dispose()
    const c = acquireCodexV1NicknameRegistry(ctx.codexySubagents)
    try {
      expect(c.pool(first.agent)).toBe(pool)
      expect(codexV1LiveNicknames(ctx.codexySubagents, first.agent.id))
        .toEqual(new Map([[SessionId('retained-child'), 'Euclid']]))
      const detachedRoster = codexV1LiveRoster(ctx.codexySubagents, first.agent.id)
      expect(detachedRoster).toEqual(new Map([[SessionId('retained-child'), 'closed']]))
      detachedRoster.clear()
      expect(codexV1LiveRoster(ctx.codexySubagents, first.agent.id).get(SessionId('retained-child'))).toBe('closed')
      expect(() => a.pool(first.agent)).toThrow('nickname registry lease is disposed')
      b.dispose()
      expect(c.pool(first.agent)).toBe(pool)
      expect(rootEffects()).toHaveLength(1)
    } finally {
      b.dispose()
      c.dispose()
    }
    expect(codexV1LiveNicknames(ctx.codexySubagents, first.agent.id).size).toBe(0)
    expect(codexV1LiveRoster(ctx.codexySubagents, first.agent.id).size).toBe(0)
    expect(rootEffects()).toHaveLength(0)
  })

  it('removes a disposed root pool while preserving other roots and registry owners', async () => {
    const { ctx, first, second } = await registryHarness()
    const a = acquireCodexV1NicknameRegistry(ctx.codexySubagents)
    const b = acquireCodexV1NicknameRegistry(ctx.codexySubagents)
    const firstPool = a.pool(first.agent)
    const secondPool = b.pool(second.agent)
    firstPool.remember(SessionId('first-child'), 'Euclid')
    secondPool.remember(SessionId('second-child'), 'Hypatia')
    try {
      await first.dispose()
      expect(codexV1LiveNicknames(ctx.codexySubagents, first.agent.id).size).toBe(0)
      expect(b.pool(second.agent)).toBe(secondPool)
      expect(codexV1LiveNicknames(ctx.codexySubagents, second.agent.id))
        .toEqual(new Map([[SessionId('second-child'), 'Hypatia']]))
      a.dispose()
      expect(b.pool(second.agent)).toBe(secondPool)
      await second.dispose()
      expect(codexV1LiveNicknames(ctx.codexySubagents, second.agent.id).size).toBe(0)
    } finally {
      a.dispose()
      b.dispose()
    }
  })

  it('keeps a replacement registry when an old lease is disposed again', async () => {
    const { ctx, first, second } = await registryHarness()
    const old = acquireCodexV1NicknameRegistry(ctx.codexySubagents)
    const oldPool = old.pool(first.agent)
    oldPool.remember(SessionId('old-child'), 'Euclid')
    old.dispose()
    expect(first.agent.ctx.fiber.getEffects()
      .filter(effect => effect.label === 'codexV1NicknameRegistry.root()')).toHaveLength(0)
    const current = acquireCodexV1NicknameRegistry(ctx.codexySubagents)
    const newPool = current.pool(second.agent)
    newPool.remember(SessionId('new-child'), 'Hypatia')
    try {
      old.dispose()
      await first.dispose()
      expect(current.pool(second.agent)).toBe(newPool)
      expect(codexV1LiveNicknames(ctx.codexySubagents, second.agent.id))
        .toEqual(new Map([[SessionId('new-child'), 'Hypatia']]))
      expect(codexV1LiveNicknames(ctx.codexySubagents, first.agent.id).size).toBe(0)
    } finally {
      current.dispose()
    }
  })
})

describe('Codex v1 nickname log recovery', () => {
  it('uses successful own v1 results and preserves old null nicknames as absent', () => {
    const inherited = spawnEvents('multi_agent_v1__spawn_agent', 'inherited', '{"agent_id":"ancestor","nickname":"Euclid"}')
    const own = spawnEvents('multi_agent_v1__spawn_agent', 'own', '{"agent_id":"own-child","nickname":"Hypatia"}')
    const unknown = spawnEvents('multi_agent_v1__spawn_agent', 'old', '{"agent_id":"old-child","nickname":null}')
    const failed = spawnEvents('multi_agent_v1__spawn_agent', 'failed', '{"agent_id":"failed-child","nickname":"Bohr"}', true)
    const other = spawnEvents('spawn_agent', 'other', '{"agent_id":"other-child","nickname":"Turing"}')
    expect(codexV1NicknamesFromLog([...inherited, ...own, ...unknown, ...failed, ...other], inherited.length))
      .toEqual(new Map([[SessionId('own-child'), 'Hypatia']]))
  })

  it('recognizes namespaced streaming calls even when the checkpoint follows the call', () => {
    const events = spawnEvents('spawn_agent', 'native', '{"agent_id":"native-child","nickname":"Noether"}')
    events.push({
      type: 'assistant/output-item', seq: SessionSeq(2), time: 0,
      data: {
        turn: 1, step: 1, index: 0, provider: 'openai', model: 'gpt-5',
        block: { type: 'tool-call', id: ToolCallId('native'), name: 'spawn_agent',
          namespace: 'multi_agent_v1', arguments: '{"message":"Task"}' },
      },
    })
    expect(codexV1NicknamesFromLog(events, 0))
      .toEqual(new Map([[SessionId('native-child'), 'Noether']]))
  })

  it('ignores malformed durable results instead of inventing a nickname', () => {
    for (const result of ['malformed', 'null', '[]', '{"agent_id":7,"nickname":"Bohr"}', '{"agent_id":"child"}']) {
      expect(codexV1NicknamesFromLog(spawnEvents('multi_agent_v1__spawn_agent', 'broken', result), 0).size).toBe(0)
    }
  })

  it('rejects conflicting successful results for the same own child', () => {
    const first = spawnEvents('multi_agent_v1__spawn_agent', 'first', '{"agent_id":"child","nickname":"Euclid"}')
    const conflicting = spawnEvents('multi_agent_v1__spawn_agent', 'second', '{"agent_id":"child","nickname":"Hypatia"}')
    expect(() => codexV1NicknamesFromLog([...first, ...conflicting], 0))
      .toThrow('Conflicting Codex v1 nickname results')
  })
})

describe('Codex v1 closed roster recovery', () => {
  it('folds successful own address changes without ancestor or other tool families', () => {
    const inherited = spawnEvents('multi_agent_v1__close_agent', 'ancestor', '{}', false, '{"target":"ancestor"}')
    const close = spawnEvents('multi_agent_v1__close_agent', 'closed', '{}', false, '{"target":"child"}')
    const resume = spawnEvents('multi_agent_v1__resume_agent', 'resumed', '{}', false, '{"id":"child"}')
    const failed = spawnEvents('multi_agent_v1__close_agent', 'failed', '{}', true, '{"target":"child"}')
    const v2 = spawnEvents('close_agent', 'v2', '{}', false, '{"target":"v2-child"}')
    const broken = spawnEvents('multi_agent_v1__close_agent', 'broken', '{}', false, 'malformed')
    const events = [...inherited, ...close]
    expect(codexV1ClosedAgentsFromLog(events, inherited.length)).toEqual(new Set([SessionId('child')]))
    events.push(...resume, ...failed, ...v2, ...broken)
    expect(codexV1ClosedAgentsFromLog(events, inherited.length)).toEqual(new Set())
  })

  it('recognizes an own streamed namespace marker even after its durable call', () => {
    const events = spawnEvents('close_agent', 'native-close', '{}', false, '{"target":"child"}')
    events.push({
      type: 'assistant/output-item', seq: SessionSeq(2), time: 0,
      data: { turn: 1, step: 1, index: 0, provider: 'openai', model: 'gpt-5', block: {
        type: 'tool-call', id: ToolCallId('native-close'), name: 'close_agent', namespace: 'multi_agent_v1',
        arguments: '{"target":"child"}',
      } },
    })
    expect(codexV1ClosedAgentsFromLog(events, 0)).toEqual(new Set([SessionId('child')]))
    expect(codexV1ClosedAgentsFromLog(events.slice(0, 2), 0)).toEqual(new Set())
  })
})
