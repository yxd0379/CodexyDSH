/**
 * Schedules one assistant step's tool calls. Exclusive calls form barriers;
 * parallel calls use a rolling pool and are reclassified before start.
 * Dispatch may overlap; Codexful calls may also overlap policy admission.
 * Results and result context remain model-ordered. Abort or an internal
 * scheduler failure stops replenishment and drains started calls.
 *
 * Abort records synthetic error results for skipped calls so replay stays
 * valid. A terminal scheduler failure preserves already-recorded `tool/call`
 * events without fabricating results.
 * @module dsh-agent-loop/tool-calls
 */

import type { Context } from '@deepseek-ai/cordis'
import { createToolResultMessage, type ToolCallBlock } from '../llm.ts'
import type {} from '../session.ts'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { TOOL_ABORTED_BEFORE_DISPATCH, TOOL_RUNTIME_SCHEDULER, type ToolExecutionInput, type ToolExecutionMode, type ToolExecutionResult, type ToolRequestBinding, type ToolRunContext } from '../tools.ts'
import { assertNever } from '@deepseek-ai/dsh-util-values'

/** One tool call after argument parsing, ready to schedule. */
interface PlannedCall {
  block: ToolCallBlock
  exec: ToolExecutionInput
  parseError?: string
}

/** Settled dispatch awaiting model-order finalization. */
interface ToolSlot {
  kind: 'tool'
  exec: ToolRunContext
  result: ToolExecutionResult
  needsPost: boolean
}

/** A malformed JSON call answered before invoking a tool handler. */
interface ParseErrorSlot {
  kind: 'parse-error'
  result: ToolExecutionResult
}

type Slot = ToolSlot | ParseErrorSlot

/** One scheduler group outcome, including a drained cancellation. */
interface GroupOutcome {
  consumed: number
  aborted: boolean
  /** Whether any committed result carried {@link ToolExecutionResult.concludesTurn}. */
  concluded: boolean
}

/** Agent-scoped differences in the tool scheduler. */
interface ToolCallScheduleOptions {
  codexArgumentFeedback?: boolean
  unboundedParallelCalls?: boolean
  requestBinding?: ToolRequestBinding
}

/**
 * Schedule one assistant step's tool calls by their live concurrency mode.
 * Ordinary completion and abort commit started-call results in order. Abort
 * drains them, records synthetic results for unstarted calls, and returns with
 * the signal still aborted after accepting started-call context through the
 * caller-supplied acceptor (the machine stages it in its next-step inbox for the
 * step boundary). An internal scheduler failure stops new dispatches, drains
 * already-started dispatches, and rejects with the first failure without
 * fabricating tool results.
 * The committed step's AgentLoop driver boundary supplies the initiating Agent
 * that becomes each explicit {@link ToolExecutionInput.agent}.
 *
 * @param ctx - loop context that owns the tool registry and carries the initiating Agent.
 * @param turn - current turn number.
 * @param step - current step number.
 * @param toolCalls - assistant calls in model order.
 * @param signal - abort signal shared by the step.
 * @param acceptContext - accepts committed result context for the next step boundary.
 * @param options - agent-scoped Codex tool argument and parallel-call behavior.
 */
export async function executeToolCalls(
  ctx: Context,
  turn: number,
  step: number,
  toolCalls: ToolCallBlock[],
  signal: AbortSignal,
  acceptContext: (context: UserMessage) => void,
  options: ToolCallScheduleOptions = {},
): Promise<{ concluded: boolean }> {
  const agent = ctx.agents.requireInitiator()
  const { session } = agent

  // Inputs are distinct because tools/execute wrappers may replace `exec.signal`.
  const planned: PlannedCall[] = toolCalls.map((block) => {
    const name = options.requestBinding === undefined
      ? block.namespace === undefined && ctx.codexyTools.get(block.name, agent) !== undefined ? block.name : undefined
      : ctx.codexyTools.requestToolName(options.requestBinding, block.name, block.namespace)
    const parsed = block.kind === 'freeform'
      ? { arguments: block.arguments }
      : parseArguments(block.arguments, options.codexArgumentFeedback === true && name !== undefined)
    const expectedKind = options.requestBinding === undefined
      ? name === undefined ? undefined : ctx.codexyTools.get(name, agent)?.kind ?? 'function'
      : ctx.codexyTools.requestToolKind(options.requestBinding, block.name, block.namespace)
    const kindError = expectedKind !== undefined && expectedKind !== (block.kind ?? 'function')
      ? `tool ${block.name} requires ${expectedKind} input` : undefined
    const notOffered = name === undefined && (options.codexArgumentFeedback === true || block.namespace !== undefined)
    return {
      block,
      exec: {
        callId: block.id,
        name: name ?? block.name,
        arguments: parsed.arguments,
        agent,
        signal,
        ...options.requestBinding === undefined ? {} : { requestBinding: options.requestBinding },
      },
      ...notOffered ? { parseError: unsupportedCall(block) }
        : kindError !== undefined ? { parseError: kindError }
          : parsed.parseError === undefined ? {} : { parseError: parsed.parseError },
    }
  })

  let next = 0
  let concluded = false
  while (next < planned.length) {
    // Commit before classifying again so registry changes affect unstarted calls.
    // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop condition
    const first = planned[next]!
    const mode = first.parseError === undefined ? ctx.codexyTools.executionMode(first.exec).kind : 'exclusive'
    const group = mode === 'parallel' ? planned.slice(next) : [first]
    const outcome = await runGroup(
      ctx, turn, step, group, mode, signal, acceptContext, options.unboundedParallelCalls === true,
    )
    next += outcome.consumed
    concluded ||= outcome.concluded
    if (outcome.aborted) {
      for (const call of planned.slice(next)) appendSkippedToolCall(session, turn, step, call.block)
      return { concluded }
    }
  }
  return { concluded }
}


/** Codex returns an unknown function identity to the model as tool feedback. */
function unsupportedCall(block: ToolCallBlock): string {
  const namespace = block.namespace === undefined || block.namespace === 'functions' ? '' : block.namespace
  return `unsupported call: ${namespace}${block.name}`
}

/** Parse JSON calls; ordinary agents retain the historical text fallback. */
function parseArguments(raw: string, codexFeedback: boolean): { arguments: unknown; parseError?: string } {
  if (raw === '' && !codexFeedback) return { arguments: {} }
  try {
    return { arguments: JSON.parse(raw) }
  } catch (error: unknown) {
    if (!codexFeedback) return { arguments: raw }
    return {
      arguments: raw,
      parseError: `failed to parse function arguments: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * Run one exclusive barrier or parallel pool. Later calls are reclassified
 * before start; an exclusive reclassification waits for the current pool to
 * drain and remains for the caller's next barrier. Results and contexts commit
 * in model order. Abort stops starts, drains and commits started calls, accepts
 * their contexts into the owning batch, records results for skipped calls, and
 * returns an aborted outcome. Scheduler failure drains dispatches without
 * committing synthetic recovery results.
 */
async function runGroup(
  ctx: Context,
  turn: number,
  step: number,
  group: PlannedCall[],
  mode: ToolExecutionMode['kind'],
  signal: AbortSignal,
  acceptContext: (context: UserMessage) => void,
  unboundedParallelCalls: boolean,
): Promise<GroupOutcome> {
  const { session } = ctx.agents.requireInitiator()
  const maxParallelToolCalls = unboundedParallelCalls
    ? group.length
    : ctx.agentLoop.config.maxParallelToolCalls.get()
  const slots: (Slot | undefined)[] = group.map(() => undefined)
  // Started slots retain their `tool/call` seq so the result can cite it.
  const callSeqs: Array<SessionSeq | undefined> = group.map(() => undefined)
  let nextToStart = 0
  let committed = 0
  let started = 0
  let aborted: boolean = signal.aborted
  let concluded = false
  let schedulerFailure: { error: unknown } | undefined
  const throwSchedulerFailure = (): void => {
    if (schedulerFailure !== undefined) throw schedulerFailure.error
  }

  // `committed` advances only across contiguous model-order slots.
  const commitReady = async (): Promise<void> => {
    while (committed < group.length) {
      const slot = slots[committed]
      if (slot === undefined) break
      const call = group[committed]
      const result = slot.kind === 'parse-error'
        ? slot.result
        : slot.needsPost
          ? await ctx.codexyTools[TOOL_RUNTIME_SCHEDULER].finalize(slot.exec, slot.result)
          : ctx.codexyTools[TOOL_RUNTIME_SCHEDULER].finish(slot.exec, slot.result)
      // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded index
      appendToolResult(session, turn, step, call!.block, result, callSeqs[committed]!)
      for (const context of result.additionalContexts ?? []) acceptContext(context)
      concluded ||= result.concludesTurn === true
      committed++
    }
  }

  const inFlight = new Map<number, Promise<number>>()

  const startCall = async (index: number): Promise<void> => {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded index
    const call = group[index]!
    callSeqs[index] = appendToolCall(session, turn, step, call.block)
    started++
    if (call.parseError !== undefined) {
      slots[index] = {
        kind: 'parse-error',
        result: {
          content: [{ type: 'text', text: call.parseError }],
          isError: true,
          error: { message: call.parseError },
        },
      }
      return
    }
    const prepared = await ctx.codexyTools[TOOL_RUNTIME_SCHEDULER].prepare(call.exec)
    throwSchedulerFailure()
    switch (prepared.kind) {
      case 'dispatch': {
        const promise = ctx.codexyTools[TOOL_RUNTIME_SCHEDULER].dispatch(prepared.exec).then(
          (outcome) => {
            slots[index] = { kind: 'tool', exec: prepared.exec, result: outcome.result, needsPost: outcome.kind === 'post-result' }
            return index
          },
          (error: unknown) => {
            schedulerFailure ??= { error }
            return index
          },
        )
        inFlight.set(index, promise)
        break
      }
      case 'post-result':
        slots[index] = { kind: 'tool', exec: prepared.exec, result: prepared.result, needsPost: true }
        break
      case 'final-result':
        slots[index] = { kind: 'tool', exec: prepared.exec, result: prepared.result, needsPost: false }
        break
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        assertNever(prepared, 'tool-call scheduler prepare result')
    }
  }

  const launchCodexParallelCall = (index: number): void => {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by fillPool
    const call = group[index]!
    callSeqs[index] = appendToolCall(session, turn, step, call.block)
    started++
    const task = (async (): Promise<number> => {
      try {
        const prepared = await ctx.codexyTools[TOOL_RUNTIME_SCHEDULER].prepare(call.exec)
        switch (prepared.kind) {
          case 'dispatch': {
            const outcome = await ctx.codexyTools[TOOL_RUNTIME_SCHEDULER].dispatch(prepared.exec)
            slots[index] = {
              kind: 'tool', exec: prepared.exec, result: outcome.result,
              needsPost: outcome.kind === 'post-result',
            }
            break
          }
          case 'post-result':
            slots[index] = { kind: 'tool', exec: prepared.exec, result: prepared.result, needsPost: true }
            break
          case 'final-result':
            slots[index] = { kind: 'tool', exec: prepared.exec, result: prepared.result, needsPost: false }
            break
          /* v8 ignore next -- closed-union exhaustiveness guard */
          default:
            assertNever(prepared, 'Codexful tool-call scheduler prepare result')
        }
      } catch (error: unknown) {
        schedulerFailure ??= { error }
      }
      return index
    })()
    inFlight.set(index, task)
  }

  const fillPool = async (): Promise<void> => {
    while (!aborted && nextToStart < group.length && inFlight.size < maxParallelToolCalls) {
      // Re-read later modes after ordered commits so registry changes can create a barrier.
      // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop condition
      const nextCall = group[nextToStart]!
      if (nextToStart > 0 && mode === 'parallel'
        && (nextCall.parseError !== undefined || ctx.codexyTools.executionMode(nextCall.exec).kind !== 'parallel')) break
      if (unboundedParallelCalls && mode === 'parallel') {
        launchCodexParallelCall(nextToStart)
        nextToStart++
        if (signal.aborted) aborted = true
        continue
      }
      await startCall(nextToStart)
      nextToStart++
      throwSchedulerFailure()
      await commitReady()
      throwSchedulerFailure()
      // Abort may arrive while pre-execute awaits.
      if (signal.aborted) aborted = true
    }
  }

  // Ordinary pre-execute remains ordered. Codexful parallel calls admit
  // independently, then both paths commit results in model order.
  try {
    await fillPool()
    while (inFlight.size > 0) {
      const settledIndex = await Promise.race(inFlight.values())
      inFlight.delete(settledIndex)
      throwSchedulerFailure()
      await commitReady()
      throwSchedulerFailure()
      // Abort may arrive while a tool or ordered commit awaits.

      if (signal.aborted) aborted = true
      await fillPool()
    }
  } catch (error: unknown) {
    schedulerFailure ??= { error }
    await Promise.allSettled(inFlight.values())
    throw schedulerFailure.error
  }

  if (aborted) {
    // Started calls and accepted context settle first; every remaining model
    // call then receives an ordered synthetic result before the turn aborts.
    for (const call of group.slice(started)) appendSkippedToolCall(session, turn, step, call.block)
    return { consumed: group.length, aborted: true, concluded }
  }
  /* v8 ignore next -- unreachable: a non-aborted group commits every started call */
  if (committed !== started) throw new Error('tool-call scheduler: uncommitted settled calls')
  return { consumed: started, aborted: false, concluded }
}

/** Append the durable call/result pair for a model call skipped after cancellation. */
function appendSkippedToolCall(session: Session, turn: number, step: number, block: ToolCallBlock): void {
  const callSeq = appendToolCall(session, turn, step, block)
  appendToolResult(session, turn, step, block, {
    content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }],
    isError: true,
    error: {
      message: 'tool call aborted before dispatch',
      info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH },
    },
  }, callSeq)
}

/** Append a started call and return the event seq that its result must cite. */
function appendToolCall(session: Session, turn: number, step: number, block: ToolCallBlock): SessionSeq {
  const event = session.append('tool/call', {
    turn, step, callId: block.id, name: block.name, arguments: block.arguments,
    ...block.kind === undefined ? {} : { kind: block.kind },
    ...block.namespace === undefined ? {} : { namespace: block.namespace },
  })
  return event.seq
}

/** Append a model-ordered result linked to its call event. */
function appendToolResult(
  session: Session,
  turn: number,
  step: number,
  block: ToolCallBlock,
  result: ToolExecutionResult,
  callSeq: SessionSeq,
): void {
  const input = {
    callId: block.id,
    content: result.content,
    isError: result.isError,
  }
  const message = block.kind === 'freeform'
    ? createToolResultMessage({ ...input, toolKind: 'freeform', name: block.name })
    : createToolResultMessage(input)
  session.append('tool/result', {
    turn, step,
    message,
    ...result.error?.info ? { error: result.error.info } : {},
    // The tool's private presentation payload (e.g. a result-time diff),
    // persisted so a UI bridge reproduces the card on replay.
    ...result.meta !== undefined ? { meta: result.meta } : {},
  }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
}
