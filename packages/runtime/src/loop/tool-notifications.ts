/** Active-turn admission and boundary recording of additional tool outputs. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '../agent-api.ts'
import type { SessionEventMap } from '../session.ts'
import { appendProductEvent } from '../session.ts'
import { createUserMessage } from '../llm.ts'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'

/** A driver's process-local pending outputs; only drained records reach model history. */
export class ToolNotificationQueue {
  private readonly pending: Omit<SessionEventMap['tool/notification'], 'turn'>[] = []

  /**
   * @param ctx - agent-scoped lifetime owning the injection listener.
   * @param owner - driver receiving the additional tool output.
   * @param activeTurn - currently open turn, absent while idle or closing admission.
   */
  constructor(ctx: Context, private readonly owner: Agent, private readonly activeTurn: () => number | undefined) {
    ctx.on('agent/tool-output-inject', (payload, next) => {
      if (payload.agent !== owner) return next()
      if (payload.message.content.every(block => block.type === 'text' && block.text.trim().length === 0)) return Promise.resolve()
      payload.signal?.throwIfAborted()
      if (this.activeTurn() === undefined) return Promise.reject(new Error('failed to inject tool output: no active turn'))
      const call = this.owner.session.snapshotEvents().findLast(event => event.type === 'tool/call'
        && event.data.callId === payload.message.source.callId)
      if (call?.type !== 'tool/call') return Promise.reject(new Error('additional tool output has no originating call'))
      if (payload.message.source.toolKind === 'freeform' && payload.message.source.name !== call.data.name) {
        return Promise.reject(new Error('additional tool output does not match its originating tool'))
      }
      this.pending.push(deepFreeze(structuredClone({
        callSeq: call.seq,
        message: payload.message,
        ...payload.historyTruncationTokenLimit === undefined ? {} : { historyTruncationTokenLimit: payload.historyTruncationTokenLimit },
        ...payload.originalText === undefined ? {} : { originalText: payload.originalText },
      })))
      return Promise.resolve()
    })
  }

  /** Whether another boundary must admit additional output before completing the turn. */
  get hasPending(): boolean { return this.pending.length > 0 }

  /**
   * Record queued outputs without changing the originating call's pending state.
   * @param turn - still-open turn admitting the messages.
   * @returns whether any output was admitted.
   */
  drain(turn: number): boolean {
    const accepted = this.pending.length > 0
    while (this.pending.length > 0) {
      const pending = this.pending[0]!
      appendProductEvent(this.owner.session, 'runtime/feature', { name: 'tool-notification', version: 1 })
      this.owner.session.append('user/message', createUserMessage({ content: pending.message.content, source: { kind: 'codexy-tool-notification', notification: { turn, ...pending } } }), { surfaceOp: 'append', sourceEventSeqs: [pending.callSeq] })
      this.pending.shift()
    }
    return accepted
  }
}
