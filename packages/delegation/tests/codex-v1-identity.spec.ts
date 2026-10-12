import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime, { codexV1IdentityOf, codexV1IdentityProjectionDefinition } from '../src/index.ts'

const header: SessionHeader = {
  version: SESSION_FORMAT_VERSION,
  id: SessionId('v1-identity'),
  createdAt: 0,
  isSeeded: true,
}

function identity(seq: number, nickname: string, agentPath?: string): SessionEvent<'subagent/codex-v1-identity'> {
  return {
    type: 'subagent/codex-v1-identity', seq: SessionSeq(seq), time: 0,
    data: { nickname, ...agentPath === undefined ? {} : { agentPath } },
  }
}

describe('Codex v1 child-owned identity', () => {
  it('excludes fork ancestors and preserves the own identity through checkpoint restoration', () => {
    const initial = codexV1IdentityProjectionDefinition.init(header, SessionLogOffset(2))
    expect(codexV1IdentityProjectionDefinition.apply(initial, identity(1, 'Ancestor'))).toBe(initial)
    const own = codexV1IdentityProjectionDefinition.apply(initial, identity(2, 'Ada', '/root/ada'))
    expect(codexV1IdentityProjectionDefinition.wire.view(own)).toEqual({ nickname: 'Ada', agentPath: '/root/ada', seq: 2 })
    const restored = codexV1IdentityProjectionDefinition.stateSchema.parse(JSON.parse(JSON.stringify(own)))
    expect(restored).toEqual(own)
    expect(codexV1IdentityProjectionDefinition.wire.view(initial)).toBeNull()
  })

  it('ignores unrelated events and clears malformed own durable identity', () => {
    const initial = codexV1IdentityProjectionDefinition.init(header, SessionLogOffset(0))
    const own = codexV1IdentityProjectionDefinition.apply(initial, identity(0, 'Ada'))
    expect(codexV1IdentityProjectionDefinition.apply(own, {
      type: 'turn/start', seq: SessionSeq(1), time: 0, data: { turn: 1 },
    })).toBe(own)
    expect(codexV1IdentityProjectionDefinition.wire.view(
      codexV1IdentityProjectionDefinition.apply(own, identity(1, '')),
    )).toBeNull()
    expect(() => codexV1IdentityProjectionDefinition.wire.viewSchema.parse({ nickname: 'Ada', seq: -1 })).toThrow()
    expect(() => codexV1IdentityProjectionDefinition.stateSchema.parse({
      inheritedEventCount: -1, identity: null,
    })).toThrow()
  })

  it('registers a nullable view with the service and removes it on unload', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(SessionProjectionRegistry)
      const service = await ctx.plugin(SubagentRuntime)
      const child = ctx.sessions.create()
      expect(codexV1IdentityOf(child, ctx.sessionProjections)).toBeNull()
      const event = child.append('subagent/codex-v1-identity', { nickname: 'Ada' })
      expect(codexV1IdentityOf(child, ctx.sessionProjections)).toEqual({ nickname: 'Ada', seq: event.seq })
      expect('surfaceOp' in event).toBe(false)
      expect(ctx.sessionProjections.snapshot(child).values.codexV1Identity).toEqual({ nickname: 'Ada', seq: event.seq })
      await service.dispose()
      expect(ctx.sessionProjections.snapshot(child).values.codexV1Identity).toBeUndefined()
      expect(() => codexV1IdentityOf(child, ctx.sessionProjections)).toThrow(/projection is unavailable/)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
