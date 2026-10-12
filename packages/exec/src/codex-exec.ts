import { productSnapshot } from '@codexydsh/bridges/session-reads'
import { requestHeaderOf } from '@codexydsh/runtime/session'
import type {} from '@codexydsh/processes'
/** Codex-style command tools over the existing subprocess and file-sandbox services.
 * @module dsh-tool-bash/codex-exec
 */

import { createHash, randomBytes } from 'node:crypto'
import { basename, isAbsolute, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { codexfulToolProfile } from '@codexydsh/prompt'
import type {} from '@codexydsh/prompt'
import { FsError } from '@deepseek-ai/dsh-fs'
import { runCodexPatch } from '@codexydsh/files'
import { HarnessError, ToolCallId } from '@codexydsh/runtime/llm'
import { SandboxUnavailableError, approveEscalation, classifyRunnerFailure, isRunnerSpawnFailure, matchesSignature, sandboxDenialMarker, escalationHintMarker } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxExecutionPolicy, EscalationApprover } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import type { ApprovalOutcome, ApprovalPolicy } from '@codexydsh/approval'
import type {} from '@deepseek-ai/dsh-shell-env'
import { defineTool } from '@codexydsh/tool-schema'
import type { ToolExecution, ToolExecutionResult, ToolExecutionToken, ToolRunContext } from '@codexydsh/tool-schema'
import type { Config } from './index.ts'

/** Facts the Codex command tool has resolved before reviewing one call. */
export interface CodexExecReviewRequest {
  /** Selected shell argv; whole-script apply_patch may run without a process. */
  argv: readonly string[]
  /** Original model-supplied shell source. */
  command: string
  /** Platform of the selected subprocess provider. */
  platform: 'posix' | 'windows'
  /** Current Session approval policy, if an approval service is composed. */
  approvalPolicy: ApprovalPolicy | undefined
}

/** A Codex command policy's decision before approval or process launch. */
export type CodexExecReviewDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason: string }

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Review the resolved Codex command before sandbox escalation or execution.
     * An ask is resolved by the command tool so dangerous-command and sandbox
     * escalation reasons can share one approval request.
     * @param request - the selected shell argv and current approval policy.
     * @mode waterfall
     */
    'tool-bash/codex-exec-review'(request: CodexExecReviewRequest, next: () => Promise<CodexExecReviewDecision>): Promise<CodexExecReviewDecision>
  }
}

/** Bound the complete model-origin input question before an approval answerer receives it. */
const MAX_STDIN_APPROVAL_BYTES = 8_000

interface CommandArgs {
  cmd: string
  workdir?: string
  tty?: boolean
  yield_time_ms?: number
  max_output_tokens?: number
  shell?: string
  login?: boolean
  sandbox_permissions?: 'use_default' | 'require_escalated'
  justification?: string
  prefix_rule?: string[]
}

interface PollArgs {
  session_id: number
  chars?: string
  yield_time_ms?: number
  max_output_tokens?: number
}

type OutputPolicy = { readonly mode: 'bytes' | 'tokens'; readonly limit: number }

interface ResultPolicies {
  readonly output: OutputPolicy
  readonly responseLimitBytes: number
  readonly decodedWarningCount: boolean
  readonly programOutputTokens: number | undefined
}

/** Exact unified-exec fields returned to a JavaScript caller. */
interface CodexCommandProgramResult {
  chunk_id?: string
  wall_time_seconds: number
  exit_code?: number
  session_id?: number
  original_token_count?: number
  output: string
}

/** One command observation with independent model and program renderings. */
interface CodexCommandResult {
  text: string
  program: CodexCommandProgramResult
}

/** Normalize only the caller's exact abort reason; concurrent execution failures remain failures. */
function normalizeCommandCancellation<A>(
  execute: (args: A, exec: ToolRunContext) => Promise<CodexCommandResult>,
): (args: A, exec: ToolRunContext) => Promise<CodexCommandResult> {
  return async (args, exec) => {
    const startedAt = performance.now()
    try {
      return await execute(args, exec)
    } catch (error) {
      if (!exec.signal.aborted || error !== exec.signal.reason) throw error
      const seconds = Math.max(0.1, (performance.now() - startedAt) / 1000).toFixed(1)
      const message = exec.name === 'exec_command'
        ? `Wall time: ${seconds} seconds\naborted by user` : `aborted by user after ${seconds}s`
      const interrupted = new HarnessError(message, 'interrupted', { cause: error })
      interrupted.name = 'Interrupted'
      throw interrupted
    }
  }
}

/** Preserve the pinned abort body while the registry retains structured interruption metadata. */
function finalizeCommandCancellation(
  _exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>,
) {
  return result.isError && result.error.info?.code === 'interrupted'
    ? [{ type: 'text' as const, text: result.error.message }] : undefined
}

const COMMAND_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false, properties: {
    text: { type: 'string', required: true },
    program: { type: 'object', required: true, additionalProperties: false, properties: {
      chunk_id: { type: 'string' },
      wall_time_seconds: { type: 'number', required: true },
      exit_code: { type: 'number' },
      session_id: { type: 'number' },
      original_token_count: { type: 'number' },
      output: { type: 'string', required: true },
    } },
  },
} as const

interface LiveCommand {
  id: number
  owner: Agent | undefined
  tty: boolean
  launchCmd: string
  launchCwd: string
  launchCallId: ToolCallId
  /** Standing policy at launch; a running terminal keeps its launch permissions after a Session switch. */
  launchPolicy: SandboxExecutionPolicy | undefined
  /** An approved sandbox bypass remains privileged even if the standing policy later matches it. */
  launchEscalated: boolean
  outputHead: Buffer
  outputTail: Buffer
  outputOmittedBytes: number
  outputBytesSinceRead: number
  stderrTail: Buffer
  finished: boolean
  outcome?: SubprocessOutcome
  failure?: Error
  done: Promise<void>
  busy: Promise<void>
  write(chars: string): Promise<void>
  terminate(): void | Promise<void>
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`)
  return value
}

function assertAllowedParameters(args: object, allowed: ReadonlySet<string>, toolName: string): void {
  for (const name of Object.keys(args)) {
    if (!allowed.has(name)) throw new Error(`${toolName}: unsupported parameter ${JSON.stringify(name)}`)
  }
}

async function serializeCommand<T>(command: LiveCommand, operation: () => Promise<T>): Promise<T> {
  const previous = command.busy
  let release: () => void = () => {}
  command.busy = new Promise<void>((finish) => { release = finish })
  await previous
  try {
    return await operation()
  } finally {
    release()
  }
}

function outputLimit(value: number | undefined, maximum: number): number {
  return Math.min(positiveInteger(value ?? 10_000, 'max_output_tokens'), maximum)
}

function byteBudget(policy: OutputPolicy): number {
  return policy.mode === 'tokens' ? policy.limit * 4 : policy.limit
}

function resultPolicies(exec: ToolExecution, outputTokens: number, maximumTokens: number, mode: Config['codexOutputPolicy'], explicitOutputTokens?: number): ResultPolicies {
  const model = mode === 'codexful-model' ? (exec.agent === undefined ? undefined : requestHeaderOf(exec.agent.session)?.config.model) : undefined
  if (mode === 'codexful-model' && model === undefined) {
    throw new Error('Codexful command output requires the current Session request/header model')
  }
  const source: OutputPolicy = mode === 'codexful-model'
    ? codexfulToolProfile(model, 'daily').sourceTruncation
    : { mode: 'tokens', limit: maximumTokens }
  const requested: OutputPolicy = { mode: 'tokens', limit: outputTokens }
  return {
    output: byteBudget(requested) < byteBudget(source) ? requested : source,
    responseLimitBytes: mode === 'codexful-model'
      ? byteBudget({ ...source, limit: Math.ceil(source.limit * 1.2) })
      : Math.floor(maximumTokens * 4 * 1.2),
    decodedWarningCount: mode === 'codexful-model',
    programOutputTokens: explicitOutputTokens,
  }
}

function yieldDuration(value: number | undefined, minimum: number, maximum: number, fallback: number): number {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new Error('yield_time_ms must be a non-negative finite number')
  }
  return Math.min(maximum, Math.max(minimum, value ?? fallback))
}

function appendOutput(command: LiveCommand, chunk: Buffer, maximumBytes: number, stderr: boolean): void {
  command.outputBytesSinceRead += chunk.length
  if (stderr) command.stderrTail = Buffer.from(Buffer.concat([command.stderrTail, chunk]).subarray(-65_536))
  const headBudget = Math.floor(maximumBytes / 2)
  const headSize = Math.min(chunk.length, headBudget - command.outputHead.length)
  command.outputHead = Buffer.concat([command.outputHead, chunk.subarray(0, headSize)])
  const remainder = chunk.subarray(headSize)
  const tailBudget = maximumBytes - headBudget
  if (remainder.length >= tailBudget) {
    command.outputOmittedBytes += command.outputTail.length + remainder.length - tailBudget
    command.outputTail = Buffer.from(remainder.subarray(remainder.length - tailBudget))
    return
  }
  const tail = Buffer.concat([command.outputTail, remainder])
  const omitted = Math.max(0, tail.length - tailBudget)
  if (omitted > 0) {
    command.outputOmittedBytes += omitted
  }
  command.outputTail = Buffer.from(tail.subarray(omitted))
}

function observeOutput(stream: Readable, command: LiveCommand, maximumBytes: number, stderr: boolean): void {
  stream.on('data', (chunk: Buffer | string) => {
    appendOutput(command, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), maximumBytes, stderr)
  })
}

function truncateMiddle(raw: string, policy: OutputPolicy): string {
  const bytes = Buffer.from(raw)
  const budget = byteBudget(policy)
  if (bytes.length <= budget) return raw
  let headEnd = Math.floor(budget / 2)
  while (headEnd > 0 && (bytes.readUInt8(headEnd) & 0xc0) === 0x80) headEnd--
  let tailStart = bytes.length - (budget - Math.floor(budget / 2))
  while (tailStart < bytes.length && (bytes.readUInt8(tailStart) & 0xc0) === 0x80) tailStart++
  const head = bytes.subarray(0, headEnd).toString('utf8')
  const tail = bytes.subarray(tailStart).toString('utf8')
  const removed = policy.mode === 'tokens'
    ? Math.ceil((bytes.length - budget) / 4)
    : Array.from(raw).length - Array.from(head).length - Array.from(tail).length
  const marker = `…${removed} ${policy.mode === 'tokens' ? 'tokens' : 'chars'} truncated…`
  return `${head}${marker}${tail}`
}

/**
 * Format bounded command output using the pinned Codex truncation policy.
 * @param raw - retained combined output, including any buffer omission marker.
 * @param policy - model-selected byte or approximate token budget.
 * @param omittedBytes - bytes discarded before formatting.
 * @param originalBytes - complete output size before buffer retention.
 * @param decodedWarningCount - count the decoded retained text for the warning.
 * @returns model-visible output with Codex's truncation warning when required.
 */
export function truncateOutput(
  raw: string, policy: OutputPolicy, omittedBytes: number, originalBytes: number, decodedWarningCount: boolean,
): string {
  const budget = byteBudget(policy)
  if (Buffer.byteLength(raw) <= budget) return raw
  const truncated = truncateMiddle(raw, policy)
  const omittedMarker = omittedBytes > 0 ? `... ${omittedBytes} bytes omitted ...` : undefined
  const notice = omittedMarker !== undefined && !truncated.includes(omittedMarker) ? `${omittedMarker}\n` : ''
  if (omittedMarker !== undefined) {
    return `Warning: truncated output (original token count: ${Math.ceil(originalBytes / 4)})\n${notice}\n${truncated}`
  }
  const warningCount = Math.ceil((decodedWarningCount ? Buffer.byteLength(raw) : originalBytes) / 4)
  return `Warning: truncated output (original token count: ${warningCount})\nTotal output lines: ${raw.split('\n').length - (raw.endsWith('\n') ? 1 : 0)}\n\n${truncated}`
}

function takeResult(command: LiveCommand, policies: ResultPolicies, startedAt: number, remove: () => void): CodexCommandResult {
  const omittedBytes = command.outputOmittedBytes
  const marker = omittedBytes > 0 ? `\n... ${omittedBytes} bytes omitted ...\n` : ''
  const raw = Buffer.concat([command.outputHead, Buffer.from(marker), command.outputTail]).toString('utf8')
  command.outputHead = Buffer.alloc(0)
  command.outputTail = Buffer.alloc(0)
  command.outputOmittedBytes = 0
  const originalBytes = command.outputBytesSinceRead
  command.outputBytesSinceRead = 0
  const chunkId = randomBytes(3).toString('hex')
  const wallTimeSeconds = (performance.now() - startedAt) / 1000
  const header = [
    `Chunk ID: ${chunkId}`,
    `Wall time: ${wallTimeSeconds.toFixed(4)} seconds`,
    ...command.finished
      ? command.outcome?.exitCode === null || command.outcome?.exitCode === undefined
        ? [] : [`Process exited with code ${command.outcome.exitCode}`]
      : [`Process running with session ID ${command.id}`],
    `Original token count: ${Math.ceil(originalBytes / 4)}`,
    'Output:',
  ]
  if (command.finished) remove()
  if (command.failure !== undefined) throw command.failure
  const responseHeader = header.join('\n')
  const responseBudget = policies.responseLimitBytes - Buffer.byteLength(responseHeader) - 1
  let policy = policies.output
  let output = truncateOutput(raw, policy, omittedBytes, originalBytes, policies.decodedWarningCount)
  while (Buffer.byteLength(output) > responseBudget && policy.limit > 0) {
    const excess = Buffer.byteLength(output) - responseBudget
    policy = { ...policy, limit: Math.max(0, policy.limit - (policy.mode === 'tokens' ? Math.ceil(excess / 4) : excess)) }
    output = truncateOutput(raw, policy, omittedBytes, originalBytes, policies.decodedWarningCount)
  }
  return {
    text: `${responseHeader}\n${output}`,
    program: {
      chunk_id: chunkId,
      wall_time_seconds: wallTimeSeconds,
      ...command.outcome?.exitCode === null || command.outcome?.exitCode === undefined
        ? {} : { exit_code: command.outcome.exitCode },
      ...command.finished ? {} : { session_id: command.id },
      original_token_count: Math.ceil(originalBytes / 4),
      output: policies.programOutputTokens === undefined ? raw
        : truncateOutput(raw, { mode: 'tokens', limit: policies.programOutputTokens }, omittedBytes, originalBytes, true),
    },
  }
}

async function waitForCommand(command: LiveCommand, durationMs: number): Promise<void> {
  if (command.finished) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    command.done,
    new Promise<void>((finish) => { timer = setTimeout(finish, durationMs) }),
  ])
  if (timer !== undefined) clearTimeout(timer)
}

function commandWorkdir(args: CommandArgs, exec: ToolExecution, policy: SandboxExecutionPolicy | undefined): string {
  const cwd = policy?.workspaceRoot ?? exec.agent?.session.header.cwd ?? process.cwd()
  return args.workdir === undefined ? cwd : isAbsolute(args.workdir) ? args.workdir : resolve(cwd, args.workdir)
}

/** Compare the execution facts that a live terminal retains across Session permission switches. */
function sameFilePolicy(left: SandboxExecutionPolicy, right: SandboxExecutionPolicy): boolean {
  return left.mode === right.mode && left.workspaceRoot === right.workspaceRoot && left.sessionId === right.sessionId
}

/** A process may finish while the tool waits for approval, so check again before writing. */
function requireRunningCommand(command: LiveCommand, id: number): void {
  if (command.finished) throw new Error(`Exec session ${id} has already exited`)
}

/** Fingerprint the exact execution request and current permission context without logging command text twice. */
function sessionGrantKey(input: {
  cmd: string
  cwd: string
  tty: boolean
  shell: string
  login: boolean
  platform: 'posix' | 'windows'
  environment: Record<string, string>
  standing: SandboxExecutionPolicy
}): string {
  const { cmd, cwd, tty, shell, login, platform, environment, standing } = input
  const encoded = JSON.stringify({
    tool: 'exec_command', cmd, cwd, tty, shell, login, platform,
    requestedPermission: 'require_escalated', targetMode: 'danger-full-access',
    standingMode: standing.mode, workspaceRoot: standing.workspaceRoot,
    sessionId: standing.sessionId,
    networkPolicy: 'unrestricted',
    hostEnvironment: Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)),
    environment: Object.entries(environment).sort(([left], [right]) => left.localeCompare(right)),
  })
  return `codex-exec:v1:${createHash('sha256').update(encoded).digest('hex')}`
}

const PREFIX_SHELLS = new Set(['/bin/bash', '/usr/bin/bash', '/bin/sh', '/usr/bin/sh', '/bin/zsh', '/usr/bin/zsh'])

/** Only literal, single-process shell commands can inherit a prefix grant. */
function literalCommandWords(cmd: string, shell: string, platform: 'posix' | 'windows'): string[] | undefined {
  if (platform !== 'posix' || !PREFIX_SHELLS.has(shell)) return undefined
  const words: string[] = []
  let word = ''
  let started = false
  let quote: 'single' | 'double' | undefined
  for (const char of cmd) {
    if (';|&<>$`\\\r\n\0#*?[]{}()%!~^'.includes(char)) return undefined
    if (char === '=' && shell.endsWith('/zsh') && quote === undefined && word.length === 0) return undefined
    if (char === "'" && quote !== 'double') { quote = quote === 'single' ? undefined : 'single'; started = true; continue }
    if (char === '"' && quote !== 'single') { quote = quote === 'double' ? undefined : 'double'; started = true; continue }
    if (/\s/u.test(char) && char !== ' ' && char !== '\t') return undefined
    if (quote === undefined && (char === ' ' || char === '\t')) {
      if (started) { words.push(word); word = ''; started = false }
      continue
    }
    word += char
    started = true
  }
  if (quote !== undefined) return undefined
  if (started) words.push(word)
  if (words.length === 0 || words.some(word => word.length === 0)) return undefined
  const first = words[0]
  if (first !== undefined && /^[A-Za-z_][A-Za-z_0-9]*=/u.test(first)) return undefined
  return words
}

const BANNED_PREFIX_PROGRAMS = new Set([
  '.', 'bash', 'builtin', 'bun', 'busybox', 'chroot', 'cmd', 'cmd.exe', 'command',
  'corepack', 'dash', 'deno', 'doas', 'env', 'exec', 'fish', 'julia', 'ksh', 'lua',
  'make', 'nice', 'node', 'nodejs', 'nohup', 'npm', 'npx', 'osascript', 'perl',
  'php', 'pkexec', 'pnpm', 'powershell', 'powershell.exe', 'pwsh', 'py', 'pypy',
  'pypy3', 'python', 'python3', 'pythonw', 'pyw', 'rm', 'ruby', 'runuser', 'script',
  'setsid', 'sh', 'source', 'stdbuf', 'su', 'sudo', 'time', 'timeout', 'xargs',
  'yarn', 'zsh',
])

/** Reject interpreter grants and package-manager grants without a named script. */
function isReusableProgramPrefix(prefix: readonly string[]): boolean {
  const program = prefix[0]
  if (program === undefined) return false
  const programName = basename(program).toLowerCase()
  const packageScript = (programName === 'npm' || programName === 'pnpm' || programName === 'yarn')
    && prefix.length >= 3 && prefix[1] === 'run' && prefix[2]?.startsWith('-') === false
  return (!BANNED_PREFIX_PROGRAMS.has(programName) || packageScript)
    && !(prefix.length === 1 && program === 'git')
}

function validatedPrefix(prefix: readonly string[], words: readonly string[] | undefined): readonly string[] {
  if (words === undefined) throw new Error('prefix_rule requires one literal shell command with no expansion, glob, redirection, or command operator')
  if (prefix.length === 0 || prefix.length > 32 || JSON.stringify(prefix).length > 1_024
    || prefix.some(word => typeof word !== 'string' || word.length === 0 || word.length > 256)) {
    throw new Error('prefix_rule must contain 1–32 non-empty command tokens totaling at most 1024 characters')
  }
  if (prefix.length > words.length || prefix.some((word, index) => word !== words[index])) {
    throw new Error('prefix_rule must be a token prefix of cmd')
  }
  if (!isReusableProgramPrefix(prefix)) {
    throw new Error('prefix_rule is too broad for a reusable unsandboxed approval')
  }
  return prefix
}

function prefixGrantKey(input: Parameters<typeof sessionGrantKey>[0], prefix: readonly string[]): string {
  const { cmd: _cmd, ...context } = input
  const encoded = JSON.stringify({
    ...context, tool: 'exec_command', prefix, requestedPermission: 'require_escalated',
    targetMode: 'danger-full-access', networkPolicy: 'unrestricted',
    hostEnvironment: Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)),
    environment: Object.entries(context.environment).sort(([left], [right]) => left.localeCompare(right)),
  })
  return `codex-exec-prefix:v1:${createHash('sha256').update(encoded).digest('hex')}`
}

function shellArgv(shell: string, cmd: string, login: boolean, platform: 'posix' | 'windows'): string[] {
  if (platform === 'windows') {
    const executable = shell.toLowerCase()
    if (executable.endsWith('cmd.exe')) return [shell, '/C', cmd]
    return [shell, '-NoLogo', ...login ? [] : ['-NoProfile'], '-Command', cmd]
  }
  return [shell, login ? '-lc' : '-c', cmd]
}

interface ShellPatchInvocation {
  patch: string
  cwd?: string
}

/**
 * Recognize only the whole-script POSIX heredoc forms Codex intercepts.
 * Other shell syntax retains normal process execution.
 */
function shellPatchInvocation(cmd: string, shell: string, platform: 'posix' | 'windows'): ShellPatchInvocation | undefined {
  if (platform !== 'posix' || !['bash', 'zsh', 'sh'].includes(basename(shell))) return undefined
  const newline = cmd.indexOf('\n')
  if (newline < 0) return undefined
  const first = cmd.slice(0, newline).replace(/\r$/u, '')
  const prefix = /^cd[ \t]+('[^']*'|"[^"$`\\]*"|[A-Za-z0-9_./-]+)[ \t]*&&[ \t]*/u.exec(first)
  const script = prefix === null ? first : first.slice(prefix[0].length)
  const head = /^(?:apply_patch|applypatch)[ \t]*<<[ \t]*(\S+)[ \t]*$/u.exec(script)
  if (head === null) return undefined
  const rawTag = head[1]
  if (rawTag === undefined) return undefined
  const quoted = (rawTag.startsWith("'") && rawTag.endsWith("'"))
    || (rawTag.startsWith('"') && rawTag.endsWith('"'))
  const delimiter = quoted ? rawTag.slice(1, -1) : rawTag
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(delimiter)) return undefined
  const rest = cmd.slice(newline + 1).replaceAll('\r\n', '\n').split('\n')
  const end = rest.indexOf(delimiter)
  if (end < 0 || rest.slice(end + 1).some(line => line !== '')) return undefined
  const rawCwd = prefix?.[1]
  if (rawCwd?.startsWith('-')) return undefined
  const cwd = rawCwd === undefined ? undefined
    : rawCwd.startsWith("'") || rawCwd.startsWith('"') ? rawCwd.slice(1, -1) : rawCwd
  if (cwd === '') return undefined
  return { patch: rest.slice(0, end).join('\n'), ...cwd === undefined ? {} : { cwd } }
}

/** Match Codex's intercepted exec result: zero wall time, no process or chunk metadata. */
function interceptedPatchResult(raw: string, policies: ResultPolicies): CodexCommandResult {
  const header = 'Wall time: 0.0000 seconds\nOutput:'
  const originalBytes = Buffer.byteLength(raw)
  const responseBudget = policies.responseLimitBytes - Buffer.byteLength(header) - 1
  let policy = policies.output
  let output = truncateOutput(raw, policy, 0, originalBytes, policies.decodedWarningCount)
  while (Buffer.byteLength(output) > responseBudget && policy.limit > 0) {
    const excess = Buffer.byteLength(output) - responseBudget
    policy = { ...policy, limit: Math.max(0, policy.limit - (policy.mode === 'tokens' ? Math.ceil(excess / 4) : excess)) }
    output = truncateOutput(raw, policy, 0, originalBytes, policies.decodedWarningCount)
  }
  return {
    text: `${header}\n${output}`,
    program: {
      wall_time_seconds: 0,
      output: policies.programOutputTokens === undefined ? raw
        : truncateOutput(raw, { mode: 'tokens', limit: policies.programOutputTokens }, 0, originalBytes, true),
    },
  }
}

/**
 * Register Codex-compatible JSON command and process-poll tools in this scope.
 * @param ctx - the owning Cordis context with shell, subprocess, and tool services.
 * @param config - output limits for this tool format.
 */
export function applyCodexExec(ctx: Context, config: Config): void {
  const maximumBytes = positiveInteger(config.codexOutputBufferBytes ?? 1_048_576, 'codexOutputBufferBytes')
  const maximumTokens = positiveInteger(config.codexMaxOutputTokens ?? 20_000, 'codexMaxOutputTokens')
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) throw new Error('Codex exec tools require ctx.subprocess')
  const sandboxMode = ctx.shell.sandboxMode
  const policyService = sandboxMode === undefined ? undefined : ctx.get('sandboxPolicy')
  if (sandboxMode !== undefined && policyService === undefined) {
    throw new Error('Codex exec tools require ctx.sandboxPolicy when the mounted shell executor confines commands')
  }
  const commands = new Map<number, LiveCommand>()
  let nextId = 1

  ctx.on('codexful/active-prefixes', async ({ agent, signal }, next) => {
    const inherited = await next()
    const activeSignal = signal ?? new AbortController().signal
    const approval = ctx.get('codexyApproval')
    const shellEnv = ctx.get('shellEnv')
    const standing = policyService?.resolve({ session: agent.session })
    // A contributor may depend on the real tool call identity; no prompt-time probe can assert its fingerprint.
    if (approval === undefined || shellEnv === undefined || standing === undefined
      || standing.mode === 'danger-full-access' || shellEnv.list().length > 0) return inherited
    const terminal = await subprocess.terminalEnvironment(activeSignal)
    const shell = terminal.defaultShell ?? (terminal.platform === 'windows' ? 'powershell.exe' : '/bin/bash')
    const callId = ToolCallId('codexful-world-state-prefix-probe')
    const probe: ToolExecution = {
      callId, rootCallId: callId, token: Symbol('codexful-prefix-probe') as ToolExecutionToken,
      name: 'exec_command', arguments: { cmd: '' }, agent, signal: activeSignal,
    }
    const grantInput = {
      cmd: '', cwd: standing.workspaceRoot, tty: false, shell, login: true,
      platform: terminal.platform, environment: shellEnv.collect(probe), standing,
    }
    const prefixes: string[][] = []
    const seen = new Set<string>()
    let bytes = 0
    // oxlint-disable-next-line typescript/no-deprecated -- Approved prefixes are reconstructed from committed Session audit events.
    for (const event of productSnapshot(agent.session).toReversed()) {
      if (event.type === 'approval/policy' || event.type === 'approval/reviewer' || event.type === 'sandbox/mode') break
      if (event.type !== 'approval/decided' || event.data.prefixRule === undefined
        || event.data.sessionGrantKey === undefined || event.data.outcome !== 'allowed-once') continue
      const prefix = event.data.prefixRule
      const key = JSON.stringify(prefix)
      if (seen.has(key) || event.data.sessionGrantKey !== prefixGrantKey(grantInput, prefix)
        || !approval.hasGrant(agent, 'exec_command', event.data.sessionGrantKey)) continue
      const lineBytes = Buffer.byteLength(`- ${key}\n`)
      if (prefixes.length === 100 || bytes + lineBytes > 5_000) break
      prefixes.push([...prefix])
      seen.add(key)
      bytes += lineBytes
    }
    return [...inherited, ...prefixes.sort((left, right) => left.length - right.length
      || left.join('').length - right.join('').length
      || JSON.stringify(left).localeCompare(JSON.stringify(right)))]
  })

  /**
   * Review a PTY write if the live process retains a sandbox bypass or a prior
   * Session file policy. The caller sends input only after this returns; denial,
   * cancellation, unavailable review, and policy changes leave it unsent.
   * @param command - the live process and its launch permissions.
   * @param chars - exact input presented to the reviewer.
   * @param exec - the current tool call that owns cancellation and approval UI.
   */
  async function approveTerminalInput(command: LiveCommand, chars: string, exec: ToolExecution): Promise<void> {
    const current = policyService?.resolve(command.owner === undefined ? {} : { session: command.owner.session })
    const changed = command.launchPolicy !== undefined
      && (current === undefined || !sameFilePolicy(command.launchPolicy, current))
    if (!command.launchEscalated && !changed) return
    if (command.owner === undefined) throw new Error('write_stdin requires an agent to approve input to a privileged terminal')
    const approval = ctx.get('codexyApproval')
    if (approval === undefined) throw new Error('write_stdin requires approval for retained terminal permissions, but no approval service is composed')
    if (chars.includes('\0')) throw new Error('write_stdin input contains a NUL byte and cannot be reviewed safely')
    const authority = command.launchEscalated
      ? 'This terminal was launched outside the file sandbox.'
      : 'This terminal retains a file policy from before the current Session permission switch.'
    const reason = `Send input to exec session ${command.id}. ${authority} Original command: ${JSON.stringify(command.launchCmd)}. Launch cwd: ${JSON.stringify(command.launchCwd)}. Original exec call ID: ${JSON.stringify(command.launchCallId)}. Input: ${JSON.stringify(chars)}`
    if (Buffer.byteLength(reason, 'utf8') > MAX_STDIN_APPROVAL_BYTES) {
      throw new Error('write_stdin input and permission details are too large to review safely; use a smaller input or start a new terminal')
    }
    const outcome = await approval.request({
      agent: command.owner,
      toolName: 'write_stdin',
      callId: exec.callId,
      reason,
      signal: exec.signal,
    })
    if (outcome !== 'allowed-once') {
      switch (outcome) {
        case 'rejected': throw new Error('write_stdin input was rejected')
        case 'cancelled': throw new Error('write_stdin approval was cancelled')
        case 'unavailable': throw new Error('write_stdin approval is unavailable')
        default: {
          const unexpected: never = outcome
          throw new Error(`write_stdin received an unknown approval outcome: ${String(unexpected)}`)
        }
      }
    }
    const afterApproval = policyService?.resolve({ session: command.owner.session })
    if (command.launchPolicy !== undefined
      && (afterApproval === undefined || current === undefined || !sameFilePolicy(current, afterApproval))) {
      throw new Error('Session file permissions changed during write_stdin approval; retry the input')
    }
  }

  ctx.on('agent/disposed', ({ agent }) => {
    for (const command of commands.values()) {
      if (command.owner !== agent) continue
      commands.delete(command.id)
      void Promise.resolve().then(() => command.terminate()).catch((error: unknown) => {
        ctx.logger.warn(`exec session cleanup failed: ${String(error)}`)
      })
    }
  })
  ctx.effect(() => async () => {
    const active = [...commands.values()]
    commands.clear()
    await Promise.allSettled(active.map(async (command) => {
      await command.terminate()
      await command.done
    }))
  }, 'codexExec.sessions')

  ctx.codexyTools.register(defineTool({
    name: 'exec_command',
    description: 'Runs a command in a PTY, returning output or a session ID for ongoing interaction.',
    isConcurrencySafe: () => true,
    closedParameters: true,
    parameters: {
      cmd: { type: 'string', required: true, description: 'Shell command to execute.' },
      ...sandboxMode === undefined ? {} : {
        justification: { type: 'string' as const, description: 'User-facing approval question for `require_escalated`; omit otherwise.' },
      },
      login: { type: 'boolean', description: 'True runs the shell with -l/-i semantics; false disables them. Defaults to true.' },
      max_output_tokens: { type: 'number', description: 'Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.' },
      ...sandboxMode === undefined ? {} : {
        prefix_rule: {
          type: 'array' as const,
          items: { type: 'string' as const },
          description: 'Reusable approval prefix for `cmd`, only with `sandbox_permissions: "require_escalated"`; for example ["git", "pull"].',
        },
        sandbox_permissions: {
          type: 'string' as const,
          enum: ['use_default', 'require_escalated'],
          description: 'Per-command sandbox override. Defaults to `use_default`; use `require_escalated` for unsandboxed execution.',
        },
      },
      shell: { type: 'string', description: "Shell binary to launch. Defaults to the user's default shell." },
      tty: { type: 'boolean', description: 'True allocates a PTY for the command; false or omitted uses plain pipes.' },
      workdir: { type: 'string', description: 'Working directory for the command. Defaults to the turn cwd.' },
      yield_time_ms: { type: 'number', description: 'Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms.' },
    },
    output: {
      schema: COMMAND_RESULT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.text }],
      codeModeResult: (_args, value) => value.program,
    },
    presentCall: args => ({ card: 'terminal', title: args.cmd, ...args.workdir === undefined ? {} : { cwd: args.workdir } }),
    presentResult: (_args, result) => {
      const block = result.content.length === 1 ? result.content[0] : undefined
      return block?.type === 'text' ? { card: 'terminal', output: block.text } : undefined
    },
    finalizeContent: finalizeCommandCancellation,
    execute: normalizeCommandCancellation(async (args: CommandArgs, exec) => {
      assertAllowedParameters(args, new Set([
        'cmd', 'workdir', 'tty', 'yield_time_ms', 'max_output_tokens', 'shell', 'login',
        'sandbox_permissions', 'justification', 'prefix_rule',
      ]), 'exec_command')
      if (args.cmd.trim().length === 0) throw new Error('cmd must be a non-empty command')
      if (args.shell !== undefined && args.shell.trim().length === 0) throw new Error('shell must be a non-empty path or name')
      if (args.justification !== undefined && args.sandbox_permissions !== 'require_escalated') {
        throw new Error('justification requires sandbox_permissions: require_escalated')
      }
      if (args.sandbox_permissions === 'require_escalated' && !args.justification?.trim()) {
        throw new Error('sandbox_permissions: require_escalated requires a justification')
      }
      if (args.sandbox_permissions !== undefined && sandboxMode === undefined) {
        throw new Error('sandbox_permissions is unavailable without a sandboxing executor')
      }
      if (args.prefix_rule !== undefined && args.sandbox_permissions !== 'require_escalated') {
        throw new Error('prefix_rule requires sandbox_permissions: require_escalated')
      }
      const outputTokens = outputLimit(args.max_output_tokens, maximumTokens)
      const policies = resultPolicies(exec, outputTokens, maximumTokens, config.codexOutputPolicy, args.max_output_tokens)
      const waitMs = yieldDuration(args.yield_time_ms, 250, 30_000, 10_000)
      const standing = policyService?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
      const approval = ctx.get('codexyApproval')
      const agent = exec.agent
      const currentApprovalPolicy = (): ApprovalPolicy | undefined => {
        const service = ctx.get('codexyApproval')
        return agent === undefined
          ? service?.config.policy
          : service?.overrideOf(agent.session) ?? service?.config.policy
      }
      const approvalPolicy = currentApprovalPolicy()
      const assertApprovalPolicyUnchanged = (): void => {
        if (currentApprovalPolicy() !== approvalPolicy) {
          throw new Error('Session approval policy changed during exec_command preparation; retry the command')
        }
      }
      const cwd = commandWorkdir(args, exec, standing)
      const environment = await subprocess.terminalEnvironment(exec.signal)
      const shell = args.shell ?? environment.defaultShell ?? (environment.platform === 'windows' ? 'powershell.exe' : '/bin/bash')
      const login = args.login ?? true
      const argv = shellArgv(shell, args.cmd, login, environment.platform)
      const review = await ctx.waterfall('tool-bash/codex-exec-review', {
        argv, command: args.cmd, platform: environment.platform, approvalPolicy,
      }, () => Promise.resolve<CodexExecReviewDecision>({ kind: 'allow' }))
      if (review.kind === 'deny') throw new Error(review.reason)
      if (args.sandbox_permissions === 'require_escalated' && approvalPolicy === 'never') {
        throw new Error('approval policy is Never; reject command — you cannot ask for escalated permissions if the approval policy is Never')
      }
      const interceptedPatch = shellPatchInvocation(args.cmd, shell, environment.platform)
      const patchFs = interceptedPatch === undefined ? undefined : ctx.get('codexyFs')
      if (interceptedPatch !== undefined) {
        if (patchFs === undefined) throw new Error('exec_command apply_patch interception requires a filesystem service')
        if (sandboxMode !== undefined && patchFs.sandboxMode === undefined) {
          throw new Error('exec_command apply_patch interception requires a confining filesystem under a confining shell')
        }
        if (patchFs.sandboxMode !== undefined && standing === undefined) {
          throw new Error('exec_command apply_patch interception requires the current Session file policy')
        }
      }
      const commandEnvironment = ctx.shellEnv.collect(exec)
      const words = literalCommandWords(args.cmd, shell, environment.platform)
      const requestedPrefix = args.prefix_rule === undefined ? undefined : validatedPrefix(args.prefix_rule, words)
      const grantInput = standing === undefined ? undefined : {
        cmd: args.cmd, cwd, tty: args.tty ?? false, shell, login, platform: environment.platform,
        environment: commandEnvironment, standing,
      }
      const reusablePrefix = review.kind !== 'allow' || grantInput === undefined || agent === undefined || words === undefined
        ? undefined
        : Array.from({ length: Math.min(words.length, 32) }, (_, index) => words.slice(0, index + 1))
          .filter(isReusableProgramPrefix)
          .find(prefix => approval?.hasGrant(agent, 'exec_command', prefixGrantKey(grantInput, prefix)))
      let approvedMode: SandboxExecutionPolicy['mode'] | undefined
      if (review.kind === 'ask') {
        if (args.sandbox_permissions === 'require_escalated' && standing?.mode !== 'danger-full-access') {
          if (standing === undefined || args.justification === undefined) {
            throw new Error('sandbox policy and justification are required for escalation')
          }
          approvedMode = await approveEscalation(
            {
              requestedMode: 'danger-full-access',
              justification: `${args.justification}\n${review.reason}`,
              effectiveMode: standing.mode,
              subject: 'command',
            },
            { approver: approval, agent, callId: exec.callId, toolName: 'exec_command', signal: exec.signal },
          )
        } else {
          if (approval === undefined) throw new Error('exec_command requires approval, but no approval service is composed')
          if (agent === undefined) throw new Error('exec_command requires approval, but the call has no agent to route it through')
          const outcome: ApprovalOutcome = await approval.request({
            agent, toolName: 'exec_command', callId: exec.callId, reason: review.reason, signal: exec.signal,
          })
          if (outcome !== 'allowed-once') {
            const reason: Record<Exclude<ApprovalOutcome, 'allowed-once'>, string> = {
              rejected: 'the user rejected tool "exec_command"',
              cancelled: 'approval for tool "exec_command" was cancelled',
              unavailable: 'exec_command requires approval, but no approval channel is available',
            }
            throw new Error(reason[outcome])
          }
        }
      } else if (reusablePrefix !== undefined && standing?.mode !== 'danger-full-access') {
        approvedMode = 'danger-full-access'
      } else if (args.sandbox_permissions === 'require_escalated') {
        if (standing === undefined || grantInput === undefined || args.justification === undefined) {
          throw new Error('sandbox policy and justification are required for escalation')
        }
        approvedMode = await approveEscalation(
          { requestedMode: 'danger-full-access', justification: args.justification, effectiveMode: standing.mode, subject: 'command' },
          {
            approver: approval === undefined ? undefined : {
              request: (request: Parameters<EscalationApprover<Agent, ToolCallId>['request']>[0]) => approval.request({
                ...request, sessionGrantKey: sessionGrantKey(grantInput),
                reason: request.reason + (requestedPrefix === undefined ? '' : `; optional Session grant: future literal commands beginning with ${JSON.stringify(requestedPrefix)} run outside the file sandbox`),
                ...requestedPrefix === undefined ? {} : {
                  prefixGrantKey: prefixGrantKey(grantInput, requestedPrefix), prefixRule: requestedPrefix,
                },
              }),
            },
            agent: exec.agent, callId: exec.callId, toolName: 'exec_command', signal: exec.signal,
          },
        )
      }
      const policy = standing === undefined ? undefined : { ...standing, mode: approvedMode ?? standing.mode }
      if (interceptedPatch !== undefined && patchFs !== undefined) {
        const refreshedPolicy = policyService?.resolve(agent === undefined ? {} : { session: agent.session })
        if (standing !== undefined && (refreshedPolicy === undefined || !sameFilePolicy(standing, refreshedPolicy))) {
          throw new Error('Session file permissions changed during exec_command preparation; retry the command')
        }
        assertApprovalPolicyUnchanged()
        const patchCwd = interceptedPatch.cwd === undefined ? cwd : resolve(cwd, interceptedPatch.cwd)
        const result = await runCodexPatch(ctx, patchFs, interceptedPatch.patch, exec, {
          cwd: patchCwd,
          policy,
          mapError: (error) => {
            if (!(error instanceof FsError) || error.code !== 'FS_SANDBOX_DENIED' || policy === undefined) return error
            const canAsk = agent !== undefined
              && (approval?.overrideOf(agent.session) ?? approval?.config.policy) === 'ask'
            const hint = canAsk ? `\n${escalationHintMarker('command')}` : ''
            return new FsError(`${sandboxDenialMarker(policy.mode)}${hint}`, 'FS_SANDBOX_DENIED', { cause: error })
          },
        })
        return interceptedPatchResult(result.message, policies)
      }
      let confined: ConfinedArgv | undefined
      let confinedMode: 'read-only' | 'workspace-write' | undefined
      if (policy !== undefined && policy.mode !== 'danger-full-access') {
        const sandbox = ctx.get('sandbox')
        if (sandbox === undefined) throw new Error('Codex exec tools require ctx.sandbox for a confined command')
        confinedMode = policy.mode
        confined = await sandbox.confine(argv, { ...policy, mode: policy.mode }, exec.signal)
      }
      // A backend may await its runner probe; a Session switch invalidates the
      // prepared permissions before the process starts.
      const refreshedPolicy = policyService?.resolve(agent === undefined ? {} : { session: agent.session })
      if (standing !== undefined && (refreshedPolicy === undefined || !sameFilePolicy(standing, refreshedPolicy))) {
        throw new Error('Session file permissions changed during exec_command preparation; retry the command')
      }
      assertApprovalPolicyUnchanged()
      if (reusablePrefix !== undefined && agent !== undefined && grantInput !== undefined
        && !approval?.hasGrant(agent, 'exec_command', prefixGrantKey(grantInput, reusablePrefix))) {
        throw new Error('Session prefix approval changed before exec_command started; retry the command')
      }
      exec.signal.throwIfAborted()
      const commandArgv = confined?.argv ?? argv
      const id = nextId++
      const command: LiveCommand = {
        id,
        owner: exec.agent,
        tty: args.tty === true,
        launchCmd: args.cmd,
        launchCwd: cwd,
        launchCallId: exec.callId,
        launchPolicy: standing,
        launchEscalated: approvedMode === 'danger-full-access' && standing?.mode !== 'danger-full-access',
        outputHead: Buffer.alloc(0),
        outputTail: Buffer.alloc(0),
        outputOmittedBytes: 0,
        outputBytesSinceRead: 0,
        stderrTail: Buffer.alloc(0),
        finished: false,
        done: Promise.resolve(),
        busy: Promise.resolve(),
        write: () => Promise.resolve(),
        terminate: () => {},
      }
      try {
        if (args.tty === true) {
          const terminal = await subprocess.spawnTerminal({
            argv: commandArgv, cwd, env: commandEnvironment, rows: 24, cols: 80,
            terminalType: 'xterm-256color', graceMs: 1_000, signal: exec.signal,
          })
          observeOutput(terminal.output, command, maximumBytes, false)
          command.write = chars => terminal.write(chars)
          command.terminate = () => terminal.terminate()
          command.done = terminal.done.then((outcome) => { command.outcome = outcome }, (error: unknown) => {
            command.failure = error instanceof Error ? error : new Error(String(error))
          })
        } else {
          const processHandle = subprocess.spawn({
            argv: commandArgv, cwd, env: commandEnvironment,
            stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
            graceMs: 1_000, signal: exec.signal,
          })
          if (processHandle.stdout !== undefined) observeOutput(processHandle.stdout, command, maximumBytes, false)
          if (processHandle.stderr !== undefined) observeOutput(processHandle.stderr, command, maximumBytes, true)
          command.write = (chars) => {
            if (chars !== '\u0003') throw new Error('stdin is closed for non-PTY exec sessions; only Ctrl-C can interrupt')
            if (processHandle.interrupt === undefined) throw new Error('subprocess provider does not support process interruption')
            return processHandle.interrupt()
          }
          command.terminate = () => { processHandle.terminate() }
          command.done = processHandle.done.then((outcome) => { command.outcome = outcome }, (error: unknown) => {
            command.failure = error instanceof Error ? error : new Error(String(error))
          })
        }
      } catch (error) {
        if (confined !== undefined && confinedMode !== undefined && isRunnerSpawnFailure(error, confined.argv[0], cwd)) {
          throw new SandboxUnavailableError(confinedMode, String(error))
        }
        throw error
      }
      command.done = command.done.then(() => {
        if (confined === undefined || confinedMode === undefined) return
        if (command.failure !== undefined && isRunnerSpawnFailure(command.failure, confined.argv[0], cwd)) {
          command.failure = new SandboxUnavailableError(confinedMode, String(command.failure))
          return
        }
        if (command.outcome === undefined) return
        const diagnostics = args.tty === true ? Buffer.concat([command.outputHead, command.outputTail]).toString('utf8') : command.stderrTail.toString('utf8')
        const failure = classifyRunnerFailure(command.outcome.exitCode, diagnostics, confined.runnerFailureRules)
        if (failure !== undefined) {
          command.failure = new SandboxUnavailableError(confinedMode, failure.detail)
          return
        }
        if (matchesSignature(command.outcome.exitCode, diagnostics, confined.denialSignatures)) {
          const canAsk = agent !== undefined
            && (approval?.overrideOf(agent.session) ?? approval?.config.policy) === 'ask'
          const hint = canAsk ? `\n${escalationHintMarker('command')}` : ''
          appendOutput(command, Buffer.from(`\n${sandboxDenialMarker(confinedMode)}${hint}\n`), maximumBytes, false)
        }
      }).finally(() => { command.finished = true })
      commands.set(id, command)
      const startedAt = performance.now()
      await waitForCommand(command, waitMs)
      if (command.failure !== undefined) throw command.failure
      exec.signal.throwIfAborted()
      return takeResult(command, policies, startedAt, () => commands.delete(id))
    }),
  }))

  ctx.codexyTools.register(defineTool({
    name: 'write_stdin',
    description: 'Writes characters to an existing unified exec session and returns recent output.',
    isConcurrencySafe: () => true,
    closedParameters: true,
    parameters: {
      chars: { type: 'string', description: 'Bytes to write to stdin. Defaults to empty, which polls without writing.' },
      max_output_tokens: { type: 'number', description: 'Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.' },
      session_id: { type: 'number', required: true, description: 'Identifier of the running unified exec session.' },
      yield_time_ms: { type: 'number', description: 'Wait before yielding output. Non-empty writes default to 250 ms and cap at 30000 ms; empty polls wait 5000-300000 ms by default.' },
    },
    output: {
      schema: COMMAND_RESULT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.text }],
      codeModeResult: (_args, value) => value.program,
    },
    presentCall: args => ({ card: 'generic', title: `Session ${args.session_id}`, kind: 'execute', rawInput: args.chars ?? '' }),
    finalizeContent: finalizeCommandCancellation,
    execute: normalizeCommandCancellation(async (args: PollArgs, exec) => {
      assertAllowedParameters(args, new Set(['session_id', 'chars', 'yield_time_ms', 'max_output_tokens']), 'write_stdin')
      if (!Number.isSafeInteger(args.session_id) || args.session_id < 1) throw new Error('session_id must be a positive integer')
      const outputTokens = outputLimit(args.max_output_tokens, maximumTokens)
      const policies = resultPolicies(exec, outputTokens, maximumTokens, config.codexOutputPolicy, args.max_output_tokens)
      const duration = args.chars === undefined || args.chars.length === 0
        ? yieldDuration(args.yield_time_ms, 5_000, 300_000, 5_000)
        : yieldDuration(args.yield_time_ms, 250, 30_000, 250)
      const command = commands.get(args.session_id)
      if (command === undefined || command.owner !== exec.agent) throw new Error(`Unknown exec session ID ${args.session_id}`)
      return serializeCommand(command, async () => {
        if (commands.get(args.session_id) !== command) throw new Error(`Unknown exec session ID ${args.session_id}`)
        const startedAt = performance.now()
        if (args.chars !== undefined && args.chars.length > 0) {
          requireRunningCommand(command, args.session_id)
          if (command.tty) await approveTerminalInput(command, args.chars, exec)
          exec.signal.throwIfAborted()
          if (commands.get(args.session_id) !== command) throw new Error(`Unknown exec session ID ${args.session_id}`)
          requireRunningCommand(command, args.session_id)
          await command.write(args.chars)
        }
        await waitForCommand(command, duration)
        if (command.failure !== undefined) throw command.failure
        exec.signal.throwIfAborted()
        return takeResult(command, policies, startedAt, () => commands.delete(args.session_id))
      })
    }),
  }))
}
