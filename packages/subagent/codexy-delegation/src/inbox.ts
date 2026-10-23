/**
 * Activation-local admission around one continuable subagent's Agent inbox.
 *
 * @module @codexydsh/delegation/inbox
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { freezeMessage } from '@codexydsh/runtime/llm'
import type { UserMessage } from '@codexydsh/runtime/session'
import type { SubagentPromptRequest } from './control-types.ts'
import { SubagentError } from './error.ts'

/** One Agent inbox destination, as the wire request selects it. */
export type SubagentDelivery = SubagentPromptRequest['delivery'] | 'queue-only'

/**
 * Preserve non-waking delivery in the durable message source before inbox admission.
 * @param message - accepted inter-agent input.
 * @param delivery - selected inbox delivery mode.
 * @returns the input with durable delivery metadata when queue-only was selected.
 */
export function withSubagentDelivery(message: UserMessage, delivery: SubagentDelivery): UserMessage {
  if (delivery !== 'queue-only' || message.source.kind !== 'agent-message') return message
  return freezeMessage({ ...message, source: { ...message.source, queueOnly: true } })
}

/** Delegate Queue, Steer, and non-waking Queue to one live Agent until closing. */
export class SubagentInbox {
  private closingPromise: Promise<void> | undefined

  /**
   * Wrap one live continuable Agent.
   * @param agent - the Agent whose inbox receives accepted deliveries.
   */
  constructor(private readonly agent: Agent) {}

  /**
   * Read the Activation's close transaction.
   * @returns the memoized transaction, or `undefined` while delivery remains open.
   */
  get closing(): Promise<void> | undefined {
    return this.closingPromise
  }

  /**
   * Read whether the underlying Agent still has accepted work to claim.
   * @returns whether either Agent inbox destination is non-empty.
   */
  get hasPending(): boolean {
    return this.agent.inbox.nextTurn.length > 0 || this.agent.inbox.nextStep.length > 0
  }

  /**
   * Submit through the Agent only while its Activation remains resident.
   * @param message - the accepted input to submit.
   * @param delivery - whether to queue, steer, or queue without waking the Agent.
   * @param codexfulMailboxOrder - keep non-waking mail in the next-step FIFO even while idle.
   */
  deliver(message: UserMessage, delivery: SubagentDelivery, codexfulMailboxOrder?: true): void {
    if (this.closingPromise !== undefined) {
      throw new SubagentError(
        `subagent "${this.agent.id}" activation is being disposed; the message was not accepted`,
        'ACTIVATION_CLOSING',
      )
    }
    const accepted = withSubagentDelivery(message, delivery)
    if (delivery === 'steer') this.agent.steer(accepted)
    else if (delivery === 'queue') this.agent.followup(accepted)
    else if (codexfulMailboxOrder || this.agent.status === 'running') this.agent.inject(accepted)
    else this.agent.inbox.append('next-turn', accepted)
  }

  /**
   * Close delivery synchronously and share one asynchronous release.
   * @param release - the one release operation to start after closing admission.
   * @returns the memoized release transaction.
   */
  close(release: () => Promise<void>): Promise<void> {
    const existing = this.closingPromise
    if (existing !== undefined) return existing
    const completion = Promise.withResolvers<void>()
    this.closingPromise = completion.promise
    void release().then(completion.resolve, completion.reject)
    return completion.promise
  }
}
