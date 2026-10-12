import { requestHeaderOf } from '@codexydsh/runtime/session'
/**
 * Surface retention selection and the shared log-recorded compaction
 * transaction for automatic open-turn and manual idle-session compaction.
 *
 * @module @codexydsh/compaction/region
 */

import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  CompactionId,
  ManualCompactionError,
  compactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from './service.ts'
import type { CompactionInitialContextInjection, CompactionResult } from './service.ts'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { createUserMessage, errorChain, freezeMessage } from '@codexydsh/runtime/llm'
import type { ContextFormed, DeveloperMessage, Message, UserMessage } from '@codexydsh/runtime/llm'
import type { TokenMeasurement, TokenMeter } from '@codexydsh/token-meter'
import { SessionSeq, type Session, type SessionEvent } from '@codexydsh/runtime/session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { frameSummary } from './summarizer.ts'
import type { SummarizationInput, SummaryResult } from './summarizer.ts'
interface RegionDependencies {
  readonly meter: TokenMeter
  readonly checkpointFormat: 'dsh' | 'codex'
  readonly codexUserMessageTokens: number
  initialContext(agent: Agent, signal?: AbortSignal): Promise<readonly (UserMessage | DeveloperMessage)[] | undefined>
  summarize(input: SummarizationInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult>
  recover(error: unknown, agent: Agent, sourceEventSeqs: readonly SessionSeq[], signal?: AbortSignal): boolean
}

/** One validated inclusive span of current surface positions. */
interface SurfaceSelection {
  readonly start: SessionSeq
  readonly end: SessionSeq
  readonly startIdx: number
  readonly endIdx: number
  readonly shadowedSeqs: readonly SessionSeq[]
}

/** A selection with its priced snapshot and the replay input built from it. */
interface PreparedCompaction extends SurfaceSelection {
  readonly measurement: TokenMeasurement
  readonly selectedNodes: TokenMeasurement['nodes']
  readonly shadowedTokenCount: number
  /** Route-priced total of the selected span; the shrink comparison's unit. */
  readonly shadowedRouteTokenCount: number
  readonly input: SummarizationInput
}

type SummarizedCompaction = PreparedCompaction & SummaryResult & {
  readonly checkpointMessage: UserMessage
  readonly retainedContext: readonly (UserMessage | DeveloperMessage)[]
  readonly retainedUsers: readonly UserMessage[]
}

interface CompactionTransactionOptions {
  /** `current-turn` derives a numbered owner; `null` writes a standalone bracket. */
  readonly owner: 'current-turn' | null
  /** Surface relationship that must survive asynchronous summarization. */
  readonly stability: 'whole-surface' | 'selected-span'
  /** Codex pre-turn and manual replacement histories omit application context. */
  readonly initialContextInjection: CompactionInitialContextInjection
  /** Optional durability checkpoint after a successfully closed bracket. */
  readonly flush?: () => Promise<void>
  /** Manual command that initiated this transaction, when present. */
  readonly sourceCommandId?: CommandId
}

interface CompactionEntryState {
  readonly openTurn: number | null
  readonly unmatchedCompactionStart: SessionEvent<'compaction/start'> | undefined
  readonly latestEndSeedSeq: SessionSeq | undefined
}

/**
 * Rejects a summary whose replacement boundaries are no longer the ones it was
 * built from, distinguished from summarizer and shrink failures so a manual
 * caller can report the two causes differently.
 */
class SurfaceChangedError extends Error {}

/** Whether the summary may still replace the span it was built from. */
type StabilityCheck = (
  dependencies: RegionDependencies,
  session: Session,
  prepared: PreparedCompaction,
) => void

/** Failure captured after `compaction/start` has committed. */
interface TransactionFailure {
  readonly error: unknown
  readonly stage: 'summary' | 'commit'
}

/**
 * The `system/message` holding surface node 0, or `undefined` when another
 * message-producing event starts the surface.
 * @param session - session supplying the log behind the current surface.
 * @param headSeq - seq at surface node 0 of a non-empty surface.
 * @returns the system head event, or `undefined` without one.
 */
function systemHead(session: Session, headSeq: SessionSeq): SessionEvent<'system/message'> | undefined {
  // Surface nodes are current log seqs, so the event exists.
  // Existing Session history read; migration deferred.
  // oxlint-disable-next-line typescript/no-non-null-assertion, typescript/no-deprecated
  const head = session.eventAt(headSeq)!
  return head.type === 'system/message' ? head : undefined
}

/**
 * Resolve the next range starting at the first non-system surface node while
 * retaining a priced recent tail and never splitting an assistant
 * tool-call/result pair. A `system/message` at surface node 0 is never inside
 * the range; without one the range starts at node 0.
 * @param session - session supplying authoritative current surface positions.
 * @param measurement - unified pressure and surface measurement from the conversation meter.
 * @param retainTokens - minimum recent tail budget retained verbatim.
 * @param includeTail - select the complete non-system history for Codex-style compaction.
 * @returns the inclusive positional seq range to compact, or `null`.
 */
export function selectCompactableRange(
  session: Session,
  measurement: TokenMeasurement,
  retainTokens: number,
  includeTail = false,
): { start: SessionSeq; end: SessionSeq } | null {
  const pricedNodes = measurement.nodes
  if (pricedNodes.length === 0) return null

  const surfaceNodes = session.surface.nodes
  if (surfaceNodes.length !== pricedNodes.length
    || surfaceNodes.some((seq, index) => seq !== pricedNodes[index]?.seq)) {
    throw new Error('compaction: token-meter surface does not match the current session surface')
  }
  // oxlint-disable-next-line typescript/no-non-null-assertion
  const firstIdx = systemHead(session, surfaceNodes[0]!) === undefined ? 0 : 1

  let keepFromIdx = pricedNodes.length
  if (!includeTail) {
    let accumulated = 0
    for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
      // oxlint-disable-next-line typescript/no-non-null-assertion
      accumulated += pricedNodes[index]!.tokens
      keepFromIdx = index
      if (accumulated >= retainTokens) break
    }
  }
  if (keepFromIdx <= firstIdx) return null

  while (keepFromIdx > firstIdx && keepFromIdx < pricedNodes.length) {
    // oxlint-disable-next-line typescript/no-non-null-assertion
    if (toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx]!)) break
    keepFromIdx -= 1
  }
  if (keepFromIdx <= firstIdx) return null
  const tail = surfaceNodes[pricedNodes.length - 1]
  if (includeTail && (tail === undefined || !toolPairingBalancedAfter(session, tail))) return null

  // oxlint-disable-next-line typescript/no-non-null-assertion
  const first = surfaceNodes[firstIdx]!
  // oxlint-disable-next-line typescript/no-non-null-assertion
  const cutoff = surfaceNodes[keepFromIdx - 1]!
  return { start: first, end: cutoff }
}

/**
 * Run the single compaction transaction over one selected positional span.
 * Selection and validation are read-only. Idle/log validation and
 * `compaction/start` are synchronously adjacent, so the durable opening marker is
 * the compaction lock before summarization yields. Every later failure makes
 * exactly one `compaction/end` attempt; a failed close deliberately leaves the
 * unmatched start detectable.
 * @param dependencies - conversation meter and dynamically dispatched summarizer hook.
 * @param session - session whose surface is mutated.
 * @param start - inclusive first surface-node seq.
 * @param end - inclusive last surface-node seq.
 * @param agent - agent used by the summarizer.
 * @param options - bracket owner, stability rule, and optional durability checkpoint.
 * @param signal - optional summarization cancellation signal.
 * @returns the successful durable compaction result.
 */
export async function compactSurfaceRegion(
  dependencies: RegionDependencies,
  session: Session,
  start: SessionSeq,
  end: SessionSeq,
  agent: Agent,
  options: CompactionTransactionOptions,
  signal?: AbortSignal,
): Promise<CompactionResult> {
  if (options.owner === null) signal?.throwIfAborted()
  const selection = validateSurfaceRegion(session, start, end)
  if (dependencies.checkpointFormat === 'codex' && selection.endIdx !== session.surface.nodes.length - 1) {
    throw new Error('Codex compaction requires a range ending at the current surface tail')
  }
  const entryState = inspectCompactionEntryState(session)
  assertCompactionInactive(
    entryState.unmatchedCompactionStart,
    entryState.latestEndSeedSeq,
    'compaction',
  )

  let owner: number | null
  if (options.owner === null) {
    if (entryState.openTurn !== null) {
      throw new ManualCompactionError('busy', 'manual compaction: the session already has an open turn')
    }
    owner = null
  } else {
    if (entryState.openTurn === null) {
      throw new Error('compactRegion: no open turn — automatic compaction events must be enclosed in a turn')
    }
    owner = entryState.openTurn
  }

  const compactionId = CompactionId(randomUUID())
  const lifecycle = {
    compactionId,
    ...options.sourceCommandId === undefined ? {} : { sourceCommandId: options.sourceCommandId },
    turn: owner,
  }
  const startEvent = session.append('compaction/start', lifecycle)
  const assertStable: StabilityCheck = options.stability === 'whole-surface'
    || dependencies.checkpointFormat === 'codex'
    ? assertWholeSurfaceUnchanged
    : assertSelectedSpanStable
  let failure: TransactionFailure | undefined
  let flushFailure: unknown
  let result: CompactionResult | undefined
  let closed = false
  let closing = false
  let stage: TransactionFailure['stage'] = 'summary'

  try {
    const prepared = prepareCompaction(dependencies, session, selection)
    const retainedContext = dependencies.checkpointFormat === 'codex'
      && options.initialContextInjection === 'before-last-user-message'
      ? (await dependencies.initialContext(agent, signal)
        ?? retainCurrentContext(session, prepared.shadowedSeqs)).map(message => freezeMessage(message))
      : []
    signal?.throwIfAborted()
    assertStable(dependencies, session, prepared)
    const summarized = await summarizeCompaction(
      dependencies,
      prepared,
      agent,
      compactionId,
      options.sourceCommandId,
      assertStable,
      retainedContext,
      signal,
    )
    if (options.owner === null) signal?.throwIfAborted()
    assertStable(dependencies, session, summarized)
    stage = 'commit'
    const pending = commitCompactionBody(session, startEvent, summarized)
    closing = true
    const endEvent = session.append('compaction/end', lifecycle)
    closed = true
    result = completeCompaction(pending, endEvent)
  } catch (error: unknown) {
    failure = { error, stage: closing ? 'commit' : stage }
    if (!closing) {
      closing = true
      try {
        session.append('compaction/end', { ...lifecycle, error: errorChain(error) })
        closed = true
      } catch (closeError: unknown) {
        failure = { error: closeError, stage: 'commit' }
      }
    }
  }

  if (closed && options.flush !== undefined) {
    try {
      await options.flush()
    } catch (error: unknown) {
      flushFailure = error
    }
  }

  if (options.owner === null) signal?.throwIfAborted()
  if (failure !== undefined) {
    if (options.owner === null) throwManualFailure(failure)
    throw failure.error
  }
  if (flushFailure !== undefined) {
    throw new ManualCompactionError(
      'persistence',
      'manual compaction durability checkpoint failed',
      { cause: flushFailure },
    )
  }
  /* v8 ignore next -- every path without a result records and throws a failure above. */
  if (result === undefined) throw new Error('compaction committed without a result')
  return result
}

/** Classify one closed manual attempt without weakening cancellation precedence. */
function throwManualFailure(failure: TransactionFailure): never {
  if (failure.stage === 'commit') {
    throw new ManualCompactionError(
      'commit',
      'manual compaction did not commit cleanly',
      { cause: failure.error },
    )
  }
  if (failure.error instanceof SurfaceChangedError) {
    throw new ManualCompactionError(
      'changed',
      'the compacted history changed during manual compaction',
      { cause: failure.error },
    )
  }
  throw new ManualCompactionError(
    'summary',
    'manual compaction could not produce a smaller summary',
    { cause: failure.error },
  )
}

/**
 * Reject a durable unmatched compaction marker unless a later constructor-seed
 * boundary proves that its owner belongs to an earlier session lifecycle.
 * @param unmatchedCompactionStart - latest unmatched opening marker, if any.
 * @param latestEndSeedSeq - newest constructor-seed boundary, if any.
 * @param stage - operation label included in the busy diagnostic.
 */
function assertCompactionInactive(
  unmatchedCompactionStart: SessionEvent<'compaction/start'> | undefined,
  latestEndSeedSeq: SessionSeq | undefined,
  stage: string,
): void {
  if (unmatchedCompactionStart === undefined
    || (latestEndSeedSeq !== undefined
      && latestEndSeedSeq > unmatchedCompactionStart.seq)) return
  throw new ManualCompactionError(
    'busy',
    `${stage}: compaction already in progress; the session compaction lock is already active`,
  )
}

/**
 * Recheck the durable compaction lock after an asynchronous policy decision.
 * @param session - session whose latest marker state is inspected.
 * @param stage - operation label included in the busy diagnostic.
 */
export function assertNoActiveCompaction(session: Session, stage: string): void {
  const entryState = inspectCompactionEntryState(session)
  assertCompactionInactive(
    entryState.unmatchedCompactionStart,
    entryState.latestEndSeedSeq,
    stage,
  )
}

/** Validate one requested surface-position span before asynchronous work begins. */
function validateSurfaceRegion(session: Session, start: SessionSeq, end: SessionSeq): SurfaceSelection {
  const nodes = session.surface.nodes
  const startIdx = nodes.indexOf(start)
  const endIdx = nodes.indexOf(end)
  if (startIdx === -1) throw new Error(`compactRegion: start seq ${start} not found in surface`)
  if (endIdx === -1) throw new Error(`compactRegion: end seq ${end} not found in surface`)
  if (startIdx > endIdx) {
    throw new Error(
      `compactRegion: start seq ${start} (position ${startIdx}) is after end seq ${end} (position ${endIdx}) on the surface`,
    )
  }
  // oxlint-disable-next-line typescript/no-non-null-assertion
  if (!toolPairingBalancedBefore(session, nodes[startIdx]!)) {
    throw new Error(`compactRegion: start seq ${start} is not a balanced boundary (would split a step's tool-call/result pair)`)
  }
  // oxlint-disable-next-line typescript/no-non-null-assertion
  if (!toolPairingBalancedAfter(session, nodes[endIdx]!)) {
    throw new Error(`compactRegion: end seq ${end} is not a balanced boundary (would split a step, or the step is still open)`)
  }

  return { start, end, startIdx, endIdx, shadowedSeqs: nodes.slice(startIdx, endIdx + 1) }
}

/** Snapshot pricing and replay input for a validated surface range. */
function prepareCompaction(
  dependencies: RegionDependencies,
  session: Session,
  selection: SurfaceSelection,
): PreparedCompaction {
  const measurement = dependencies.meter.measure(session)
  const selectedNodes = measurement.nodes.slice(selection.startIdx, selection.endIdx + 1)
  if (selectedNodes.length !== selection.shadowedSeqs.length
    || selectedNodes.some((node, index) => node.seq !== selection.shadowedSeqs[index])) {
    throw new SurfaceChangedError('compaction: selected surface changed before summarization began')
  }
  return {
    ...selection,
    measurement,
    selectedNodes,
    // The shadow-price protocol prices replacements with the fixed heuristic
    // so the O(1) projection fold stays in agreement with its own appends;
    // retention, range selection, and the shrink comparison read the
    // route-priced `tokens` instead.
    shadowedTokenCount: selectedNodes.reduce((total, node) => total + node.heuristicTokens, 0),
    shadowedRouteTokenCount: selectedNodes.reduce((total, node) => total + node.tokens, 0),
    input: buildSummarizationInput(session, selection.shadowedSeqs),
  }
}

/** Run the summarizer and frame its replacement checkpoint. */
async function summarizeCompaction(
  dependencies: RegionDependencies,
  prepared: PreparedCompaction,
  agent: Agent,
  compactionId: CompactionResult['compactionId'],
  sourceCommandId: CommandId | undefined,
  assertStable: StabilityCheck,
  retainedContext: readonly (UserMessage | DeveloperMessage)[],
  signal?: AbortSignal,
): Promise<SummarizedCompaction> {
  let summaryResult: SummaryResult
  for (;;) {
    signal?.throwIfAborted()
    try {
      summaryResult = await dependencies.summarize({ ...prepared.input, source: {
        compactionId,
        ...sourceCommandId === undefined ? {} : { sourceCommandId },
        sourceEventSeqs: prepared.shadowedSeqs,
        shadowedRange: { start: prepared.start, end: prepared.end },
      } }, agent, signal)
      break
    } catch (error: unknown) {
      if (signal?.aborted === true) throw error
      assertStable(dependencies, agent.session, prepared)
      if (!dependencies.recover(error, agent, prepared.shadowedSeqs, signal)) throw error
      prepared = prepareCompaction(dependencies, agent.session,
        validateSurfaceRegion(agent.session, prepared.start, prepared.end))
    }
  }
  const checkpointMessage = createUserMessage({
    content: frameSummary(summaryResult.summary, dependencies.checkpointFormat),
    source: compactCheckpointSource(compactionId, sourceCommandId),
  })
  const retainedUsers = dependencies.checkpointFormat === 'codex'
    ? retainUserMessages(prepared.input.messages, dependencies.codexUserMessageTokens)
    : []
  if (dependencies.checkpointFormat !== 'codex') {
    const replacementTokenCount = dependencies.meter.estimateMessage(checkpointMessage)
    if (replacementTokenCount >= prepared.shadowedRouteTokenCount) {
      throw new Error(
        `summary is not smaller than the shadowed content (${replacementTokenCount} estimated framed tokens >= ${prepared.shadowedRouteTokenCount})`,
      )
    }
  }
  return {
    ...prepared,
    ...summaryResult,
    checkpointMessage,
    retainedContext,
    retainedUsers,
  }
}

/** Retain independent current context fragments when no application rebuild is supplied. */
function retainCurrentContext(session: Session, shadowedSeqs: readonly SessionSeq[]): (UserMessage | DeveloperMessage)[] {
  const groups = new Map<string, { index: number; message: UserMessage | DeveloperMessage }[]>()
  for (const [index, seq] of shadowedSeqs.entries()) {
    // The selected seqs are current surface nodes validated by compactSurfaceRegion.
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const event = session.eventAt(seq)
    const message = event?.type === 'developer/message' ? event.data.message
      : event?.type === 'user/message' ? event.data : undefined
    if (message === undefined) continue
    const sourceKind: string = message.source.kind
    if (sourceKind === 'agent-instructions') {
      groups.set(`agent-instructions:${seq}`, [{ index, message }])
      continue
    }
    if (sourceKind !== 'runtime-context') continue
    // Runtime-context producers declare these forms in agent-loop's source merge.
    const source = message.source as Message['source'] & ContextFormed
    const sections = source.form === 'snapshot' ? source.sections : []
    const separate = sections.find(section => section.name === 'codexful-v2:multi-agent-role'
      || section.name === 'codexful-v2:multi-agent-mode')
    const worldState: unknown = Reflect.get(source, 'codexWorldState') ?? Reflect.get(source, 'codexMultiAgentWorldState')
    const section: unknown = typeof worldState === 'object' && worldState !== null
      ? Reflect.get(worldState, 'section') : undefined
    const delta = (section === 'permissions' || section === 'environment')
      && typeof worldState === 'object' && worldState !== null
      && Reflect.get(worldState, 'mode') === 'delta'
    const group = section === 'permissions' || section === 'environment'
      || section === 'multi-agent-role' || section === 'multi-agent-mode' ? `world-state:${section}`
      : separate?.name ?? (message.role === 'developer' || source.form === 'instructions'
        ? 'developer-instructions' : 'environment')
    const previous = delta ? groups.get(group) ?? [] : []
    groups.set(group, [...previous, { index, message }])
  }
  return [...groups.values()].flat().sort((left, right) => left.index - right.index)
    .map(entry => entry.message)
}

/** Preserve context attribution while deferring native role restoration to request preparation. */
function storedContextMessage(message: UserMessage | DeveloperMessage): UserMessage {
  if (message.role === 'user') return message
  const source = message.source as Message['source'] & ContextFormed
  const separate = source.form === 'snapshot' && source.sections.some(section =>
    section.name === 'codexful-v2:multi-agent-role' || section.name === 'codexful-v2:multi-agent-mode')
  return createUserMessage({
    content: message.content,
    source: message.source.kind === 'runtime-context' && !separate
      && Reflect.get(source, 'codexWorldState') === undefined && Reflect.get(source, 'codexMultiAgentWorldState') === undefined
      ? { ...message.source, form: 'instructions' }
      : message.source,
  })
}

/** Preserve recent explicit user messages from the already selected model history. */
function retainUserMessages(
  messages: readonly Message[],
  maxTokens: number,
): UserMessage[] {
  let remaining = maxTokens
  const retained: UserMessage[] = []
  for (let index = messages.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const current = messages[index]
    if (current?.role !== 'user' || current.source.kind !== 'user') continue
    const text = current.content.filter(block => block.type === 'text').map(block => block.text).join('')
    if (text.length === 0) continue
    const tokens = Math.ceil(Buffer.byteLength(text, 'utf8') / 4)
    const content = tokens <= remaining && current.content.every(block => block.type === 'text')
      ? [...current.content]
      : [{ type: 'text' as const, text: truncateUserText(text, remaining) }]
    retained.unshift(freezeMessage({ ...current, content, source: { kind: 'user' } }))
    if (tokens > remaining) break
    remaining -= tokens
  }
  return retained
}

/** Apply Codex's approximate UTF-8 token budget while retaining both ends. */
function truncateUserText(text: string, maxTokens: number): string {
  const maxBytes = maxTokens * 4
  const chars = Array.from(text)
  let leftBytes = 0
  let rightBytes = 0
  const left: string[] = []
  const right: string[] = []
  for (const char of chars) {
    const bytes = Buffer.byteLength(char, 'utf8')
    if (leftBytes + bytes > Math.floor(maxBytes / 2)) break
    left.push(char)
    leftBytes += bytes
  }
  for (let index = chars.length - 1; index >= left.length; index -= 1) {
    const char = chars[index]
    if (char === undefined) break
    const bytes = Buffer.byteLength(char, 'utf8')
    if (rightBytes + bytes > maxBytes - Math.floor(maxBytes / 2)) break
    right.unshift(char)
    rightBytes += bytes
  }
  const removed = Math.ceil((Buffer.byteLength(text, 'utf8') - maxBytes) / 4)
  return `${left.join('')}…${removed} tokens truncated…${right.join('')}`
}

/** Reject a summary prepared against any earlier surface generation. */
function assertWholeSurfaceUnchanged(
  dependencies: RegionDependencies,
  session: Session,
  prepared: PreparedCompaction,
): void {
  const current = dependencies.meter.measure(session)
  if (!isDeepStrictEqual(current.nodes, prepared.measurement.nodes)) {
    throw new SurfaceChangedError('compaction: session surface changed during summarization')
  }
}

/**
 * Require only that the selected span remain the same present, contiguous,
 * equally priced, balanced replacement target. Nodes added outside it remain
 * visible and do not invalidate the summary.
 */
function assertSelectedSpanStable(
  dependencies: RegionDependencies,
  session: Session,
  prepared: PreparedCompaction,
): void {
  let current: SurfaceSelection
  try {
    current = validateSurfaceRegion(session, prepared.start, prepared.end)
  } catch (error: unknown) {
    throw new SurfaceChangedError(
      'compaction: the selected span is no longer a valid replacement target',
      { cause: error },
    )
  }
  if (!isDeepStrictEqual([...current.shadowedSeqs], [...prepared.shadowedSeqs])) {
    throw new SurfaceChangedError('compaction: the selected span changed during summarization')
  }
  const measured = dependencies.meter.measure(session).nodes.slice(current.startIdx, current.endIdx + 1)
  if (!isDeepStrictEqual(measured, prepared.selectedNodes)) {
    throw new SurfaceChangedError('compaction: the selected span was rewritten during summarization')
  }
}

/** Append one completed summary record and replacement body without yielding. */
function commitCompactionBody(
  session: Session,
  startEvent: SessionEvent<'compaction/start'>,
  summarized: SummarizedCompaction,
): Omit<CompactionResult, 'endSeq'> {
  const {
    start,
    end,
    shadowedSeqs,
    shadowedTokenCount,
    summary,
    provider,
    model,
    maxTokens,
    omittedInputMessages,
    usage,
    checkpointMessage,
    retainedContext,
    retainedUsers,
    clientMetadata,
  } = summarized
  const callRecord = summarized.llmStreamCall === true
    ? { rawOutput: summarized.rawOutput, llmStreamCall: true as const }
    : summarized.rawOutput === undefined ? {} : { rawOutput: summarized.rawOutput }
  const summaryData = {
    compactionId: startEvent.data.compactionId,
    ...startEvent.data.sourceCommandId === undefined
      ? {}
      : { sourceCommandId: startEvent.data.sourceCommandId },
    summary,
    ...callRecord,
    shadowedRange: { start, end },
    shadowedSeqs: [...shadowedSeqs],
    shadowedTokenCount,
    provider,
    model,
    ...maxTokens === undefined ? {} : { maxTokens },
    ...omittedInputMessages === undefined ? {} : { omittedInputMessages },
    ...usage === undefined ? {} : { usage },
    ...clientMetadata === undefined ? {} : { clientMetadata },
  }
  const summaryEvent = session.append('compaction/summary', summaryData)
  const storedContext = retainedContext.map(storedContextMessage)
  const lastUser = retainedUsers.at(-1)
  const [first, ...following] = [
    ...lastUser === undefined ? storedContext : [
      ...retainedUsers.slice(0, -1), ...storedContext, lastUser,
    ],
    checkpointMessage,
  ]
  session.append('user/message', first, {
    surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
    sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
  })
  for (const message of following) {
    session.append('user/message', message, {
      surfaceOp: 'append',
      sourceEventSeqs: [summaryEvent.seq],
    })
  }
  return {
    compactionId: startEvent.data.compactionId,
    ...startEvent.data.sourceCommandId === undefined
      ? {}
      : { sourceCommandId: startEvent.data.sourceCommandId },
    startSeq: startEvent.seq,
    summarySeq: summaryEvent.seq,
    summary,
    shadowedRange: { start, end },
    shadowedSeqs: [...shadowedSeqs],
    shadowedTokenCount,
  }
}

/** Attach the successfully appended close event to a pending result. */
function completeCompaction(
  pending: Omit<CompactionResult, 'endSeq'>,
  endEvent: SessionEvent<'compaction/end'>,
): CompactionResult {
  return { ...pending, endSeq: endEvent.seq }
}

/**
 * Reconstruct the last routed request's cacheable prefix for the shadowed
 * region: the system prompt held by the `system/message` at surface node 0,
 * the header's tool schemas, then the region's own derived messages in surface
 * order. The summarizer appends only the compaction instruction after this, so
 * the call is a genuine prefix of the conversation and reuses the provider's
 * KV cache. A surface without a system head, or whose head projects to no
 * message, contributes no leading system message.
 * @param session - session supplying the surface head, request header, and per-node projection.
 * @param shadowedSeqs - the surface-node seqs, in order, being compacted.
 * @returns the replayed conversation prefix to condense.
 */
function buildSummarizationInput(
  session: Session,
  shadowedSeqs: readonly SessionSeq[],
): SummarizationInput {
  const header = requestHeaderOf(session)
  // shadowedSeqs are current surface seqs, so the surface has a node 0.
  // oxlint-disable-next-line typescript/no-non-null-assertion
  const head = systemHead(session, session.surface.nodes[0]!)
  const system = head === undefined ? null : session.deriveEventMessage(head)
  const regionMessages = shadowedSeqs
    // shadowedSeqs are current surface seqs, so each is a valid log index.
    // Existing Session history read; migration deferred.
    // oxlint-disable-next-line typescript/no-non-null-assertion, typescript/no-deprecated
    .map(seq => session.deriveEventMessage(session.eventAt(seq)!))
    .filter((message): message is Message => message !== null)
  return {
    ...header?.tools === undefined ? {} : { tools: header.tools },
    headMessageCount: system === null ? 0 : 1,
    messages: system === null ? regionMessages : [system, ...regionMessages],
  }
}

/** Inspect open-turn, unmatched-compaction, and latest seed-boundary state independently. */
function inspectCompactionEntryState(session: Session): CompactionEntryState {
  let openTurn: number | null = null
  let openTurnStateKnown = false
  let unmatchedCompactionStart: SessionEvent<'compaction/start'> | undefined
  let compactionEntryStateKnown = false
  let latestEndSeedSeq: SessionSeq | undefined
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    // Existing Session history read; migration deferred.
    // oxlint-disable-next-line typescript/no-non-null-assertion, typescript/no-deprecated
    const event = session.eventAt(SessionSeq(seq))!
    if (latestEndSeedSeq === undefined && event.type === 'session/end-seed') {
      latestEndSeedSeq = event.seq
    }
    if (!compactionEntryStateKnown) {
      if (event.type === 'compaction/start') {
        unmatchedCompactionStart = event
        compactionEntryStateKnown = true
      } else if (event.type === 'compaction/end') {
        compactionEntryStateKnown = true
      }
    }
    if (!openTurnStateKnown) {
      if (event.type === 'turn/start') {
        openTurn = event.data.turn
        openTurnStateKnown = true
      } else if (event.type === 'turn/end') {
        openTurnStateKnown = true
      }
    }
    if (openTurnStateKnown
      && compactionEntryStateKnown
      && latestEndSeedSeq !== undefined) break
  }
  return { openTurn, unmatchedCompactionStart, latestEndSeedSeq }
}
