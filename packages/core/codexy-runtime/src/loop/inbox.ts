/**
 * Driver-owned durable agent inbox projection and command facade.
 *
 * @module @codexydsh/runtime/loop/inbox
 */

import type {} from '../llm.ts'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { SessionEventMap } from '../session.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '../agent-api.ts'
import type { AgentEventDispatch, Inbox as InboxContract, InboxState, InboxTarget, InboxWireState } from '@deepseek-ai/dsh-agent'
import { z } from 'zod'
import { snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'

/** Wire validation for pending agent input reconstructed from durable inbox splices. */
export const inboxProjectionSchema = z.object({
  'next-turn': z.array(z.custom<UserMessage>()).readonly(),
  'next-step': z.array(z.custom<UserMessage>()).readonly(),
}).readonly()

/** Standard fold that reconstructs pending input and rejects invalid durable splice history. */
export const inboxProjectionDefinition = {
  key: 'inbox',
  stateSchema: inboxProjectionSchema,
  init: (): InboxState => ({ 'next-turn': [], 'next-step': [] }),
  apply(state: InboxState, event) {
    if (event.type !== 'agent/inbox/spliced') return state
    const splice = event.data
    try {
      const inbox = state[splice.target]
      const removedCount = splice.removedCount ?? 0
      if (!Number.isSafeInteger(splice.start) || splice.start < 0 || splice.start > inbox.length
        || !Number.isSafeInteger(removedCount) || removedCount < 0
        || splice.start + removedCount > inbox.length) {
        throw new Error('invalid inbox splice')
      }
      const next = inbox.toSpliced(splice.start, removedCount, ...splice.inserted)
      const ids = new Set<string>()
      for (const message of splice.target === 'next-turn'
        ? [...next, ...state['next-step']]
        : [...state['next-turn'], ...next]) {
        if (ids.has(message.id)) throw new Error(`message "${message.id}" is already pending`)
        ids.add(message.id)
      }
      return splice.target === 'next-turn'
        ? { 'next-turn': next, 'next-step': state['next-step'] }
        : { 'next-turn': state['next-turn'], 'next-step': next }
    } catch (error: unknown) {
      throw new Error(`invalid persisted inbox splice at session seq ${event.seq}`, { cause: error })
    }
  },
  wire: {
    // The wire value is the fold state itself: every pending message already
    // round-trips the session log as lossless JSON. Only the static type
    // narrows to the JSON-safe projection table entry.
    viewSchema: z.object({ 'next-turn': z.array(z.custom<JsonValue>()).readonly(), 'next-step': z.array(z.custom<JsonValue>()).readonly() }).readonly(),
    view: (state: InboxState): InboxWireState => ({ 'next-turn': state['next-turn'].map(message => snapshotJsonValue<unknown>(message) as JsonValue), 'next-step': state['next-step'].map(message => snapshotJsonValue<unknown>(message) as JsonValue) }),
  },
  stateVersion: 1,
} satisfies ProjectionDefinition<'inbox', InboxState>

/**
 * Driver-owned durable Inbox implementation used by ReactLoopAgent and focused
 * provider tests.
 * @param projections - registry with the standard Inbox projection registered by AgentLoop.
 * @param session - session whose durable events store pending input.
 * @param dispatch - agent-scoped notifications for Inbox lifecycle events.
 */
export class ReactLoopInbox implements InboxContract {
  constructor(
    private readonly projections: SessionProjectionRegistry,
    private readonly session: Session,
    private readonly dispatch: AgentEventDispatch,
  ) {}

  /** Prompts awaiting individual turns. */
  get nextTurn(): readonly UserMessage[] {
    return this.current()['next-turn']
  }

  /** Input awaiting the next step boundary. */
  get nextStep(): readonly UserMessage[] {
    return this.current()['next-step']
  }

  /** Whether either pending-message list contains work. */
  get hasPending(): boolean {
    const state = this.current()
    return state['next-turn'].length > 0 || state['next-step'].length > 0
  }

  /**
   * Durably cancel pending input, preserving already completed conversation when selected.
   * @param keepConversation - optional classifier for completed human actions retained in pending context.
   */
  clear(keepConversation?: (message: UserMessage) => boolean): void {
    if (keepConversation === undefined) this.splice('next-step', 0, this.nextStep.length, [])
    else {
      let index = 0
      for (const message of this.nextStep) {
        if (keepConversation(message)) index++
        else this.splice('next-step', index, 1, [])
      }
    }
    this.splice('next-turn', 0, this.nextTurn.length, [])
  }

  /**
   * Remove and return the complete batch proposed for one step.
   * @param target - whether this boundary also consumes one queued turn.
   * @param turn - turn that will own the claimed batch.
   * @param isMailbox - optional Codexful classifier that defers fresh-turn pending input and orders mail last.
   * @param isPriorConversation - optional classifier for completed human actions that must precede a fresh task.
   * @returns claimed messages in the order supplied to the next step.
   */
  claim(target: InboxTarget, turn: number, isMailbox?: (message: UserMessage) => boolean,
    isPriorConversation?: (message: UserMessage) => boolean): UserMessage[] {
    const freshTurn = isMailbox !== undefined && target === 'next-turn' && this.nextTurn.length > 0
    const claimed = freshTurn ? [] : this.mutate('next-step', 0, this.nextStep.length, [], false)
    if (freshTurn && isPriorConversation !== undefined) {
      let index = 0
      for (const message of this.nextStep) {
        if (isPriorConversation(message)) claimed.push(...this.mutate('next-step', index, 1, [], false))
        else index++
      }
    }
    if (target === 'next-turn') claimed.push(...this.mutate('next-turn', 0, 1, [], false))
    let ordered = claimed
    if (isMailbox !== undefined && !freshTurn) {
      const regular: UserMessage[] = []
      const mailbox: UserMessage[] = []
      for (const message of claimed) (isMailbox(message) ? mailbox : regular).push(message)
      ordered = [...regular, ...mailbox]
    }
    for (const message of ordered) this.dispatch.emit('agent/inbox/claimed', { message, turn })
    return ordered
  }

  /**
   * Append one message to a pending list.
   * @param target - pending list to extend.
   * @param message - message to append.
   */
  append(target: InboxTarget, message: UserMessage): void {
    this.splice(target, this.current()[target].length, 0, [message])
  }

  /**
   * Prepend one message to a pending list.
   * @param target - pending list to extend.
   * @param message - message to prepend.
   */
  prepend(target: InboxTarget, message: UserMessage): void {
    this.splice(target, 0, 0, [message])
  }

  /**
   * Replace one pending message in place.
   * @param messageId - identity of the pending message to replace.
   * @param newMessage - replacement message.
   * @returns whether the message was still pending.
   */
  replace(messageId: MessageId, newMessage: UserMessage): boolean {
    const location = this.locate(messageId)
    if (location === undefined) return false
    this.splice(location.target, location.index, 1, [newMessage])
    return true
  }

  /**
   * Remove one pending message.
   * @param messageId - identity of the pending message to remove.
   * @returns whether the message was still pending.
   */
  remove(messageId: MessageId): boolean {
    const location = this.locate(messageId)
    if (location === undefined) return false
    this.splice(location.target, location.index, 1, [])
    return true
  }

  /**
   * Apply standard splice semantics and durably record the normalized result.
   * @param target - pending list to mutate.
   * @param start - splice position.
   * @param deleteCount - maximum number of messages to remove.
   * @param inserted - messages to insert at the resolved position.
   * @returns messages removed by the splice.
   */
  splice(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
  ): UserMessage[] {
    return this.mutate(target, start, deleteCount, inserted, true)
  }

  /** Locate one pending identity across both owned lists. */
  private locate(messageId: MessageId): { target: InboxTarget; index: number } | undefined {
    const state = this.current()
    for (const target of ['next-turn', 'next-step'] as const) {
      const index = state[target].findIndex(message => message.id === messageId)
      if (index >= 0) return { target, index }
    }
    return undefined
  }

  /** Read the current durable projection state. */
  private current(): InboxState {
    const state = this.projections.stateOf(this.session, 'inbox')
    if (state === undefined) {
      throw new Error(
        `agent "${this.session.id}" cannot read inbox state: its projection registration is not active`,
      )
    }
    return state
  }

  /** Commit one normalized mutation and publish its live events. */
  private mutate(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
    discardRemoved: boolean,
  ): UserMessage[] {
    const state = this.current()
    const inbox = state[target]
    const truncatedStart = Math.trunc(start)
    const offset = Number.isNaN(truncatedStart) ? 0 : truncatedStart
    const actualStart = offset < 0
      ? Math.max(inbox.length + offset, 0)
      : Math.min(offset, inbox.length)
    const truncatedDeleteCount = Math.trunc(deleteCount)
    const actualDeleteCount = Math.min(
      Math.max(Number.isNaN(truncatedDeleteCount) ? 0 : truncatedDeleteCount, 0),
      inbox.length - actualStart,
    )
    if (actualDeleteCount === 0 && inserted.length === 0) return []
    const candidate = inbox.toSpliced(actualStart, actualDeleteCount, ...inserted)
    const ids = new Set<string>()
    for (const message of target === 'next-turn'
      ? [...candidate, ...state['next-step']]
      : [...state['next-turn'], ...candidate]) {
      if (ids.has(message.id)) throw new Error(`message "${message.id}" is already pending`)
      ids.add(message.id)
    }
    const outcome = discardRemoved && actualDeleteCount > 0 ? 'canceled' as const : undefined
    const splice: SessionEventMap['agent/inbox/spliced'] = {
      target,
      start: actualStart,
      ...(actualDeleteCount === 0 ? {} : { removedCount: actualDeleteCount }),
      inserted,
      ...(outcome === undefined ? {} : { outcome }),
    }
    const removed = inbox.slice(actualStart, actualStart + actualDeleteCount)
    const event = this.session.append('agent/inbox/spliced', splice)
    if (discardRemoved) {
      for (const message of removed) this.dispatch.emit('agent/inbox/discarded', { message })
    }
    for (const message of event.data.inserted) {
      this.dispatch.emit('agent/inbox/inserted', { message })
    }
    return removed
  }
}
