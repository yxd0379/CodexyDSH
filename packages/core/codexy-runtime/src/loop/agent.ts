import { appendProductEvent, platformHeader, deriveMessageNodes, requestHeaderOf, deriveProductMessages } from '../session.ts'
/**
 * Default Agent driver over queued turns and step-boundary input. Every request
 * is derived from the session log.
 * @module dsh-agent-loop/agent
 */

import type {} from '../agent-api.ts'
import type { Agent, AgentEventDispatch, AgentOptions, AgentStatus, CancelOptions, InboxTarget, PreStepDecision, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { AgentCancelCause } from '@deepseek-ai/dsh-session'
import { agentEvents, assembleContextFor } from '../agent-api.ts'
import type { GenerateOptions, PreparedLlmCall, PreparedLlmModel, ToolSchema } from '../llm.ts'
import type { AssistantMessage, ContextSnapshotSection, LlmCallConfig, Message } from '@deepseek-ai/dsh-llm'
import {
  LlmError,
  createAssistantMessage,
  createDeveloperMessage,
  createUserMessage,
  errorChain,
  markAgentLoopRequest,
} from '../llm.ts'
import { assertNever, deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { EpochHeader } from '../session.ts'
import type { RequestContext, Session, SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { canonicalHeader, headerEquals, SessionSeq } from '../session.ts'
import { joinContextSections, renderContextSections, renderPrompt } from '../prompt.ts'
import type { PromptAssembly, PromptPreparation } from '../prompt.ts'
import { TOOL_REQUEST_CAPTURE, type ToolRequestBinding } from '../tools.ts'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { Context } from '@deepseek-ai/cordis'
import { ReactLoopInbox } from './inbox.ts'
import { ToolNotificationQueue } from './tool-notifications.ts'
import { DeveloperContextProjection, RuntimeContextProjection } from './runtime-context.ts'
import { AssistantStreamAttempt } from './assistant-stream.ts'
import { SystemPromptProjection } from './runtime-context.ts'
import { executeToolCalls } from './tool-calls.ts'
import { codexMultiAgentRoleMessage, codexPermissionMessage, codexPermissionRoleMigrations, projectCodexWorldState } from './codex-world-state.ts'
import type { CodexWorldStateInput, CodexWorldStateUpdates } from './codex-world-state.ts'
import type { CodexWorldStateProjection } from './world-state-projection.ts'
import { defaultInputAdmission } from './input-admission.ts'
import type { InputAdmissionPolicy } from './input-admission.ts'
import { codexMultiAgentModeMessage, codexMultiAgentModeRoleMigrations } from './codex-multi-agent-mode.ts'

const CODEX_INTERRUPTED_TURN_MARKER = '<turn_aborted>\nThe user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.\n</turn_aborted>'
const CODEX_DEVELOPER_INTERRUPTED_TURN_MARKER = '<turn_aborted>\nThe previous turn was interrupted on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.\n</turn_aborted>'

type Phase =
  | { kind: 'idle'; lastTurn: number }
  | {
    kind: 'maintenance'
    abort: AbortController
    lastTurn: number
    wakeRequested: boolean
  }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }

type StepEndReason = Extract<TurnEndReason, { kind: 'completed' | 'max-tokens' }>
type StepOutcome = { end: StepEndReason | null; assistant: AssistantMessage | undefined }


/** Decide whether pending non-waking mail waits for a later turn after a completed response. */
export type CodexMailboxDeferral = (
  message: AssistantMessage | undefined,
  pending: readonly UserMessage[],
) => boolean

type PreparedStep =
  | { kind: 'reject' }
  | {
    kind: 'enter'
    messages: UserMessage[]
    startsRequestSeries?: true
    developerContextPlacement?: 'after-agent-instructions'
    assembly: PromptAssembly
    promptPreparation: PromptPreparation
    preparedModel: PreparedLlmModel | undefined
    requestBinding: ToolRequestBinding
    developerSections: ContextSnapshotSection[]
    codexWorldState?: CodexWorldStateUpdates
    codexWorldStateInput?: CodexWorldStateInput
    contextSurfaceReplaced?: true
    contextRepair?: { message: UserMessage; seq?: SessionSeq }
    runtimeContextSections: ContextSnapshotSection[]
    runtimeContextMessage?: UserMessage | undefined
    injectedToolOutput?: true
  }

/** Remove adapter-derived values before plugins propose the next request config. */
function requestProposal(header: EpochHeader): LlmCallConfig {
  if (header.adapterDefaults === undefined) return header.config
  const proposal = { ...header.config }
  if (header.adapterDefaults.reasoningEffort === true) delete proposal.reasoningEffort
  if (header.adapterDefaults.maxTokens === true) delete proposal.maxTokens
  return proposal
}

/**
 * Read the cause `cancel()` passed when aborting a loop-owned signal, copying
 * only the fields `turn/end` records. The live reason stays the caller's
 * object, and Node's fetch assigns a `stack` onto it that `Session.append`
 * would either log or reject as data JSON cannot hold.
 * @param signal - a turn or maintenance signal this loop owns.
 * @returns the copied cause, or undefined while the signal is still live.
 */
function abortedCancelCause(signal: AbortSignal): AgentCancelCause | undefined {
  if (!signal.aborted) return undefined
  // `cancel()` is the only aborter of the signals this loop owns.
  const cause = signal.reason as AgentCancelCause
  switch (cause.kind) {
    case 'user':
    case 'parent':
    case 'disposed':
      return { kind: cause.kind }
    case 'hook':
      return { kind: 'hook', reason: cause.reason }
    /* v8 ignore next -- cancel accepts the closed AgentCancelCause union */
    default:
      return assertNever(cause)
  }
}

/** Drives one session through turn and step boundaries. */
export class ReactLoopAgent implements Agent {
  readonly inbox: ReactLoopInbox
  private phase: Phase
  private activeTurn: number | undefined
  private readonly toolNotifications: ToolNotificationQueue
  private activityDone: Promise<void> = Promise.resolve()

  /** The agent-scoped registration boundary; the lifecycle owner unwinds it after the driver exits. */
  readonly scope: Scope
  readonly ctx: Context

  /** Fused dispatcher, built once in the constructor so hot-path dispatches never allocate. */
  private readonly dispatch: AgentEventDispatch

  /** Whether this loop instance has appended its initial/resume request anchor. */
  private requestHeaderLogged = false
  /** Whether this attachment has guarded Codexful Responses headers for older readers. */
  /** Surface generation at attachment or the preceding built request. */
  private requestSurfaceGeneration: number
  private readonly runtimeContext: RuntimeContextProjection
  private readonly developerContext: DeveloperContextProjection
  /** Process-local revision of assistant frames for this attached Session. */
  private assistantStreamRevision = 0
  private assistantAttemptCounter = 0
  private readonly systemPrompt: SystemPromptProjection
  /** Identities fully frozen by this loop; weak references do not retain replaced history. */
  private readonly frozenMessages = new WeakSet<Message>()
  /** Number of active scoped Codexful marker registrations. */
  private interruptedTurnMarkerOwners = 0
  /** Number of scoped Codexful v2 child registrations using developer-role interruption markers. */
  private developerInterruptedTurnMarkerOwners = 0
  /** Number of scoped registrations that use Codex-style JSON parse feedback. */
  private codexToolArgumentFeedbackOwners = 0
  /** Number of scoped registrations that admit all parallel-safe calls in a step. */
  private codexToolConcurrencyOwners = 0
  /** Number of scoped registrations that start completed tool items during a model stream. */
  private codexMailboxDeferral: CodexMailboxDeferral | undefined
  private codexMailboxClassifier: ((message: UserMessage) => boolean) | undefined
  private codexPriorConversationClassifier: ((message: UserMessage) => boolean) | undefined
  /** Scoped Codexful renderer for the selected model's assembled base instructions. */
  private codexModelSwitchInstructions: ((assembly: PromptAssembly) => string) | undefined
  /** Scoped world-state contribution; ordinary agents keep the snapshot projector. */
  private codexWorldState: ((assembly: PromptAssembly) => CodexWorldStateInput) | undefined
  /** Scoped delegation mode text chosen from this step's prepared request. */
  private codexMultiAgentMode: ((config: LlmCallConfig, tools: readonly ToolSchema[]) => string | undefined) | undefined
  /** Scoped Session projection admitted only after the current route is prepared. */
  private preparedHistoryProjection: ((turn: number, step: number) => void) | undefined

  constructor(
    private loopCtx: Context,
    public readonly id: SessionId,
    public readonly options: AgentOptions,
    public readonly session: Session,
    private readonly inputAdmission: InputAdmissionPolicy = defaultInputAdmission,
  ) {
    this.requestSurfaceGeneration = session.surface.contentGeneration
    this.dispatch = agentEvents(loopCtx, this)
    this.scope = createScope(loopCtx, this)
    this.ctx = this.scope.ctx
    this.inbox = new ReactLoopInbox(this.ctx.sessionProjections, session, this.dispatch)
    this.toolNotifications = new ToolNotificationQueue(this.ctx, this, () => this.activeTurn)
    /* v8 ignore next -- the loop registers its own turnBoundary unit, so the key is always present */
    const lastTurn = this.loopCtx.sessionProjections.stateOf(session, 'turnBoundary')?.lastTurn ?? 0
    this.phase = { kind: 'idle', lastTurn }
    this.runtimeContext = new RuntimeContextProjection(this.ctx, session)
    this.developerContext = new DeveloperContextProjection(this.ctx, session)
    this.systemPrompt = new SystemPromptProjection(session)
  }

  get status(): AgentStatus {
    return this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running'
  }

  /**
   * Include Codex's interruption guidance in subsequent requests for this agent.
   * The returned disposer makes preset-scoped installation reversible.
   * @returns the registration disposer.
   */
  enableInterruptedTurnMarker(): () => void {
    this.interruptedTurnMarkerOwners++
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      this.interruptedTurnMarkerOwners--
    }
  }

  /** Install the selected-model instruction renderer for Codex-style switch history. */
  enableCodexModelSwitch(instructions: (assembly: PromptAssembly) => string): () => void {
    if (this.codexModelSwitchInstructions !== undefined) {
      throw new Error('Codex model-switch instructions are already installed for this agent')
    }
    this.codexModelSwitchInstructions = instructions
    return () => {
      if (this.codexModelSwitchInstructions === instructions) this.codexModelSwitchInstructions = undefined
    }
  }

  /** Install Codexful's append-only world-state projection for this agent. */
  enableCodexWorldState(resolve: (assembly: PromptAssembly) => CodexWorldStateInput): () => void {
    if (this.codexWorldState !== undefined) throw new Error('Codex world-state projection is already installed for this agent')
    this.codexWorldState = resolve
    return () => {
      if (this.codexWorldState === resolve) this.codexWorldState = undefined
    }
  }

  /** Install Codexful v2's request-time delegation mode renderer. */
  enableCodexMultiAgentMode(render: (config: LlmCallConfig, tools: readonly ToolSchema[]) => string | undefined): () => void {
    if (this.codexMultiAgentMode !== undefined) throw new Error('Codex multi-agent mode is already installed for this agent')
    this.codexMultiAgentMode = render
    return () => {
      if (this.codexMultiAgentMode === render) this.codexMultiAgentMode = undefined
    }
  }

  /** Install one post-preparation projection of already logged model history. */
  enablePreparedHistoryProjection(project: (turn: number, step: number) => void): () => void {
    if (this.preparedHistoryProjection !== undefined) throw new Error('prepared history projection is already installed for this agent')
    this.preparedHistoryProjection = project
    return () => {
      if (this.preparedHistoryProjection === project) this.preparedHistoryProjection = undefined
    }
  }

  /** Re-role only Codexful model-switch fragments when a route changes developer support. */
  private projectCodexModelSwitchRoles(turn: number, step: number, native: boolean): void {
    if (this.codexModelSwitchInstructions === undefined) return
    for (const seq of [...this.session.surface.nodes]) {
      // oxlint-disable-next-line typescript/no-deprecated -- Re-role the durable source of a visible fragment.
      const event = this.session.eventAt(seq)
      const message = event?.type === 'developer/message' ? event.data.message
        : event?.type === 'user/message' ? event.data : undefined
      if (message?.source.kind !== 'model-selection' || message.source.form !== 'instructions'
        || (native ? event?.type !== 'user/message' : event?.type !== 'developer/message')) continue
      const intent = { surfaceOp: { op: 'replace' as const, startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] }
      if (native) {
        this.session.append('developer/message', { turn, step, message: createDeveloperMessage({
          content: message.content, source: message.source,
        }) }, intent)
      } else {
        this.session.append('user/message', createUserMessage({
          content: message.content, source: message.source,
        }), intent)
      }
    }
  }

  /** Preserve exact-action acknowledgement roles across prepared provider changes. */
  private projectCodexApprovalRoles(turn: number, step: number, native: boolean): void {
    if (this.inputAdmission === defaultInputAdmission) return
    for (const { seq, message } of deriveMessageNodes(this.session)) {
      if (message.role !== 'user' && message.role !== 'developer') continue
      const kind: string = message.source.kind
      if (kind !== 'user-approval' || !('approvedActionId' in message.source)
        || (native ? message.role !== 'user' : message.role !== 'developer')) continue
      const intent = { surfaceOp: { op: 'replace' as const, startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] }
      const input = { content: message.content, source: message.source }
      if (native) this.session.append('developer/message', { turn, step, message: createDeveloperMessage(input) }, intent)
      else this.session.append('user/message', createUserMessage(input), intent)
    }
  }

  /** Read the last durable switch, including a switch not followed by a request header. */
  private codexModelSwitchState(): { pendingModel: string | undefined; missingModel: string | undefined } {
    if (this.codexModelSwitchInstructions === undefined) return { pendingModel: undefined, missingModel: undefined }
    const state = this.loopCtx.sessionProjections.stateOf(this.session, 'codexModelSwitch')
    if (state === undefined) throw new Error('agent-loop codex model-switch projection is not registered')
    const { latestSwitchSeq: seq, latestSwitchModel: model, latestHeaderSeq: headerSeq } = state
    if (seq === null || model === null) return { pendingModel: undefined, missingModel: undefined }
    return {
      pendingModel: headerSeq === null || seq > headerSeq ? model : undefined,
      missingModel: this.session.surface.nodes.includes(seq) ? undefined : model,
    }
  }

  private codexWorldStateProjection(): CodexWorldStateProjection {
    const state = this.loopCtx.sessionProjections.stateOf(this.session, 'codexWorldState')
    if (state === undefined) throw new Error('agent-loop Codex world-state projection is not registered')
    return state
  }

  /**
   * Mark interrupted turns for developer-role projection on the next real step.
   * The disposer restores the ordinary interruption marker for later turns.
   * @returns the registration disposer.
   */
  enableDeveloperInterruptedTurnMarker(): () => void {
    this.developerInterruptedTurnMarkerOwners++
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      this.developerInterruptedTurnMarkerOwners--
    }
  }

  /** Replace durable interruption placeholders in place on a developer-capable route. */
  private projectDeveloperInterruptedMarkers(turn: number, step: number): void {
    if (this.developerInterruptedTurnMarkerOwners === 0) return
    for (const seq of [...this.session.surface.nodes]) {
      if (seq < this.session.inheritedEventCount) continue
      // oxlint-disable-next-line typescript/no-deprecated -- Inspect the durable source of a visible node.
      const event = this.session.eventAt(seq)
      if (event?.type !== 'user/message' || event.data.source.kind !== 'user'
        || event.data.content.length !== 1 || event.data.content[0]?.type !== 'text') continue
      const marker = event.data.content[0].text
      if (marker !== CODEX_DEVELOPER_INTERRUPTED_TURN_MARKER && marker !== CODEX_INTERRUPTED_TURN_MARKER) continue
      const recordedSourceSeq = event.sourceEventSeqs?.find((sourceSeq) => {
        // oxlint-disable-next-line typescript/no-deprecated -- Resolve the marker's durable cancellation source.
        const source = this.session.eventAt(sourceSeq)
        return source?.type === 'turn/end' && source.data.reason.kind === 'aborted'
          && source.data.reason.reason.kind === 'user'
      })
      const sourceSeq = recordedSourceSeq ?? (marker === CODEX_INTERRUPTED_TURN_MARKER
        && event.sourceEventSeqs === undefined ? SessionSeq(seq - 1) : undefined)
      if (sourceSeq === undefined) continue
      // oxlint-disable-next-line typescript/no-deprecated -- Older markers cited no source event.
      const source = this.session.eventAt(sourceSeq)
      if (source?.type !== 'turn/end' || source.data.reason.kind !== 'aborted'
        || source.data.reason.reason.kind !== 'user') continue
      this.session.append('developer/message', {
        turn,
        step,
        message: createDeveloperMessage({
          content: [{ type: 'text', text: CODEX_DEVELOPER_INTERRUPTED_TURN_MARKER }],
          source: { kind: 'user' },
        }),
      }, {
        surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
        sourceEventSeqs: [seq, sourceSeq],
      })
    }
  }

  /**
   * Return malformed tool-call JSON to the model using Codex's feedback text.
   * The returned disposer restores standard DSH argument handling.
   * @returns the registration disposer.
   */
  enableCodexToolArgumentFeedback(): () => void {
    this.codexToolArgumentFeedbackOwners++
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      this.codexToolArgumentFeedbackOwners--
    }
  }

  /**
   * Admit every parallel-safe sibling without the ordinary DSH pool limit.
   * The returned disposer restores the configured limit for later steps.
   * @returns the registration disposer.
   */
  enableCodexToolConcurrency(): () => void {
    this.codexToolConcurrencyOwners++
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      this.codexToolConcurrencyOwners--
    }
  }


  /** Let a completed response leave only non-waking mail pending for a later turn. */
  enableCodexMailboxDeferral(shouldDefer: CodexMailboxDeferral): () => void {
    if (this.codexMailboxDeferral !== undefined) {
      throw new Error('Codex mailbox deferral is already installed for this agent')
    }
    this.codexMailboxDeferral = shouldDefer
    return () => {
      if (this.codexMailboxDeferral === shouldDefer) this.codexMailboxDeferral = undefined
    }
  }

  /** Claim fresh turn input before pending mail, and pending steers before mailbox input. */
  enableCodexInputOrder(isMailbox: (message: UserMessage) => boolean,
    isPriorConversation?: (message: UserMessage) => boolean): () => void {
    if (this.codexMailboxClassifier !== undefined) {
      throw new Error('Codex input ordering is already installed for this agent')
    }
    this.codexMailboxClassifier = isMailbox
    this.codexPriorConversationClassifier = isPriorConversation
    return () => {
      if (this.codexMailboxClassifier === isMailbox) {
        this.codexMailboxClassifier = undefined
        this.codexPriorConversationClassifier = undefined
      }
    }
  }

  /** Commit a phase and publish its externally visible status transition. */
  private setPhase(next: Phase): void {
    const previousStatus = this.status
    this.phase = next
    const status = this.status
    if (status !== previousStatus) {
      this.dispatch.emit('agent/status', { status })
    }
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    // Waking input cannot join an aborted activity, so it starts the next turn.
    // Captured before the insertion so a reentrant cancel from a splice observer cannot reclassify it.
    const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    const resolvedTarget = wakingAfterAbort ? 'next-turn' : target
    this.inbox.splice(resolvedTarget, Infinity, 0, [message])
    if (wakeup) this.wakeDriver(wakingAfterAbort)
  }

  followup(input: UserMessage): void {
    this.send(input, 'next-turn', true)
  }

  steer(input: UserMessage): void {
    this.send(input, 'next-step', true)
  }

  inject(input: UserMessage): void {
    this.send(input, 'next-step', false)
  }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) {
      this.inbox.clear(this.codexPriorConversationClassifier)
      if (this.phase.kind !== 'idle') this.phase.wakeRequested = false
    }
    if (this.phase.kind !== 'idle' && !this.phase.abort.signal.aborted) {
      if (options.keepInbox && options.resumeInbox && cause.kind === 'user' && this.inbox.hasPending) {
        this.phase.wakeRequested = true
      }
      this.phase.abort.abort(cause)
      this.ctx.emit('agent/cancelled', { agent: this, cause })
    }
  }

  runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
    const done = Promise.withResolvers<void>()
    const maintenance: Phase = {
      kind: 'maintenance',
      abort: new AbortController(),
      lastTurn: this.phase.lastTurn,
      wakeRequested: false,
    }
    this.setPhase(maintenance)
    this.activityDone = done.promise
    return (async () => {
      try {
        return await job(maintenance.abort.signal)
      } finally {
        this.setPhase({ kind: 'idle', lastTurn: maintenance.lastTurn })
        const cause = abortedCancelCause(maintenance.abort.signal)
        if (cause?.kind !== 'disposed' && maintenance.wakeRequested && this.inbox.hasPending) this.wakeDriver()
        done.resolve()
      }
    })()
  }

  /**
   * Start one driver, or latch its wake behind maintenance or an aborted
   * activity. A wake sent while idle always opens its turn boundary, even
   * when its message was cleared; only a latched replay is suppressed when
   * the queue no longer holds the wake.
   * @param wakeAfterAbort - the {@link send} classification, captured before
   *   the inbox insertion so a reentrant cancel cannot reclassify it.
   */
  private wakeDriver(wakeAfterAbort = false): void {
    if (this.phase.kind !== 'idle') {
      // Maintenance and aborted drivers cannot deliver the wake: latch it for
      // replay at convergence. Live drivers claim queued work themselves;
      // disposal never latches, so teardown waits on no model turn.
      const reason = abortedCancelCause(this.phase.abort.signal)
      if (reason?.kind !== 'disposed' && (this.phase.kind === 'maintenance' || wakeAfterAbort)) {
        this.phase.wakeRequested = true
      }
      return
    }
    const driver = Promise.withResolvers<void>()
    this.activityDone = driver.promise
    this.setPhase({
      kind: 'running',
      abort: new AbortController(),
      turn: this.phase.lastTurn,
      step: 0,
      wakeRequested: false,
    })
    this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject)
  }

  async whenIdle(): Promise<void> {
    let activity: Promise<void>
    do {
      await (activity = this.activityDone)
    } while (activity !== this.activityDone)
  }

  /** Report one failure at its live boundary, then preserve it for driver containment. */
  private throwError(error: unknown): never {
    const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn
    const step = this.phase.kind === 'running' ? this.phase.step : 0
    this.dispatch.emit('agent/error', { turn, step, error })
    throw error
  }

  private async kick(): Promise<void> {
    try {
      while (await this.turn()) {}
    } catch (_error) {
      // Reported failures and cancellation are contained at the driver boundary.
    } finally {
      /* v8 ignore next -- kick owns a running phase until this driver boundary */
      if (this.phase.kind === 'running') {
        const { turn, wakeRequested } = this.phase
        this.setPhase({ kind: 'idle', lastTurn: turn })
        if (wakeRequested && this.inbox.hasPending) this.wakeDriver()
      }
    }
  }

  private async preStep(target: InboxTarget, position: { turn: number; step: number }): Promise<PreparedStep> {
    /* v8 ignore next -- private callers establish the running phase before proposing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": pre-step outside running phase`)
    const signal = this.phase.abort.signal
    const injectedToolOutput = this.toolNotifications.drain(position.turn)
    const claimed = this.inbox.claim(target, position.turn, this.codexMailboxClassifier, this.codexPriorConversationClassifier)
    const assemblyContext = assembleContextFor(this, signal)
    const promptPreparation = await this.loopCtx.codexyPrompt.prepare(assemblyContext)
    signal.throwIfAborted()
    const { provider, model } = promptPreparation.variables
    let preparedModel: PreparedLlmModel | undefined
    if (provider && model) {
      try {
        preparedModel = await this.loopCtx.codexyRequests.prepareModel(provider, model, signal)
      } catch (error: unknown) {
        // Middleware-only routes retain their existing dispatch validation.
        if (!(error instanceof LlmError) || error.code !== 'NO_ADAPTER') throw error
      }
    }
    signal.throwIfAborted()
    const preparedContext = { ...assemblyContext, promptPreparation, ...preparedModel === undefined ? {} : { preparedModel } }
    const requestCapture = await this.loopCtx.codexyTools.prepareRequest({
      context: preparedContext, variables: promptPreparation.variables,
    })
    const assembly = await this.loopCtx.codexyPrompt.assemble({
      ...preparedContext,
      [TOOL_REQUEST_CAPTURE]: requestCapture,
    }, promptPreparation)
    signal.throwIfAborted()
    const requestBinding = this.loopCtx.codexyTools.bindAssembly(requestCapture, assembly.tools, assembly.nestedTools)
    const worldStateInput = this.codexWorldState?.(assembly)
    const worldState = worldStateInput === undefined
      ? undefined : projectCodexWorldState(this.session, this.codexWorldStateProjection(), worldStateInput)
    const genericAssembly = worldState === undefined ? assembly : {
      ...assembly,
      contexts: assembly.contexts.filter(context =>
        context.name !== 'codexful:environment' && context.name !== 'codexful:permissions'
        && context.name !== 'codexful-v2:multi-agent-role'),
    }
    const sections = renderContextSections(genericAssembly)
    const renderedContext = joinContextSections(sections, assembly.contextSnapshotIntro)
    const context = this.runtimeContext.project(
      renderedContext, sections,
    )
    const decision = await this.dispatch.waterfall(
      'codexy-agent/pre-step', {
        messages: claimed, ...position, signal, promptPreparation,
        ...preparedModel === undefined ? {} : { preparedModel },
      },
      () => this.dispatch.waterfall('agent/pre-step', { messages: claimed, ...position, signal },
      (): Promise<PreStepDecision> => Promise.resolve<PreStepDecision>({
        kind: 'enter',
        messages: [
          ...claimed,
          ...context === undefined ? [] : [context],
          ...worldState?.environment === undefined ? [] : [worldState.environment],
        ],
      })),
    )
    signal.throwIfAborted()
    if (decision.kind === 'reject') return decision
    return this.refreshPreparedContext({
      ...decision, assembly, promptPreparation, preparedModel, requestBinding,
      developerSections: renderContextSections(genericAssembly, 'developer'),
      ...worldState === undefined ? {} : { codexWorldState: worldState },
      ...worldStateInput === undefined ? {} : { codexWorldStateInput: worldStateInput },
      runtimeContextSections: sections,
      ...injectedToolOutput ? { injectedToolOutput: true } : {},
      ...context === undefined ? {} : { runtimeContextMessage: context },
    })
  }

  /** Restore assembled runtime context after a listener replaces the history surface. */
  private refreshPreparedContext(
    decision: Extract<PreparedStep, { kind: 'enter' }>,
  ): Extract<PreparedStep, { kind: 'enter' }> {
    if (decision.assembly.contextSnapshotIntro !== 'none'
      || this.session.surface.contentGeneration === this.requestSurfaceGeneration) return decision
    const rendered = joinContextSections(decision.runtimeContextSections, decision.assembly.contextSnapshotIntro)
    const current = this.runtimeContext.project(rendered, decision.runtimeContextSections)
    const messages = decision.messages.filter(message => message !== decision.runtimeContextMessage)
    if (current === undefined) {
      const { contextRepair: _previousRepair, ...retained } = decision
      return { ...retained, messages, contextSurfaceReplaced: true, runtimeContextMessage: undefined }
    }
    const seq = this.runtimeContext.retainedSeq()
    return {
      ...decision, messages: [current, ...messages], contextSurfaceReplaced: true,
      runtimeContextMessage: current,
      contextRepair: { message: current, ...seq === undefined ? {} : { seq } },
    }
  }

  /** Whether the assembled tool schemas differ from the logged request header's. */
  private toolsChanged(tools: PromptAssembly['tools']): boolean {
    const baseline = requestHeaderOf(this.session)
    if (baseline === undefined) return false
    return !headerEquals(baseline, canonicalHeader({ ...baseline, tools: [...tools] }))
  }

  /** Open one turn before claiming its first proposed step. */
  private async turn(): Promise<boolean> {
    if (this.phase.kind !== 'running') {
      this.throwError(new Error(`agent "${this.id}": turn without driver reservation`))
    }
    const phase = this.phase
    const { signal } = phase.abort
    signal.throwIfAborted()
    const turn = phase.turn + 1
    try {
      this.session.append('turn/start', { turn })
    } catch (error: unknown) {
      this.throwError(error)
    }
    phase.turn = turn
    this.activeTurn = turn
    let turnEnds: TurnEndReason | null = null
    let deferredMailbox = false
    let target: InboxTarget = 'next-turn'
    try {
      while (true) {
        signal.throwIfAborted()
        const step = phase.step + 1
        const decision = await this.preStep(target, { turn, step })
        if (decision.kind === 'reject') {
          turnEnds = { kind: 'blocked' }
          return false
        }
        if (turnEnds && decision.messages.length === 0 && decision.injectedToolOutput !== true) break
        // A removed waking message or an enter decision rewritten to empty
        // still owns the initial turn boundary, but it spends no model call.
        if (phase.step === 0 && decision.messages.length === 0) {
          turnEnds = { kind: 'completed' }
          return false
        }
        signal.throwIfAborted()
        this.session.append('step/start', { turn, step })
        phase.step = step
        let latestAssistant: AssistantMessage | undefined
        try {
          // max-tokens is sticky: once any step hits the ceiling, later steps
          // that complete normally must not downgrade the turn outcome.
          const outcome = await this.step(decision)
          const stepEnd = outcome.end
          latestAssistant = outcome.assistant
          // max-tokens stays sticky: a later completed step must not
          // downgrade the turn outcome.
          if (turnEnds === null || turnEnds.kind !== 'max-tokens') turnEnds = stepEnd
        } finally {
          this.session.append('step/end', { turn, step })
        }
        signal.throwIfAborted()
        const shouldDeferMailbox = (): boolean => {
          if (turnEnds?.kind !== 'completed' || this.codexMailboxDeferral === undefined
            || this.inbox.nextStep.length === 0) return false
          return this.codexMailboxDeferral(latestAssistant, this.inbox.nextStep)
        }
        await this.dispatch.serial('agent/step-completed', {
          turn, step, signal,
          needsFollowUp: turnEnds === null || this.toolNotifications.hasPending
            || this.inbox.nextStep.length > 0 && !shouldDeferMailbox(),
        })
        signal.throwIfAborted()
        if (turnEnds && !this.toolNotifications.hasPending && (this.inbox.nextStep.length === 0 || shouldDeferMailbox())) {
          await this.dispatch.serial('agent/turn-stopping', { turn, signal })
          signal.throwIfAborted()
        }
        if (turnEnds && !this.toolNotifications.hasPending && (this.inbox.nextStep.length === 0 || shouldDeferMailbox())) {
          deferredMailbox = this.inbox.nextStep.length > 0
          break
        }
        target = 'next-step'
      }
    } catch (error: unknown) {
      // A cause is present exactly while the signal is aborted.
      const cause = abortedCancelCause(signal)
      if (cause !== undefined) {
        turnEnds = { kind: 'aborted', reason: cause }
        throw error
      }
      // Every failure is structured: an `LlmError` keeps its facts, anything
      // else flattens to `errorChain` text under the `UNKNOWN` code.
      turnEnds = {
        kind: 'error',
        error: error instanceof LlmError
          ? error.failure
          : { message: errorChain(error), code: 'UNKNOWN' },
      }
      this.throwError(error)
    } finally {
      this.activeTurn = undefined
      try {
        this.toolNotifications.drain(turn)
        // oxlint-disable-next-line typescript/no-non-null-assertion -- every exit assigns a turn ending
        const turnEnd = this.session.append('turn/end', { turn, reason: turnEnds! })
        if (turnEnds?.kind === 'aborted' && turnEnds.reason.kind === 'user'
          && (this.interruptedTurnMarkerOwners > 0 || this.developerInterruptedTurnMarkerOwners > 0)) {
          const developer = this.developerInterruptedTurnMarkerOwners > 0
          this.session.append('user/message', createUserMessage({
            content: [{ type: 'text', text: developer
              ? CODEX_DEVELOPER_INTERRUPTED_TURN_MARKER
              : CODEX_INTERRUPTED_TURN_MARKER }],
            source: { kind: 'user' },
          }), { surfaceOp: 'append', sourceEventSeqs: [turnEnd.seq] })
        }
      } catch (error: unknown) {
        this.throwError(error)
      }
    }
    if (!this.inbox.hasPending || deferredMailbox && this.inbox.nextTurn.length === 0) return false
    phase.abort = new AbortController()
    // A fresh controller makes a latch set on the old one stale: the live driver claims the queue itself.
    phase.wakeRequested = false
    phase.step = 0
    return true
  }

  private async step(decision: Extract<PreparedStep, { kind: 'enter' }>): Promise<StepOutcome> {
    /* v8 ignore next -- private callers establish the running phase before executing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": step outside running phase`)
    const { turn, step, abort: { signal } } = this.phase
    signal.throwIfAborted()

    const { assembly, promptPreparation, preparedModel, requestBinding } = decision
    const requestTools = [...this.loopCtx.codexyTools.requestSchemas(requestBinding)]
    const renderedPrompt = renderPrompt(assembly)
    const switchState = this.codexModelSwitchState()
    const previousModel = switchState.pendingModel ?? requestHeaderOf(this.session)?.config.model
    let firstAttempt = true
    let attempt = 0
    while (true) {
      const { config, preparedCall } = await this.prepareRequest(turn, step, signal, promptPreparation, preparedModel)
      let entryFailure: { error: unknown } | undefined
      try {
        await this.dispatch.serial('agent/request-enter', {
          turn, step, attempt: ++attempt, signal, config, promptPreparation,
          ...preparedModel === undefined ? {} : { preparedModel },
        })
        signal.throwIfAborted()
      } catch (error: unknown) {
        entryFailure = { error }
      }
      if (firstAttempt) decision = this.refreshPreparedContext(decision)
      if (firstAttempt && entryFailure === undefined) {
        const messages = await this.dispatch.waterfall('agent/request-input', {
          messages: decision.messages, turn, step, signal, config, promptPreparation,
          ...preparedModel === undefined ? {} : { preparedModel },
        }, () => Promise.resolve(decision.messages))
        signal.throwIfAborted()
        decision = { ...decision, messages }
      }
      const nativeDeveloperHistory = preparedCall?.developerHistory === 'native'
      if (firstAttempt) {
        if (entryFailure === undefined) signal.throwIfAborted()
        this.preparedHistoryProjection?.(turn, step)
      }
      if (firstAttempt && nativeDeveloperHistory) this.projectDeveloperInterruptedMarkers(turn, step)
      {
        this.projectCodexModelSwitchRoles(turn, step, nativeDeveloperHistory)
        this.projectCodexApprovalRoles(turn, step, nativeDeveloperHistory)
        for (const { seq, message } of codexMultiAgentModeRoleMigrations(
          this.session, nativeDeveloperHistory,
        )) {
          const intent = { surfaceOp: { op: 'replace' as const, startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] }
          if (message.role === 'developer') this.session.append('developer/message', { turn, step, message }, intent)
          else this.session.append('user/message', message, intent)
        }
        for (const { seq, message } of codexPermissionRoleMigrations(
          this.session, nativeDeveloperHistory,
        )) {
          const intent = { surfaceOp: { op: 'replace' as const, startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] }
          if (message.role === 'developer') this.session.append('developer/message', { turn, step, message }, intent)
          else this.session.append('user/message', message, intent)
        }
        for (const { seq, message } of this.developerContext.migration(nativeDeveloperHistory)) {
          const intent = { surfaceOp: { op: 'replace' as const, startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] }
          if (message.role === 'developer') {
            this.session.append('developer/message', { turn, step, message }, intent)
          } else {
            this.session.append('user/message', message, intent)
          }
        }
      }
      const developerUpdate = firstAttempt && nativeDeveloperHistory
        ? this.developerContext.project(decision.developerSections, this.codexWorldState !== undefined)
        : undefined
      const fallbackPermissionUpdate = firstAttempt && !nativeDeveloperHistory
        ? this.developerContext.projectFallback(decision.developerSections, this.codexWorldState !== undefined)
        : undefined
      if (entryFailure === undefined && !nativeDeveloperHistory
        && deriveProductMessages(this.session).some(message => message.role === 'developer')) {
        throw new LlmError(
          `provider "${config.provider}" model "${config.model}" cannot replay developer-role history from this Session`,
          'UNSUPPORTED_CONTENT',
        )
      }
      const startsRequestSeries = firstAttempt && decision.startsRequestSeries === true
      const commits = this.systemPrompt.project(renderedPrompt, {
        inHistory: preparedCall?.systemPromptUpdate === 'in-history',
        startsSeries: startsRequestSeries
          || this.requestSurfaceGeneration !== this.session.surface.contentGeneration
          || this.toolsChanged(requestTools),
      })
      for (const { message, intent } of commits) {
        this.session.append('system/message', { turn, step, message }, intent)
      }
      if ((firstAttempt
        ? previousModel !== undefined && previousModel !== config.model
          || switchState.missingModel === config.model
        : this.codexModelSwitchState().missingModel === config.model)
        && this.codexModelSwitchInstructions !== undefined) {
        const instructions = this.codexModelSwitchInstructions(assembly)
        if (instructions.length > 0) {
          const text = `<model_switch>\nThe user was previously using a different model. Please continue the conversation according to the following instructions:\n\n${instructions}\n</model_switch>`
          const content = [{ type: 'text' as const, text }]
          const source = { kind: 'model-selection' as const, form: 'instructions' as const, targetModel: config.model }
          if (nativeDeveloperHistory) {
            this.session.append('developer/message', { turn, step, message: createDeveloperMessage({ content, source }) }, { surfaceOp: 'append' })
          } else {
            this.session.append('user/message', createUserMessage({ content, source }), { surfaceOp: 'append' })
          }
        }
      }
      if (firstAttempt) {
        const worldState = decision.codexWorldStateInput === undefined ? undefined
          : projectCodexWorldState(this.session, this.codexWorldStateProjection(), decision.codexWorldStateInput)
        const worldPermission = worldState === undefined
          ? undefined : codexPermissionMessage(worldState, nativeDeveloperHistory)
        const multiAgentRole = worldState === undefined ? undefined : codexMultiAgentRoleMessage(worldState, nativeDeveloperHistory)
        const modeBody = this.codexMultiAgentMode?.(config, requestTools)
        const contextMode = worldState?.contextMode ?? 'delta'
        const multiAgentMode = this.codexMultiAgentMode === undefined ? undefined
          : codexMultiAgentModeMessage(this.session, modeBody, nativeDeveloperHistory,
            decision.codexWorldStateInput?.multiAgentRole, contextMode)
        const developerSeq = decision.contextSurfaceReplaced === true
          ? this.developerContext.developerSeq() : undefined
        const fallbackSeq = decision.contextSurfaceReplaced === true
          ? this.developerContext.fallbackSeq() : undefined
        const environmentCandidate = decision.codexWorldState?.environment
        const messages = worldState === undefined ? decision.messages : decision.messages.flatMap(message =>
          message !== environmentCandidate ? [message]
            : worldState.environment === undefined ? [] : [worldState.environment])
        if (worldState?.environment !== undefined
          && (environmentCandidate === undefined || !decision.messages.includes(environmentCandidate))) {
          messages.push(worldState.environment)
        }
        const planned = this.inputAdmission({
          messages,
          nativeDeveloperHistory,
          ...developerUpdate === undefined ? {} : { developer: developerUpdate },
          ...fallbackPermissionUpdate === undefined ? {} : { fallback: fallbackPermissionUpdate },
          ...worldPermission === undefined ? {} : { permission: worldPermission },
          ...multiAgentRole === undefined ? {} : { multiAgentRole },
          ...multiAgentMode === undefined ? {} : { multiAgentMode },
          ...worldState === undefined ? {} : { codexContextMode: contextMode },
          ...developerSeq === undefined ? {} : { developerSeq },
          ...fallbackSeq === undefined ? {} : { fallbackSeq },
          ...decision.contextRepair === undefined ? {} : { repair: decision.contextRepair },
          afterAgentInstructions: decision.developerContextPlacement === 'after-agent-instructions',
          omitModelSelectionNotice: this.codexModelSwitchInstructions !== undefined,
        })
        for (const { message, replaces } of planned) {
          const intent = replaces === undefined
            ? { surfaceOp: 'append' as const }
            : { surfaceOp: { op: 'replace' as const, startSeq: replaces, endSeq: replaces }, sourceEventSeqs: [replaces] }
          if (message.role === 'developer') this.session.append('developer/message', { turn, step, message }, intent)
          else this.session.append('user/message', message, intent)
        }
      } else {
        const modeBody = this.codexMultiAgentMode?.(config, requestTools)
        const multiAgentMode = this.codexMultiAgentMode === undefined ? undefined
          : codexMultiAgentModeMessage(this.session, modeBody, nativeDeveloperHistory,
            decision.codexWorldStateInput?.multiAgentRole)
        if (multiAgentMode?.role === 'developer') {
          this.session.append('developer/message', { turn, step, message: multiAgentMode }, { surfaceOp: 'append' })
        } else if (multiAgentMode !== undefined) {
          this.session.append('user/message', multiAgentMode, { surfaceOp: 'append' })
        }
      }
      if (entryFailure !== undefined) throw entryFailure.error
      firstAttempt = false
      const live = new AssistantStreamAttempt(
        this.session.id,
        ++this.assistantAttemptCounter,
        () => ++this.assistantStreamRevision,
        turn,
        step,
        (frame) => { this.dispatch.emit('agent/assistant-stream', { frame }) },
      )
      const request = this.buildRequest(config, preparedCall, requestTools, startsRequestSeries, signal,
        (timing) => {
          this.loopCtx.logger.debug('llm/request-timing %o', { sessionId: this.session.id, turn, step, timing })
        })
      // Follow upstream: settle the model response before starting its tools.
      let started = false
      try {
        const stream = preparedCall?.stream(request) ?? this.loopCtx.codexyRequests.stream(request)
        signal.throwIfAborted()
        live.start()
        started = true
        for await (const chunk of stream) {
          signal.throwIfAborted()
          live.push(chunk)
        }
        signal.throwIfAborted()
      } catch (error: unknown) {
        if (!started) throw error
        try {
          const content = signal.aborted ? live.interruptedBlocks() : []
          if (content.length > 0) {
            live.settle('assistant/message', () => this.session.append('assistant/message', {
              turn, step,
              message: createAssistantMessage({
                content,
                source: { provider: request.provider, model: request.model,
                  ...live.replayState === undefined ? {} : { replayState: live.replayState } },
              }),
              interrupted: true,
              ...live.usage === undefined ? {} : { usage: live.usage },
              stream: live.stream,
            }, { surfaceOp: 'append' }).seq)
          } else {
            live.settle('assistant/attempt', () => this.session.append('assistant/attempt', {
              turn, step, stream: live.stream,
            }).seq)
          }
        } catch (settlementError: unknown) {
          throw new AggregateError([error, settlementError],
            'Assistant stream failed and its durable settlement was rejected', { cause: error })
        }
        throw error
      }
      try {
        const finish = live.finish
        if (finish.kind === 'error' || finish.kind === 'aborted') {
          live.settle('assistant/attempt', () => this.session.append('assistant/attempt', {
            turn, step, stream: live.stream,
          }).seq)
          const action = await this.dispatch.waterfall('agent/request-error', {
            turn, step, provider: request.provider, failure: finish.failure,
            retryPolicy: preparedCall?.retryPolicy, signal,
          }, () => Promise.resolve<RequestErrorAction>(undefined))
          signal.throwIfAborted()
          if (action?.kind !== 'retry') throw new LlmError(finish.failure.message, finish.failure.code, finish.failure)
          continue
        }
        const message = createAssistantMessage({
          content: live.blocks(),
          source: { provider: request.provider, model: request.model,
            ...live.replayState === undefined ? {} : { replayState: live.replayState } },
        })
        live.settle('assistant/message', () => this.session.append('assistant/message', {
          turn, step, message, stream: live.stream,
          ...live.usage === undefined ? {} : { usage: live.usage },
        }, { surfaceOp: 'append' }).seq)
        const assistant = message
        if (finish.kind === 'max-tokens') return { end: { kind: 'max-tokens' }, assistant }
        const toolCalls = message.content.filter(block => block.type === 'tool-call')
        if (toolCalls.length === 0) return {
          end: finish.kind === 'stop' && finish.endTurn === false ? null : { kind: 'completed' },
          assistant,
        }
        const { concluded } = await executeToolCalls(
          this.loopCtx, turn, step, toolCalls, signal,
          context => this.inbox.splice('next-step', this.inbox.nextStep.length, 0, [context]),
          {
            codexArgumentFeedback: this.codexToolArgumentFeedbackOwners > 0,
            unboundedParallelCalls: this.codexToolConcurrencyOwners > 0,
            requestBinding,
          },
        )
        return { end: concluded ? { kind: 'completed' } : null, assistant }
      } catch (error: unknown) {
        if (!live.ended) live.abandon()
        throw error
      }
    }
  }

  /** Resolve request config and bind its adapter before admitting model-visible input. */
  private async prepareRequest(
    turn: number,
    step: number,
    signal: AbortSignal,
    promptPreparation: PromptPreparation,
    preparedModel: PreparedLlmModel | undefined,
  ): Promise<{ config: LlmCallConfig; preparedCall?: PreparedLlmCall }> {
    const { session } = this

    // A loop instance starts from its declared route, restoring only an explicit
    // effort owned by that exact model. Later steps re-resolve marked defaults.
    const persistedHeader = requestHeaderOf(session)
    const persistedConfig = persistedHeader?.config
    const route = { provider: this.options.provider ?? '', model: this.options.model ?? '' }
    const persistedReasoningEffort = persistedConfig?.provider === route.provider
      && persistedConfig.model === route.model
      && persistedHeader?.adapterDefaults?.reasoningEffort !== true
      ? persistedConfig.reasoningEffort
      : undefined
    const reasoningEffort = this.options.reasoningEffort ?? persistedReasoningEffort
    const maxTokens = this.options.maxTokens
    const seedConfig = deepFreeze(structuredClone(
      this.requestHeaderLogged
        // oxlint-disable-next-line typescript/no-non-null-assertion -- the instance logged the header it now folds
        ? requestProposal(persistedHeader!)
        : {
          ...route,
          ...reasoningEffort === undefined ? {} : { reasoningEffort },
          ...maxTokens === undefined ? {} : { maxTokens },
        },
    ))
    const proposedConfig = await this.dispatch.waterfall(
      'codexy-agent/request', {
        turn, step, signal, promptPreparation,
        ...preparedModel === undefined ? {} : { preparedModel },
      },
      () => this.dispatch.waterfall('agent/request', { turn, step, signal }, () => Promise.resolve(seedConfig)),
    )
    signal.throwIfAborted()
    if (!proposedConfig.provider || !proposedConfig.model) {
      throw new Error(`agent "${this.id}" has no provider/model: set AgentOptions.provider and AgentOptions.model or supply both via the agent/request waterfall`)
    }
    const { provider, model } = promptPreparation.variables
    if ((provider !== undefined && provider !== '' && proposedConfig.provider !== provider)
      || (model !== undefined && model !== '' && proposedConfig.model !== model)) {
      throw new Error(`agent "${this.id}" request route differs from the prepared prompt and tools`)
    }
    let config: LlmCallConfig
    let preparedCall: PreparedLlmCall | undefined
    try {
      preparedCall = preparedModel === undefined
        ? await this.loopCtx.codexyRequests.prepareCall(proposedConfig, signal) : preparedModel.prepareCall(proposedConfig)
      config = preparedCall.config
    } catch (error: unknown) {
      // Middleware may serve an unregistered route; terminal dispatch still requires an adapter.
      if (!(error instanceof LlmError) || error.code !== 'NO_ADAPTER') throw error
      config = deepFreeze(structuredClone(proposedConfig))
    }
    signal.throwIfAborted()
    return { config, ...preparedCall === undefined ? {} : { preparedCall } }
  }

  /** Log the resolved envelope and derive a frozen request from the admitted surface. */
  private buildRequest(
    config: LlmCallConfig,
    preparedCall: PreparedLlmCall | undefined,
    tools: GenerateOptions['tools'] & object,
    startsRequestSeries: boolean,
    signal: AbortSignal,
    onRequestTiming: NonNullable<GenerateOptions['onRequestTiming']>,
  ): GenerateOptions {
    const { session } = this
    const surfaceGeneration = session.surface.contentGeneration
    const header = canonicalHeader({
      config,
      ...preparedCall === undefined ? {} : { adapterDefaults: preparedCall.adapterDefaults },
      ...tools.length > 0 ? { tools } : {},
    })
    const baseline = requestHeaderOf(this.session)
    const startsSeries = startsRequestSeries
      || this.requestSurfaceGeneration !== surfaceGeneration
    let headerReason: 'initial' | 'resume' | 'change' | 'series' | undefined
    if (!this.requestHeaderLogged) {
      headerReason = baseline === undefined ? 'initial' : 'resume'
      this.requestHeaderLogged = true
    } else if (baseline === undefined || !headerEquals(baseline, header)) {
      headerReason = 'change'
    } else if (startsSeries) {
      headerReason = 'series'
    }
    if (headerReason !== undefined) {
      const data = { header, reason: headerReason,
        ...headerReason === 'change' && startsSeries ? { startsSeries: true as const } : {} }
      session.append('request/header', { ...data, header: platformHeader(header) })
      appendProductEvent(session, 'request/header', data)
    }
    this.requestSurfaceGeneration = surfaceGeneration

    const contextWindow = preparedCall?.context?.contextWindow
    const systemPromptUpdate = preparedCall?.systemPromptUpdate
    const requestContext: RequestContext = {
      provider: config.provider,
      model: config.model,
      ...contextWindow === undefined ? {} : { contextWindow },
      ...systemPromptUpdate === undefined ? {} : { systemPromptUpdate },
    }
    const previousContext = session.requestContext()
    if (previousContext?.provider !== requestContext.provider
      || previousContext.model !== requestContext.model
      || previousContext.contextWindow !== requestContext.contextWindow
      || previousContext.systemPromptUpdate !== requestContext.systemPromptUpdate) {
      session.append('request/context', requestContext)
    }
    signal.throwIfAborted()

    // canonicalHeader is shallow; append logs a detached snapshot, not these local values.
    deepFreeze(header)
    const boundaryMessages = deriveProductMessages(session)
    for (const message of boundaryMessages) {
      if (this.frozenMessages.has(message)) continue
      deepFreeze(message)
      this.frozenMessages.add(message)
    }
    Object.freeze(boundaryMessages)
    const request = markAgentLoopRequest(Object.freeze({
      ...header.config,
      messages: boundaryMessages,
      ...header.tools !== undefined ? { tools: header.tools } : {},
      sessionId: this.session.id,
      signal,
      onRequestTiming,
    }))
    return request
  }
}
