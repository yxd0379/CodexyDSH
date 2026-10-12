/**
 * Incremental chunk-to-message assembler. This is the single canonical assembly
 * algorithm used by the agent loop to build an assistant message from a chunk
 * stream. The loop records timed content chunks and persists completed-item
 * provider replay metadata with the corresponding output items.
 *
 * @module @deepseek-ai/dsh-llm/assembler
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage, ModelMessageSource } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, ReplayEnvelope, StreamChunk, TokenUsage } from './llm.ts'

interface PartialBlock {
  blockType: string
  text: string
  toolCallId?: ToolCallId
  toolCallName?: string
  toolCallKind?: 'function' | 'freeform'
  toolCallArguments: string
  /** Set by `block-end` — authoritative, and freezes the partial. */
  block?: ContentBlock
}

/**
 * Incrementally assembles raw {@link StreamChunk}s into complete
 * {@link ContentBlock}s and a final assistant {@link Message}.
 *
 * The agent loop feeds it while recording timed content chunks, then
 * reads `blocks()` / `message()` / `usage` / `finish` once the stream ends,
 * or `interruptedBlocks()` when cancellation cut the stream short.
 *
 * Tolerant of delta-only protocols (no block-start/end); deltas arriving for
 * an index already closed by `block-end` are ignored (malformed stream) so a
 * misbehaving adapter cannot grow memory or corrupt a completed block.
 */
export class BlockAssembler {
  private partials = new Map<number, PartialBlock>()
  private order: number[] = []
  private _usage: TokenUsage | undefined
  private _finish: FinishReason | undefined
  private _replayState: ReplayEnvelope | undefined
  private _attemptReplayState: ReplayEnvelope | undefined
  private readonly completedItemReplay = new Map<number, ReplayEnvelope>()

  /**
   * Feed one chunk into the assembly state.
   * @param chunk - the next raw chunk, in stream order.
   */
  push(chunk: StreamChunk): void {
    switch (chunk.type) {
      case 'block-start': {
        if (chunk.replayState !== undefined) this._attemptReplayState = chunk.replayState
        if (!this.partials.has(chunk.index)) {
          this.order.push(chunk.index)
          this.partials.set(chunk.index, {
            blockType: chunk.blockType,
            text: '',
            toolCallArguments: '',
          })
        }
        return
      }
      case 'text-delta':
      case 'reasoning-delta': {
        const partial = this.ensure(chunk.index, chunk.type === 'text-delta' ? 'text' : 'reasoning')
        if (partial.block) return // closed by block-end; ignore stragglers
        partial.text += chunk.text
        return
      }
      case 'tool-call-delta': {
        const partial = this.ensure(chunk.index, 'tool-call')
        if (partial.block) return // closed by block-end; ignore stragglers
        partial.toolCallId = chunk.id
        if (chunk.name) partial.toolCallName = chunk.name
        if (chunk.kind !== undefined) partial.toolCallKind = chunk.kind
        partial.toolCallArguments += chunk.argumentsDelta
        return
      }
      case 'block-end': {
        const partial = this.ensure(chunk.index, chunk.block.type)
        // First close wins; ignoring re-close stragglers keeps streamed output
        // and the final assembled block in agreement.
        if (partial.block) return
        partial.block = chunk.block
        if (chunk.replayState !== undefined) this.completedItemReplay.set(chunk.index, chunk.replayState)
        return
      }
      case 'usage': {
        this._usage = chunk.usage
        return
      }
      case 'finish': {
        this._finish = chunk.reason
        this._replayState = chunk.replayState
        // A progress-only attempt has no completed message. Retain its final
        // observed terminal/failure facts without promoting it into history.
        if (this._attemptReplayState !== undefined && chunk.replayState !== undefined) this._attemptReplayState = chunk.replayState
        return
      }
      default: return assertNever(chunk, 'BlockAssembler.push')
    }
  }

  private ensure(index: number, blockType: string): PartialBlock {
    let partial = this.partials.get(index)
    if (!partial) {
      partial = { blockType, text: '', toolCallArguments: '' }
      this.partials.set(index, partial)
      this.order.push(index)
    }
    return partial
  }

  private assemble(partial: PartialBlock, index: number): ContentBlock {
    if (partial.block) return partial.block
    switch (partial.blockType) {
      case 'text': return { type: 'text', text: partial.text }
      case 'reasoning': return { type: 'reasoning', text: partial.text }
      case 'tool-call': return {
        type: 'tool-call',
        id: partial.toolCallId ?? brandString<ToolCallId>(`call-${index}`),
        name: partial.toolCallName ?? '',
        ...partial.toolCallKind === undefined ? {} : { kind: partial.toolCallKind },
        arguments: partial.toolCallArguments,
      }
      default: throw new Error(`cannot assemble incomplete block of type "${partial.blockType}"`)
    }
  }

  /** Invariant accessor: every index in `order` has a partial. */
  private mustGet(index: number): PartialBlock {
    const partial = this.partials.get(index)
    if (!partial) throw new Error(`BlockAssembler invariant violated: no partial for index ${index}`)
    return partial
  }

  /**
   * The one shared keep/drop decision over all seen blocks: max-token
   * truncation drops tool calls that cannot be executed safely. Emitted blocks
   * and replay metadata both derive from this result, so they cannot disagree.
   */
  private assembled(): { blocks: ContentBlock[]; replay: ReplayEnvelope | undefined } {
    const all = this.order.map(index => this.assemble(this.mustGet(index), index))
    const kept = this.finish.kind === 'max-tokens'
      ? all.map(block => block.type !== 'tool-call')
      : undefined
    const blocks = kept === undefined ? all : all.filter((_, position) => kept[position])
    const envelope = this._replayState
    if (envelope?.blocks === undefined) return { blocks, replay: envelope }
    if (envelope.blocks.length !== all.length) return { blocks, replay: undefined }
    return {
      blocks,
      replay: kept === undefined || blocks.length === all.length
        ? envelope
        : { response: envelope.response, blocks: envelope.blocks.filter((_, position) => kept[position]) },
    }
  }

  /**
   * Assemble all blocks seen so far, in stream order.
   * @returns one block per seen index, except that max-token truncation drops
   *   tool calls that cannot be executed safely; an open block assembles from
   *   its accumulated deltas (an unknown block type never closed by `block-end` throws).
   */
  blocks(): ContentBlock[] {
    return this.assembled().blocks
  }

  /**
   * Return only items closed by the provider before an interrupted response.
   * Open deltas did not become completed response items and cannot enter retry history.
   * @returns completed blocks in response order.
   */
  completedBlocks(): ContentBlock[] {
    return this.order
      .map(index => this.mustGet(index).block)
      .filter((block): block is ContentBlock => block !== undefined)
  }

  /** Replay metadata aligned to {@link completedBlocks} after interruption or stream error. */
  get completedReplayState(): ReplayEnvelope | undefined {
    const completed = this.order.flatMap((index, position) => {
      const block = this.mustGet(index).block
      return block === undefined ? [] : [{ index, position, block }]
    })
    const lastItem = completed.at(-1)
    if (lastItem === undefined) return undefined
    const terminal = this._replayState
    if (terminal !== undefined) {
      const entries = terminal.blocks
      if (entries === undefined) return terminal
      if (entries.length === this.order.length) return {
          response: terminal.response,
          blocks: completed.map(item => entries[item.position]),
        }
      // The hosted observer's terminal metadata is aligned to closed items,
      // while actual pending hosted starts remain separate recovery facts.
      if (this._attemptReplayState !== undefined && entries.length === completed.length) return terminal
      if (!completed.some(item => item.block.type === 'provider-output')) return undefined
      // An interrupted hosted response may have open SDK text/reasoning slots.
      // Their absence is not evidence to discard actually closed native items.
    }
    const toolItem = [...completed].reverse().find(item => item.block.type === 'tool-call')
    // A hosted item may close after a client tool. Its later response snapshot
    // must not be replaced with the earlier tool's incomplete native history.
    const responseOwner = completed.some(item => item.block.type === 'provider-output') ? lastItem : toolItem ?? lastItem
    const responseItem = this.completedItemReplay.get(responseOwner.index)
    if (responseItem?.blocks?.length !== 1) return undefined
    const blocks: unknown[] = []
    for (const item of completed) {
      const entries = this.completedItemReplay.get(item.index)?.blocks
      if (entries?.length !== 1) return undefined
      blocks.push(entries[0])
    }
    return {
      response: responseItem.response,
      blocks,
    }
  }

  /**
   * Assemble the prefix an interrupted stream can safely finalize: closed and
   * open text/reasoning blocks with non-whitespace content, in stream order.
   * Whole-response scheduling uses this prefix and omits tool calls because
   * interruption precedes their dispatch. Codexful streaming dispatch uses
   * completedBlocks() to retain calls already started. Open unknown blocks are
   * also omitted.
   * @returns the kept blocks; empty when nothing streamed before the interruption.
   */
  interruptedBlocks(): ContentBlock[] {
    return this.order
      .map((index) => {
        const partial = this.mustGet(index)
        const type = partial.block?.type ?? partial.blockType
        if (type === 'provider-output') return partial.block
        if (type !== 'text' && type !== 'reasoning') return undefined
        return this.assemble(partial, index)
      })
      .filter((block): block is ContentBlock =>
        block?.type === 'provider-output' || (block?.type === 'text' || block?.type === 'reasoning') && block.text.trim() !== '')
  }

  /** Usage from the `usage` chunk; undefined until one arrives. */
  get usage(): TokenUsage | undefined {
    return this._usage
  }

  /** Finish reason from the `finish` chunk; `{kind: 'stop'}` when the stream ended without one. */
  get finish(): FinishReason {
    return this._finish ?? { kind: 'stop' }
  }

  /**
   * Replay metadata from the terminal finish chunk, if any, with per-block
   * entries pruned in step with {@link blocks}. Undefined when the envelope's
   * entries do not align with the emitted blocks.
   */
  get replayState(): ReplayEnvelope | undefined {
    return this.assembled().replay
  }

  /** Opaque unfinished provider facts, never promoted into completed model history. */
  get attemptReplayState(): ReplayEnvelope | undefined {
    return this._attemptReplayState
  }

  /**
   * The assembled assistant message.
   * @param source - provider/model attribution (without the `kind` tag) for the assembled message.
   * @returns a frozen assistant-role message over `blocks()` (same open-block assembly rules).
   */
  message(source: Omit<ModelMessageSource, 'kind'>): AssistantMessage {
    return createAssistantMessage({ content: this.blocks(), source })
  }
}
