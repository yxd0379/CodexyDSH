/** Accounting uses settled attempts, provider buckets, route identity and fork ownership. */
import { Context } from '@deepseek-ai/cordis'
import { createMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionEventMap, SessionEventType, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionObservation, SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { expect, it, onTestFinished, vi } from 'vitest'
import { collectUsage, emptyUsage, totalUsage } from '../src/aggregate.ts'
import UsageController from '../src/index.ts'
import type { ModelUsage } from '../src/types.ts'

function log() {
  const events: SessionEvent[] = []
  return {
    events,
    append<Type extends SessionEventType>(type: Type, data: SessionEventMap[Type], time = 100): void {
      events.push({ type, data, time, seq: SessionSeq(events.length) } as SessionEvent)
    },
  }
}

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 2, reasoningTokens: 3, totalTokens: 21 }

it('counts retries and zero-usage requests while taking only the last usage sample of each attempt', () => {
  const l = log()
  l.append('request/header', { reason: 'initial', header: { config: { provider: 'one', model: 'shared' } } })
  l.append('assistant/attempt', { turn: 1, step: 1, stream: [
    { type: 'chunk', time: 1, chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } } },
    { type: 'chunk', time: 2, chunk: { type: 'usage', usage } },
  ] })
  l.append('assistant/message', { turn: 1, step: 1, stream: [
    { type: 'chunk', time: 1, chunk: { type: 'usage', usage: { inputTokens: 99, outputTokens: 99 } } },
  ], usage, message: createMessage({ role: 'assistant', content: [], source: { kind: 'model', provider: 'one', model: 'shared' } }) })
  l.append('assistant/attempt', { turn: 1, step: 2, stream: [] })
  l.append('assistant/attempt', { turn: 1, step: 3, stream: [
    { type: 'chunk', time: 1, chunk: { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } } },
  ] })
  const models = new Map<string, ModelUsage>()
  collectUsage(models, l.events, SessionLogOffset(0), {})
  expect([...models.values()]).toEqual([{ provider: 'one', model: 'shared', requests: 4, reportedRequests: 3,
    inputTokens: 32, outputTokens: 10, totalTokens: 42, cacheReadTokens: 8, cacheWriteTokens: 4 }])
})

it('separates providers and model switches, and retains unknown routes on older failed attempts', () => {
  const l = log()
  l.append('assistant/attempt', { turn: 1, step: 1, stream: [] })
  l.append('request/context', { provider: 'one', model: 'shared' })
  l.append('assistant/attempt', { turn: 1, step: 2, stream: [] })
  l.append('request/header', { reason: 'initial', header: { config: { provider: 'two', model: 'shared' } } })
  l.append('assistant/attempt', { turn: 1, step: 3, stream: [] })
  l.append('assistant/message', { turn: 1, step: 4, stream: [], usage,
    message: createMessage({ role: 'assistant', content: [], source: { kind: 'model', provider: 'two', model: 'different' } }) })
  const models = new Map<string, ModelUsage>()
  collectUsage(models, l.events, SessionLogOffset(0), {})
  expect([...models.values()].map(row => [row.provider, row.model, row.requests])).toEqual([
    [null, null, 1], ['one', 'shared', 1], ['two', 'shared', 1], ['two', 'different', 1],
  ])
  expect(totalUsage([...models.values()])).toEqual({ requests: 4, reportedRequests: 1,
    inputTokens: 16, outputTokens: 5, totalTokens: 21, cacheReadTokens: 4, cacheWriteTokens: 2 })
})

it('excludes inherited requests but reads their route metadata for new child requests', () => {
  const l = log()
  l.append('request/context', { provider: 'parent', model: 'model' })
  l.append('assistant/attempt', { turn: 1, step: 1, stream: [] })
  l.append('assistant/attempt', { turn: 2, step: 1, stream: [] })
  const models = new Map<string, ModelUsage>()
  collectUsage(models, l.events, SessionLogOffset(2), {})
  expect([...models.values()]).toEqual([{ provider: 'parent', model: 'model', ...emptyUsage(), requests: 1 }])
})

it('filters by dispatch time with inclusive start and exclusive end, falling back to settlement for old logs', () => {
  const l = log()
  for (const requestSentTime of [99, 100, 199, 200]) l.append('assistant/attempt', { turn: 1, step: 1, stream: [], requestSentTime }, 900)
  l.append('assistant/attempt', { turn: 1, step: 1, stream: [] }, 150)
  const models = new Map<string, ModelUsage>()
  collectUsage(models, l.events, SessionLogOffset(0), { since: 100, until: 200 })
  expect(totalUsage([...models.values()]).requests).toBe(3)
})

it('ignores output checkpoints and synthetic crash-repair messages without a settled attempt', () => {
  const l = log()
  l.append('assistant/output-item', { turn: 1, step: 1, index: 0, block: { type: 'text', text: 'partial' }, provider: 'one', model: 'model' })
  l.append('assistant/message', { turn: 1, step: 1, stream: [], interrupted: true,
    message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'partial' }], source: { kind: 'model', provider: 'one', model: 'model' } }) })
  const models = new Map<string, ModelUsage>()
  collectUsage(models, l.events, SessionLogOffset(0), {})
  expect(totalUsage([...models.values()])).toEqual(emptyUsage())
})

function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const query = {
    listSessions: vi.fn<SessionQueryEngine['listSessions']>().mockResolvedValue([]),
    observeSession: vi.fn<SessionQueryEngine['observeSession']>(),
  }
  ctx.provide('sessionQuery', query as never)
  return { query, controller: new UsageController(ctx) }
}

it('rejects invalid wire time ranges before querying the corpus', async () => {
  const { query, controller } = fixture()
  const signal = new AbortController().signal
  for (const request of [{ since: -1 }, { until: Infinity }, { since: 0.5 }, { since: 2, until: 2 }, { since: 3, until: 2 }]) {
    await expect(controller.snapshot(request, signal)).rejects.toMatchObject({ code: 'gateway/bad-request' })
  }
  expect(query.listSessions).not.toHaveBeenCalled()
})

it('combines retained Sessions and orders models by tokens, then requests, then route', async () => {
  const { query, controller } = fixture()
  const first = log()
  for (const model of ['beta', 'alpha', 'gamma', 'largest']) {
    first.append('assistant/message', { turn: 1, step: 1, stream: [], usage: {
      inputTokens: model === 'largest' ? 20 : 10, outputTokens: 5,
    }, message: createMessage({ role: 'assistant', content: [], source: { kind: 'model', provider: 'one', model } }) })
  }
  const second = log()
  second.append('request/context', { provider: 'one', model: 'gamma' })
  second.append('assistant/attempt', { turn: 1, step: 1, stream: [] })
  const headers: SessionHeader[] = ['first', 'second'].map(name => ({
    id: SessionId(name), version: SESSION_FORMAT_VERSION, createdAt: 0, isSeeded: false, delegationDepth: 0,
  }))
  query.listSessions.mockResolvedValue(headers.map(header => ({ header, live: false, persisted: true })))
  const dispose = vi.fn()
  query.observeSession.mockImplementation(async (id) => {
    const index = headers.findIndex(header => header.id === id)
    const events = index === 0 ? first.events : second.events
    const observation: SessionObservation = {
      source: 'prepared', header: headers[index]!, inheritedEventCount: SessionLogOffset(0),
      cursor: SessionSeq(events.length - 1), events, retain: () => observation, [Symbol.dispose]: dispose,
    }
    return observation
  })
  const signal = new AbortController().signal
  const snapshot = await controller.snapshot({}, signal)
  expect(snapshot.models.map(row => row.model)).toEqual(['largest', 'gamma', 'alpha', 'beta'])
  expect(snapshot.totals).toEqual({ requests: 5, reportedRequests: 4, inputTokens: 50, outputTokens: 20,
    totalTokens: 70, cacheReadTokens: 0, cacheWriteTokens: 0 })
  expect(query.observeSession).toHaveBeenCalledWith(headers[0]!.id, { signal, projectionMode: 'none' })
  expect(dispose).toHaveBeenCalledTimes(2)
})

it('returns complete empty totals, releases observation leases and propagates read errors', async () => {
  const { query, controller } = fixture()
  const signal = new AbortController().signal
  expect(await controller.snapshot({}, signal)).toMatchObject({ totals: emptyUsage(), models: [] })
  const header: SessionHeader = { id: SessionId('usage-test'), version: SESSION_FORMAT_VERSION, createdAt: 0, isSeeded: false, delegationDepth: 0 }
  query.listSessions.mockResolvedValue([{ header, live: false, persisted: true }])
  const dispose = vi.fn()
  const observation: SessionObservation = {
    source: 'prepared', header, inheritedEventCount: SessionLogOffset(0), cursor: -1, events: [],
    retain: () => observation, [Symbol.dispose]: dispose,
  }
  query.observeSession.mockResolvedValue(observation)
  await controller.snapshot({}, signal)
  expect(dispose).toHaveBeenCalledOnce()
  const failure = new Error('Unreadable history')
  query.observeSession.mockRejectedValue(failure)
  await expect(controller.snapshot({}, signal)).rejects.toBe(failure)
  const aborted = new AbortController()
  aborted.abort()
  await expect(controller.snapshot({}, aborted.signal)).rejects.toMatchObject({ name: 'AbortError' })
})
