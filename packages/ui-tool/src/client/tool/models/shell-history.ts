/** Incremental command identities linking exec_command to its write_stdin receipts. */
import type { Context } from '@deepseek-ai/cordis'
import type { ConversationNodeDefinition, ConversationViewDefinition, ConversationViewNode, ToolCallBlock } from '@codexydsh/ui-conversation/client'
import type {} from '@deepseek-ai/dsh-tools/types'
import { codexShellModel, type CodexShellModel } from './codex-shell-model.ts'

/** Command identity and latest observed process outcome shared by its recorded polls. */
export interface ShellActivity {
  readonly command: string
  readonly originCallId: string
  readonly latest: CodexShellModel
}
/** Session-local lookup; IDs reused by later commands start a new activity. */
export interface ShellHistory {
  /** @param callId - Recorded shell invocation. @returns Its originating command and latest receipt. */
  get(callId: string): ShellActivity | undefined
}
declare module '@codexydsh/ui-conversation/client' {
  interface ConversationViewSnapshotMap {
    /** Links loaded shell commands and their polls without rescanning Chat rows. */
    'tool-shell-history': ShellHistory
  }
}
interface ShellNode extends ConversationViewNode { readonly data: CodexShellModel }

/** Fold only the dispatched shell arguments and their matching result. */
export const shellCallDefinition: ConversationNodeDefinition<ToolCallBlock> = {
  kind: 'tool-shell-call', target: 'tool-shell-history',
  match: event => event.type === 'tool/call' && (event.data.name === 'exec_command' || event.data.name === 'write_stdin')
    ? { id: String(event.data.callId), role: 'start' }
    : event.type === 'tool/result' ? { id: String(event.data.message.source.callId), role: 'update' } : null,
  start: (_context, { event }) => {
    if (event.type !== 'tool/call') throw new Error('Shell activity requires a dispatched call')
    return { phase: 'start', callId: String(event.data.callId), name: event.data.name, argsRaw: event.data.arguments,
      turn: event.data.turn, step: event.data.step, time: event.time, subCalls: [] }
  },
  update: (context, { event }) => {
    if (event.type !== 'tool/result') return context.state
    const previous = context.state
    const call = 'kind' in previous ? previous.call : previous.phase === 'start' ? { name: previous.name, argsRaw: previous.argsRaw } : null
    return { kind: 'tool-result', callId: previous.callId, seq: event.seq, time: event.time,
      call, callTime: previous.time, content: event.data.message.content, isError: event.data.message.isError === true,
      ...event.data.error === undefined ? {} : { error: event.data.error }, subCalls: [] }
  },
  buildViewNode: (context) => {
    const block = context.state
    if (block === undefined) return null
    const name = 'kind' in block ? block.call?.name : block.name
    const data = name === undefined ? null : codexShellModel(name, block)
    return data === null ? null : { key: context.key, kind: context.kind, id: context.id, target: 'tool-shell-history', data }
  },
}

/** Incremental per-call associations, rebuilt in recorded order when history is replaced. */
export const shellHistoryView: ConversationViewDefinition<ShellNode, ShellHistory> = {
  target: 'tool-shell-history',
  create: () => {
    let origins = new Map<string, string>()
    let processes = new Map<string, string>()
    let activities = new Map<string, ShellActivity>()
    const snapshot = (): ShellHistory => {
      const calls = origins; const runs = activities
      return { get: (callId) => { const origin = calls.get(callId); return origin === undefined ? undefined : runs.get(origin) } }
    }
    const add = (node: ShellNode) => {
      const model = node.data
      const previousOrigin = origins.get(node.id)
      const origin = previousOrigin
        ?? (model.poll && model.requestedProcessId !== undefined ? processes.get(model.requestedProcessId) : node.id)
      if (origin === undefined) return
      const previous = activities.get(origin)
      origins.set(node.id, origin)
      activities.set(origin, { command: model.poll ? previous?.command ?? '' : model.command, originCallId: origin, latest: model })
      if (model.processId !== undefined) processes.set(model.processId, origin)
    }
    return {
      empty: snapshot(),
      replace: ({ nodes }) => {
        origins = new Map(); processes = new Map(); activities = new Map()
        for (const node of nodes) add(node)
        return snapshot()
      },
      apply: ({ upserts }) => {
        origins = new Map(origins); processes = new Map(processes); activities = new Map(activities)
        for (const node of upserts) add(node)
        return snapshot()
      },
    }
  },
}

/** Register effect-owned shell history projection.
 * @param ctx - Tool view plugin context.
 */
export function registerShellHistory(ctx: Context): void {
  ctx.uiConversation.events.register(shellCallDefinition)
  ctx.uiConversation.views.register(shellHistoryView)
}
