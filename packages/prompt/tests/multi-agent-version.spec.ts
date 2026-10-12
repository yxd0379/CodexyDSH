import { snapshotProductEvents } from '@codexydsh/runtime/session'
import { decodeCodexyArtifact } from '@codexydsh/runtime/persistence'
/** Durable delegation selection across Session replay, forks, and history replacement. */

import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@codexydsh/runtime/llm'
import SessionStore, { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it } from 'vitest'
import {
  codexfulMultiAgentVersion,
  codexfulMultiAgentVersionProjection,
  recordCodexfulMultiAgentVersion,
} from '../src/multi-agent-version.ts'

async function withRegistry(
  run: (ctx: Context, session: Session) => void | Promise<void>,
  register = true,
): Promise<void> {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    if (register) ctx.sessionProjections.register(codexfulMultiAgentVersionProjection)
    await run(ctx, ctx.sessions.create(SessionId('delegation-version')))
  } finally {
    await ctx.fiber.dispose()
  }
}

describe('Codexful delegation version', () => {
  it('stores its model-visible selection as a required product fact that survives cold decoding', async () => {
    await withRegistry((ctx, session) => {
      recordCodexfulMultiAgentVersion(ctx.sessionProjections, session, 'v2')
      const raw = session.snapshotEvents()
      expect(raw[0]).toMatchObject({ type: 'codexy/fact', data: { type: 'codexful/multi-agent-version', data: { version: 'v2' } } })
      expect(raw[0]?.ignorable).toBeUndefined()
      const metadata = { kind: 'codexy-session', version: 1, session: session.header, inheritedEventCount: 0 }
      const artifact = decodeCodexyArtifact(Buffer.from([metadata, ...raw].map(row => JSON.stringify(row)).join('\n') + '\n'))
      const restored = Session.fromRestore(session.id, artifact.events, artifact.metadata.session, artifact.metadata.inheritedEventCount, 'detached')
      expect(codexfulMultiAgentVersion(ctx.sessionProjections, restored)).toBe('v2')
    })
  })

  it('restores its host-only selection from the Session log and persisted projection', async () => {
    await withRegistry((ctx, session) => {
      expect(codexfulMultiAgentVersion(ctx.sessionProjections, session)).toBeNull()
      recordCodexfulMultiAgentVersion(ctx.sessionProjections, session, 'v2')

      const replayed = Session.create(session.id, session.snapshotEvents(), session.header)
      expect(codexfulMultiAgentVersion(ctx.sessionProjections, replayed)).toBe('v2')
      expect(replayed.deriveMessages()).toEqual([])

      const checkpoint = ctx.sessionProjections.checkpoint(session)
      const restored = ctx.sessionProjections.restore(
        checkpoint, [], session.seq, session.header, session.inheritedEventCount,
      )
      expect(restored.checkpoint['codexfulMultiAgentVersion']).toEqual(checkpoint['codexfulMultiAgentVersion'])
      expect(restored.checkpoint['codexfulMultiAgentVersion']?.val).toBe('v2')
      expect(restored.snapshot.values).toEqual({})
    })
  })

  it('records repeated selections only once, including after replay', async () => {
    await withRegistry((ctx, session) => {
      recordCodexfulMultiAgentVersion(ctx.sessionProjections, session, 'v1')
      recordCodexfulMultiAgentVersion(ctx.sessionProjections, session, 'v1')
      expect(session.snapshotEvents()).toHaveLength(1)

      const replayed = Session.create(session.id, session.snapshotEvents(), session.header)
      recordCodexfulMultiAgentVersion(ctx.sessionProjections, replayed, 'v1')
      expect(snapshotProductEvents(replayed).filter(event => event.type === 'codexful/multi-agent-version'))
        .toEqual(snapshotProductEvents(session))
    })
  })

  it('records an explicit v2 override of a previous v1 selection', async () => {
    await withRegistry((ctx, session) => {
      recordCodexfulMultiAgentVersion(ctx.sessionProjections, session, 'v1')
      recordCodexfulMultiAgentVersion(ctx.sessionProjections, session, 'v2')
      recordCodexfulMultiAgentVersion(ctx.sessionProjections, session, 'v2')

      expect(snapshotProductEvents(session).map(event => event.data)).toEqual([{ version: 'v1' }, { version: 'v2' }])
      expect(codexfulMultiAgentVersion(ctx.sessionProjections, session)).toBe('v2')
    })
  })

  it('inherits the selected version through the fork seed without following later parent changes', async () => {
    await withRegistry((ctx, session) => {
      recordCodexfulMultiAgentVersion(ctx.sessionProjections, session, 'v1')
      session.append('turn/start', { turn: 1 })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'parent task' }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      const child = ctx.sessions.fork(session, undefined, SessionId('delegation-version-child'))

      expect(codexfulMultiAgentVersion(ctx.sessionProjections, child)).toBe('v1')
      expect(child.snapshotEvents(SessionLogOffset(0), child.inheritedEventCount))
        .toContainEqual(session.snapshotEvents()[0])
      const eventCount = child.seq
      recordCodexfulMultiAgentVersion(ctx.sessionProjections, child, 'v1')
      expect(child.seq).toBe(eventCount)

      recordCodexfulMultiAgentVersion(ctx.sessionProjections, session, 'v2')
      expect(codexfulMultiAgentVersion(ctx.sessionProjections, session)).toBe('v2')
      expect(codexfulMultiAgentVersion(ctx.sessionProjections, child)).toBe('v1')
    })
  })

  it('keeps the version after replacing the model history with a compact summary', async () => {
    await withRegistry((ctx, session) => {
      recordCodexfulMultiAgentVersion(ctx.sessionProjections, session, 'v2')
      const original = session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'long original task' }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      const summary = createUserMessage({
        content: [{ type: 'text', text: 'compact summary' }], source: { kind: 'runtime-context' },
      })
      session.append('user/message', summary, {
        surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq },
        sourceEventSeqs: [original.seq],
      })

      expect(session.deriveMessages()).toEqual([summary])
      expect(codexfulMultiAgentVersion(ctx.sessionProjections, session)).toBe('v2')
      const replayed = Session.create(session.id, session.snapshotEvents(), session.header)
      expect(replayed.deriveMessages()).toEqual([summary])
      expect(codexfulMultiAgentVersion(ctx.sessionProjections, replayed)).toBe('v2')
    })
  })

  it('requires its owning projection before reading or recording a selection', async () => {
    await withRegistry((ctx, session) => {
      expect(() => codexfulMultiAgentVersion(ctx.sessionProjections, session))
        .toThrow('Codexful delegation requires its Session version projection')
      expect(() => { recordCodexfulMultiAgentVersion(ctx.sessionProjections, session, 'v1') })
        .toThrow('Codexful delegation requires its Session version projection')
      expect(session.snapshotEvents()).toEqual([])
    }, false)
  })

  it.each(['v3', true, { version: 'v2' }])('rejects an invalid persisted projection value %j', async (value) => {
    await withRegistry((ctx, session) => {
      recordCodexfulMultiAgentVersion(ctx.sessionProjections, session, 'v1')
      const checkpoint = ctx.sessionProjections.checkpoint(session)
      const row = checkpoint['codexfulMultiAgentVersion']
      if (row === undefined) throw new Error('missing selected-version checkpoint')
      expect(() => ctx.sessionProjections.restore(
        { codexfulMultiAgentVersion: { ...row, val: value } },
        [], session.seq, session.header, session.inheritedEventCount,
      )).toThrow()
    })
  })

  it('rejects an invalid version when replaying persisted selection events', async () => {
    await withRegistry((ctx, session) => {
      recordCodexfulMultiAgentVersion(ctx.sessionProjections, session, 'v1')
      const encoded = JSON.stringify(session.snapshotEvents()).replace('"version":"v1"', '"version":"v3"')
      const invalidEvents = JSON.parse(encoded) as SessionEvent[]
      expect(() => ctx.sessionProjections.restore(
        {}, invalidEvents, SessionLogOffset(0), session.header, session.inheritedEventCount,
      )).toThrow()
    })
  })

  it('releases the projection when its contributing fiber unloads and reconstructs after registration', async () => {
    await withRegistry(async (ctx, session) => {
      const fiber = await ctx.plugin(Object.assign((owner: Context) => {
        owner.sessionProjections.register(codexfulMultiAgentVersionProjection)
      }, { inject: ['sessionProjections'] }))
      recordCodexfulMultiAgentVersion(ctx.sessionProjections, session, 'v2')
      expect(codexfulMultiAgentVersion(ctx.sessionProjections, session)).toBe('v2')

      await fiber.dispose()
      expect(() => codexfulMultiAgentVersion(ctx.sessionProjections, session))
        .toThrow('Codexful delegation requires its Session version projection')
      ctx.sessionProjections.register(codexfulMultiAgentVersionProjection)
      expect(codexfulMultiAgentVersion(ctx.sessionProjections, session)).toBe('v2')
    }, false)
  })
})
