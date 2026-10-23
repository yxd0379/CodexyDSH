// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionListState, SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session/types'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ChatSnapshot, ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { chatViewDefinition } from '../../ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts'
import { SubagentActivity, subagentActivityDefinition } from '../src/client/activity.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const parent = 'parent-session' as SessionId
const child = 'child-session' as SessionId
const discovery: SessionLiveEventEntry = { type: 'event', event: {
  type: 'subagent/catalog', seq: SessionSeq(3), time: 3_000,
  data: { version: 0, childId: child, childCreatedAt: 2_000, mode: 'continuable', label: '/root/reviewer' },
} }

function readActivity(entries: readonly SessionLiveEventEntry[]): ChatNode<'subagent-activity'> {
  const assembler = new ConversationNodeAssembler(
    { entries: () => [subagentActivityDefinition], fallbackEntry: () => undefined },
    { entries: () => [chatViewDefinition] },
  )
  assembler.replaceWindow(entries, false)
  assembler.activateTarget('chat')
  assembler.flush()
  const snapshot = assembler.snapshot('chat') as ChatSnapshot
  const node = snapshot.nodes.values().find((candidate): candidate is ChatNode<'subagent-activity'> => candidate.kind === 'subagent-activity')
  if (node === undefined) throw new Error('expected child activity')
  return node
}

it('reconstructs a navigable child from its durable catalog rather than the model-facing task name', () => {
  const node = readActivity([
    { type: 'event', event: { type: 'turn/start', seq: SessionSeq(1), time: 1_000, data: { turn: 1 } } },
    { type: 'event', event: { type: 'step/start', seq: SessionSeq(2), time: 2_000, data: { turn: 1, step: 1 } } },
    discovery,
  ])
  expect(node).toMatchObject({
    anchorSeq: 3, groupTree: 'process', location: { kind: 'step', turn: { turn: 1 }, step: { step: 1 } },
    data: { childSessionId: child, mode: 'continuable', label: '/root/reviewer' },
  })
  expect(readActivity([discovery]).data).toEqual(node.data)
})

it('shows pending, running, and confirmed completion without treating spawn success as child completion', () => {
  const node = readActivity([discovery])
  let list: SessionListState = { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }
  let statuses: SessionStatusSnapshot = new Map()
  const openChild = vi.fn()
  const props = {
    node, sessionId: parent, openChild, t: makeTranslate(zh),
    useSessions: <T,>(select: (state: SessionListState) => T): T => select(list),
    useSessionStatus: <T,>(select: (state: SessionStatusSnapshot) => T): T => select(statuses),
  }
  const view = render(<SubagentActivity {...props} />)
  expect(view.getByText('状态待同步')).toBeTruthy()
  expect(view.queryByText('已完成')).toBeNull()
  statuses = new Map([[child, { running: true, completionUnread: false, pendingInteraction: undefined }]])
  view.rerender(<SubagentActivity {...props} />)
  expect(view.getByText('正在运行')).toBeTruthy()
  fireEvent.click(view.getByRole('button'))
  expect(openChild).toHaveBeenCalledExactlyOnceWith({ parentSessionId: parent, childSessionId: child, mode: 'continuable' })

  list = { ...list, byId: { [child]: {
    id: child, displayTitle: 'reviewer', blank: false, updatedAt: 4_000, running: false, retainedBy: {},
    projectionValues: { subagentTiming: { settledMs: 1_000, lastTurnCompleted: true } },
  } } }
  // A newer running observation overrides an older completed summary.
  view.rerender(<SubagentActivity {...props} />)
  expect(view.getByText('正在运行')).toBeTruthy()
  statuses = new Map([[child, { running: false, completionUnread: false, pendingInteraction: undefined }]])
  view.rerender(<SubagentActivity {...props} />)
  expect(view.getByText('已完成')).toBeTruthy()
  expect(view.queryByText('正在运行')).toBeNull()
})
