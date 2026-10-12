// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@codexydsh/test-support/client'
import { MutableSessionEventSource, type SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { createAssistantMessage, createUserMessage, createMessage } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import { commonZh } from '@codexydsh/test-support/client'
import { EMPTY_CHAT_SNAPSHOT } from '../src/client/contract/snapshot.ts'
import { zh } from '../src/client/locale.ts'
import { readCompleteTurn, turnCopyText } from '../src/client/chat/turn-copy.ts'
import { TurnCopyMenu } from '../src/client/chat/TurnCopyMenu.tsx'

const t = makeTranslate(zh, commonZh)
const callId = ToolCallId('read-proof')
const recordedOutput = Array.from({ length: 220 }, (_, index) => `output line ${index}`).join('\n')
function entry(event: SessionEvent): SessionEventLikeEntry { return { type: 'event', event } }
function evidence(): SessionEventLikeEntry[] {
  const base = (seq: number) => ({ seq: SessionSeq(seq), time: 1_700_000_000_000 + seq })
  return [
    entry({ ...base(1), type: 'turn/start', data: { turn: 1 } }),
    entry({ ...base(2), type: 'user/message', surfaceOp: 'append', data: createUserMessage({
      source: { kind: 'user' }, content: [{ type: 'text', text: 'Inspect the whole file' }],
    }) }),
    entry({ ...base(3), type: 'assistant/message', surfaceOp: 'append', data: {
      turn: 1, step: 1, stream: [], message: createAssistantMessage({
        source: { provider: 'mock', model: 'model' }, content: [
          { type: 'reasoning', text: 'Reasoning beyond a preview '.repeat(20) },
          { type: 'text', text: 'I will inspect the file.' },
        ],
      }),
    } }),
    entry({ ...base(4), type: 'tool/call', data: { turn: 1, step: 1, callId, name: 'exec_command', arguments: '{"cmd":"cat proof.txt"}' } }),
    entry({ ...base(5), type: 'tool/result', surfaceOp: 'append', data: { turn: 1, step: 1, message: createMessage({
      role: 'tool', toolCallId: callId, source: { kind: 'tool', callId }, content: [{ type: 'text', text: recordedOutput }],
    }) } }),
    entry({ ...base(6), type: 'user/message', surfaceOp: 'append', data: createUserMessage({
      source: { kind: 'user' }, content: [{ type: 'text', text: 'Also check the last line' }],
    }) }),
    entry({ ...base(7), type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 2, stream: [],
      message: createAssistantMessage({ source: { provider: 'mock', model: 'model' }, content: [{ type: 'text', text: 'The final answer.' }] }),
    } }),
    entry({ ...base(8), type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }),
  ]
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('Turn copy text', () => {
  it('copies the question, progress, all reasoning, complete tools, steering, and answer in order', () => {
    const text = turnCopyText(evidence(), 'full', [], t)
    expect(text).toContain('Inspect the whole file')
    expect(text).toContain('Reasoning beyond a preview '.repeat(20))
    expect(text).toContain('I will inspect the file.')
    expect(text).toContain('{"cmd":"cat proof.txt"}')
    expect(text).toContain(recordedOutput)
    expect(text).toContain('Also check the last line')
    expect(text).toContain('The final answer.')
    expect(text.indexOf('output line 219')).toBeLessThan(text.indexOf('The final answer.'))
  })

  it('uses the displayed activity summary and omits command output in concise copies', () => {
    const text = turnCopyText(evidence(), 'brief', [{ callId, text: '已浏览 读取 proof.txt' }], t)
    expect(text).toContain('已浏览 读取 proof.txt')
    expect(text).not.toContain('output line')
    expect(text).not.toContain('Reasoning beyond a preview '.repeat(20))
    expect(text).toContain('The final answer.')
  })

  it('pages missing earlier history before claiming a complete Turn', async () => {
    const events = evidence()
    const source = new MutableSessionEventSource()
    source.replace(events.slice(4), true)
    const loadOlder = vi.fn(async () => { source.prepend(events.slice(0, 4), false) })
    const result = await readCompleteTurn({ eventSource: source, session: { loadOlder } }, 1, 8)
    expect(loadOlder).toHaveBeenCalledTimes(1)
    expect(result).toEqual(events)
  })

  it('captures the recorded live boundary before missing history loads and new messages arrive', async () => {
    const events = evidence()
    const source = new MutableSessionEventSource()
    source.replace(events.slice(3, 5), true)
    const loadOlder = vi.fn(async () => {
      for (const event of events.slice(5, 7)) source.append(event)
      source.prepend(events.slice(0, 3), false)
    })
    const result = await readCompleteTurn({ eventSource: source, session: { loadOlder } }, 1)
    expect(result).toEqual(events.slice(0, 5))
    expect(turnCopyText(result, 'full', [], t)).toContain(recordedOutput)
    expect(turnCopyText(result, 'full', [], t)).not.toContain('The final answer.')
  })

  it('refuses missing starts, wrong closing Turns, and unsuccessful page loads', async () => {
    const source = new MutableSessionEventSource()
    source.replace(evidence().slice(3), false)
    const binding = { eventSource: source, session: { loadOlder: vi.fn(async () => {}) } }
    await expect(readCompleteTurn(binding, 1, 8)).rejects.toThrow('Complete Turn history')
    source.replace(evidence(), false)
    await expect(readCompleteTurn(binding, 2, 8)).rejects.toThrow('Complete Turn history')
    source.replace(evidence().slice(3), true)
    await expect(readCompleteTurn(binding, 1, 8)).rejects.toThrow('did not load')
  })
})

describe('Flat Turn copy actions', () => {
  it('shows all three levels and copies only the selected question without loading history', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const readTurnEvents = vi.fn(async () => evidence())
    render(<TurnCopyMenu turn={1} question="Only this question" snapshot={EMPTY_CHAT_SNAPSHOT} readTurnEvents={readTurnEvents} t={t} />)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getAllByRole('button')).toHaveLength(3)
    expect(screen.getByRole('button', { name: '简略过程' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '完整过程' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '仅问题' }))
    await waitFor(() => { expect(writeText).toHaveBeenCalledWith('Only this question') })
    expect(readTurnEvents).not.toHaveBeenCalled()
  })

  it('retains the three actions for retry when loading fails and copies untruncated output', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const readTurnEvents = vi.fn().mockRejectedValueOnce(new Error('load failed')).mockResolvedValue(evidence())
    render(<TurnCopyMenu turn={1} question="Inspect the whole file" endSeq={8} snapshot={EMPTY_CHAT_SNAPSHOT} readTurnEvents={readTurnEvents} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: '完整过程' }))
    await waitFor(() => { expect(screen.getByText('复制失败，请重试')).toBeTruthy() })
    expect(writeText).not.toHaveBeenCalled()
    expect(screen.getAllByRole('button')).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: '完整过程' }))
    await waitFor(() => { expect(writeText).toHaveBeenCalledTimes(1) })
    expect(writeText.mock.calls[0]?.[0]).toContain(recordedOutput)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('shows loading and prevents duplicate copies, then does not copy after unmounting', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const deferred = Promise.withResolvers<readonly SessionEventLikeEntry[]>()
    const readTurnEvents = vi.fn(() => deferred.promise)
    const view = render(<TurnCopyMenu turn={1} question="Inspect the whole file" endSeq={8} snapshot={EMPTY_CHAT_SNAPSHOT} readTurnEvents={readTurnEvents} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: '简略过程' }))
    expect(screen.getByRole('button', { name: '简略过程' }).getAttribute('aria-busy')).toBe('true')
    expect(screen.getByText('正在准备复制')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '完整过程' }))
    expect(readTurnEvents).toHaveBeenCalledTimes(1)
    view.unmount()
    deferred.resolve(evidence())
    await deferred.promise
    await Promise.resolve()
    expect(writeText).not.toHaveBeenCalled()
  })
})
