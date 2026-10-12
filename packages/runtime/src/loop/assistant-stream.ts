/** Process-local assistant attempt framing and durable stream accumulation. */

import {
  AssistantStreamAccumulator,
  BlockAssembler,
  LlmAttemptId,
  type AssistantStreamRecord,
  type ContentBlock,
  type FinishReason,
  type ReplayEnvelope,
  type StreamChunk,
  type TokenUsage,
} from '../llm.ts'
import type { AssistantStreamFrame } from '../agent-api.ts'
import type { SessionEventMap, SessionId, SessionSeq } from '../session.ts'

/** Folds one model attempt into one compact stream plus ordered transient frames. */
export class AssistantStreamAttempt {
  private readonly accumulator = new AssistantStreamAccumulator()
  private readonly assembler = new BlockAssembler()
  private index = 0
  private terminal = false
  /** Epoch ms the provider call was dispatched; absent until {@link start}. */
  private dispatchTime: number | undefined
  private readonly timings: NonNullable<SessionEventMap['assistant/attempt']['requestTimings']> = []
  /** Attempt identity unique within this Agent lifecycle. */
  readonly attemptId: LlmAttemptId

  /** Whether this started attempt has emitted its terminal frame. */
  get ended(): boolean { return this.terminal }

  /** Dispatch time of the provider call, or undefined when the attempt never started one. */
  get requestSentTime(): number | undefined { return this.dispatchTime }

  /** Persisted timing fields shared by every successful, failed, and cancelled settlement. */
  get diagnostics(): Pick<SessionEventMap['assistant/attempt'], 'requestSentTime' | 'requestTimings'> {
    return {
      ...this.dispatchTime === undefined ? {} : { requestSentTime: this.dispatchTime },
      ...this.timings.length === 0 ? {} : { requestTimings: this.timings.map(timing => ({ ...timing })) },
    }
  }

  /** Retain one adapter-owned transport milestone without creating model content. */
  recordTiming(timing: NonNullable<SessionEventMap['assistant/attempt']['requestTimings']>[number]): void {
    this.timings.push({ ...timing })
  }

  /**
   * @param sessionId - identity embedded only in the Agent-lifecycle-local attempt id.
   * @param attempt - attached-Session-local attempt counter.
   * @param nextRevision - allocates the next emitted frame revision.
   * @param turn - durable turn owning the request.
   * @param step - durable step owning the request.
   * @param emit - agent-scoped notification publisher.
   */
  constructor(
    sessionId: SessionId,
    attempt: number,
    private readonly nextRevision: () => number,
    readonly turn: number,
    readonly step: number,
    private readonly emit: (frame: AssistantStreamFrame) => void,
  ) {
    this.attemptId = LlmAttemptId(`${sessionId}:${attempt}`)
  }

  /**
   * Publish the opening marker before the first delivered chunk.
   * @param requestSentTime - epoch ms taken immediately before the provider call was dispatched.
   */
  start(requestSentTime: number): void {
    this.dispatchTime = requestSentTime
    this.emit({
      type: 'start',
      attemptId: this.attemptId,
      revision: this.nextRevision(),
      turn: this.turn,
      step: this.step,
    })
  }

  /** Feed assembly the complete chunk while keeping per-item replay state out of the timed stream. */
  push(chunk: StreamChunk): void {
    const visibleChunk: StreamChunk = chunk.type === 'block-end' && chunk.replayState !== undefined
      ? { type: 'block-end', index: chunk.index, block: chunk.block }
      : chunk
    const timed = this.accumulator.push({ time: Date.now(), chunk: visibleChunk })
    this.assembler.push(chunk)
    this.emit({
      type: 'chunk',
      attemptId: this.attemptId,
      revision: this.nextRevision(),
      index: this.index++,
      time: timed.time,
      chunk: timed.chunk,
    })
  }

  /**
   * Publish terminal settlement after the matching durable event commits.
   * @param eventType - durable settlement type.
   * @param append - synchronous durable append returning its committed seq.
   */
  settle(
    eventType: 'assistant/message' | 'assistant/attempt',
    append: () => SessionSeq,
  ): void {
    let seq: SessionSeq
    try {
      seq = append()
    } catch (error: unknown) {
      this.abandon()
      throw error
    }
    this.terminal = true
    this.emit({
      type: 'end',
      attemptId: this.attemptId,
      revision: this.nextRevision(),
      index: this.index,
      outcome: { kind: 'committed', eventType, seq },
    })
  }

  /** Publish abandonment when no durable attempt event can be committed. */
  abandon(): void {
    this.terminal = true
    this.emit({
      type: 'end',
      attemptId: this.attemptId,
      revision: this.nextRevision(),
      index: this.index,
      outcome: { kind: 'abandoned' },
    })
  }

  /** Exact compact stream for the final durable event. */
  get stream(): SessionEventMap['assistant/attempt']['stream'] {
    return [...this.accumulator.snapshot()] as AssistantStreamRecord[]
  }

  /** Canonical completed-message blocks from the same chunks. */
  blocks(): ContentBlock[] {
    return this.assembler.blocks()
  }

  /** Completed provider items that remain in history after a stream failure. */
  completedBlocks(): ContentBlock[] {
    return this.assembler.completedBlocks()
  }

  /** Provider replay metadata aligned to completed blocks after an interrupted response. */
  get completedReplayState(): ReplayEnvelope | undefined {
    return this.assembler.completedReplayState
  }

  /** Safe visible prefix when cancellation interrupts the attempt. */
  interruptedBlocks(): ContentBlock[] {
    return this.assembler.interruptedBlocks()
  }

  /** Latest adapter-reported usage in the stream. */
  get usage(): TokenUsage | undefined {
    return this.assembler.usage
  }

  /** Terminal reason, defaulting to stop when the stream omitted one. */
  get finish(): FinishReason {
    return this.assembler.finish
  }

  /** Replay state carried by the terminal finish record. */
  get replayState(): ReplayEnvelope | undefined {
    return this.assembler.replayState
  }

  /** Latest observed unfinished native progress, independent of content assembly. */
  get attemptReplayState(): ReplayEnvelope | undefined {
    return this.assembler.attemptReplayState
  }
}
