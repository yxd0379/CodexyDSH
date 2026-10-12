import { describe, expect, it } from 'vitest'
import { createUserMessage, ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  codexfulCompletionText,
  createCodexfulSettlementMessage,
  createCodexV1SettlementMessage,
  createCodexV1ShutdownMessage,
  createSettlementMessage,
} from '../src/continuation-messages.ts'
import { withSubagentDelivery } from '../src/inbox.ts'

const childId = SessionId('settled-child')
const summary = { type: 'text', text: `Background subagent ${childId} finished and will do no further work unless you send it more.` }
const reasoning: ContentBlock = { type: 'reasoning', text: 'private child reasoning' }
const toolCall: ContentBlock = { type: 'tool-call', id: ToolCallId('child-call'), name: 'read', arguments: '{}' }

describe('Codex v1 completion notifications', () => {
  it('renders real runtime closure as the shutdown final status', () => {
    expect(createCodexV1ShutdownMessage(childId, { nickname: 'Ada' }).content)
      .toEqual([{ type: 'text', text: `<subagent_notification>\n{"agent_path":"${childId}","status":"shutdown"}\n</subagent_notification>` }])
  })
  it('uses the child reference and preserves final text inside the pinned JSON wrapper', () => {
    const message = createCodexV1SettlementMessage(childId, { nickname: 'Ada', agentPath: '/root/ada' },
      { kind: 'completed' }, [reasoning, { type: 'text', text: 'Done.\n' }, { type: 'text', text: 'Next.' }])
    expect(message?.role).toBe('user')
    expect(message?.content).toEqual([{ type: 'text', text:
      '<subagent_notification>\n{"agent_path":"/root/ada","status":{"completed":"Done.\\nNext."}}\n</subagent_notification>',
    }])
    expect(message?.source).toMatchObject({ kind: 'subagent-settled', senderSessionId: childId })
  })

  it('uses the Session id when no path exists and emits null when there is no final text', () => {
    expect(createCodexV1SettlementMessage(childId, { nickname: 'Ada' }, { kind: 'completed' }, [reasoning])?.content)
      .toEqual([{ type: 'text', text: `<subagent_notification>\n{"agent_path":"${childId}","status":{"completed":null}}\n</subagent_notification>` }])
  })

  it('reports a real terminal error without the child reasoning', () => {
    expect(createCodexV1SettlementMessage(childId, { nickname: 'Ada' },
      { kind: 'error', error: { code: 'UNKNOWN', message: 'Failed.' } }, [reasoning])?.content)
      .toEqual([{ type: 'text', text: `<subagent_notification>\n{"agent_path":"${childId}","status":{"errored":"Failed."}}\n</subagent_notification>` }])
  })

  it('keeps interruption outside the first-final-status notification', () => {
    expect(createCodexV1SettlementMessage(childId, { nickname: 'Ada' }, { kind: 'aborted', reason: { kind: 'user' } }, undefined)).toBeUndefined()
    expect(createCodexV1SettlementMessage(childId, { nickname: 'Ada' }, { kind: 'interrupted' }, undefined)).toBeUndefined()
    expect(createCodexV1SettlementMessage(childId, { nickname: 'Ada' }, { kind: 'forked' }, undefined)).toBeUndefined()
  })
})

describe('continuable settlement content', () => {
  it('records queue-only Agent delivery without changing the original message identity', () => {
    const original = createUserMessage({
      content: [{ type: 'text', text: 'report' }],
      source: { kind: 'agent-message', form: 'relay', senderSessionId: childId },
    })
    const queued = withSubagentDelivery(original, 'queue-only')
    expect(queued.id).toBe(original.id)
    expect(queued.source).toEqual({ ...original.source, queueOnly: true })
    expect(original.source).not.toHaveProperty('queueOnly')
    expect(withSubagentDelivery(original, 'steer')).toBe(original)
  })

  it.each([
    ['reasoning before the answer', [reasoning, { type: 'text', text: 'answer' }]],
    ['a tool call after the answer', [{ type: 'text', text: 'answer' }, toolCall]],
  ] satisfies [string, ContentBlock[]][])('reports only the closing text with %s', (_label, output) => {
    const original = structuredClone(output)
    const message = createSettlementMessage(childId, { stopReason: 'completed', output })

    expect(message.role).toBe('user')
    expect(message.content).toEqual([
      summary,
      { type: 'text', text: 'Its closing message:' },
      { type: 'text', text: 'answer' },
    ])
    expect(output).toEqual(original)
  })

  it.each([
    ['absent output', undefined],
    ['empty output', []],
    ['reasoning-only output', [reasoning]],
    ['empty text', [{ type: 'text', text: '' }]],
  ] satisfies [string, ContentBlock[] | undefined][])('reports no closing message for %s', (_label, output) => {
    const message = createSettlementMessage(childId, { stopReason: 'completed', ...output === undefined ? {} : { output } })

    expect(message.content).toEqual([
      summary,
      { type: 'text', text: 'It left no closing message.' },
    ])
  })

  it('preserves text block order and bytes around omitted reasoning and tool calls', () => {
    const first: ContentBlock = { type: 'text', text: '  first\n' }
    const second: ContentBlock = { type: 'text', text: '\n第二段  ' }
    const message = createSettlementMessage(childId, {
      stopReason: 'completed',
      output: [reasoning, first, toolCall, second],
    })

    expect(message.content).toEqual([
      summary,
      { type: 'text', text: 'Its closing message:' },
      first,
      second,
    ])
  })
})

describe('Codexful v2 completion envelope', () => {
  const prefix = 'Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/worker\nPayload:\n'

  it('uses the exact completed, shutdown, and not-found payloads', () => {
    expect(codexfulCompletionText('/root', '/root/worker', { kind: 'completed', message: 'Done.' }))
      .toBe(prefix + 'Done.')
    expect(codexfulCompletionText('/root', '/root/worker', { kind: 'completed' })).toBe(prefix)
    expect(codexfulCompletionText('/root', '/root/worker', { kind: 'shutdown' }))
      .toBe(prefix + 'Agent shut down.')
    expect(codexfulCompletionText('/root', '/root/worker', { kind: 'not-found' }))
      .toBe(prefix + 'Agent was not found.')
  })

  it.each(['pending-init', 'running', 'interrupted'] as const)('sends no report for %s', (kind) => {
    expect(codexfulCompletionText('/root', '/root/worker', { kind })).toBeUndefined()
  })

  it('keeps an error and the pinned follow-up instruction, truncating a long error in the middle', () => {
    expect(codexfulCompletionText('/root', '/root/worker', { kind: 'errored', error: 'failed' }))
      .toBe(prefix + 'Agent errored: failed\n\nThis agent\'s turn failed. If you still need this agent, use the available collaboration tools to give it another task.')
    const long = codexfulCompletionText('/root', '/root/worker', {
      kind: 'errored', error: 'a'.repeat(2000) + 'b'.repeat(2000),
    })
    expect(long).toContain('a'.repeat(1800) + '…100 tokens truncated…' + 'b'.repeat(1800))
    const multibyte = codexfulCompletionText('/root', '/root/worker', {
      kind: 'errored', error: '界'.repeat(1201),
    })
    expect(multibyte).toContain('界'.repeat(600) + '…1 tokens truncated…' + '界'.repeat(600))
  })

  it('suppresses a canceled child and records the settled child id for a completed one', () => {
    expect(createCodexfulSettlementMessage(childId, '/root/worker', { stopReason: 'aborted' }, []))
      .toBeUndefined()
    const message = createCodexfulSettlementMessage(childId, '/root/worker', {
      stopReason: 'completed', output: [{ type: 'text', text: 'Done.' }],
    }, [])
    expect(message?.content).toEqual([{ type: 'text', text: prefix + 'Done.' }])
    expect(message?.source).toMatchObject({ kind: 'subagent-settled', senderSessionId: childId })
  })
})
