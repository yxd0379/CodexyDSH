/**
 * Durable projection state for the system prompt and dynamic user/developer
 * context updates formed by the system-prompt plugin.
 * @module @codexydsh/runtime/loop/runtime-context
 */

import { createDeveloperMessage, createSystemMessage, createUserMessage } from '../llm.ts'
import type {} from '../llm.ts'
import type { ContextFormed, ContextSnapshotSection, Message } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '../session.ts'
import type { DeveloperMessage, SystemMessage, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionSeq, SurfaceIntent } from '@deepseek-ai/dsh-session'
import { isReplacementSurfaceEvent } from '../session.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { CodexMultiAgentWorldStateSource, CodexWorldStateSource } from './codex-world-state.ts'
import { isCodexMultiAgentModeSource } from './codex-multi-agent-mode.ts'

/** Attribution for runtime context, including captured Codexful world-state fragments. */
export type RuntimeContextSource = {
  kind: 'runtime-context'
  readonly codexWorldState?: CodexWorldStateSource
  readonly codexMultiAgentWorldState?: CodexMultiAgentWorldStateSource
} & ContextFormed

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'runtime-context': RuntimeContextSource
  }
}

const SOURCE = 'runtime-context'
const CLEARED = 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.'
const DEVELOPER_CLEARED = 'Current developer context: none. Earlier runtime developer instructions no longer apply.'

function isOwned(message: UserMessage): boolean {
  return message.source.kind === SOURCE && message.source.codexWorldState === undefined
    && message.source.codexMultiAgentWorldState === undefined
    && message.source.form !== 'instructions' && !isCodexMultiAgentModeSource(message.source)
}

function isDeveloperFallback(message: UserMessage): boolean {
  return message.source.kind === SOURCE && message.source.codexWorldState === undefined
    && message.source.codexMultiAgentWorldState === undefined
    && message.source.form === 'instructions'
}

function textOf(message: Message): string | undefined {
  if (!message.content.every(block => block.type === 'text')) return
  return message.content.map(block => block.text).join('\n\n')
}

/** One uncommitted system-prompt surface operation for request admission or reconciliation. */
export interface SystemPromptCommit {
  /** Rendered prompt or empty content: an empty head records no prompt; empty tails are dormant. */
  message: SystemMessage
  /** `append` for a new system node, otherwise a replacement of one surviving system node. */
  intent: SurfaceIntent<'system/message'>
}

/** The request-series facts one prompt decision is made under. */
export interface SystemPromptDecisionInput {
  /** Whether the prepared route for this attempt reads a later `system` message as the effective prompt. */
  inHistory: boolean
  /**
   * Whether this step's request starts a new model-message series: a pre-step
   * listener declared one, the surface was replaced since the last request, or
   * the assembled tool schemas differ from the logged header.
   */
  startsSeries: boolean
}

/** Committed events from the newest backward; the restore scans stop at the first match. */
function eventsNewestFirst(session: Session): readonly SessionEvent[] {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  return session.snapshotEvents().toReversed()
}

/**
 * Decides how a rendered system prompt reaches the surface without owning the
 * commit. The first prompt, even empty, reserves surface node 0.
 * A capable continuing series appends changed nonempty text after the
 * cached history. An incapable route, broken series, or cleared prompt instead
 * normalizes the first system node and empties later active nodes. Dormant empty
 * tails do not supply effective text or require repeated replacements.
 */
export class SystemPromptProjection {
  constructor(private readonly session: Session) {}

  /** The surviving `system/message` nodes in surface order. */
  private systemNodes(): { seq: SessionSeq; text: string | undefined }[] {
    const nodes: { seq: SessionSeq; text: string | undefined }[] = []
    for (const seq of this.session.surface.nodes) {
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const event = this.session.eventAt(seq)
      if (event?.type !== 'system/message') continue
      const content = event.data.message.content
      const text = content.length === 0 ? '' : textOf(event.data.message)
      nodes.push({ seq, text })
    }
    return nodes
  }

  /**
   * Reconcile effective text and retained nodes with the prepared route and series.
   * @param rendered - the fully rendered system prompt; `''` when none is active.
   * @param input - the route capability and series facts for this step.
   * @returns ordered per-node updates; an empty list means no update is needed.
   */
  project(rendered: string, input: SystemPromptDecisionInput): SystemPromptCommit[] {
    const nodes = this.systemNodes()
    const head = nodes[0]
    if (head === undefined) {
      return [{ message: createSystemMessage(rendered), intent: { surfaceOp: 'append' } }]
    }
    const latest = nodes.findLast(node => node.text !== '') ?? head
    if (!input.inHistory || input.startsSeries || rendered.length === 0) {
      const updates = nodes.slice(1).filter(node => node.text !== '')
        .map(node => this.replace(node.seq, ''))
      if (head.text !== rendered) updates.push(this.replace(head.seq, rendered))
      return updates
    }
    if (latest.text === rendered) return []
    return [{ message: createSystemMessage(rendered), intent: { surfaceOp: 'append' } }]
  }

  private replace(seq: SessionSeq, text: string): SystemPromptCommit {
    return {
      message: createSystemMessage(text),
      intent: { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] },
    }
  }
}

/** Tracks the last retained runtime-context snapshot without owning its commit. */
export class RuntimeContextProjection {
  /** `undefined` means no snapshot ever existed; `null` means none is retained. */
  private retained: { seq: SessionSeq; text: string | undefined } | null | undefined

  /**
   * Restore projection state once, then follow authoritative session events.
   * @param ctx - agent-scoped event context.
   * @param session - session receiving projected messages.
   */
  constructor(ctx: Context, session: Session) {
    const surface = new Set(session.surface.nodes)
    for (const event of eventsNewestFirst(session)) {
      if (event.type !== 'user/message' || !isOwned(event.data)) continue
      this.retained ??= null
      if (surface.has(event.seq)) {
        this.retained = { seq: event.seq, text: textOf(event.data) }
        break
      }
    }

    ctx.on('session/event', (subject, event) => {
      if (subject !== session) return
      if (event.type === 'user/message' && isOwned(event.data)) {
        this.retained = { seq: event.seq, text: textOf(event.data) }
      } else if (this.retained
        && isReplacementSurfaceEvent(event)
        && event.sourceEventSeqs?.includes(this.retained.seq) === true) {
        this.retained = null
      }
    })
  }

  /**
   * Create an uncommitted snapshot only when the retained value differs.
   * @param current - fully rendered dynamic context.
   * @param sections - named contributions that formed the current snapshot.
   * @returns a candidate user message, or `undefined` when no update is needed.
   */
  project(current: string, sections: readonly ContextSnapshotSection[]): UserMessage | undefined {
    if (this.retained === undefined && current.length === 0) return
    const snapshot = current.length === 0 ? CLEARED : current
    if (this.retained?.text === snapshot) return
    return createUserMessage({
      content: [{ type: 'text', text: snapshot }],
      // The cleared marker has no contributions left to attribute.
      source: sections.length === 0
        ? { kind: SOURCE }
        : { kind: SOURCE, form: 'snapshot', sections },
    })
  }

  /** Current user-role context node, when it survived or was restored after a surface replacement. */
  retainedSeq(): SessionSeq | undefined {
    return this.retained?.seq
  }
}

/** Tracks native and user-role fallback permission updates from the Session surface. */
export class DeveloperContextProjection {
  /** Each route role has its own latest visible update; `null` means a replacement removed it. */
  private developer: { seq: SessionSeq; text: string | undefined } | null | undefined
  private fallback: { seq: SessionSeq; text: string | undefined } | null | undefined

  /**
   * Restore the last model-visible developer context and follow replacements.
   * @param ctx - agent-scoped event context.
   * @param session - session receiving the projected messages.
   */
  constructor(ctx: Context, private readonly session: Session) {
    const surface = new Set(session.surface.nodes)
    for (const event of eventsNewestFirst(session)) {
      if (event.type === 'developer/message' && event.data.message.source.kind === SOURCE
        && event.data.message.source.codexWorldState === undefined
        && event.data.message.source.codexMultiAgentWorldState === undefined
        && !isCodexMultiAgentModeSource(event.data.message.source)) {
        this.developer ??= null
        if (this.developer === null && surface.has(event.seq)) {
          this.developer = { seq: event.seq, text: textOf(event.data.message) }
        }
      } else if (event.type === 'user/message' && isDeveloperFallback(event.data)) {
        this.fallback ??= null
        if (this.fallback === null && surface.has(event.seq)) {
          this.fallback = { seq: event.seq, text: textOf(event.data) }
        }
      }
      if (this.developer && this.fallback) break
    }

    ctx.on('session/event', (subject, event) => {
      if (subject !== session) return
      if (isReplacementSurfaceEvent(event)) {
        if (this.developer && event.sourceEventSeqs?.includes(this.developer.seq) === true) this.developer = null
        if (this.fallback && event.sourceEventSeqs?.includes(this.fallback.seq) === true) this.fallback = null
      }
      if (event.type === 'developer/message' && event.data.message.source.kind === SOURCE
        && event.data.message.source.codexWorldState === undefined
        && event.data.message.source.codexMultiAgentWorldState === undefined
        && !isCodexMultiAgentModeSource(event.data.message.source)) {
        this.developer = { seq: event.seq, text: textOf(event.data.message) }
      } else if (event.type === 'user/message' && isDeveloperFallback(event.data)) {
        this.fallback = { seq: event.seq, text: textOf(event.data) }
      }
    })
  }

  /**
   * Re-role visible permission updates when a Session changes between native and fallback routes.
   * @param native - whether the prepared route serializes developer history natively.
   * @returns single-node replacements in surface order; unrelated developer messages remain untouched.
   */
  migration(native: boolean): { seq: SessionSeq; message: DeveloperMessage | UserMessage }[] {
    const replacements: { seq: SessionSeq; message: DeveloperMessage | UserMessage }[] = []
    for (const seq of this.session.surface.nodes) {
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const event = this.session.eventAt(seq)
      const source = event?.type === 'developer/message' ? event.data.message
        : event?.type === 'user/message' ? event.data : undefined
      if (source === undefined || source.source.kind !== SOURCE || source.source.codexWorldState !== undefined
        || source.source.codexMultiAgentWorldState !== undefined
        || isCodexMultiAgentModeSource(source.source)) continue
      if (native ? event?.type !== 'user/message' || !isDeveloperFallback(event.data)
        : event?.type !== 'developer/message') continue
      if (textOf(source) === undefined) throw new Error('Runtime permission role migration requires text blocks')
      const content = source.content
      replacements.push({
        seq,
        message: native
          ? createDeveloperMessage({ content, source: source.source })
          : createUserMessage({ content, source: { ...source.source, form: 'instructions' } }),
      })
    }
    return replacements
  }

  private text(sections: readonly ContextSnapshotSection[]): string | undefined {
    const current = sections.map(section => section.text).join('\n\n')
    if (this.developer === undefined && this.fallback === undefined && current.length === 0) return
    return current.length === 0 ? DEVELOPER_CLEARED : current
  }

  /**
   * Return one uncommitted developer update when its retained text changed or compaction removed it.
   * @param sections - ordered, rendered developer contributions for this step.
   * @param preserveBlocks - retain one content block per contributed fragment.
   * @returns an update to append after provider admission, or `undefined` when unchanged.
   */
  project(sections: readonly ContextSnapshotSection[], preserveBlocks = false): DeveloperMessage | undefined {
    const text = this.text(sections)
    if (text === undefined || this.developer?.text === text) return
    return createDeveloperMessage({
      content: preserveBlocks && sections.length > 0
        ? sections.map(section => ({ type: 'text' as const, text: section.text })) : [{ type: 'text', text }],
      source: { kind: SOURCE, form: 'snapshot', sections },
    })
  }

  /**
   * Return a user-role permission update when the prepared route lacks native developer history.
   * @param sections - ordered developer contributions for this step.
   * @param preserveBlocks - retain one content block per contributed fragment.
   * @returns an append-only user message distinguished from environment snapshots by its source form.
   */
  projectFallback(sections: readonly ContextSnapshotSection[], preserveBlocks = false): UserMessage | undefined {
    const text = this.text(sections)
    if (text === undefined || this.fallback?.text === text) return
    return createUserMessage({
      content: preserveBlocks && sections.length > 0
        ? sections.map(section => ({ type: 'text' as const, text: section.text })) : [{ type: 'text', text }],
      source: { kind: SOURCE, form: 'instructions' },
    })
  }

  /** Current user-role permission node, when a compacted request must update it in place. */
  fallbackSeq(): SessionSeq | undefined {
    return this.fallback?.seq
  }

  /** Current native permission node, when a compacted request must update it in place. */
  developerSeq(): SessionSeq | undefined {
    return this.developer?.seq
  }
}
