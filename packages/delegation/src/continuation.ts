import { encodeProductEvents } from '@codexydsh/runtime/session'
import { productSnapshot } from '@codexydsh/bridges/session-reads'
/**
 * Continuable-subagent orchestration behind `ctx.codexySubagents`: stable child ids,
 * descriptor persistence, provider preparation, cold resume, authorization,
 * and message routing. {@link ContinuableActivationRegistry} owns the mutable
 * process-local Activation graph and its settlement and disposal lifecycle.
 *
 * A continuable child has one durable Session and at most one process-local
 * Activation. The Agent inbox is the only turn queue, so this manager owns
 * durable orchestration while the Agent loop owns all turn ordering and
 * execution. No continuable path creates a Task or an intermediate
 * result-bearing wrapper.
 *
 * @module @codexydsh/delegation
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ReasoningEffortId, contentHasImage, createUserMessage } from '@codexydsh/runtime/llm'
import type { ContentBlock, MessageId, MessageSource } from '@codexydsh/runtime/llm'
import { SessionLogOffset } from '@codexydsh/runtime/session'
import type { SessionId } from '@codexydsh/runtime/session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { SessionObservation, SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import {
  childSessionMeta,
  captureDelegatedPolicyOverrides,
  resolveChildAgentOptions,
  resolveChildDepth,
} from './child-agent.ts'
import {
  ContinuableActivationRegistry,
} from './continuation-activation.ts'
import type { Activation } from './continuation-activation.ts'
import {
  agentMessageSource,
  codexfulAgentText,
  createAgentMessage,
  createCodexfulAgentMessage,
  withContinuableReturnGuidance,
} from './continuation-messages.ts'
import { assertSubagentMaxDepth } from './depth.ts'
import { foldSubagentDescriptor, snapshotSubagentDescriptor } from './descriptor.ts'
import { establishCatalogChild } from './catalog.ts'
import { SubagentError } from './error.ts'
import { withSubagentDelivery, type SubagentDelivery } from './inbox.ts'
import { isAdjacentAgentSendMessageTool } from './internal.ts'
import type { ActivationObserver } from './lifecycle.ts'
import type {
  ContinuableCreateRequest,
  ContinuableCreateSpec,
  ContinuableStart,
  ContinuableStartSpec,
  SubagentInterruptAuthority,
  SubagentSendMessageOptions,
} from './types.ts'

/** Inputs shared by model messages and human prompts. */
type ChildDeliveryOptions = {
  readonly delivery: SubagentDelivery
  /** Exact warm epoch captured before any resident-only delivery await. */
  readonly residentActivation?: Activation
  /** Codex v2 restores an unloaded child before accepting non-waking Agent mail. */
  readonly materializeOnQueueOnly?: true
  /** Codex v2 keeps non-waking mail FIFO with later waking follow-ups. */
  readonly codexfulMailboxOrder?: true
  /** Durable direct parent when a v2 task-tree target outlives that parent's Agent. */
  readonly taskTreeParentSession?: SessionId
  /**
   * A provided host source is preserved on the user message; omission attributes
   * an adjacent-Agent message to the parent.
   */
  readonly source?: MessageSource
  /** Original sender when task-tree routing admits delivery through an ancestor. */
  readonly author?: Agent
  readonly signal: AbortSignal
}

/** V2 Agent messages carry a single text payload, matching the tool's JSON schema. */
function codexfulPayload(content: ContentBlock[]): string {
  if (content.length !== 1 || content[0]?.type !== 'text') {
    throw new Error('Codexful task-tree messages require one plain-text block')
  }
  return content[0].text
}

/** Package-private hooks supplied by the owning service. */
interface ContinuationHost {
  /** Resolve one provider's detached continuable-creation contribution. */
  prepareContinuable(name: string, request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>
  /** Build the lifecycle observer for one Activation residency epoch. */
  observeActivation(provider: string, childId: SessionId, parent: Agent): ActivationObserver
}

/**
 * The continuable-subagent orchestration service behind `ctx.codexySubagents`. Tool
 * schema and host adapters are consumers of this one contract; foreground
 * one-shot delegation keeps calling `ctx.codexySubagents.start()` and never enters
 * this lifecycle.
 */
export class SubagentContinuationManager {
  private readonly activations: ContinuableActivationRegistry

  constructor(
    private readonly ctx: Context,
    private readonly host: ContinuationHost,
    maxActiveSubagents: () => number,
  ) {
    this.activations = new ContinuableActivationRegistry(
      ctx,
      (provider, childId, parent) => host.observeActivation(provider, childId, parent),
      maxActiveSubagents,
    )
  }

  /**
   * Start one continuable background child and resolve at initial inbox acceptance.
   * Every earlier failure disposes any created handle and rolls back Activation
   * and parent ownership without returning either id.
   * @param spec - provider, delegation request, and caller cancellation.
   * @returns the durable child id and accepted initial prompt message id.
   */
  async startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart> {
    const request = spec.request
    const parent = request.parent
    const initialPrompt = spec.codexfulTask
      ? [{ type: 'text' as const, text: codexfulAgentText(
        'NEW_TASK', spec.label, spec.label.slice(0, spec.label.lastIndexOf('/')),
        codexfulPayload(request.prompt),
      ) }]
      : request.prompt
    const initialSource: MessageSource = spec.codexfulTask
      ? agentMessageSource(parent)
      : { kind: 'user' }
    this.activations.assertAdmitting(parent)
    const persistence = this.requirePersistence()
    assertSubagentMaxDepth(request.maxDepth)
    const childId = spec.childId ?? brandString<SessionId>(randomUUID())
    this.activations.assertChildIdAvailable(childId)
    const childDepth = resolveChildDepth(parent, request.maxDepth)
    // Snapshot before any await: invalid descriptor JSON rejects the call
    // before a child exists, and the detached value is what reaches the log.
    const agentOptions = resolveChildAgentOptions(parent, request.agentOptions, childDepth)
    const agentProvider = agentOptions.provider
    const agentModel = agentOptions.model
    const agentReasoningEffort = agentOptions.reasoningEffort
    const descriptor = snapshotSubagentDescriptor({
      mode: 'continuable',
      provider: spec.provider,
      label: spec.label,
      ...agentProvider !== undefined ? { agentProvider } : {},
      ...agentModel !== undefined ? { agentModel } : {},
      ...agentReasoningEffort !== undefined ? { agentReasoningEffort } : {},
      ...request.persona !== undefined ? { persona: request.persona } : {},
      ...request.toolFilter !== undefined ? { toolFilter: request.toolFilter } : {},
    })
    const codexV1Identity = spec.codexV1Identity === undefined ? undefined : structuredClone(spec.codexV1Identity)
    // Capture before the first await: a later parent switch belongs to the
    // parent's future, not to this child.
    const delegatedPolicies = captureDelegatedPolicyOverrides(parent, request.delegatedApprovalPolicy)

    // An idle continuation-managed parent must not settle while a caller is
    // still creating its child. A turn-scoped delegation does not need this,
    // but the service is also callable outside a turn.
    const releaseHold = this.activations.holdOwnership(parent, childId)
    try {
      const prepared = await this.host.prepareContinuable(spec.provider, {
        sessionId: childId,
        parent,
        ...request.forkTurns === undefined ? {} : { forkTurns: request.forkTurns },
        signal: spec.signal,
      })
      spec.signal.throwIfAborted()
      this.activations.assertAdmitting(parent)

      const inheritedEventCount = prepared.inheritedEventCount
        ?? SessionLogOffset(prepared.seed?.length ?? 0)
      const seed = prepared.seed
      const messageId = await this.activations.locks.run(childId, async () => {
        spec.signal.throwIfAborted()
        this.activations.assertAdmitting(parent)
        this.activations.assertChildIdAvailable(childId)
        if (spec.childId !== undefined) {
          const persisted = await persistence.stat(childId, { signal: spec.signal })
          spec.signal.throwIfAborted()
          this.activations.assertAdmitting(parent)
          this.activations.assertChildIdAvailable(childId)
          if (persisted !== undefined) {
            throw new SubagentError(`subagent "${childId}" already exists`, 'DUPLICATE_CHILD')
          }
        }
        const activation = await this.activations.materialize({
          childId,
          provider: spec.provider,
          parent,
          create: {
            seed,
            meta: childSessionMeta(parent, childDepth, prepared.seed !== undefined),
            inheritedEventCount,
            delegatedPolicies,
            descriptor,
            ...codexV1Identity === undefined ? {} : { codexV1Identity },
          },
          agentOptions,
          composition: { persona: request.persona, toolFilter: request.toolFilter },
          signal: spec.signal,
        })
        const childHeader = activation.handle.agent.session.header
        return await this.submitMaterialized(
          activation,
          !spec.codexfulTask
            && isAdjacentAgentSendMessageTool(this.ctx.get('tools')?.get('send_message', activation.handle.agent))
            ? withContinuableReturnGuidance(parent.id, initialPrompt)
            : initialPrompt,
          { source: initialSource, signal: spec.signal, delivery: 'queue' },
          parent,
          () => { establishCatalogChild(parent.session, childHeader, descriptor) },
        )
      })
      return { childId, messageId }
    } catch (error: unknown) {
      releaseHold()
      throw error
    }
  }

  /**
   * Deliver one model-authored message across a direct edge by default.
   * Codexful routing rechecks same-root membership and preserves the target's
   * direct-parent ownership. Its queue-only delivery restores a missing child
   * through that parent; ordinary queue-only delivery writes the cold Session.
   * @param sender - exact live Agent authorizing and originating the message.
   * @param targetId - durable direct-parent or direct-child session id.
   * @param content - model-authored content to deliver.
   * @param options - caller cancellation before acceptance.
   * @returns the accepted message's inbox id.
   */
  async sendMessage(
    sender: Agent,
    targetId: SessionId,
    content: ContentBlock[],
    options: SubagentSendMessageOptions,
  ): Promise<MessageId> {
    if (this.ctx.agents.get(sender.id) !== sender) {
      throw new SubagentError(
        'message delivery requires the exact live sender agent',
        'UNAUTHORIZED',
      )
    }
    this.activations.assertAdmitting(sender)
    const residentActivation = options.residentOnly ? this.residentTarget(targetId) : undefined
    if (options.routing === 'codexful-task-tree') {
      return this.sendWithinTaskTree(sender, targetId, content, options, residentActivation)
    }
    const senderActivation = this.activations.get(sender.id)
    if (senderActivation !== undefined
      && senderActivation.handle.agent === sender
      && senderActivation.parentSession === targetId) {
      options.signal.throwIfAborted()
      return this.sendToParent(senderActivation, sender, content, options.delivery ?? 'steer')
    }
    if (sender.session.header.parentSession === targetId) {
      throw new SubagentError(
        `agent "${sender.id}" is not a resident continuable child and cannot send to parent "${targetId}"`,
        'UNAUTHORIZED',
      )
    }
    return this.deliverToChild(sender, targetId, content, {
      signal: options.signal,
      delivery: options.delivery ?? 'steer',
      ...residentActivation === undefined ? {} : { residentActivation },
    })
  }

  /** Validate a Codexful message against one root tree before using direct-parent delivery. */
  private async sendWithinTaskTree(
    sender: Agent,
    targetId: SessionId,
    content: ContentBlock[],
    options: SubagentSendMessageOptions,
    residentActivation?: Activation,
  ): Promise<MessageId> {
    let root = sender
    let brokenLineage = false
    while (root.session.header.parentSession !== undefined) {
      const parent = this.ctx.agents.get(root.session.header.parentSession)
      if (parent === undefined) {
        brokenLineage = true
        break
      }
      root = parent
    }
    let entries: Awaited<ReturnType<typeof this.ctx.codexySubagents.listDescendants>> | undefined
    if (brokenLineage) {
      let recovered = false
      for (const candidate of this.ctx.agents.roots()) {
        const descendants = await this.ctx.codexySubagents.listDescendants(candidate.id, options.signal)
        if (descendants.some(entry => entry.kind === 'child' && entry.id === sender.id)) {
          root = candidate
          entries = descendants
          recovered = true
          break
        }
      }
      if (!recovered) {
        throw new SubagentError('task-tree message requires a live root', 'PARENT_UNAVAILABLE')
      }
    }
    if (targetId === sender.id) throw new SubagentError('an agent cannot message itself', 'UNAUTHORIZED')
    entries ??= await this.ctx.codexySubagents.listDescendants(root.id, options.signal)
    if (residentActivation !== undefined) this.residentTarget(targetId, residentActivation)
    options.signal.throwIfAborted()
    if (this.ctx.agents.get(sender.id) !== sender) {
      throw new SubagentError('task-tree message requires the exact live sender', 'UNAUTHORIZED')
    }
    const senderEntry = entries.find(entry => entry.kind === 'child'
      && entry.mode === 'continuable' && entry.id === sender.id)
    const senderPath = sender.id === root.id ? '/root'
      : senderEntry?.kind === 'child' && senderEntry.mode === 'continuable' ? senderEntry.label : undefined
    if (senderPath === undefined) {
      throw new SubagentError('sender is outside the root task tree', 'UNAUTHORIZED')
    }
    const payload = codexfulPayload(content)
    if (targetId === root.id) {
      if (options.delivery !== 'queue-only') {
        throw new SubagentError("follow-up tasks can't target the root agent", 'UNAUTHORIZED')
      }
      const message = createCodexfulAgentMessage(sender, '/root', senderPath, payload)
      this.sendAgentMessage(root, message, 'queue-only')
      return message.id
    }
    const target = entries.find(entry => entry.kind === 'child'
      && entry.mode === 'continuable' && entry.id === targetId)
    if (target === undefined || target.kind !== 'child' || target.mode !== 'continuable') {
      throw new SubagentError(`subagent "${targetId}" is outside the sender's task tree`, 'UNAUTHORIZED')
    }
    const directParent = this.ctx.agents.get(target.parentId)
    return this.deliverToChild(directParent ?? root, targetId, [{
      type: 'text', text: codexfulAgentText('MESSAGE', target.label, senderPath, payload),
    }], {
      signal: options.signal,
      delivery: options.delivery ?? 'steer',
      source: agentMessageSource(sender),
      materializeOnQueueOnly: true,
      codexfulMailboxOrder: true,
      ...directParent === undefined ? { taskTreeParentSession: target.parentId } : {},
      ...residentActivation === undefined ? {} : { residentActivation },
    })
  }

  /**
   * Queue one human-authored prompt as a distinct direct-child turn.
   * @param parent - exact live direct parent authorizing delivery.
   * @param childId - durable direct-child session id.
   * @param content - model-visible prompt blocks.
   * @param source - durable attribution for the human prompt.
   * @param signal - caller cancellation before inbox acceptance.
   * @returns the accepted durable message id.
   */
  async queuePrompt(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    source: MessageSource,
    signal: AbortSignal,
  ): Promise<MessageId> {
    return this.deliverToChild(parent, childId, content, { source, signal, delivery: 'queue' })
  }

  /**
   * Steer one host-authored prompt to a direct continuable child.
   * @param parent - exact live direct parent authorizing delivery.
   * @param childId - durable direct-child session id.
   * @param content - model-visible prompt blocks.
   * @param source - durable attribution for the host prompt.
   * @param signal - caller cancellation before inbox acceptance.
   * @returns the accepted durable message id.
   */
  async steerPrompt(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    source: MessageSource,
    signal: AbortSignal,
  ): Promise<MessageId> {
    return this.deliverToChild(parent, childId, content, { source, signal, delivery: 'steer' })
  }

  /** Route one parent-originated delivery through residency and cold resume. */
  private async deliverToChild(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    options: ChildDeliveryOptions,
  ): Promise<MessageId> {
    this.activations.assertAdmitting(parent)
    const releaseHold = this.activations.holdOwnership(parent, childId)
    try {
      const messageId = await this.deliverFollowup(parent, childId, content, options)
      releaseHold()
      return messageId
    } catch (error: unknown) {
      releaseHold()
      throw error
    }
  }

  /** The delivery loop behind {@link deliverToChild}, run under the parent hold. */
  private async deliverFollowup(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    options: ChildDeliveryOptions,
  ): Promise<MessageId> {
    while (true) {
      const live = await this.activations.locks.run(childId, async () => {
        if (options.residentActivation !== undefined) this.residentTarget(childId, options.residentActivation)
        const activation = this.activations.get(childId)
        if (activation === undefined) {
          return options.delivery === 'queue-only' && !options.materializeOnQueueOnly
            ? this.queueColdMessage(parent, childId, content, { ...options, delivery: 'queue-only' })
            : this.coldResume(parent, childId, content, options)
        }
        const disposal = activation.inbox.closing
        /* v8 ignore next 3 -- the send-versus-dispose cutoff needs a delivery to
         * observe the transaction inside the same critical section that opened it. */
        if (disposal !== undefined) {
          return disposal.then(() => undefined, () => undefined)
        }
        if (contentHasImage(content)) {
          await this.assertImageCapable(activation.handle.agent, options.signal)
          if (options.residentActivation !== undefined) this.residentTarget(childId, options.residentActivation)
          if (activation.inbox.closing !== undefined) {
            await Promise.allSettled([activation.inbox.closing])
            return undefined
          }
        }
        const messageId = this.submitAdmitted(activation, content, options, parent)
        activation.announced = true
        return messageId
      })
      /* v8 ignore start -- only a delivery that lost the disposal cutoff retries. */
      if (live !== undefined) return live
      this.activations.assertAdmitting(parent)
      options.signal.throwIfAborted()
      /* v8 ignore stop */
    }
  }

  /** Refuse absent, closing, unpublished, or replaced resident-only targets. */
  private residentTarget(childId: SessionId, expected?: Activation): Activation {
    const activation = this.activations.get(childId)
    if (activation === undefined || expected !== undefined && activation !== expected
      || !activation.announced || activation.inbox.closing !== undefined
      || this.ctx.agents.get(childId) !== activation.handle.agent) {
      throw new SubagentError(`subagent "${childId}" is not loaded for this delivery`, 'NOT_RESUMABLE')
    }
    return activation
  }

  /**
   * Load a direct continuable child without admitting any new prompt.
   * @param parent - exact live direct parent authorizing the child.
   * @param childId - durable child identity to reconstruct or retain.
   * @param signal - caller cancellation before successful loading.
   * @returns completion of child reconstruction and residency admission.
   */
  async loadContinuable(parent: Agent, childId: SessionId, signal: AbortSignal): Promise<void> {
    this.activations.assertAdmitting(parent)
    this.activations.authorizeLineage(parent, childId, parent.id)
    const releaseHold = this.activations.holdOwnership(parent, childId)
    try {
      while (true) {
        const loaded = await this.activations.locks.run(childId, async () => {
          signal.throwIfAborted()
          this.activations.assertAdmitting(parent)
          const live = this.activations.get(childId)
          if (live !== undefined) {
            this.activations.authorizeLineage(parent, childId, live.parentSession)
            if (live.inbox.closing !== undefined) {
              await Promise.allSettled([live.inbox.closing])
              return false
            }
            live.retainUntilClose = true
            live.announced = true
            return true
          }
          const activation = await this.coldMaterialize(parent, childId, { signal, delivery: 'queue' }, true)
          try {
            signal.throwIfAborted()
            this.activations.assertAdmitting(parent)
            activation.announced = true
          } catch (error: unknown) {
            await this.activations.dispose(activation).catch((cleanupError: unknown) => {
              this.ctx.logger.warn(`subagent "${childId}" rollback after loading failed: ${String(cleanupError)}`)
            })
            throw error
          }
          return true
        })
        if (loaded) return
      }
    } finally {
      releaseHold()
    }
  }

  /**
   * Read an admitted direct child's current residency without reconstructing it.
   * @param parent - exact live direct parent claiming the child.
   * @param childId - direct-child Session id to inspect.
   * @returns its admitted Agent, or undefined during loading, closing, or absent ownership.
   */
  loadedContinuable(parent: Agent, childId: SessionId): Agent | undefined {
    return this.activations.loadedContinuable(parent, childId)
  }

  /**
   * Interrupt one live continuable child's current turn. Admission is
   * synchronous and the cancellation effect is asynchronous. An absent or
   * already-closing target is an accepted no-op after authority checks.
   * @param targetSessionId - the durable child session id to interrupt.
   * @param authority - the human parent address or exact live ancestor Agent.
   */
  interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void {
    this.activations.interrupt(targetSessionId, authority)
  }

  /** Deliver one resident continuable child's message to its live direct parent. */
  private sendToParent(
    activation: Activation,
    sender: Agent,
    content: ContentBlock[],
    delivery: SubagentDelivery,
  ): MessageId {
    /* v8 ignore next 6 -- only synchronous re-entrant teardown can open this
     * transaction between exact-agent authorization and this no-await span. */
    if (activation.inbox.closing !== undefined) {
      throw new SubagentError(
        `subagent "${sender.id}" activation is being disposed; the message was not delivered`,
        'ACTIVATION_CLOSING',
      )
    }
    const parent = this.ctx.agents.get(activation.parentSession)
    if (parent === undefined) {
      throw new SubagentError(
        'direct parent is not live; the message was not delivered',
        'PARENT_UNAVAILABLE',
      )
    }
    const message = createAgentMessage(sender, content)
    this.sendAgentMessage(parent, message, delivery)
    return message.id
  }

  /** Send one Agent message while translating only the target's own rejection. */
  private sendAgentMessage(
    parent: Agent,
    message: ReturnType<typeof createUserMessage>,
    delivery: SubagentDelivery,
  ): void {
    try {
      this.activations.sendWaking(parent, message, delivery)
    } catch (error: unknown) {
      throw new SubagentError(
        'direct parent is not live; the message was not delivered',
        'PARENT_UNAVAILABLE',
        { cause: error },
      )
    }
  }

  /** Close manager-wide admission and release every live Activation. */
  async drain(): Promise<void> {
    await this.activations.drain()
  }

  /**
   * Stop only the continuable descendants of exact live host-owned parents.
   * @param parents - exact live roots whose continuable descendants must stop.
   */
  async drainDescendants(parents: readonly Agent[]): Promise<void> {
    await this.activations.drainDescendants(parents)
  }

  /**
   * Release selected resident direct children of one exact live parent.
   * @param parent - exact live direct parent authorizing the selected release.
   * @param childIds - durable direct-child ids to release when resident.
   */
  async drainChildren(parent: Agent, childIds: readonly SessionId[]): Promise<void> {
    await this.activations.drainChildren(parent, childIds)
  }

  /**
   * Unload a terminal Codexful child with no active turn or pending mail.
   * @param parent - exact live direct parent or task-tree root of the candidate.
   * @param childId - candidate child Session id.
   * @returns whether the candidate was safely unloaded.
   */
  tryUnloadCodexfulChild(parent: Agent, childId: SessionId): Promise<boolean> {
    return this.activations.tryUnloadCodexfulChild(parent, childId)
  }

  /**
   * Cold-resume a persisted child and submit the waiting turn. The descriptor
   * supplies every reconstruction input; no subagent provider is dispatched.
   */
  private async coldResume(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    options: ChildDeliveryOptions,
  ): Promise<MessageId> {
    const activation = await this.coldMaterialize(parent, childId, options)
    return await this.submitMaterialized(activation, content, options, parent)
  }

  /** Reconstruct one persisted child under the caller's existing child lock. */
  private async coldMaterialize(
    parent: Agent,
    childId: SessionId,
    options: ChildDeliveryOptions,
    retainUntilClose = false,
  ): Promise<Activation> {
    const query = this.requireSessionQuery()
    let observation: SessionObservation
    try {
      observation = await query.observeSession(childId, {
        signal: options.signal,
      })
    } catch (error: unknown) {
      options.signal.throwIfAborted()
      throw new SubagentError(`subagent "${childId}" is unavailable`, 'NOT_RESUMABLE', { cause: error })
    }
    using source = observation
    this.activations.assertAdmitting(parent)
    if (options.taskTreeParentSession === undefined) {
      this.activations.authorizeLineage(parent, childId, source.header.parentSession)
    } else if (this.ctx.agents.get(parent.id) !== parent
      || parent.session.header.parentSession !== undefined
      || source.header.parentSession !== options.taskTreeParentSession) {
      throw new SubagentError('task-tree resume requires its live root and recorded parent', 'UNAUTHORIZED')
    }
    const descriptor = foldSubagentDescriptor(
      source.events.slice(source.inheritedEventCount),
    )
    if (descriptor === undefined || descriptor.mode !== 'continuable') {
      throw new SubagentError(
        `subagent "${childId}" has no supported continuation state and cannot be resumed; choose a different target`,
        'NOT_RESUMABLE',
      )
    }
    let activation: Activation
    try {
      activation = await this.activations.materialize({
        childId,
        provider: descriptor.provider,
        parent,
        agentOptions: {
          ...descriptor.agentProvider !== undefined ? { provider: descriptor.agentProvider } : {},
          ...descriptor.agentModel !== undefined ? { model: descriptor.agentModel } : {},
          ...descriptor.agentReasoningEffort !== undefined
            ? { reasoningEffort: ReasoningEffortId(descriptor.agentReasoningEffort) }
            : {},
        },
        composition: { persona: descriptor.persona, toolFilter: descriptor.toolFilter },
        ...retainUntilClose ? { retainUntilClose: true } : {},
        signal: options.signal,
      })
    } catch (error: unknown) {
      options.signal.throwIfAborted()
      if (error instanceof SubagentError) throw error
      throw new SubagentError(`subagent "${childId}" is unavailable`, 'NOT_RESUMABLE', { cause: error })
    }
    return activation
  }

  /** Persist a non-waking message for an inactive child without reserving an Activation slot. */
  private async queueColdMessage(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    options: ChildDeliveryOptions & { readonly delivery: 'queue-only' },
  ): Promise<MessageId> {
    await using handle = await this.requirePersistence().open(childId, 'write', { signal: options.signal })
    const { events, eventState } = await handle.read(0, undefined, { signal: options.signal })
    options.signal.throwIfAborted()
    this.activations.assertAdmitting(parent)
    this.activations.authorizeLineage(parent, childId, handle.header.parentSession)
    const descriptor = foldSubagentDescriptor(events.slice(handle.inheritedEventCount))
    if (descriptor === undefined || descriptor.mode !== 'continuable') {
      throw new SubagentError(
        `subagent "${childId}" has no supported continuation state and cannot receive a message`,
        'NOT_RESUMABLE',
      )
    }
    if (contentHasImage(content)) {
      await this.assertRouteImageCapable({
        provider: descriptor.agentProvider,
        model: descriptor.agentModel,
      }, options.signal)
    }
    const sessions = this.ctx.get('sessions')
    const projections = this.ctx.get('sessionProjections')
    if (sessions === undefined || projections === undefined) {
      throw new SubagentError('agent inbox projection is unavailable', 'CONTINUATION_UNAVAILABLE')
    }
    const session = sessions.prepare(childId, {
      seed: encodeProductEvents(events),
      meta: handle.header,
      inheritedEventCount: handle.inheritedEventCount,
      eventState,
    })
    const pending = projections.stateOf(session, 'inbox')
    if (pending === undefined) {
      throw new SubagentError('agent inbox projection is unavailable', 'CONTINUATION_UNAVAILABLE')
    }
    const message = options.source === undefined
      ? createAgentMessage(options.author ?? parent, content)
      : createUserMessage({ content, source: options.source })
    const accepted = withSubagentDelivery(message, options.delivery)
    options.signal.throwIfAborted()
    this.activations.assertAdmitting(parent)
    session.append('agent/inbox/spliced', {
      target: 'next-turn',
      start: pending['next-turn'].length,
      inserted: [accepted],
    })
    // A detached restore may add its own resume marker before the Inbox event.
    // oxlint-disable-next-line typescript/no-deprecated -- Persist the complete constructor-and-message suffix.
    const suffix = productSnapshot(session, SessionLogOffset(events.length))
    await handle.append(encodeProductEvents(suffix), { signal: options.signal })
    await handle.flush()
    return accepted.id
  }

  /** Admit a materialized child, commit its creation fact, and release it on failure. */
  private async submitMaterialized(
    activation: Activation,
    content: ContentBlock[],
    options: ChildDeliveryOptions,
    parent: Agent,
    commit?: () => void,
  ): Promise<MessageId> {
    try {
      if (contentHasImage(content)) {
        await this.assertImageCapable(activation.handle.agent, options.signal)
        if (activation.inbox.closing !== undefined) {
          throw new SubagentError(`subagent "${activation.childId}" is closing`, 'ACTIVATION_CLOSING')
        }
      }
      const messageId = this.submitAdmitted(activation, content, options, parent)
      commit?.()
      activation.announced = true
      return messageId
    } catch (error: unknown) {
      try {
        await this.activations.dispose(activation)
      } catch (cleanupError: unknown) {
        this.ctx.logger.warn(
          `subagent continuation: disposal after admission or catalog append failure also failed: ${String(cleanupError)}`,
        )
      }
      throw error
    }
  }

  /** Build and submit one message across the final synchronous admission cutoff. */
  private submitAdmitted(
    activation: Activation,
    content: ContentBlock[],
    options: ChildDeliveryOptions,
    parent: Agent,
  ): MessageId {
    const message = options.source === undefined
      ? createAgentMessage(options.author ?? parent, content)
      : createUserMessage({ content, source: options.source })
    return this.activations.submitAdmitted(
      activation,
      message,
      options.delivery,
      parent,
      options.signal,
      options.taskTreeParentSession,
      options.codexfulMailboxOrder,
    )
  }

  /** Refuse image content for a child whose fixed model accepts text only. */
  private async assertImageCapable(
    agent: Agent,
    signal: AbortSignal,
  ): Promise<void> {
    return this.assertRouteImageCapable(agent.options, signal)
  }

  /** Refuse image content against a stored child's fixed model route. */
  private async assertRouteImageCapable(
    route: { provider?: string | undefined; model?: string | undefined },
    signal: AbortSignal,
  ): Promise<void> {
    const { provider, model } = route
    if (provider === undefined || model === undefined) return
    const llm = this.ctx.get('llm')
    /* v8 ignore next -- without an LLM registry, delivery defers to projection. */
    if (llm === undefined) return
    const info = await llm.resolveModelInfo(provider, model, signal)
    if (info.inputModalities !== undefined && !info.inputModalities.includes('image')) {
      throw new SubagentError(
        `Model "${model}" does not support image input.`,
        'MODEL_DOES_NOT_SUPPORT_IMAGES',
      )
    }
  }

  /** Resolve the persistence service continuable children require, or fail loud. */
  private requirePersistence(): SessionPersistence {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new SubagentError(
        'continuable subagents require session persistence (load a dsh-session-persistence backend)',
        'PERSISTENCE_UNAVAILABLE',
      )
    }
    return persistence
  }

  /** Resolve the Session query service used for cold child observations. */
  private requireSessionQuery(): SessionQueryEngine {
    const query = this.ctx.get('sessionQuery')
    if (query === undefined) {
      throw new SubagentError(
        'continuable subagents require session query (load @deepseek-ai/dsh-session-query)',
        'CONTINUATION_UNAVAILABLE',
      )
    }
    return query
  }
}

export default SubagentContinuationManager
