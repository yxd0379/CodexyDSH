/** Durable reviewer lifecycle projection, including clipped Session history. */
import { describe, expect, it } from 'vitest'
import type { ApprovalRequestId } from '@deepseek-ai/dsh-api-remotes/client'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEventMap } from '@deepseek-ai/dsh-session/types'
import type { SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { ConversationNodeAssembler } from '@codexydsh/ui-conversation/client'
import type { ChatSnapshot } from '../src/client/contract/snapshot.ts'
import { approvalReviewDefinition } from '../src/client/conversation-nodes/approval-review.ts'
import { chatViewDefinition } from '../src/client/conversation-nodes/chat-snapshot-builder.ts'
import { unknownFallbackDefinition } from '../src/client/conversation-nodes/fallback.ts'
import { TURN_PROCESS_INDEPENDENT_KINDS } from '../src/client/contract/turn-process.ts'

const id = 'review-1' as ApprovalRequestId
function asked(): SessionLiveEventEntry {
  return { type: 'event', event: { seq: SessionSeq(1), time: 1, type: 'approval/asked', data: {
    id, toolName: 'exec_command', reason: 'Write the requested file',
  } } }
}
function review(seq: number, data: Omit<SessionEventMap['approval/review'], 'id'>): SessionLiveEventEntry {
  return { type: 'event', event: { seq: SessionSeq(seq), time: seq, type: 'approval/review', data: { id, ...data } } }
}
function assembly(events: SessionLiveEventEntry[], hasMore = false) {
  const value = new ConversationNodeAssembler({ entries: () => [approvalReviewDefinition], fallbackEntry: () => unknownFallbackDefinition }, {
    entries: () => [chatViewDefinition],
  })
  value.replaceWindow(events, hasMore)
  value.activateTarget('chat')
  return value
}
function nodes(value: ConversationNodeAssembler) {
  const current = value.snapshot('chat') as ChatSnapshot
  return current.nodes.values().filter(node => node.kind === 'approval-review')
}

describe('Public approval review projection', () => {
  it('folds progress and verdict by approval id, excluding reviewer inputs and inspection evidence', () => {
    const value = assembly([asked(), review(2, { status: 'started', input: {
      provider: 'local', model: 'reviewer', system: 'private system', user: 'private input', temperature: 0, maxTokens: 100,
    } })])
    const pending = nodes(value)[0]!
    expect(pending.data).toEqual({ id, status: 'started', toolName: 'exec_command', reason: 'Write the requested file' })
    value.append(review(3, { status: 'inspecting', inspection: {
      callId: 'private-inspection' as ToolCallId, name: 'exec_command', arguments: 'private arguments',
      response: [{ type: 'text', text: 'private inspection' }], result: 'private result',
    } }))
    value.append(review(4, { status: 'denied', response: [{ type: 'text', text: 'private final reviewer response' }], assessment: {
      risk_level: 'high', user_authorization: 'low', outcome: 'deny', rationale: 'The requested path is outside the workspace.',
    } }))
    value.flush()
    const completed = nodes(value)
    expect(completed).toHaveLength(1)
    expect(completed[0]!.key).toBe(pending.key)
    expect(completed[0]!.data).toEqual({ id, status: 'denied', toolName: 'exec_command', reason: 'Write the requested file', rationale: 'The requested path is outside the workspace.' })
    expect(JSON.stringify(completed)).not.toContain('private')
    expect(TURN_PROCESS_INDEPENDENT_KINDS.has('approval-review')).toBe(true)
  })

  it('renders a terminal verdict whose request lies outside the loaded window', () => {
    const value = assembly([review(4, { status: 'failed', error: 'Reviewer disconnected' })], true)
    expect(nodes(value)).toHaveLength(1)
    expect(nodes(value)[0]!.data).toEqual({ id, status: 'failed', error: 'Reviewer disconnected' })
  })
})
