// @vitest-environment jsdom
/** Source-linked cancellation notices preserve ordinary user input and model history. */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { makeTranslate } from '@codexydsh/test-support/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { commonEn } from '@codexydsh/test-support/client'
import type { SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { ConversationNodeAssembler } from '@codexydsh/ui-conversation/client'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { SessionSeq, type SessionEvent, type SessionEventMap } from '@deepseek-ai/dsh-session/types'
import { UserMessageNodeView } from '../src/client/chat/MessageItem.tsx'
import type { ChatNode } from '../src/client/contract/chat-nodes.ts'
import { EMPTY_CHAT_SNAPSHOT, type ChatSnapshot } from '../src/client/contract/snapshot.ts'
import { chatViewDefinition } from '../src/client/conversation-nodes/chat-snapshot-builder.ts'
import { messageDefinition } from '../src/client/conversation-nodes/message.ts'
import { turnProcessDefinition } from '../src/client/conversation-nodes/turn-process.ts'
import { en, zh } from '../src/client/locale.ts'
import { derivePresentationPolicy } from '../src/client/presentation-policy.ts'

afterEach(cleanup)

const marker = '<turn_aborted>\nThe previous turn was interrupted on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.\n</turn_aborted>'
const userMarker = '<turn_aborted>\nThe user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.\n</turn_aborted>'
const markerVariants = [{ mode: 'user', text: userMarker }, { mode: 'developer', text: marker }]
const start: SessionLiveEventEntry = {
  type: 'event', event: { seq: SessionSeq(0), time: 0, type: 'turn/start', data: { turn: 1 } },
}
function end(reason: SessionEventMap['turn/end']['reason']): SessionLiveEventEntry {
  return { type: 'event', event: { seq: SessionSeq(1), time: 1, type: 'turn/end', data: { turn: 1, reason } } }
}
function message(text = marker, sources?: number[]): { type: 'event'; event: SessionEvent<'user/message'> } {
  return { type: 'event', event: {
    seq: SessionSeq(2), time: 2, type: 'user/message', surfaceOp: 'append',
    ...sources === undefined ? {} : { sourceEventSeqs: sources.map(SessionSeq) },
    data: { role: 'user', id: MessageId('interruption-input'), content: [{ type: 'text', text }], source: { kind: 'user' } },
  } }
}
function assembly(events: SessionLiveEventEntry[], hasMore = false) {
  const value = new ConversationNodeAssembler({
    entries: () => [messageDefinition, turnProcessDefinition], fallbackEntry: () => undefined,
  }, {
    entries: () => [chatViewDefinition],
  })
  value.replaceWindow(events, hasMore)
  value.activateTarget('chat')
  return value
}
function userNode(value: ConversationNodeAssembler): ChatNode<'user'> {
  const current = value.snapshot('chat') as ChatSnapshot
  const node = current.nodes.values().find(node => node.kind === 'user')
  expect(node).toBeDefined()
  return node as ChatNode<'user'>
}
function row(node: ChatNode<'user'>, codexful = true, dictionary = en) {
  const policy = derivePresentationPolicy(createSnapshotStore('standard' as const), createSnapshotStore(codexful)).getSnapshot()
  // This isolated renderer reads only the node, locale, presentation, and user-bubble actions.
  const props: Partial<Parameters<typeof UserMessageNodeView>[0]> = {
    node, t: makeTranslate(dictionary, commonEn),
    usePresentation: selector => selector(policy),
    useChat: selector => selector(EMPTY_CHAT_SNAPSHOT),
    readTurnEvents: async () => [],
    openFile: () => {}, openSkill: () => {}, renderMessageImages: () => null,
    inspectCall: undefined, forkAt: () => {}, loadImage: async () => '', fileMentions: () => undefined,
    usePerformanceUsage: selector => selector('compact'),
    useTurnData: () => undefined,
    renderSlot: () => null,
  }
  return <UserMessageNodeView {...props as Parameters<typeof UserMessageNodeView>[0]} />
}

describe('Generated user-interruption presentation', () => {
  it.each(markerVariants)('reconstructs the $mode marker from a cited user-cancelled turn during live admission and history replay', ({ text }) => {
    const ended = end({ kind: 'aborted', reason: { kind: 'user' } })
    const notice = message(text, [1])
    const value = assembly([start, ended])
    value.append(notice)
    value.flush()
    expect(userNode(value).data.interruptedTurn).toBe(1)
    expect(userNode(value).data.content).toEqual(notice.event.data.content)
    expect(notice.event).toEqual(message(text, [1]).event)
    value.replaceWindow([start, ended, notice], false)
    expect(userNode(value).data.interruptedTurn).toBe(1)
  })

  it.each(markerVariants)('keeps identical $mode XML typed without a source citation as a full ordinary bubble', ({ text }) => {
    const node = userNode(assembly([start, end({ kind: 'aborted', reason: { kind: 'user' } }), message(text)]))
    expect(node.data.interruptedTurn).toBeUndefined()
    const view = render(row(node))
    expect(view.container.querySelector('[data-user-interruption]')).toBeNull()
    expect(view.container.querySelector('[data-message-full]')?.textContent).toBe(text)
  })

  it.each([
    { kind: 'completed' },
    { kind: 'aborted', reason: { kind: 'parent' } },
    { kind: 'aborted', reason: { kind: 'hook', reason: 'Before task' } },
    { kind: 'aborted', reason: { kind: 'legacy' } },
  ] satisfies SessionEventMap['turn/end']['reason'][])('does not attribute a %j ending to a user cancellation', (reason) => {
    const node = userNode(assembly([start, end(reason), message(marker, [1])]))
    expect(node.data.interruptedTurn).toBeUndefined()
  })

  it('keeps unrelated source citations, other message bodies, and an unloaded source readable', () => {
    const ended = end({ kind: 'aborted', reason: { kind: 'user' } })
    expect(userNode(assembly([start, ended, message(marker, [0])])).data.interruptedTurn).toBeUndefined()
    expect(userNode(assembly([start, ended, message('Please resume now.', [1])])).data.interruptedTurn).toBeUndefined()
    expect(userNode(assembly([message(marker, [1])], true)).data.interruptedTurn).toBeUndefined()
  })

  it.each([en, zh])('omits generated protocol text from Codexful Chat without removing its stored input', (dictionary) => {
    const node = userNode(assembly([start, end({ kind: 'aborted', reason: { kind: 'user' } }), message(marker, [1])]))
    const view = render(row(node, true, dictionary))
    expect(view.container.childElementCount).toBe(0)
    expect(node.data.content).toEqual([{ type: 'text', text: marker }])
  })

  it('preserves the ordinary DSH bubble when Codexful presentation is disabled', () => {
    const node = userNode(assembly([start, end({ kind: 'aborted', reason: { kind: 'user' } }), message(marker, [1])]))
    const view = render(row(node, false))
    expect(view.container.querySelector('[data-user-interruption]')).toBeNull()
    expect(view.container.querySelector('[data-message-full]')?.textContent).toBe(marker)
  })
})
