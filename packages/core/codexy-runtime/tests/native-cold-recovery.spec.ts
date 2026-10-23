import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import {
  createMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import { appendProductEvent, encodeProductEvents, platformHeader, requestHeaderOf, snapshotProductEvents } from '@codexydsh/runtime/session'
import type { EpochHeader } from '@codexydsh/runtime/session'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'

describe('native Session persistence for Codexy', () => {
  it('restores model history and required product facts after closing every writer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codexy-native-recovery-'))
    const contexts: Context[] = []
    const handles: SessionHandle[] = []
    onTestFinished(async () => {
      try {
        for (const handle of handles.reverse()) await handle.close()
        for (const instance of contexts.reverse()) await instance.fiber.dispose()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
    const context = new Context()
    contexts.push(context)
    await context.plugin(SessionStore)
    await context.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const session = context.sessions.create(SessionId('native-cold-recovery'), { meta: { cwd: root } })
    const writer = await context.sessionPersistence.create(session.header)
    handles.push(writer)

    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('system/message', {
      turn: 1,
      step: 1,
      message: createSystemMessage('Read the requested file and report its contents.'),
    }, { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Read README.md.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const header: EpochHeader = {
      config: {
        provider: 'fixture',
        model: 'fixture',
        codexfulResponses: {
          omitDefaultMaxTokens: true,
          reasoningSummary: 'auto',
          wireProfile: 'codex-0.162.1',
          strictModelInput: true,
          clientMetadata: { 'x-codex-turn-id': 'cold-recovery-turn' },
        },
      },
      tools: [
        { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
        {
          kind: 'freeform',
          name: 'apply_patch',
          description: 'Apply a patch.',
          format: { type: 'grammar', syntax: 'regex', definition: '[\\s\\S]+' },
          namespace: { name: 'functions', description: 'Workspace tools.', toolName: 'apply_patch' },
        },
      ],
    }
    session.append('request/header', { reason: 'initial', header: platformHeader(header) })
    appendProductEvent(session, 'request/header', { reason: 'initial', header })
    appendProductEvent(session, 'runtime/feature', { name: 'native-request-header', version: 1 })
    const call = {
      type: 'tool-call' as const,
      id: ToolCallId('read-readme'),
      name: 'read_file',
      arguments: '{"path":"README.md"}',
    }
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant', content: [call], source: { kind: 'model', provider: 'fixture', model: 'fixture' },
      }),
      stream: [
        { type: 'chunk', time: 1, chunk: { type: 'block-start', index: 0, blockType: 'tool-call' } },
        { type: 'chunk', time: 2, chunk: { type: 'block-end', index: 0, block: call } },
        { type: 'chunk', time: 3, chunk: { type: 'finish', reason: { kind: 'tool-calls' } } },
      ],
    }, { surfaceOp: 'append' })
    session.append('tool/call', {
      turn: 1, step: 1, callId: call.id, name: call.name, arguments: call.arguments,
    })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: '# CodexyDSH' }], isError: false }),
    }, { surfaceOp: 'append' })
    appendProductEvent(session, 'request/feature', { name: 'codexful-responses', version: 1 })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const transcript = session.deriveMessages()
    const events = session.snapshotEvents()
    const productEvents = snapshotProductEvents(session)
    expect(transcript.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'tool'])
    expect(events.filter(event => event.type === 'codexy/fact')).toHaveLength(3)
    expect(productEvents.filter(event => event.type === 'runtime/feature' || event.type === 'request/feature'))
      .toHaveLength(2)
    expect(requestHeaderOf(session)).toEqual(header)
    expect(session.requestHeader()).toEqual(platformHeader(header))
    expect(encodeProductEvents(productEvents)).toEqual(events)
    await expect(context.sessions.flush(session)).resolves.toBe(true)
    await writer.close()
    await context.fiber.dispose()

    const restarted = new Context()
    contexts.push(restarted)
    await restarted.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const reader = await restarted.sessionPersistence.open(session.id, 'read')
    handles.push(reader)
    try {
      const restored = await reader.read()
      expect(restored.events).toEqual(events)
      const recovered = Session.fromRestore(
        session.id, restored.events, reader.header, reader.inheritedEventCount, restored.eventState,
      )
      expect(recovered.deriveMessages()).toEqual(transcript)
      expect(requestHeaderOf(recovered)).toEqual(header)
      expect(recovered.requestHeader()).toEqual(platformHeader(header))
      const recoveredEvents = snapshotProductEvents(recovered)
      expect(recoveredEvents.slice(0, productEvents.length)).toEqual(productEvents)
      expect(recoveredEvents.slice(productEvents.length)).toEqual([
        { type: 'session/end-seed', seq: events.length, time: expect.any(Number), data: {} },
      ])
    } finally {
      await reader.close()
    }
  })
})
