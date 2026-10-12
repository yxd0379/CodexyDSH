/** Compact shell activity derived from the recorded Codex tool protocol. */
import { shellExploration } from './shell-exploration.ts'
import type { ToolCallBlock } from './tool-call-model.ts'
import { parsedToolCall } from './raw-tool-call.ts'
import { resultText, toolRowModel, type ToolRowState } from './tool-call-model.ts'

/** A recognized inspection command; its full shell source remains available. */
export interface CodexExplorationEntry {
  readonly kind: 'list' | 'search' | 'read'
  readonly detail: string
}

/** Shell command, recorded output, and lifecycle displayed by the compact row. */
export interface CodexShellModel {
  readonly command: string
  readonly workdir: string | undefined
  readonly entries: readonly CodexExplorationEntry[]
  readonly output: string | undefined
  readonly exitCode: number | undefined
  readonly processId: string | undefined
  readonly requestedProcessId: string | undefined
  readonly duration: string | undefined
  readonly state: ToolRowState
  readonly poll: boolean
}

/**
 * Read the Codex shell response header without interpreting output as metadata.
 * @param toolName - exec_command or write_stdin wire name.
 * @param block - immutable preparation, execution, or result record.
 * @returns display values, or null when dispatched arguments cannot be read.
 */
export function codexShellModel(toolName: string, block: ToolCallBlock): CodexShellModel | null {
  const parsed = parsedToolCall(block)
  if (parsed === null) return null
  const poll = toolName === 'write_stdin'
  const rawCommand = poll ? parsed.args.chars : parsed.args.cmd
  if (rawCommand !== undefined && typeof rawCommand !== 'string') return null
  if (!poll && (typeof rawCommand !== 'string' || rawCommand.trim() === '')) return null
  const command = rawCommand ?? ''
  const text = 'kind' in block ? resultText(block) : undefined
  const marker = text?.indexOf('\nOutput:') ?? -1
  const header = text !== undefined && marker >= 0 ? text.slice(0, marker) : ''
  const recordedExit = /^Process exited with code (-?\d+)$/m.exec(header)?.[1]
  const exitCode = recordedExit === undefined ? undefined : Number(recordedExit)
  const processId = /^Process running with session ID (\S+)$/m.exec(header)?.[1]
  const requestedProcessId = poll && (typeof parsed.args.session_id === 'number' || typeof parsed.args.session_id === 'string')
    ? String(parsed.args.session_id) : undefined
  const duration = /^Wall time: ([\d.]+) seconds$/m.exec(header)?.[1]
  const row = toolRowModel(toolName, block)
  const state = row.state === 'ok' && exitCode !== undefined && exitCode !== 0 ? 'error' : row.state
  return {
    command,
    workdir: typeof parsed.args.workdir === 'string' ? parsed.args.workdir : undefined,
    entries: !poll && state !== 'error' && state !== 'stopped' ? shellExploration(command) : [],
    output: text === undefined ? undefined : marker >= 0 ? text.slice(marker + '\nOutput:'.length).replace(/^\r?\n/, '') : text,
    exitCode, processId, requestedProcessId, duration, state, poll,
  }
}
