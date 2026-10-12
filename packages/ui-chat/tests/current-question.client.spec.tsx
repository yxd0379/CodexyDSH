// @vitest-environment jsdom
/** Original question reminders retain human input identity and reuse Turn navigation. */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@codexydsh/test-support/client'
import { commonEn } from '@codexydsh/test-support/client'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { TurnNavigationItem } from '../src/client/contract/snapshot.ts'
import { currentQuestionItems } from '../src/client/chat/current-question.ts'
import { CurrentQuestionBar } from '../src/client/chat/CurrentQuestionBar.tsx'
import { en } from '../src/client/locale.ts'
import { chatSnapshotFixture } from './chat-snapshot-fixture.client.ts'
import { useChatScroll } from '../src/client/chat/use-chat-scroll.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

it('uses original human questions and excludes steering, generated interruption and unavailable anchors', () => {
  const interrupted = { kind: 'user' as const, seq: 3, time: 3000,
    content: [{ type: 'text' as const, text: '<turn_aborted>Protocol</turn_aborted>' }], source: null, interruptedTurn: 1 }
  const snapshot = chatSnapshotFixture({ nodes: [
    { kind: 'user', seq: 1, time: 1000, content: [{ type: 'text', text: 'Original question' }], source: null },
    { kind: 'steering', seq: 2, time: 2000, content: [{ type: 'text', text: 'Updated instruction' }],
      source: null, messageId: MessageId('steering') },
    interrupted,
  ] })
  const candidates: TurnNavigationItem[] = snapshot.nodes.values().map((node, index) => ({
    turn: index + 1, anchorKey: node.key, prompt: 'Question', response: '',
  }))
  const original = candidates[0]!
  candidates.push({ turn: 4, anchorKey: 'unloaded', prompt: 'Unavailable', response: '' })
  expect(currentQuestionItems(candidates, snapshot.nodes)).toEqual([original])
})

it('returns to the exact loaded original question without changing its preview text', () => {
  const item = { turn: 7, anchorKey: 'original-7', prompt: 'Please explain this change.', response: 'Answer' }
  const navigate = vi.fn()
  const view = render(<CurrentQuestionBar item={item} onNavigate={navigate} t={makeTranslate(en, commonEn)} />)
  expect(view.getByText(item.prompt)).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: en['chat.currentQuestion.back'] }))
  expect(navigate).toHaveBeenCalledExactlyOnceWith({
    turn: 7, prompt: item.prompt, response: item.response, anchor: { kind: 'loaded', key: item.anchorKey },
  })
})

it('tracks scrolling across original questions and removes the reminder on return or outside Codexful', () => {
  vi.useFakeTimers()
  const questions = [
    { turn: 1, anchorKey: 'first', prompt: 'First question', response: '' },
    { turn: 2, anchorKey: 'second', prompt: 'Second question', response: '' },
  ]
  const noQuestions: typeof questions = []
  const order = ['first', 'answer-1', 'steer-1', 'second', 'answer-2']
  const chatScroll = { read: () => null, save: () => {} }
  const loadOlder = () => {}
  const loadThrough = async () => {}
  const t = makeTranslate(en, commonEn)
  function Harness({ codexful }: { codexful: boolean }) {
    const scroll = useChatScroll({
      ready: true, order, firstSeq: 1, lastKey: 'answer-2', lastIsUser: false,
      steeringId: null, submissionId: null, running: false, loadingOlder: false, hasMore: false,
      chatScroll, loadOlder, loadThrough, loadedTurns: questions, questions: codexful ? questions : noQuestions,
    })
    return <>
      <div ref={scroll.listRef} data-testid="scrollport">
        <div ref={scroll.columnRef}>
          {order.map((key, index) => <div key={key} data-chat-turn={index < 3 ? '1' : '2'}
            data-chat-node-key={key} data-chat-anchor-key={key} data-chat-flow-key={key}>{key}</div>)}
        </div>
      </div>
      {scroll.pinnedQuestion !== null && <CurrentQuestionBar item={scroll.pinnedQuestion}
        onNavigate={scroll.navigateToTurn} t={t} />}
    </>
  }
  const view = render(<Harness codexful />)
  const list = view.getByTestId('scrollport')
  Object.defineProperties(list, {
    clientHeight: { configurable: true, value: 300 }, scrollHeight: { configurable: true, value: 1100 },
  })
  vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 500, 300))
  const starts = [0, 60, 200, 600, 660]
  for (const [index, row] of [...list.querySelectorAll<HTMLElement>('[data-chat-node-key]')].entries()) {
    vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 100 + starts[index]! - list.scrollTop, 500, 60))
  }
  const move = (top: number) => {
    act(() => { list.scrollTop = top; fireEvent.scroll(list) })
  }
  move(50)
  expect(view.container.querySelector('[data-current-question-bar]')).toBeNull()
  move(80)
  expect(view.container.querySelector('[data-current-question-bar]')?.getAttribute('data-current-question-bar')).toBe('1')
  move(200)
  expect(view.container.querySelector('[data-current-question-bar]')?.getAttribute('data-current-question-bar')).toBe('1')
  fireEvent.click(view.getByRole('button', { name: en['chat.currentQuestion.back'] }))
  expect(list.scrollTop).toBe(0)
  expect(view.container.querySelector('[data-current-question-bar]')).toBeNull()
  move(650)
  expect(view.container.querySelector('[data-current-question-bar]')).toBeNull()
  move(660)
  expect(view.container.querySelector('[data-current-question-bar]')?.getAttribute('data-current-question-bar')).toBe('2')
  view.rerender(<Harness codexful={false} />)
  expect(view.container.querySelector('[data-current-question-bar]')).toBeNull()
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})
