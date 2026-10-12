import { productEventAt, productSnapshot } from '@codexydsh/bridges/session-reads'
/** Codexful fork history copied from the parent's current model context. */

import { createSystemMessage } from '@codexydsh/runtime/llm'
import { encodeProductEvents, projectProductEvents, buildForkSeed, foldSurface, SessionLogOffset, SessionSeq } from '@codexydsh/runtime/session'
import type { Session, SessionEvent, SessionLogOffset as SessionLogOffsetType, SessionSeq as SessionSeqType } from '@codexydsh/runtime/session'
import type { Agent } from '@deepseek-ai/dsh-agent'

declare module '@codexydsh/runtime/types' {
  interface SessionEventMap {
    /** Parent-history selection retained for the child's first model request. */
    'subagent/fork-window': { lastNTurns: number; cutoffSeq: SessionSeqType }
  }
}

/** Balanced child seed and the exact cut between copied and fork-owned events. */
export interface CodexfulForkSeed {
  readonly seed: readonly SessionEvent[]
  readonly inheritedEventCount: SessionLogOffsetType
}

/** Select final assistant messages from completed parent turns. */
function finalAssistantSeqs(events: readonly SessionEvent[]): Set<SessionSeqType> {
  const lastAssistant = new Map<number, SessionEvent<'assistant/message'>>()
  const finals = new Set<SessionSeqType>()
  for (const event of events) {
    if (event.type === 'assistant/message') lastAssistant.set(event.data.turn, event)
    if (event.type !== 'turn/end' || event.data.reason.kind !== 'completed') continue
    const assistant = lastAssistant.get(event.data.turn)
    if (assistant !== undefined && assistant.data.interrupted !== true
      && assistant.data.message.content.every(block => block.type !== 'tool-call')) {
      finals.add(assistant.seq)
    }
  }
  return finals
}

/** Remove reasoning and provider replay state from a retained final answer. */
function withoutReasoning(event: SessionEvent<'assistant/message'>): SessionEvent<'assistant/message'> {
  const { message } = event.data
  return {
    ...event,
    data: {
      ...event.data,
      stream: event.data.stream.filter((record) => {
        if (record.type === 'reasoning-chunks' || record.type === 'tool-call-chunks') return false
        if (record.type !== 'chunk') return true
        const chunk = record.chunk
        if (chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta') return false
        if (chunk.type === 'block-start') return chunk.blockType !== 'reasoning' && chunk.blockType !== 'tool-call'
        if (chunk.type === 'block-end') return chunk.block.type !== 'reasoning' && chunk.block.type !== 'tool-call'
        return true
      }),
      message: {
        ...message,
        content: message.content.filter(block => block.type !== 'reasoning'),
        source: { kind: 'model', provider: message.source.provider, model: message.source.model },
      },
    },
  }
}

/**
 * Capture the parent through its current event, balancing a running tool step
 * while retaining the exact inherited cut for Session restore.
 * @param parent - agent whose current durable log supplies the context.
 * @param lastNTurns - optional count of recent parent instruction turns to retain.
 * @returns a balanced seed, or undefined before the parent has recorded work.
 */
export function codexfulForkSeed(parent: Agent, lastNTurns?: number): CodexfulForkSeed | undefined {
  if (lastNTurns !== undefined && (!Number.isSafeInteger(lastNTurns) || lastNTurns <= 0)) {
    throw new Error('forkTurns must be a positive safe integer')
  }
  // oxlint-disable-next-line typescript/no-deprecated -- Fork creation needs one atomic parent-log snapshot.
  const events = productSnapshot(parent.session)
  const last = events.at(-1)
  if (last === undefined) return undefined
  const finals = finalAssistantSeqs(events)
  const seed = projectProductEvents(buildForkSeed(encodeProductEvents(events), last.seq)).map(event =>
    event.type === 'assistant/message' && finals.has(event.seq) ? withoutReasoning(event) : event)
  if (lastNTurns !== undefined) {
    const active = new Set(parent.session.surface.nodes)
    const boundaries: SessionSeqType[] = []
    let instructionInTurn = false
    for (const event of events) {
      if (event.type === 'turn/start') instructionInTurn = false
      if (event.type !== 'user/message' || !active.has(event.seq)) continue
      const source = event.data.source
      if (source.kind === 'user' || source.kind === 'agent-message' && source.queueOnly !== true
        && !instructionInTurn) {
        boundaries.push(event.seq)
        instructionInTurn = true
      }
    }
    const cutoffSeq = boundaries[Math.max(0, boundaries.length - lastNTurns)] ?? SessionSeq(events.length)
    seed.push({
      type: 'subagent/fork-window', seq: SessionSeq(seed.length), time: last.time,
      data: { lastNTurns, cutoffSeq },
    })
  }
  return { seed, inheritedEventCount: SessionLogOffset(events.length) }
}

/** Hide inherited model items that Codex does not carry into a fork request. */
function excludeInherited(event: SessionEvent, finals: ReadonlySet<SessionSeqType>): boolean {
  switch (event.type) {
    case 'assistant/message': return !finals.has(event.seq)
    case 'tool/result': return true
    case 'user/message': return event.data.source.kind === 'agent-message'
      || event.data.source.kind === 'subagent-settled'
    default: return false
  }
}

/**
 * Project only Codex-retained inherited messages into the child's model input.
 * Replacements are durable and idempotent across subsequent steps and restores.
 * @param session - forked child Session with its original copied event prefix.
 * @param turn - open child turn receiving these replacements.
 * @param step - open child step receiving these replacements.
 * @param descriptorSeq - first child-owned descriptor, after the fork's synthetic closers.
 */
export function scrubCodexfulForkHistory(
  session: Session, turn: number, step: number, descriptorSeq: SessionSeqType,
): void {
  if (session.inheritedEventCount === 0) return
  // oxlint-disable-next-line typescript/no-deprecated -- Read the immutable inherited prefix once for final-answer classification.
  const inherited = productSnapshot(session, SessionLogOffset(0), session.inheritedEventCount)
  const finals = finalAssistantSeqs(inherited)
  // oxlint-disable-next-line typescript/no-deprecated -- The selection is a fork-owned log event before the descriptor.
  const windows = productSnapshot(session, session.inheritedEventCount, SessionLogOffset(descriptorSeq))
    .filter(event => event.type === 'subagent/fork-window')
  if (windows.length > 1) throw new Error('fork history contains multiple selection events')
  const window = windows[0]
  const cutoffSeq = window?.data.cutoffSeq
  if (window !== undefined && (!Number.isSafeInteger(window.data.lastNTurns)
    || window.data.lastNTurns <= 0 || !Number.isSafeInteger(cutoffSeq)
    || Number(cutoffSeq) < 0 || Number(cutoffSeq) > Number(session.inheritedEventCount))) {
    throw new Error('fork history selection event is invalid')
  }
  const inheritedNodes = foldSurface(encodeProductEvents(inherited)).nodes
  const cutoffIndex = cutoffSeq === undefined ? -1 : inheritedNodes.indexOf(cutoffSeq)
  if (cutoffSeq !== undefined && Number(cutoffSeq) !== Number(session.inheritedEventCount) && cutoffIndex < 0) {
    throw new Error('fork history cutoff is absent from the inherited surface')
  }
  const hidden = new Set(cutoffSeq === undefined ? []
    : cutoffIndex < 0 ? inheritedNodes : inheritedNodes.slice(0, cutoffIndex))
  for (const seq of [...session.surface.nodes]) {
    if (seq >= descriptorSeq) continue
    // oxlint-disable-next-line typescript/no-deprecated -- Surface nodes identify durable inherited messages.
    const event = productEventAt(session, seq)
    if (event === undefined) continue
    const syntheticCloser = seq >= session.inheritedEventCount
    if (syntheticCloser
      ? event.type !== 'assistant/message' && event.type !== 'tool/result'
      : !hidden.has(seq) && !excludeInherited(event, finals)) continue
    session.append('system/message', { turn, step, message: createSystemMessage('') }, {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
      sourceEventSeqs: [seq],
    })
  }
}
