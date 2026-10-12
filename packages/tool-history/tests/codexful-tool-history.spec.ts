import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { codexfulToolProfile } from '@codexydsh/prompt'
import type { ContentBlock } from '@codexydsh/runtime/llm'
import { ToolCallId, createMessage, createToolResultMessage } from '@codexydsh/runtime/llm'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { appendProductEvent, encodeProductEvent } from '@codexydsh/runtime/session'
import type { ToolResultMessage } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@codexydsh/token-meter'
import CodexfulToolHistory, { textBytes, truncateToolResult } from '@codexydsh/tool-history'
import { describe, expect, it } from 'vitest'

const known = codexfulToolProfile('gpt-6-sol', 'daily').sourceTruncation
const fallback = codexfulToolProfile('qwen3.8', 'daily').sourceTruncation

function result(text: string, content: ContentBlock[] = [{ type: 'text', text }]): ToolResultMessage {
  return createToolResultMessage({ callId: ToolCallId('call'), content, isError: false })
}

function service(): CodexfulToolHistory {
  const ctx = new Context()
  new SessionProjectionRegistry(ctx)
  new TokenMeter(ctx)
  return new CodexfulToolHistory(ctx)
}

function appendStep(session: Session, turn: number, model: string, text: string): number {
  const callId = ToolCallId(`call-${turn}`)
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('request/header', {
    header: { config: { provider: 'fixture', model } },
    reason: turn === 1 ? 'initial' : 'change',
  })
  session.append('assistant/message', {
    turn, step: 1, stream: [],
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: callId, name: 'exec_command', arguments: '{}' }],
      source: { kind: 'model', provider: 'fixture', model },
    }),
  }, { surfaceOp: 'append' })
  session.append('tool/call', { turn, step: 1, callId, name: 'exec_command', arguments: '{}' })
  const original = session.append('tool/result', {
    turn, step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text }], isError: true }),
    error: { name: 'ExitError', code: 'EXIT_1', reason: 'exit 1' },
    meta: { presenter: 'terminal', exitCode: 1 },
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return original.seq
}

describe('Codexful tool-result history truncation', () => {
  it('prunes in a prepended pre-step listener before later observers', async () => {
    const ctx = new Context()
    new SessionProjectionRegistry(ctx)
    new TokenMeter(ctx)
    const session = Session.create(SessionId('pre-step'))
    appendStep(session, 1, 'qwen3.8', 'X'.repeat(20000))
    const agent = { id: session.id, session, options: {} } as Agent
    let observedShortHistory = false
    ctx.on('codexy-agent/pre-step', ({ agent: current }, next) => {
      observedShortHistory = current.session.deriveMessages().some(message => message.role === 'tool'
        && message.content.some(block => block.type === 'text' && block.text.includes('tokens truncated')))
      return next()
    })
    new CodexfulToolHistory(ctx)
    const decision = await agentEvents(ctx, agent).waterfall('codexy-agent/pre-step', {
      messages: [], turn: 2, step: 1, signal: new AbortController().signal,
    }, () => Promise.resolve({ kind: 'enter' as const, messages: [] }))
    expect(decision.kind).toBe('enter')
    expect(observedShortHistory).toBe(true)
  })

  it('uses the pinned 1.2 allowance on payload text independently of message metadata', () => {
    expect(known).toEqual({ mode: 'tokens', limit: 10000 })
    expect(fallback).toEqual({ mode: 'bytes', limit: 10000 })
    for (const [policy, cap] of [[known, 48000], [fallback, 12000]] as const) {
      const atLimit = result('x'.repeat(cap))
      expect(textBytes(atLimit.content)).toBe(cap)
      expect(truncateToolResult(atLimit, policy)).toBeNull()
      const above = result('x'.repeat(cap + 1))
      const shortened = truncateToolResult(above, policy)
      expect(shortened).not.toBeNull()
      expect(textBytes(shortened!.content)).toBeGreaterThan(cap)
      const text = shortened!.content[0]
      if (text?.type !== 'text') throw new Error('expected text result')
      expect(text.text).toMatch(/…1 tokens truncated…/)
    }
  })

  it('counts omitted approximate tokens without splitting Unicode code points', () => {
    const source = '😀'.repeat(2000) + '汉'.repeat(2000) + '尾'.repeat(2000) + '\u0000'
    const original = result(source)
    const shortened = truncateToolResult(original, fallback)!
    const block = shortened.content[0]
    if (block?.type !== 'text') throw new Error('expected text result')
    const text = block.text
    expect(text).toContain('\u0000')
    expect(text).not.toContain('\uFFFD')
    const match = text.match(/…(\d+) tokens truncated…/)
    expect(match).not.toBeNull()
    expect(Number(match![1])).toBe(Math.ceil((Buffer.byteLength(source, 'utf8') - 12000) / 4))
  })

  it('budgets mixed text blocks in order and preserves rich blocks', () => {
    const image: ContentBlock = {
      type: 'image',
      attachment: {
        attachmentId: `sha256:${'a'.repeat(64)}` as never,
        mediaType: 'image/png', bytes: 1, width: 1, height: 1,
      },
    }
    const original = result('', [
      { type: 'text', text: 'A'.repeat(2000) },
      image,
      { type: 'text', text: '😀'.repeat(4000) },
      { type: 'text', text: 'tail omitted' },
    ])
    const shortened = truncateToolResult(original, fallback)!
    expect(shortened.content[0]).toEqual({ type: 'text', text: 'A'.repeat(2000) })
    expect(shortened.content[1]).toEqual(image)
    const truncated = shortened.content[2]
    if (truncated?.type !== 'text') throw new Error('expected truncated text block')
    expect(truncated.text).toMatch(/…\d+ tokens truncated…/)
    expect(shortened.content[3]).toEqual({ type: 'text', text: '[omitted 1 text items ...]' })
    expect(JSON.stringify(shortened.content)).not.toContain('tail omitted')
  })

  it('charges each text item separately in the pinned token mode', () => {
    const original = result('', [
      { type: 'text', text: 'A' },
      { type: 'text', text: 'B'.repeat(47997) },
    ])
    expect(textBytes(original.content)).toBeLessThan(48000)
    const shortened = truncateToolResult(original, known)!
    expect(shortened.content[0]).toEqual({ type: 'text', text: 'A' })
    const second = shortened.content[1]
    if (second?.type !== 'text') throw new Error('expected truncated second block')
    expect(second.text).toMatch(/…1 tokens truncated…/)
  })

  it('converts fallback bytes to a saved token budget before charging text items', () => {
    const original = result('', [
      { type: 'text', text: 'A' },
      { type: 'text', text: 'B'.repeat(11997) },
    ])
    expect(textBytes(original.content)).toBeLessThan(12000)
    const shortened = truncateToolResult(original, fallback)!
    expect(shortened.content[0]).toEqual({ type: 'text', text: 'A' })
    const second = shortened.content[1]
    if (second?.type !== 'text') throw new Error('expected truncated second block')
    expect(second.text).toMatch(/…1 tokens truncated…/)
  })

  it('keeps the raw result, its error and metadata, and uses each result\'s earlier header', () => {
    const session = Session.create(SessionId('codexful-history'))
    const knownSeq = appendStep(session, 1, 'gpt-6-sol', 'K'.repeat(20000))
    const fallbackSeq = appendStep(session, 2, 'qwen3.8', 'F'.repeat(20000))
    expect(service().pruneSession(session)).toBe(1)
    const original = session.snapshotEvents()[fallbackSeq]!
    expect(original).toMatchObject({
      type: 'tool/result',
      data: { message: { content: [{ type: 'text', text: 'F'.repeat(20000) }] } },
    })
    const replacement = session.snapshotEvents().at(-1)!
    expect(replacement).toMatchObject({
      type: 'tool/result',
      surfaceOp: { op: 'replace', startSeq: fallbackSeq, endSeq: fallbackSeq },
      sourceEventSeqs: [fallbackSeq],
      data: {
        turn: 2, step: 1,
        error: { name: 'ExitError', code: 'EXIT_1', reason: 'exit 1' },
        meta: { presenter: 'terminal', exitCode: 1 },
        message: { source: { kind: 'tool', callId: ToolCallId('call-2') }, isError: true },
      },
    })
    expect(session.surface.nodes).toContain(SessionSeq(knownSeq))
    expect(session.surface.nodes).not.toContain(SessionSeq(fallbackSeq))
    const visible = session.deriveMessages().filter(message => message.role === 'tool').map((message) => {
      const text = message.content.find(block => block.type === 'text')
      return text?.type === 'text' ? text.text : ''
    })
    expect(visible[0]).toBe('K'.repeat(20000))
    expect(visible[1]).toMatch(/…\d+ tokens truncated…/)
    const price = session.snapshotEvents()[replacement.seq - 1]!
    expect(price).toMatchObject({
      type: 'compaction/prune',
      data: { shadowedRange: { start: fallbackSeq, end: fallbackSeq }, shadowedSeqs: [fallbackSeq] },
    })
  })

  it('converges after replay and a fork-style inherited seed', () => {
    const session = Session.create(SessionId('source'))
    appendStep(session, 1, 'gpt-6-sol', 'X'.repeat(55000))
    const prune = service()
    expect(prune.pruneSession(session)).toBe(1)
    expect(prune.pruneSession(session)).toBe(0)
    const restored = Session.create(SessionId('restored'), session.snapshotEvents())
    expect(prune.pruneSession(restored)).toBe(0)
    const fork = Session.create(SessionId('fork'), session.snapshotEvents())
    fork.append('session/end-seed', { inherited: true })
    expect(prune.pruneSession(fork)).toBe(0)
  })

  it('uses native request headers after durable carrier and platform seed encoding', () => {
    for (const encoding of ['carrier', 'seed'] as const) {
      const session = Session.create(SessionId(`native-${encoding}`))
      const nativeHeader = {
        config: { provider: 'fixture', model: 'qwen3.8' },
        tools: [{ name: 'apply_patch', kind: 'freeform' as const, description: 'Patch files', format: { type: 'grammar' as const, syntax: 'lark' as const, definition: 'start: /[\\s\\S]+/' } }],
      }
      if (encoding === 'carrier') {
        appendProductEvent(session, 'request/header', { header: nativeHeader, reason: 'initial' })
      }
      const seeded = encoding === 'seed' ? Session.create(SessionId('native-seed'), [encodeProductEvent({
        type: 'request/header', seq: SessionSeq(0), time: 0, data: { header: nativeHeader, reason: 'initial' },
      })]) : session
      const original = seeded.append('tool/result', { turn: 1, step: 1, message: result('X'.repeat(20000)) }, { surfaceOp: 'append' })
      expect(service().pruneSession(seeded), encoding).toBe(1)
      expect(seeded.eventAt(original.seq)?.data).toMatchObject({ message: { content: [{ type: 'text', text: 'X'.repeat(20000) }] } })
      const visible = seeded.deriveMessages().find(message => message.role === 'tool')
      expect(visible?.content[0]).toMatchObject({ type: 'text', text: expect.stringMatching(/tokens truncated/) })
    }
  })
})
