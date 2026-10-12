import { mountAgentLoopTestDependencies } from '@codexydsh/runtime-testkit'
import { projectProductEvent } from '@codexydsh/runtime/events'
import type { SessionEvent as ProductSessionEvent } from '@codexydsh/runtime/types'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@codexydsh/runtime/llm'
import type { GenerateOptions, StreamChunk } from '@codexydsh/runtime/llm'
import SessionStore, { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistence, SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import type { SessionAccess, SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@codexydsh/runtime/prompt'
import ToolRuntime from '@codexydsh/runtime/tools'
import CodexfulAgentLoop from '@codexydsh/runtime'
import CodexfulMemory from '../src/index.ts'
import { resolveConfig } from '../src/config.ts'

/** Per-case workspace artifacts are retained under the user's no-deletion rule. */
export async function privateRoot(): Promise<string> {
  const parent = resolve('.playwright-mcp')
  await mkdir(parent, { recursive: true })
  return mkdtemp(resolve(parent, 'codexful-memory-tests-'))
}

/** Captures actual Session events and exposes the ordinary read-handle API. */
class SourcePersistence extends SessionPersistence {
  private readonly stored = new Map<SessionId, { header: SessionHeader; events: SessionEvent[] }>()
  constructor(ctx: Context) {
    super(ctx)
    ctx.on('session/created', (session) => { if (!this.stored.has(session.id)) this.stored.set(session.id, { header: session.header, events: [] }) })
    ctx.on('session/event', (session, event) => { this.stored.get(session.id)?.events.push(event) })
  }
  override async create(header: SessionHeader): Promise<SessionHandle> {
    const stored = { header, events: [] as SessionEvent[] }
    this.stored.set(header.id, stored)
    return { id: header.id, header, access: 'write', inheritedEventCount: SessionLogOffset(0),
      read: async () => ({ events: [...stored.events], eventState: 'shared-frozen' }),
      append: async (events) => { for (const event of events) if (event.seq >= stored.events.length) stored.events.push(event) },
      flush: async () => {}, close: async () => {}, [Symbol.asyncDispose]: async () => {} }
  }
  override async open(id: SessionId, access: SessionAccess): Promise<SessionHandle> {
    if (access !== 'read') throw new Error('Memory must only read historical Sessions')
    const stored = this.stored.get(id)
    if (stored === undefined) throw new Error('Missing source Session')
    return { id, header: stored.header, access, inheritedEventCount: SessionLogOffset(0),
      read: async () => ({ events: [...stored.events], eventState: 'shared-frozen' }),
      append: async () => { throw new Error('Source Session is read-only') }, flush: async () => {}, close: async () => {}, [Symbol.asyncDispose]: async () => {} }
  }
  override async flush(): Promise<void> {}
  override async stat(id: SessionId) {
    const stored = this.stored.get(id)
    return stored === undefined ? undefined : { header: stored.header, revision: SessionPersistenceRevision(String(stored.events.length)) }
  }
  override async list() { return [...this.stored.values()].map(stored => ({ header: stored.header, revision: SessionPersistenceRevision(String(stored.events.length)) })) }
  events(id: SessionId): readonly SessionEvent[] { return this.stored.get(id)?.events ?? [] }
}

/** Emits explicit scripted completions while recording every auxiliary and foreground request. */
export class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  responses: (string | ((request: GenerateOptions) => Promise<string>))[] = []
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    this.requests.push(options)
    const response = this.responses.shift()
    if (response === undefined) throw new Error('Unexpected model request')
    const text = typeof response === 'string' ? response : await response(options)
    options.signal?.throwIfAborted()
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export async function harness(options: { version?: 'v1' | 'v2'; generateMemories?: boolean; dedicatedTools?: boolean; minRolloutIdleHours?: number } = {}) {
  const root = await privateRoot()
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(SourcePersistence)
    await ctx.plugin(CodexfulAgentLoop, { agents: [] })
    const adapter = new ScriptedAdapter()
    ctx.effect(() => ctx.codexyRequests.registerAdapter(['recording'], adapter), 'memory-tests.adapter')
    ctx.effect(() => ctx.codexyPrompt.section({ name: 'fixture:base', order: 0, complete: true, text: 'BASE' }), 'memory-tests.base')
    ctx.on('codexy-prompt/assemble', async (_assembly, _context, next) => ({ ...await next(), contextSnapshotIntro: 'none' }))
    await ctx.plugin(CodexfulMemory, resolveConfig({ root, ...options }))
    const events = new Map<SessionId, ProductSessionEvent[]>()
    ctx.on('session/event', (session, event) => {
      let list = events.get(session.id)
      if (list === undefined) { list = []; events.set(session.id, list) }
      list.push(projectProductEvent(event))
    })
    return { root, ctx, adapter, events }
  } catch (error) { await ctx.fiber.dispose(); throw error }
}

export function sourceSession(ctx: Context, id: string, text: string): Session {
  const session = ctx.sessions.create(SessionId(id), { meta: { cwd: '/workspace' } })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session
}

export const extracted = JSON.stringify({ raw_memory: 'Prefer focused tests.', rollout_summary: 'The user prefers focused tests and explicit evidence.', rollout_slug: 'focused-tests' })
export const consolidated = JSON.stringify({ memory_summary: 'Prefer focused tests.', memory: '# Memory\nPrefer focused tests.\n', skills: [] })
