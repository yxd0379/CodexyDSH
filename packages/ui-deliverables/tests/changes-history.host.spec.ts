/** Complete file-only observations retain original edits independently of the Chat page. */
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { SessionId, SessionLogOffset, SessionSeq, SESSION_FORMAT_VERSION, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionQueryError, type SessionObservation, type SessionObservationOptions } from '@deepseek-ai/dsh-session-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectChangesHistory } from '../src/changes-history.ts'
import { CHANGES_HISTORY_PATH, changesHistoryUrl, isChangesHistory, recordedFileDiffs } from '../src/changes.ts'
import { registerPresentOpen } from '../src/present-open.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0 })

const sessionId = SessionId('full-history')
const edit = (seq: number, turn: number, path: string, isError = false): SessionEvent<'tool/result'> => {
  const callId = ToolCallId(`patch-${seq}`)
  return { seq: SessionSeq(seq), time: seq + 1, type: 'tool/result', surfaceOp: 'append', data: { turn, step: 1,
    message: createMessage({ role: 'tool', toolCallId: callId, source: { kind: 'tool', callId },
      content: [{ type: 'text', text: 'Raw tool output must stay on the Host' }], ...isError ? { isError: true } : {} }),
    meta: { diffs: [{ path, oldText: null, newText: `content-${seq}\n` }] },
  } }
}

const events: SessionEvent[] = [
  { type: 'user/message', seq: SessionSeq(0), time: 1, surfaceOp: 'append',
    data: createUserMessage({ content: [{ type: 'text', text: 'Private model context' }], source: { kind: 'user' } }) },
  edit(1, 1, 'src/old.ts'),
  { type: 'workspace/changes', seq: SessionSeq(2), time: 3, data: { turn: 1 } },
  edit(3, 20, 'src/middle.ts'),
  edit(4, 99, 'src/latest.ts'),
  edit(5, 99, 'src/latest.ts'),
  edit(6, 99, 'src/failed.ts', true),
  { type: 'workspace/changes', seq: SessionSeq(7), time: 8, data: { turn: 99 } },
  { type: 'workspace/changes', seq: SessionSeq(8), time: 9, data: { turn: 99 } },
]

async function fixture() {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const dispose = vi.fn()
  const observation: SessionObservation = {
    source: 'prepared', header: { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1, isSeeded: true },
    inheritedEventCount: SessionLogOffset(2), events, cursor: SessionSeq(8),
    retain: () => observation, [Symbol.dispose]: dispose,
  }
  const observeSession = vi.fn(async (_id: SessionId, _options?: SessionObservationOptions) => observation)
  ctx.provide('sessionQuery', { observeSession } as never)
  const desktop = vi.fn(() => ({ name: 'web', available: false, fileManager: null }))
  ctx.provide('sessionController', { workspaceDesktop: desktop } as never)
  const connection = new HostConnectionService(ctx, [], {} as ConstructorParameters<typeof HostConnectionService>[2])
  await ctx.plugin({ inject: ['connection', 'sessionQuery', 'sessionController'], apply: registerPresentOpen })
  const handler = connection.createSharedFetchHandler('/api')
  const read = (query = '?sessionId=full-history', signal?: AbortSignal) =>
    handler.fetch(new Request(`http://localhost${CHANGES_HISTORY_PATH}${query}`, signal === undefined ? {} : { signal }))
  return { ctx, observation, observeSession, dispose, desktop, read }
}

describe('complete Session changes', () => {
  it('returns early, inherited and latest edits with genuine coordinates, omitting prompts and raw output', async () => {
    const { read, observeSession, dispose, desktop } = await fixture()
    const response = await read()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const result: unknown = await response.json()
    expect(isChangesHistory(result)).toBe(true)
    expect(result).toEqual({ throughSeq: 8, turns: [
      { turn: 1, changes: { seq: 2 }, diffs: [{ path: 'src/old.ts', oldText: null, newText: 'content-1\n', callId: 'patch-1' }] },
      { turn: 20, diffs: [{ path: 'src/middle.ts', oldText: null, newText: 'content-3\n', callId: 'patch-3' }] },
      { turn: 99, changes: { seq: 8 }, diffs: [
        { path: 'src/latest.ts', oldText: null, newText: 'content-4\n', callId: 'patch-4' },
        { path: 'src/latest.ts', oldText: null, newText: 'content-5\n', callId: 'patch-5' },
      ] },
    ] })
    expect(JSON.stringify(result)).not.toContain('Private model context')
    expect(JSON.stringify(result)).not.toContain('Raw tool output')
    expect(observeSession).toHaveBeenCalledOnce()
    expect(observeSession.mock.calls[0]?.[0]).toBe(sessionId)
    expect(observeSession.mock.calls[0]?.[1]?.projectionMode).toBe('none')
    expect(observeSession.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
    expect(dispose).toHaveBeenCalledOnce()
    expect(desktop).not.toHaveBeenCalled()
    expect(changesHistoryUrl(sessionId)).toBe('api/changes.history?sessionId=full-history')
  })

  it('excludes tool surface rewrites so an edit is counted only once', () => {
    const rewrite: SessionEvent<'tool/result'> = { ...edit(9, 99, 'src/rewritten.ts'), surfaceOp: { op: 'replace', startSeq: SessionSeq(4), endSeq: SessionSeq(4) } }
    expect(collectChangesHistory([...events, rewrite], 9)).toEqual({ ...collectChangesHistory(events, 8), throughSeq: 9 })
  })

  it('rejects missing coordinates and maps missing or failed observations without leaking Host errors', async () => {
    const { read, observeSession } = await fixture()
    expect((await read('')).status).toBe(400)
    expect(observeSession).not.toHaveBeenCalled()
    observeSession.mockRejectedValueOnce(new SessionQueryError('private path', 'SESSION_QUERY_SESSION_NOT_FOUND'))
    expect((await read()).status).toBe(404)
    observeSession.mockRejectedValueOnce(new Error('private path'))
    const failed = await read()
    expect(failed.status).toBe(500)
    expect(await failed.text()).not.toContain('private path')
  })

  it('releases a late observation after its browser request is cancelled', async () => {
    const { read, observeSession, observation, dispose } = await fixture()
    const deferred = Promise.withResolvers<SessionObservation>()
    observeSession.mockReturnValueOnce(deferred.promise)
    const controller = new AbortController()
    const result = read(undefined, controller.signal)
    const rejected = expect(result).rejects.toThrow()
    controller.abort()
    deferred.resolve(observation)
    await rejected
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('validates inventories and filters malformed presentation metadata at the wire boundary', () => {
    expect(isChangesHistory({ throughSeq: -1, turns: [] })).toBe(true)
    const valid = collectChangesHistory(events, 8)
    expect(isChangesHistory(valid)).toBe(true)
    for (const value of [null, {}, { ...valid, throughSeq: -2 }, { ...valid, throughSeq: 1.5 },
      { ...valid, turns: [{ turn: 0, changes: { seq: 1 } }] }, { ...valid, turns: [{ turn: 1 }] },
      { ...valid, turns: [{ turn: 1, changes: { seq: 9 } }] }, { ...valid, turns: [{ turn: 1, diffs: [{}] }] },
      { ...valid, turns: [valid.turns[1], valid.turns[0]] },
    ]) expect(isChangesHistory(value)).toBe(false)
    expect(recordedFileDiffs({ diffs: [{ path: 'a', oldText: null, newText: 'x' }, {}, { path: 'b', oldText: 2, newText: 'x' }] }, ToolCallId('real')))
      .toEqual([{ path: 'a', oldText: null, newText: 'x', callId: 'real' }])
  })
})
