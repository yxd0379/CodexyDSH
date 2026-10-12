/** Human memory operations retain their receiving Session and reject incomplete or stale edits. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MemoryConflictError, MemoryRevision } from '@codexydsh/memory'
import type { Memory } from '@codexydsh/memory'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it, vi } from 'vitest'
import MemoryController from '../src/index.ts'

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })
const revision = MemoryRevision('read-revision')

function fixture() {
  const ctx = new Context()
  roots.push(ctx)
  const provider = {
    snapshot: vi.fn<Memory['snapshot']>().mockResolvedValue({ root: '/memory', version: 'v2', summary: '', running: false }),
    list: vi.fn<Memory['list']>().mockResolvedValue({ path: null, entries: [], next_cursor: null, truncated: false }),
    read: vi.fn<Memory['read']>().mockResolvedValue({ path: 'MEMORY.md', start_line_number: 1, content: 'original', truncated: false, revision }),
    search: vi.fn<Memory['search']>().mockResolvedValue({ queries: ['hello'], match_mode: { type: 'any' }, path: null, matches: [], next_cursor: null, truncated: false }),
    edit: vi.fn<Memory['edit']>().mockResolvedValue(MemoryRevision('published')),
    refresh: vi.fn<Memory['refresh']>().mockResolvedValue({ extracted: 0, skipped: 1, consolidated: false }),
  }
  let route: { provider?: string; model?: string } = { provider: 'current-provider', model: 'current-model' }
  const prepare = vi.fn(async () => ({ variables: route }))
  ctx.provide('codexyPrompt', { prepare } as never)
  ctx.provide('memory', provider as never)
  const id = SessionId('memory-owner')
  const agent = { id, session: { id }, ctx, options: { provider: 'original-provider', model: 'original-model' } } as Agent
  return { controller: new MemoryController(ctx), provider, prepare, agent, signal: new AbortController().signal,
    clearSelectedRoute: () => { route = {} } }
}

it('passes exact Session ownership and cancellation to public reads', async () => {
  const b = fixture()
  await b.controller.snapshot(b.agent, b.signal)
  expect(b.provider.snapshot).toHaveBeenCalledExactlyOnceWith(b.signal)
  await b.controller.list(b.agent, { path: 'rollout_summaries' }, b.signal)
  expect(b.provider.list).toHaveBeenCalledExactlyOnceWith({ path: 'rollout_summaries' }, { session: b.agent.session, signal: b.signal })
  await b.controller.read(b.agent, { path: 'MEMORY.md' }, b.signal)
  expect(b.provider.read).toHaveBeenCalledExactlyOnceWith({ path: 'MEMORY.md' }, { session: b.agent.session, signal: b.signal })
  await b.controller.search(b.agent, { queries: ['hello'] }, b.signal)
  expect(b.provider.search).toHaveBeenCalledExactlyOnceWith({ queries: ['hello'] }, { session: b.agent.session, signal: b.signal })
})

it('rejects truncated reads, stale revisions, and managed detail edits before a write', async () => {
  const b = fixture()
  const request = { path: 'MEMORY.md', content: 'replacement', expectedRevision: revision }
  b.provider.read.mockResolvedValueOnce({ path: 'MEMORY.md', start_line_number: 1, content: 'part', truncated: true, revision })
  await expect(b.controller.edit(b.agent, request, b.signal)).rejects.toMatchObject({ code: 'memory/truncated' })
  await expect(b.controller.edit(b.agent, { ...request, expectedRevision: MemoryRevision('stale') }, b.signal)).rejects.toMatchObject({ code: 'memory/conflict' })
  await expect(b.controller.edit(b.agent, { ...request, path: 'rollout_summaries/one.md' }, b.signal)).rejects.toMatchObject({ code: 'gateway/bad-request' })
  expect(b.provider.edit).not.toHaveBeenCalled()
})

it('preserves provider CAS failures after the preliminary complete read', async () => {
  const b = fixture()
  const request = { path: 'MEMORY.md', content: 'replacement', expectedRevision: revision }
  b.provider.edit.mockRejectedValueOnce(new MemoryConflictError('MEMORY.md'))
  await expect(b.controller.edit(b.agent, request, b.signal)).rejects.toMatchObject({ code: 'memory/conflict' })
  expect(b.provider.edit).toHaveBeenCalledExactlyOnceWith(request, { session: b.agent.session, signal: b.signal })
})

it('publishes a complete human edit through the Session-owned provider operation', async () => {
  const b = fixture()
  const request = { path: 'MEMORY.md', content: 'replacement', expectedRevision: revision }
  expect(await b.controller.edit(b.agent, request, b.signal)).toBe(MemoryRevision('published'))
  expect(b.provider.edit).toHaveBeenCalledExactlyOnceWith(request, { session: b.agent.session, signal: b.signal })
})

it('refreshes using current prompt-prepared provider/model rather than initial Agent options', async () => {
  const b = fixture()
  await b.controller.refresh(b.agent, b.signal)
  expect(b.prepare).toHaveBeenCalledExactlyOnceWith({ agent: b.agent, scope: b.agent, signal: b.signal })
  expect(b.provider.refresh).toHaveBeenCalledExactlyOnceWith({ session: b.agent.session, signal: b.signal,
    route: { provider: 'current-provider', model: 'current-model' }, force: true })
})

it('uses explicit initial options when preparation has no selected route', async () => {
  const b = fixture()
  b.clearSelectedRoute()
  await b.controller.refresh(b.agent, b.signal)
  expect(b.provider.refresh).toHaveBeenCalledWith(expect.objectContaining({ route: { provider: 'original-provider', model: 'original-model' } }))
})
