/**
 * Codexful per-step pruning of oversized tool results in model history.
 *
 * @module @codexydsh/tool-history
 */

import type {} from '@codexydsh/token-meter'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {} from '@codexydsh/runtime/agent'
import { codexfulToolProfile } from '@codexydsh/prompt'
import type { Session, SessionEvent, SessionSeq, ToolResultMessage } from '@codexydsh/runtime/session'
import { snapshotProductEvents } from '@codexydsh/runtime/session'
import type {} from '@deepseek-ai/dsh-compaction'
import { truncateToolResult } from './truncate.ts'

export { SERIALIZATION_ALLOWANCE, textBytes, truncateToolResult } from './truncate.ts'

/** Codexful history pruning accepts no configuration fields. */
export type Config = Record<string, never>

declare module '@deepseek-ai/cordis' {
  interface Context {
    codexfulToolHistory: CodexfulToolHistory
  }
}

/** Model-history rewrite that retains the original Session result event. */
export class CodexfulToolHistory extends Service {
  static inject = ['agents', 'codexyTokenMeter']
  static Config = z.object({})

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'codexfulToolHistory')
    const unsupported = Object.keys(config)[0]
    if (unsupported !== undefined) throw new Error(`CodexfulToolHistory: unknown config key "${unsupported}"`)
    ctx.on('codexy-agent/pre-step', ({ agent, signal }, next): Promise<PreStepDecision> => {
      if (!signal.aborted) this.pruneSession(agent.session)
      return next()
    }, { prepend: true })
  }

  /**
   * Replace every oversized, previously unmodified tool result on one current surface.
   * Each result uses the last request header before its original event; a result
   * without an earlier header is left intact because its source model is unknown.
   * A `compaction/prune` event immediately precedes each replacement. A later
   * failure leaves earlier replacements committed in the append-only Session.
   * @param session - live or restored Session whose model history is inspected.
   * @returns the number of landed tool-result replacements.
   */
  pruneSession(session: Session): number {
    // oxlint-disable-next-line typescript/no-deprecated -- Originating models require ordered raw headers on restored and forked Sessions.
    const events = snapshotProductEvents(session)
    const modelByResult = new Map<SessionSeq, string>()
    let model: string | undefined
    for (const event of events) {
      if (event.type === 'request/header') model = event.data.header.config.model
      else if (event.type === 'tool/result' && event.surfaceOp === 'append' && model !== undefined) {
        modelByResult.set(event.seq, model)
      }
    }
    let replacements = 0
    for (const seq of [...session.surface.nodes]) {
      const event: SessionEvent | undefined = events[seq]
      if (event?.type !== 'tool/result' || event.surfaceOp !== 'append') continue
      const originatingModel = modelByResult.get(seq)
      if (originatingModel === undefined) continue
      const original = session.deriveEventMessage(event) as ToolResultMessage
      const policy = codexfulToolProfile(originatingModel, 'daily').sourceTruncation
      const message = truncateToolResult(original, policy)
      if (message === null) continue
      session.append('compaction/prune', {
        shadowedRange: { start: seq, end: seq },
        shadowedSeqs: [seq],
        shadowedTokenCount: this.ctx.codexyTokenMeter.estimateMessage(original),
      })
      session.append('tool/result', { ...event.data, message }, {
        surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
        sourceEventSeqs: [seq],
      })
      replacements++
    }
    return replacements
  }
}

export default CodexfulToolHistory
