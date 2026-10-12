/** Memory-only durable wire choices; no Session files or temporary data are removed. */
import { describe, expect, it } from 'vitest'
import { createSystemMessage, createUserMessage } from '@codexydsh/runtime/llm'
import { Session, SessionId, SessionLogOffset, appendProductEvent, deriveProductMessages, requestHeaderOf } from '../src/session.ts'
import { decodeCodexyArtifact, encodeArtifactEvents, encodeArtifactHeader } from '../src/persistence-codec.ts'
import type { CodexyResponsesConfig } from '../src/types.ts'

function artifact(controls: CodexyResponsesConfig) {
  const id = SessionId('wire-profile-memory')
  const header = { version: 4 as const, id, createdAt: 1000, isSeeded: false }
  const session = Session.create(id, undefined, header)
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const base = createSystemMessage('ORIGINAL BASE\nverbatim')
  session.append('system/message', { turn: 1, step: 1, message: base }, { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  appendProductEvent(session, 'request/header', { reason: 'initial', header: {
    config: { provider: 'local', model: 'qwen3.8-27b-w8a8', codexfulResponses: controls },
  } })
  const bytes = Buffer.from(encodeArtifactHeader({ kind: 'codexy-session', version: 1, session: header,
    inheritedEventCount: SessionLogOffset(0) }) + encodeArtifactEvents(session.snapshotEvents()))
  return { bytes, base }
}

describe('durable Codex Responses wire profile', () => {
  it.each([undefined, 'codex-0.162.1'] as const)('restores the original base role, text, id and explicit wire choice=%s', (wireProfile) => {
    const controls: CodexyResponsesConfig = { omitDefaultMaxTokens: true, reasoningSummary: 'none',
      ...wireProfile === undefined ? {} : { wireProfile } }
    const { bytes, base } = artifact(controls)
    const decoded = decodeCodexyArtifact(bytes)
    const restored = Session.fromRestore(decoded.metadata.session.id, decoded.events, decoded.metadata.session,
      decoded.metadata.inheritedEventCount, 'detached')
    expect(deriveProductMessages(restored).find(message => message.role === 'system')).toEqual(base)
    expect(requestHeaderOf(restored)?.config.codexfulResponses).toEqual(controls)
    expect(encodeArtifactHeader(decoded.metadata) + encodeArtifactEvents(decoded.events)).toBe(bytes.toString())
  })

  it('does not accept an unknown wire version as a durable supported choice', () => {
    const { bytes } = artifact({ omitDefaultMaxTokens: true, reasoningSummary: 'none', wireProfile: 'codex-0.162.1' })
    const unsupported = Buffer.from(bytes.toString().replace('codex-0.162.1', 'codex-unknown'))
    expect(() => decodeCodexyArtifact(unsupported)).toThrow('invalid Codexy request controls')
  })

  it('restores captured metadata strings exactly without treating them as ordinary Responses metadata', () => {
    const controls: CodexyResponsesConfig = { omitDefaultMaxTokens: true, reasoningSummary: 'none',
      wireProfile: 'codex-0.162.1', clientMetadata: { installation_id: 'product-installation',
        turn_started_at_unix_ms: '1000', analytics_enabled: 'false' } }
    const { bytes } = artifact(controls)
    const decoded = decodeCodexyArtifact(bytes)
    const restored = Session.fromRestore(decoded.metadata.session.id, decoded.events, decoded.metadata.session,
      decoded.metadata.inheritedEventCount, 'detached')
    expect(requestHeaderOf(restored)?.config.codexfulResponses).toEqual(controls)
    expect(encodeArtifactHeader(decoded.metadata) + encodeArtifactEvents(decoded.events)).toBe(bytes.toString())
    const unsupported = Buffer.from(bytes.toString().replace('"analytics_enabled":"false"', '"analytics_enabled":false'))
    expect(() => decodeCodexyArtifact(unsupported)).toThrow('invalid Codexy client metadata')
  })
})
