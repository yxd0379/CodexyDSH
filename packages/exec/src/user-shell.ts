import { requestHeaderOf } from '@codexydsh/runtime/session'
/** Human-origin shell commands: direct execution and durable Codex user context. */

import { basename } from 'node:path'
import type { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@codexydsh/runtime/llm'
import { codexfulToolProfile } from '@codexydsh/prompt'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { Config } from './index.ts'
import { truncateOutput } from './codex-exec.ts'

/** Durable metadata identifying a human's unsandboxed shell command and its settled result. */
export interface UserShellCommandSource {
  readonly kind: 'user-shell-command'
  readonly form: 'result'
  readonly command: string
  readonly cwd: string
  readonly exitCode: number
  readonly durationMs: number
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A direct human shell command, retained for the next model request. */
    'user-shell-command': UserShellCommandSource
  }
}

interface LiveRun {
  readonly abort: AbortController
  readonly done: Promise<CommandResult>
}

function positiveInteger(value: number, key: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new Error(`tool-bash: ${key} must be a positive timer-safe integer`)
  }
  return value
}

/** Bounded combined stdout/stderr, preserving both ends in process emission order. */
class OutputBuffer {
  private head = Buffer.alloc(0)
  private tail = Buffer.alloc(0)
  private totalBytes = 0

  constructor(private readonly maximumBytes: number) {}

  observe(stream: Readable): void {
    stream.on('data', (chunk: Buffer | string) => {
      const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      this.totalBytes += data.length
      const headLimit = Math.ceil(this.maximumBytes / 2)
      const headBytes = Math.min(headLimit - this.head.length, data.length)
      this.head = Buffer.concat([this.head, data.subarray(0, headBytes)])
      const tailLimit = this.maximumBytes - headLimit
      this.tail = tailLimit === 0 ? Buffer.alloc(0) : Buffer.concat([this.tail, data.subarray(headBytes)]).subarray(-tailLimit)
    })
  }

  snapshot(): { raw: string; omittedBytes: number; originalBytes: number } {
    const omitted = this.totalBytes - this.head.length - this.tail.length
    const raw = this.head.toString('utf8') + (omitted > 0 ? `\n... ${omitted} bytes omitted ...\n` : '') + this.tail.toString('utf8')
    return { raw, omittedBytes: omitted, originalBytes: this.totalBytes }
  }
}

/**
 * Register /shell as a human command without adding any model-facing tool.
 * Login shells and sandbox bypass match Codex's explicit user shell action.
 * @param ctx - owning plugin context with subprocess and human command registries.
 * @param config - command timeout and retained output budgets.
 */
export function applyUserShellCommands(ctx: Context, config: Config): void {
  const timeoutMs = positiveInteger(config.userShellTimeoutMs ?? 3_600_000, 'userShellTimeoutMs')
  const maximumBytes = positiveInteger(config.userShellOutputBytes ?? 1_048_576, 'userShellOutputBytes')
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) throw new Error('tool-bash: user shell commands require subprocess')
  const running = new Map<Agent, LiveRun>()
  const lifecycle = new AbortController()

  ctx.on('agent/cancelled', ({ agent, cause }) => { running.get(agent)?.abort.abort(cause) })
  ctx.effect(() => async () => {
    lifecycle.abort(new Error('user shell plugin disposed'))
    await Promise.allSettled([...running.values()].map(run => run.done))
  }, 'tool-bash: stop user shell commands')

  ctx.inject(['commands'], (scope) => {
    scope.commands.register({
      name: 'shell',
      description: 'Run a user shell command directly with full access, without invoking the model.',
      input: { hint: 'Shell command (runs outside the agent sandbox)' },
      async handler({ agent, rawInput, signal }) {
        const command = rawInput.trim()
        if (command.trim().length === 0) return { kind: 'error', text: 'Enter a non-empty shell command.' }
        if (running.has(agent)) return { kind: 'error', text: 'A user shell command is already running in this Session.' }
        if (agent.session.header.cwd === undefined) return { kind: 'error', text: 'Shell working directory is unavailable in this Session.' }
        lifecycle.signal.throwIfAborted()
        const auxiliary = agent.status === 'running'
        const abort = new AbortController()
        const execute = async (maintenanceSignal?: AbortSignal): Promise<CommandResult> => {
          const fused = AbortSignal.any([signal, abort.signal, lifecycle.signal, ...maintenanceSignal === undefined ? [] : [maintenanceSignal]])
          const cwd = agent.session.header.cwd!
          const startedAt = performance.now()
          const buffer = new OutputBuffer(maximumBytes)
          let exitCode = -1
          let failure: string | undefined
          const timeout = new Error('command timed out')
          const deadline = setTimeout(() => { abort.abort(timeout) }, timeoutMs)
          let model = requestHeaderOf(agent.session)?.config.model ?? agent.options.model
          try {
            const preparation = await ctx.codexyPrompt.prepare({ agent, scope: agent, signal: fused })
            model = preparation.variables.model ?? model
            const environment = await subprocess.terminalEnvironment(fused)
            fused.throwIfAborted()
            const shell = environment.defaultShell ?? (environment.platform === 'windows' ? 'powershell.exe' : '/bin/bash')
            const argv = environment.platform === 'windows'
              ? basename(shell).toLowerCase() === 'cmd.exe' ? [shell, '/C', command] : [shell, '-NoLogo', '-Command', command]
              : [shell, '-lc', command]
            const process = subprocess.spawn({
              argv, cwd, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
              graceMs: 1_000, signal: fused,
            })
            if (process.stdout !== undefined) buffer.observe(process.stdout)
            if (process.stderr !== undefined) buffer.observe(process.stderr)
            const outcome = await process.done
            exitCode = outcome.exitCode ?? -1
          } catch (error) {
            failure = error instanceof Error ? error.message : String(error)
          } finally {
            clearTimeout(deadline)
          }
          const timedOut = fused.aborted && fused.reason === timeout
          const durationMs = fused.aborted && !timedOut ? 0 : performance.now() - startedAt
          const policy = codexfulToolProfile(model, 'codex-pinned').sourceTruncation
          const retained = buffer.snapshot()
          const raw = timedOut ? `command timed out after ${Math.round(durationMs)} milliseconds\n${retained.raw}`
            : fused.aborted ? 'command aborted by user'
              : failure === undefined ? retained.raw : `execution error: ${failure}`
          const output = truncateOutput(raw, policy, retained.omittedBytes, retained.originalBytes, true)
          if (fused.aborted) exitCode = -1
          const source: UserShellCommandSource = { kind: 'user-shell-command', form: 'result', command, cwd, exitCode, durationMs }
          const text = `<user_shell_command>\n<command>\n${command}\n</command>\n<result>\nExit code: ${exitCode}\nDuration: ${(durationMs / 1_000).toFixed(4)} seconds\nOutput:\n${output}\n</result>\n</user_shell_command>`
          const message = createUserMessage({ source, content: [{ type: 'text', text }] })
          if (auxiliary || agent.session.deriveMessages()[0]?.role !== 'system') {
            agent.inject(message)
            return { kind: 'success', text }
          }
          const event = agent.session.append('user/message', message, { surfaceOp: 'append' })
          return { kind: 'success', text, sourceEventSeq: event.seq }
        }
        const done = auxiliary ? execute() : agent.runMaintenance(execute)
        running.set(agent, { abort, done })
        try {
          return await done
        } finally {
          running.delete(agent)
        }
      },
    })
  })
}
