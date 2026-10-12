import { snapshotProductEvents, projectProductEvent, appendProductEvent } from '@codexydsh/runtime/session'
import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@codexydsh/runtime/llm'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { SystemPrompt } from '@codexydsh/test-support/host-tools'
import { ToolRuntime } from '@codexydsh/test-support/host-tools'
import LocalSubprocessRuntime from '@codexydsh/processes'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import LocalFileSystem from '@codexydsh/filesystem-local'
import SandboxedFileSystem from '@codexydsh/filesystem-sandbox'
import * as ToolFs from '@codexydsh/files'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import { SandboxProvider, escalationHintMarker, sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import ApprovalService, { setApprovalPolicy } from '@codexydsh/approval'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'
import * as ToolBash from '@codexydsh/exec'

async function setup(config: { codexOutputBufferBytes?: number; codexMaxOutputTokens?: number; codexOutputPolicy?: 'fixed-tokens' | 'codexful-model' } = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(BashEnvPlugin)
  await ctx.plugin(LocalBashExecutor, {})
  const fiber = await ctx.plugin(ToolBash, { toolFormat: 'codex', ...config })
  return { ctx, fiber }
}

async function setupPatch() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-codex-exec-patch-'))
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(BashEnvPlugin)
  await ctx.plugin(LocalBashExecutor, {})
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(ToolFs, { applyPatch: true, applyPatchOnly: true })
  await ctx.plugin(ToolBash, { toolFormat: 'codex' })
  return { root, ctx }
}

class ConfiningBashExecutor extends LocalBashExecutor {
  override get sandboxMode() { return 'read-only' as const }
}

class DenyingSandbox extends SandboxProvider {
  async confine(_argv: readonly string[], _policy: SandboxPolicy): Promise<ConfinedArgv> {
    return {
      argv: [process.execPath, '-e', "process.stderr.write('Permission denied');process.exit(1)"],
      enforcement: 'full',
      denialSignatures: ['Permission denied'],
      runnerFailureRules: [],
    }
  }
}

async function setupSandbox() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(BashEnvPlugin)
  await ctx.plugin(SandboxPolicyService, { mode: 'read-only' })
  await ctx.plugin(DenyingSandbox)
  await ctx.plugin(ConfiningBashExecutor, {})
  const fiber = await ctx.plugin(ToolBash, { toolFormat: 'codex' })
  return { ctx, fiber }
}

const askApprovalPolicy = { config: { policy: 'ask' as const }, overrideOf: () => undefined }

let nextCall = 1
async function call(ctx: Context, name: string, args: object, agent?: Agent): Promise<string> {
  const result = await ctx.codexyTools.execute({
    name, arguments: args, callId: ToolCallId(`codex-exec-${nextCall++}`), signal: new AbortController().signal,
    ...agent === undefined ? {} : { agent },
  })
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

async function readyPty(ctx: Context, agent: Agent, args: object): Promise<number> {
  let output = await call(ctx, 'exec_command', { ...args, tty: true, yield_time_ms: 250 }, agent)
  const id = Number(output.match(/Process running with session ID (\d+)/)?.[1])
  expect(Number.isSafeInteger(id)).toBe(true)
  for (let poll = 0; poll < 3 && !output.includes('READY'); poll += 1) {
    output = await call(ctx, 'write_stdin', { session_id: id, chars: '' }, agent)
  }
  expect(output).toContain('READY')
  return id
}

describe('Codex command tool format', () => {
  it('intercepts a complete apply_patch heredoc with workdir and optional cd', async () => {
    const { root, ctx } = await setupPatch()
    try {
      await mkdir(join(root, 'nested'))
      const direct = await call(ctx, 'exec_command', {
        cmd: "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: first.txt\n+one\n*** End Patch\nPATCH",
        workdir: root, login: false,
      })
      expect(direct).toBe('Wall time: 0.0000 seconds\nOutput:\nSuccess. Updated the following files:\nA first.txt\n')
      expect(await readFile(join(root, 'first.txt'), 'utf8')).toBe('one\n')

      const nested = await call(ctx, 'exec_command', {
        cmd: "cd nested && applypatch <<'PATCH'\n*** Begin Patch\n*** Add File: second.txt\n+two\n*** End Patch\nPATCH",
        workdir: root, login: false,
      })
      expect(nested).toBe('Wall time: 0.0000 seconds\nOutput:\nSuccess. Updated the following files:\nA second.txt\n')
      expect(await readFile(join(root, 'nested', 'second.txt'), 'utf8')).toBe('two\n')

      const unquoted = await call(ctx, 'exec_command', {
        cmd: 'apply_patch <<PATCH\n*** Begin Patch\n*** Add File: literal.txt\n+$NOT_EXPANDED\n*** End Patch\nPATCH',
        workdir: root, login: false,
      })
      expect(unquoted).toContain('A literal.txt')
      expect(await readFile(join(root, 'literal.txt'), 'utf8')).toBe('$NOT_EXPANDED\n')
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns a failed intercepted patch as the exec_command tool result', async () => {
    const { root, ctx } = await setupPatch()
    try {
      const failed = await call(ctx, 'exec_command', {
        cmd: "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: invalid.txt\n+never written\nPATCH",
        workdir: root, login: false,
      })
      expect(failed).toContain('Error: Invalid patch: expected *** Begin Patch and *** End Patch')
      expect(failed).not.toContain('Chunk ID:')
      await expect(readFile(join(root, 'invalid.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      const normal = await call(ctx, 'exec_command', { cmd: 'printf ordinary', workdir: root, login: false })
      expect(normal).toContain('Chunk ID:')
      expect(normal).toContain('Output:\nordinary')
      const mixed = await call(ctx, 'exec_command', {
        cmd: "printf mixed; apply_patch <<'PATCH'\n*** Begin Patch\n*** End Patch\nPATCH",
        workdir: root, login: false,
      })
      expect(mixed).toContain('Chunk ID:')
      expect(mixed).toContain('mixed')
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses file sandbox policy for an intercepted patch without spawning the shell', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-codex-exec-patch-policy-'))
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(BashEnvPlugin)
      await ctx.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: root })
      await ctx.plugin(DenyingSandbox)
      await ctx.plugin(ConfiningBashExecutor, {})
      await ctx.plugin(SandboxedFileSystem, { cwd: root })
      await ctx.plugin(ToolFs, { applyPatch: true, applyPatchOnly: true })
      await ctx.plugin(ToolBash, { toolFormat: 'codex' })
      const session = Session.create(SessionId('codex-intercepted-patch-policy'))
      const agent = { session } as Agent
      const args = {
        cmd: "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: policy.txt\n+approved mode\n*** End Patch\nPATCH",
        workdir: root, login: false,
      }
      const denied = await call(ctx, 'exec_command', args, agent)
      expect(denied).toContain(sandboxDenialMarker('read-only'))
      expect(denied).not.toContain('Chunk ID:')
      await expect(readFile(join(root, 'policy.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

      setSandboxMode(session, 'workspace-write')
      const allowed = await call(ctx, 'exec_command', args, agent)
      expect(allowed).toContain('Wall time: 0.0000 seconds\nOutput:\nSuccess.')
      expect(await readFile(join(root, 'policy.txt'), 'utf8')).toBe('approved mode\n')
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
  it('classifies both tools as parallel and serializes polls of one session', async () => {
    const { ctx, fiber } = await setup()
    for (const [name, args] of [
      ['exec_command', { cmd: 'printf ready' }],
      ['write_stdin', { session_id: 1 }],
    ] as const) {
      expect(ctx.codexyTools.executionMode({
        name, arguments: args, callId: ToolCallId(`mode-${name}`), signal: new AbortController().signal,
      })).toEqual({ kind: 'parallel' })
    }
    const [left, right] = await Promise.all([
      call(ctx, 'exec_command', { cmd: 'node -e "process.stdout.write(\'left\')"', login: false }),
      call(ctx, 'exec_command', { cmd: 'node -e "process.stdout.write(\'right\')"', login: false }),
    ])
    expect(left).toContain('Output:\nleft')
    expect(right).toContain('Output:\nright')

    const first = await call(ctx, 'exec_command', {
      cmd: 'node -e "let n=0;process.stdin.on(\'data\',b=>{process.stdout.write(String(b));if(++n===2)process.exit(0)})"',
      login: false, tty: true, yield_time_ms: 250,
    })
    const id = Number(first.match(/Process running with session ID (\d+)/)?.[1])
    expect(Number.isSafeInteger(id)).toBe(true)
    const [one, two] = await Promise.all([
      call(ctx, 'write_stdin', { session_id: id, chars: 'one\n', yield_time_ms: 250 }),
      call(ctx, 'write_stdin', { session_id: id, chars: 'two\n', yield_time_ms: 250 }),
    ])
    expect(one).toContain('one')
    expect(one).not.toContain('two')
    expect(two).toContain('two')
    expect(two).toContain('Process exited with code 0')
    await fiber.dispose()
  })

  it('registers two Codex tools and reports a completed command in the model-visible format', async () => {
    const { ctx, fiber } = await setup()
    expect(ctx.codexyTools.schemas().map(tool => tool.name)).toEqual(['exec_command', 'write_stdin'])
    const execSchema = ctx.codexyTools.schemas().find(tool => tool.name === 'exec_command')
    const stdinSchema = ctx.codexyTools.schemas().find(tool => tool.name === 'write_stdin')
    if (execSchema === undefined || execSchema.kind === 'freeform') throw new Error('exec_command must have a function schema')
    if (stdinSchema === undefined || stdinSchema.kind === 'freeform') throw new Error('write_stdin must have a function schema')
    expect(execSchema?.parameters.additionalProperties).toBe(false)
    expect(stdinSchema?.parameters.additionalProperties).toBe(false)
    expect(Object.keys(execSchema?.parameters.properties ?? {})).toEqual([
      'cmd', 'login', 'max_output_tokens', 'shell', 'tty', 'workdir', 'yield_time_ms',
    ])
    expect(Object.keys(stdinSchema?.parameters.properties ?? {})).toEqual([
      'chars', 'max_output_tokens', 'session_id', 'yield_time_ms',
    ])
    const result = await call(ctx, 'exec_command', { cmd: 'node -e "process.stdout.write(\'hello\')"', login: false })
    expect(result).toContain('Process exited with code 0')
    expect(result).toContain('Output:\nhello')
    expect(result).not.toContain('Warning: truncated output')
    await fiber.dispose()
    expect(ctx.codexyTools.schemas()).toEqual([])
  })

  it('returns nonzero exits to the model and rejects unsupported parameters', async () => {
    const { ctx, fiber } = await setup()
    const failed = await call(ctx, 'exec_command', {
      cmd: 'node -e "process.stderr.write(\'bad command\');process.exit(7)"', login: false,
    })
    expect(failed).toContain('Process exited with code 7')
    expect(failed).toContain('bad command')
    expect(failed).not.toContain(sandboxDenialMarker('read-only'))
    expect(await call(ctx, 'exec_command', { cmd: 'printf unreachable', prefix_rule: ['printf'] }))
      .toContain('"prefix_rule" is not a declared property (additionalProperties: false)')
    await fiber.dispose()
  })

  it.skipIf(process.platform === 'win32')('omits an exit-status line when a command ends by signal', async () => {
    const { ctx, fiber } = await setup()
    try {
      const result = await call(ctx, 'exec_command', {
        cmd: 'kill -TERM $$', shell: '/bin/sh', login: false,
      })
      expect(result).toContain('Original token count: 0\nOutput:')
      expect(result).not.toContain('Process exited with')
      expect(result).not.toContain('Process running with session ID')
    } finally {
      await fiber.dispose()
    }
  })

  it('continues a running command through write_stdin and closes its session on exit', async () => {
    const { ctx, fiber } = await setup()
    const first = await call(ctx, 'exec_command', {
      cmd: 'node -e "process.stdin.once(\'data\', b => {process.stdout.write(String(b));process.exit(0)})"',
      login: false,
      tty: true,
      yield_time_ms: 250,
    })
    const id = Number(first.match(/Process running with session ID (\d+)/)?.[1])
    expect(Number.isSafeInteger(id)).toBe(true)
    const second = await call(ctx, 'write_stdin', { session_id: id, chars: 'from stdin\n', yield_time_ms: 250 })
    expect(second).toContain('Process exited with code 0')
    expect(second).toContain('from stdin')
    expect(await call(ctx, 'write_stdin', { session_id: id })).toContain(`Unknown exec session ID ${id}`)
    await fiber.dispose()
  })

  it('rejects text for a non-PTY session and delivers Ctrl-C as an interrupt', async () => {
    const { ctx, fiber } = await setup()
    const first = await call(ctx, 'exec_command', {
      cmd: 'node -e "process.on(\'SIGINT\',()=>{process.stdout.write(\'interrupted\');process.exit(0)});process.stdout.write(\'ready\\n\');setInterval(()=>{},1000)"',
      login: false, yield_time_ms: 1_000,
    })
    const id = Number(first.match(/Process running with session ID (\d+)/)?.[1])
    expect(first).toContain('ready')
    expect(Number.isSafeInteger(id)).toBe(true)
    expect(await call(ctx, 'write_stdin', { session_id: id, chars: 'ordinary input' }))
      .toContain('only Ctrl-C can interrupt')
    const stopped = await call(ctx, 'write_stdin', { session_id: id, chars: '\u0003', yield_time_ms: 1_000 })
    expect(stopped).toContain('interrupted')
    expect(stopped).toContain('Process exited with code 0')
    await fiber.dispose()
  })

  it('keeps the head and tail of output under a small requested budget', async () => {
    const { ctx, fiber } = await setup()
    const result = await call(ctx, 'exec_command', {
      cmd: 'node -e "process.stdout.write(\'HEAD\' + \'.\'.repeat(400) + \'TAIL\')"',
      login: false,
      max_output_tokens: 20,
    })
    expect(result).toContain('Warning: truncated output')
    expect(result).toContain('Total output lines: 1')
    expect(result).toMatch(/…\d+ tokens truncated…/)
    expect(result).toContain('HEAD')
    expect(result).toContain('TAIL')
    await fiber.dispose()
  })

  it('uses the current request model for Codexful byte and token output policies', async () => {
    const { ctx, fiber } = await setup({ codexMaxOutputTokens: 10_000, codexOutputPolicy: 'codexful-model' })
    const session = Session.create(SessionId('codex-output-model-route'))
    const agent = { session } as Agent
    const cmd = "node -e \"process.stdout.write('HEAD' + 'x'.repeat(20000) + 'TAIL')\""
    try {
      session.append('request/header', { reason: 'initial', header: { config: { provider: 'test', model: 'deepseek-v4-flash' } } })
      const fallback = await call(ctx, 'exec_command', { cmd, login: false }, agent)
      expect(fallback).toContain('Warning: truncated output (original token count: 5002)')
      expect(fallback).toContain('…10008 chars truncated…')
      expect(fallback).toContain('HEAD')
      expect(fallback).toContain('TAIL')
      expect(Buffer.byteLength(fallback)).toBeLessThanOrEqual(12_000)

      const requested = await call(ctx, 'exec_command', { cmd, login: false, max_output_tokens: 1_000 }, agent)
      expect(requested).toMatch(/…\d+ tokens truncated…/)
      expect(requested).not.toContain('chars truncated')

      session.append('request/header', { reason: 'change', header: { config: { provider: 'test', model: 'gpt-6-sol' } } })
      const known = await call(ctx, 'exec_command', { cmd, login: false }, agent)
      expect(known).toContain(`Output:\nHEAD${'x'.repeat(20000)}TAIL`)
      expect(known).not.toContain('Warning: truncated output')

      const waiting = await call(ctx, 'exec_command', {
        cmd: 'node -e "process.stdout.write(\'READY\');process.stdin.once(\'data\',()=>{process.stdout.write(\'HEAD\'+\'x\'.repeat(20000)+\'TAIL\');process.exit(0)})"',
        login: false, tty: true, yield_time_ms: 250,
      }, agent)
      const sessionId = Number(waiting.match(/Process running with session ID (\d+)/)?.[1])
      expect(Number.isSafeInteger(sessionId)).toBe(true)
      session.append('request/header', { reason: 'change', header: { config: { provider: 'test', model: 'deepseek-v4-flash' } } })
      const polled = await call(ctx, 'write_stdin', { session_id: sessionId, chars: 'go\n', yield_time_ms: 30_000 }, agent)
      expect(polled).toMatch(/…\d+ chars truncated…/)
      expect(polled).toContain('HEAD')
      expect(polled).toContain('TAIL')
    } finally {
      await fiber.dispose()
    }
  })

  it('counts decoded bytes in a Codexful truncation warning', async () => {
    const { ctx, fiber } = await setup({ codexOutputPolicy: 'codexful-model' })
    const session = Session.create(SessionId('codex-output-invalid-utf8'))
    session.append('request/header', { reason: 'initial', header: { config: { provider: 'test', model: 'deepseek-v4-flash' } } })
    try {
      const result = await call(ctx, 'exec_command', {
        cmd: 'node -e "process.stdout.write(Buffer.from([255,255]))"', login: false, max_output_tokens: 1,
      }, { session } as Agent)
      expect(result).toContain('Original token count: 1\nOutput:')
      expect(result).toContain('Warning: truncated output (original token count: 2)')
    } finally {
      await fiber.dispose()
    }
  })

  it('requires a request header when Codexful output policy is enabled', async () => {
    const { ctx, fiber } = await setup({ codexOutputPolicy: 'codexful-model' })
    try {
      const result = await call(ctx, 'exec_command', { cmd: 'printf unreachable', login: false }, {
        session: Session.create(SessionId('codex-output-missing-header')),
      } as Agent)
      expect(result).toContain('Codexful command output requires the current Session request/header model')
    } finally {
      await fiber.dispose()
    }
  })

  it('retains the beginning and end when collection drops the middle', async () => {
    const { ctx, fiber } = await setup({ codexOutputBufferBytes: 80 })
    const result = await call(ctx, 'exec_command', {
      cmd: 'node -e "process.stdout.write(\'HEAD\' + \'.\'.repeat(400) + \'TAIL\')"', login: false,
      max_output_tokens: 100,
    })
    expect(result).toContain('HEAD')
    expect(result).toContain('TAIL')
    expect(result).toMatch(/\.\.\. \d+ bytes omitted \.\.\./)
    expect(result).toContain('Original token count: 102')
    await fiber.dispose()
  })

  it('counts raw output bytes before decoding invalid UTF-8', async () => {
    const { ctx, fiber } = await setup()
    const result = await call(ctx, 'exec_command', {
      cmd: 'node -e "process.stdout.write(Buffer.from([0xff, 0x80, 0x41]))"', login: false,
    })
    expect(result).toContain('Original token count: 1\nOutput:\n��A')
    await fiber.dispose()
  })

  it('preserves UTF-8 boundaries and caps the complete response at the model allowance', async () => {
    const { ctx, fiber } = await setup({ codexMaxOutputTokens: 70 })
    const result = await call(ctx, 'exec_command', {
      cmd: 'node -e "process.stdout.write(\'x\'.repeat(39) + \'🙂\' + \'y\'.repeat(400) + \'🙂TAIL\')"',
      login: false,
      max_output_tokens: 70,
    })
    expect(result).toContain('TAIL')
    expect(result).not.toContain('�')
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(Math.floor(70 * 4 * 1.2))
    await fiber.dispose()
  })

  it('allocates a terminal when tty is requested', async () => {
    const { ctx, fiber } = await setup()
    const result = await call(ctx, 'exec_command', {
      cmd: 'node -e "process.stdout.write(\'pty output\')"', login: false, tty: true,
    })
    expect(result).toContain('Process exited with code 0')
    expect(result).toContain('pty output')
    await fiber.dispose()
  })

  it('distinguishes a sandbox denial from a command error and requires approval for escalation', async () => {
    const { ctx, fiber } = await setupSandbox()
    const denied = await call(ctx, 'exec_command', { cmd: 'printf unreachable', login: false })
    expect(denied).toContain(sandboxDenialMarker('read-only'))
    expect(denied).toContain('Process exited with code 1')
    const noApproval = await call(ctx, 'exec_command', {
      cmd: 'printf unreachable', login: false,
      sandbox_permissions: 'require_escalated', justification: 'Need to write outside this workspace',
    })
    expect(noApproval).toContain('requires approval')
    await fiber.dispose()
  })

  it('suggests escalation after a denial only when the Session can request approval', async () => {
    const { ctx, fiber } = await setupSandbox()
    const approvalFiber = await ctx.plugin(ApprovalService, { policy: 'ask' })
    const agent = { session: Session.create(SessionId('codex-denial-hint')) } as Agent
    try {
      const ask = await call(ctx, 'exec_command', { cmd: 'printf denied', login: false }, agent)
      expect(ask).toContain(sandboxDenialMarker('read-only'))
      expect(ask).toContain(escalationHintMarker('command'))
      await approvalFiber.dispose()
      await ctx.plugin(ApprovalService, { policy: 'never' })
      const never = await call(ctx, 'exec_command', { cmd: 'printf denied', login: false }, agent)
      expect(never).toContain(sandboxDenialMarker('read-only'))
      expect(never).not.toContain(escalationHintMarker('command'))
    } finally {
      await fiber.dispose()
    }
  })

  it('does not launch a command when Session permissions change during sandbox preparation', async () => {
    const { ctx, fiber } = await setupSandbox()
    const session = Session.create(SessionId('codex-confine-policy-switch'))
    setSandboxMode(session, 'workspace-write')
    const agent = { session } as Agent
    let enteredConfine: () => void = () => {}
    let releaseConfine: () => void = () => {}
    const entered = new Promise<void>((resolve) => { enteredConfine = resolve })
    const paused = new Promise<void>((resolve) => { releaseConfine = resolve })
    const originalConfine = ctx.sandbox.confine.bind(ctx.sandbox)
    const confine = vi.spyOn(ctx.sandbox, 'confine').mockImplementation(async (argv, policy, signal) => {
      enteredConfine()
      await paused
      return originalConfine(argv, policy, signal)
    })
    const spawn = vi.spyOn(ctx.subprocess, 'spawn')
    const spawnTerminal = vi.spyOn(ctx.subprocess, 'spawnTerminal')
    let pending: Promise<string> | undefined
    try {
      pending = call(ctx, 'exec_command', { cmd: 'printf should-not-run', login: false }, agent)
      await entered
      expect(confine.mock.calls[0]?.[1].mode).toBe('workspace-write')
      setSandboxMode(session, 'read-only')
      releaseConfine()
      expect(await pending).toContain('Session file permissions changed during exec_command preparation')
      expect(spawn).not.toHaveBeenCalled()
      expect(spawnTerminal).not.toHaveBeenCalled()
    } finally {
      releaseConfine()
      await pending
      confine.mockRestore()
      spawn.mockRestore()
      spawnTerminal.mockRestore()
      await fiber.dispose()
    }
  })

  it('does not launch a command when Session approval policy changes during sandbox preparation', async () => {
    const { ctx, fiber } = await setupSandbox()
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    const session = Session.create(SessionId('codex-confine-approval-switch'))
    setSandboxMode(session, 'workspace-write')
    const agent = { session } as Agent
    let enteredConfine: () => void = () => {}
    let releaseConfine: () => void = () => {}
    const entered = new Promise<void>((resolve) => { enteredConfine = resolve })
    const paused = new Promise<void>((resolve) => { releaseConfine = resolve })
    const originalConfine = ctx.sandbox.confine.bind(ctx.sandbox)
    const confine = vi.spyOn(ctx.sandbox, 'confine').mockImplementation(async (argv, policy, signal) => {
      enteredConfine()
      await paused
      return originalConfine(argv, policy, signal)
    })
    const spawn = vi.spyOn(ctx.subprocess, 'spawn')
    let pending: Promise<string> | undefined
    try {
      pending = call(ctx, 'exec_command', { cmd: 'printf should-not-run', login: false }, agent)
      await entered
      setApprovalPolicy(session, 'never')
      releaseConfine()
      expect(await pending).toContain('Session approval policy changed during exec_command preparation')
      expect(spawn).not.toHaveBeenCalled()
    } finally {
      releaseConfine()
      await pending
      confine.mockRestore()
      spawn.mockRestore()
      await fiber.dispose()
    }
  })

  it('rejects an explicit override before spawning under full access and never approval', async () => {
    const { ctx, fiber } = await setupSandbox()
    await ctx.plugin(ApprovalService, { policy: 'never' })
    const session = Session.create(SessionId('codex-full-access-never'))
    setSandboxMode(session, 'danger-full-access')
    const agent = { session } as Agent
    const spawn = vi.spyOn(ctx.subprocess, 'spawn')
    const spawnTerminal = vi.spyOn(ctx.subprocess, 'spawnTerminal')
    try {
      const denied = await call(ctx, 'exec_command', {
        cmd: 'printf should-not-run', login: false,
        sandbox_permissions: 'require_escalated', justification: 'Request full access',
      }, agent)
      expect(denied).toContain('approval policy is Never; reject command')
      expect(spawn).not.toHaveBeenCalled()
      expect(spawnTerminal).not.toHaveBeenCalled()
      spawn.mockRestore()
      spawnTerminal.mockRestore()
      const allowed = await call(ctx, 'exec_command', {
        cmd: 'printf allowed', login: false, sandbox_permissions: 'use_default',
      }, agent)
      expect(allowed).toContain('Process exited with code 0')
      expect(allowed).toContain('Output:\nallowed')
    } finally {
      spawn.mockRestore()
      spawnTerminal.mockRestore()
      await fiber.dispose()
    }
  })

  it('offers a visible prefix grant and reuses it only for literal matching commands in this permission context', async () => {
    const { ctx, fiber } = await setupSandbox()
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    const parameters = ctx.codexyTools.schemas().find(tool => tool.name === 'exec_command')?.parameters
    expect(Object.keys(parameters?.properties ?? {})).toEqual([
      'cmd', 'justification', 'login', 'max_output_tokens', 'prefix_rule',
      'sandbox_permissions', 'shell', 'tty', 'workdir', 'yield_time_ms',
    ])
    expect(parameters).toMatchObject({ properties: {
      prefix_rule: { type: 'array', items: { type: 'string' } },
      sandbox_permissions: {
        type: 'string', enum: ['use_default', 'require_escalated'],
        description: 'Per-command sandbox override. Defaults to `use_default`; use `require_escalated` for unsandboxed execution.',
      },
    } })
    const session = Session.create(SessionId('codex-prefix-grant'))
    session.append('turn/start', { turn: 1 })
    const agent = { session } as Agent
    const answer = vi.fn(async (req: { prefixRule?: readonly string[] }) =>
      req.prefixRule === undefined ? 'allowed-once' as const : 'allow-prefix-for-session' as const)
    ctx.on('codexy-approval/request', answer)
    try {
      const first = await call(ctx, 'exec_command', {
        cmd: 'echo prefix first', login: false,
        sandbox_permissions: 'require_escalated', justification: 'Test a reusable command prefix',
        prefix_rule: ['echo', 'prefix'],
      }, agent)
      expect(first).toContain('Output:\nprefix first')
      expect(answer).toHaveBeenCalledTimes(1)
      expect(answer.mock.calls[0]?.[0]?.prefixRule).toEqual(['echo', 'prefix'])
      const asked = snapshotProductEvents(session).find(event => event.type === 'approval/asked')
      expect(asked?.type === 'approval/asked' ? asked.data.reason : undefined)
        .toContain('future literal commands beginning with ["echo","prefix"] run outside the file sandbox')
      const granted = snapshotProductEvents(session).find(event => event.type === 'approval/decided' && event.data.sessionGrantKey !== undefined)
      expect(granted?.type === 'approval/decided' ? granted.data.sessionGrantKey : undefined)
        .toMatch(/^codex-exec-prefix:v1:/)
      if (granted?.type !== 'approval/decided' || granted.data.sessionGrantKey === undefined) {
        throw new Error('exec_command did not persist the approved prefix')
      }
      const visiblePrefixes = (owner = agent) => ctx.waterfall('codexful/active-prefixes', { agent: owner }, () => Promise.resolve([]))
      expect(await visiblePrefixes()).toEqual([])

      const reused = await call(ctx, 'exec_command', { cmd: 'echo prefix second', login: false }, agent)
      expect(reused).toContain('Output:\nprefix second')
      expect(answer).toHaveBeenCalledTimes(1)
      const different = await call(ctx, 'exec_command', { cmd: 'echo other', login: false }, agent)
      expect(different).toContain(sandboxDenialMarker('read-only'))
      expect(await call(ctx, 'exec_command', { cmd: 'echo prefix second', login: false, workdir: '/tmp' }, agent))
        .toContain(sandboxDenialMarker('read-only'))
      expect(await call(ctx, 'exec_command', { cmd: 'echo prefix second', login: true }, agent))
        .toContain(sandboxDenialMarker('read-only'))
      const otherAgent = { session: Session.create(SessionId('codex-prefix-other-session')) } as Agent
      expect(await call(ctx, 'exec_command', { cmd: 'echo prefix second', login: false }, otherAgent))
        .toContain(sandboxDenialMarker('read-only'))

      expect(await call(ctx, 'exec_command', {
        cmd: 'echo prefix default', sandbox_permissions: 'require_escalated',
        justification: 'Save the default command context', prefix_rule: ['echo', 'prefix'],
      }, agent)).toContain('Output:\nprefix default')
      expect(await visiblePrefixes()).toEqual([['echo', 'prefix']])
      const removeDynamicEnv = ctx.shellEnv.register({
        name: 'test-dynamic-context', variables: { DSH_DYNAMIC: { description: 'Dynamic call context.' } },
        resolve: () => ({ DSH_DYNAMIC: 'test' }),
      })
      expect(await visiblePrefixes()).toEqual([])
      removeDynamicEnv()
      expect(await visiblePrefixes()).toEqual([['echo', 'prefix']])
      const restoredSession = Session.fromRestore(session.id, structuredClone(session.snapshotEvents()),
        session.header, SessionLogOffset(0), 'detached')
      const restoredAgent = { session: restoredSession } as Agent
      expect(ctx.codexyApproval.hasGrant(restoredAgent, 'exec_command', granted.data.sessionGrantKey)).toBe(true)
      expect(await visiblePrefixes(restoredAgent)).toEqual([['echo', 'prefix']])

      setSandboxMode(session, 'workspace-write')
      expect(await visiblePrefixes()).toEqual([])
      const afterSwitch = await call(ctx, 'exec_command', { cmd: 'echo prefix third', login: false }, agent)
      expect(afterSwitch).toContain(sandboxDenialMarker('workspace-write'))
      expect(answer).toHaveBeenCalledTimes(2)
    } finally {
      await fiber.dispose()
    }
  })

  it('rejects prefix reuse for commands that can hide a second shell action', async () => {
    const { ctx, fiber } = await setupSandbox()
    try {
      const base = { login: false, sandbox_permissions: 'require_escalated', justification: 'Run a command' }
      for (const cmd of ['echo prefix; echo hidden', 'echo prefix $(echo hidden)', 'echo prefix && echo hidden', 'echo\u00a0prefix hidden']) {
        expect(await call(ctx, 'exec_command', { ...base, cmd, prefix_rule: ['echo', 'prefix'] }))
          .toContain('prefix_rule requires one literal shell command')
      }
      expect(await call(ctx, 'exec_command', { ...base, cmd: 'echo other', prefix_rule: ['echo', 'prefix'] }))
        .toContain('prefix_rule must be a token prefix of cmd')
      expect(await call(ctx, 'exec_command', { ...base, cmd: 'git status', prefix_rule: ['git'] }))
        .toContain('prefix_rule is too broad')
      for (const wrapper of ['command', 'exec', 'time', 'builtin', 'nohup', 'nice', 'timeout', 'xargs', 'npm', 'pnpm', 'yarn']) {
        expect(await call(ctx, 'exec_command', { ...base, cmd: `${wrapper} echo safe`, prefix_rule: [wrapper] }))
          .toContain('prefix_rule is too broad')
      }
      expect(await call(ctx, 'exec_command', { cmd: 'echo prefix', prefix_rule: ['echo', 'prefix'] }))
        .toContain('prefix_rule requires sandbox_permissions')
    } finally {
      await fiber.dispose()
    }
  })

  it.each(['npm', 'pnpm', 'yarn'])('reuses an approved %s run prefix only for its named package script', async (program) => {
    const { ctx, fiber } = await setupSandbox()
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    const session = Session.create(SessionId(`codex-package-prefix-${program}`))
    session.append('turn/start', { turn: 1 })
    const agent = { session } as Agent
    const answer = vi.fn(() => Promise.resolve('allow-prefix-for-session' as const))
    ctx.on('codexy-approval/request', answer)
    const confined = vi.spyOn(ctx.sandbox, 'confine')
    vi.spyOn(ctx.subprocess, 'terminalEnvironment').mockResolvedValue({ platform: 'posix', defaultShell: '/bin/bash' })
    const spawned: SubprocessSpawnSpec[] = []
    vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
      spawned.push(spec)
      return {
        stdin: undefined, stdout: Readable.from([]), stderr: Readable.from([]), control: undefined,
        collected: {}, done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate() {}, async waitForExit() { return true },
      }
    })
    const base = { login: false, sandbox_permissions: 'require_escalated', justification: 'May I run the development script?' }
    try {
      for (const prefix of [[program], [program, 'run'], [program, 'exec', 'node'], [program, 'run', '--help']]) {
        expect(await call(ctx, 'exec_command', { ...base, cmd: prefix.join(' '), prefix_rule: prefix }, agent))
          .toContain('prefix_rule is too broad')
      }
      expect(spawned).toHaveLength(0)
      expect(answer).not.toHaveBeenCalled()

      expect(await call(ctx, 'exec_command', { ...base, cmd: `${program} run dev`, prefix_rule: [program, 'run', 'dev'] }, agent))
        .toContain('Process exited with code 0')
      expect(answer).toHaveBeenCalledTimes(1)
      expect(spawned[0]?.argv).toEqual(['/bin/bash', '-c', `${program} run dev`])
      expect(confined).not.toHaveBeenCalled()
      const granted = snapshotProductEvents(session).find(event => event.type === 'approval/decided')
      expect(granted?.type === 'approval/decided' ? granted.data.prefixRule : undefined).toEqual([program, 'run', 'dev'])

      expect(await call(ctx, 'exec_command', { cmd: `${program} run dev -- --help`, login: false }, agent))
        .toContain('Process exited with code 0')
      expect(answer).toHaveBeenCalledTimes(1)
      expect(spawned[1]?.argv).toEqual(['/bin/bash', '-c', `${program} run dev -- --help`])
      expect(confined).not.toHaveBeenCalled()
      await call(ctx, 'exec_command', { cmd: `${program} run test`, login: false }, agent)
      expect(confined).toHaveBeenCalledTimes(1)
      expect(spawned).toHaveLength(3)
      expect(spawned[2]?.argv[0]).toBe(process.execPath)
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('does not reuse an existing prefix grant for a command wrapper', async () => {
    const { ctx, fiber } = await setupSandbox()
    const agent = { session: Session.create(SessionId('codex-prefix-wrapper')) } as Agent
    ctx.provide('codexyApproval', { ...askApprovalPolicy, hasGrant: () => true } as never)
    try {
      expect(await call(ctx, 'exec_command', { cmd: 'command echo safe', login: false }, agent))
        .toContain(sandboxDenialMarker('read-only'))
    } finally {
      await fiber.dispose()
    }
  })

  it('uses a stable exact-command Session fingerprint and changes it with execution context', async () => {
    const { ctx, fiber } = await setupSandbox()
    const session = Session.create(SessionId('codex-approval-key'))
    const agent = { session } as Agent
    const keys: string[] = []
    const request = vi.fn(async (ask: { sessionGrantKey?: string }) => {
      if (ask.sessionGrantKey !== undefined) keys.push(ask.sessionGrantKey)
      return 'allowed-once' as const
    })
    ctx.provide('codexyApproval', { ...askApprovalPolicy, request, hasGrant: () => false } as never)
    const run = async (args: Record<string, unknown>, owner = agent) => {
      const result = await ctx.codexyTools.execute({
        name: 'exec_command',
        arguments: { cmd: 'printf safe', login: false, sandbox_permissions: 'require_escalated', justification: 'Run benign test command', ...args },
        callId: ToolCallId(`approval-key-${keys.length}`), signal: new AbortController().signal, agent: owner,
      })
      expect(result.content.find(block => block.type === 'text')?.text).toContain('Process exited with code 0')
    }

    await run({})
    await run({})
    expect(keys[0]).toMatch(/^codex-exec:v1:[a-f0-9]{64}$/)
    expect(keys[1]).toBe(keys[0])
    await run({ cmd: 'printf changed' })
    await run({ workdir: '/tmp' })
    await run({ login: true })
    await run({ tty: true })
    await run({}, { session: Session.create(SessionId('other-session')) } as Agent)
    setSandboxMode(session, 'workspace-write')
    await run({})
    expect(new Set(keys).size).toBe(7)
    await fiber.dispose()
  })

  it('reviews each nonempty input to an escalated PTY before delivering it', async () => {
    const { ctx, fiber } = await setupSandbox()
    const agent = { session: Session.create(SessionId('codex-escalated-stdin')) } as Agent
    let allowInput = false
    const request = vi.fn(async (ask: { toolName: string; callId: ToolCallId; reason?: string }) =>
      ask.toolName === 'exec_command' || allowInput ? 'allowed-once' as const : 'rejected' as const)
    ctx.provide('codexyApproval', { ...askApprovalPolicy, request, hasGrant: () => false } as never)
    try {
      const cmd = 'node -e "process.stdin.once(\'data\',b=>{process.stdout.write(\'received:\'+String(b));process.exit(0)});process.stdout.write(\'READY\\n\')"'
      const workdir = process.cwd()
      const id = await readyPty(ctx, agent, {
        cmd, workdir, login: false,
        sandbox_permissions: 'require_escalated', justification: 'Run this interactive test command',
      })
      const denied = await call(ctx, 'write_stdin', { session_id: id, chars: 'blocked\n' }, agent)
      expect(denied).toContain('write_stdin input was rejected')
      expect(request).toHaveBeenCalledTimes(2)
      expect(request.mock.calls[1]?.[0]?.toolName).toBe('write_stdin')
      expect(request.mock.calls[1]?.[0]?.reason).toContain('Input: "blocked\\n"')
      expect(request.mock.calls[1]?.[0]?.reason).toContain(`Original command: ${JSON.stringify(cmd)}`)
      expect(request.mock.calls[1]?.[0]?.reason).toContain(`Launch cwd: ${JSON.stringify(workdir)}`)
      expect(request.mock.calls[1]?.[0]?.reason).toContain(`Original exec call ID: ${JSON.stringify(request.mock.calls[0]?.[0]?.callId)}`)

      expect(await call(ctx, 'write_stdin', { session_id: id, chars: 'bad\0input' }, agent))
        .toContain('write_stdin input contains a NUL byte')
      expect(await call(ctx, 'write_stdin', { session_id: id, chars: 'x'.repeat(8_000) }, agent))
        .toContain('write_stdin input and permission details are too large')
      expect(request).toHaveBeenCalledTimes(2)

      allowInput = true
      const accepted = await call(ctx, 'write_stdin', { session_id: id, chars: 'allowed\n', yield_time_ms: 1_000 }, agent)
      expect(accepted).toContain('received:allowed')
      expect(accepted).not.toContain('received:blocked')
      expect(request).toHaveBeenCalledTimes(3)
    } finally {
      await fiber.dispose()
    }
  })

  it('rejects drifted PTY input through the Session approval policy when prompts are disabled', async () => {
    const { ctx, fiber } = await setupSandbox()
    await ctx.plugin(ApprovalService, { policy: 'never' })
    const session = Session.create(SessionId('codex-never-stdin'))
    session.append('turn/start', { turn: 1 })
    setSandboxMode(session, 'danger-full-access')
    const agent = { session } as Agent
    const answerer = vi.fn(async () => 'allowed-once' as const)
    ctx.on('codexy-approval/request', answerer)
    try {
      const id = await readyPty(ctx, agent, {
        cmd: 'node -e "process.stdin.once(\'data\',b=>{process.stdout.write(\'received:\'+String(b));process.exit(0)});process.stdout.write(\'READY\\n\')"',
        login: false,
      })
      setSandboxMode(session, 'read-only')
      const denied = await call(ctx, 'write_stdin', { session_id: id, chars: 'blocked\n' }, agent)
      expect(denied).toContain('write_stdin input was rejected')
      expect(answerer).not.toHaveBeenCalled()
      expect(snapshotProductEvents(session).filter(event => event.type === 'approval/asked')).toHaveLength(1)
      expect(snapshotProductEvents(session).filter(event => event.type === 'approval/decided')).toHaveLength(1)
    } finally {
      await fiber.dispose()
    }
  })

  it('reviews PTY input after a Session policy switch and rejects an approval made under stale policy', async () => {
    const { ctx, fiber } = await setupSandbox()
    const session = Session.create(SessionId('codex-drifted-stdin'))
    const agent = { session } as Agent
    setSandboxMode(session, 'danger-full-access')
    let changeDuringReview = true
    const request = vi.fn(async () => {
      if (changeDuringReview) {
        setSandboxMode(session, 'workspace-write')
        changeDuringReview = false
      }
      return 'allowed-once' as const
    })
    ctx.provide('codexyApproval', { ...askApprovalPolicy, request, hasGrant: () => false } as never)
    try {
      const id = await readyPty(ctx, agent, {
        cmd: 'node -e "process.stdin.once(\'data\',b=>{process.stdout.write(\'received:\'+String(b));process.exit(0)});process.stdout.write(\'READY\\n\')"',
        login: false,
      })
      setSandboxMode(session, 'read-only')

      const stale = await call(ctx, 'write_stdin', { session_id: id, chars: 'retry\n' }, agent)
      expect(stale).toContain('Session file permissions changed during write_stdin approval')
      expect(request).toHaveBeenCalledTimes(1)
      const accepted = await call(ctx, 'write_stdin', { session_id: id, chars: 'retry\n', yield_time_ms: 1_000 }, agent)
      expect(accepted).toContain('received:retry')
      expect(accepted.match(/received:retry/g)).toHaveLength(1)
      expect(request).toHaveBeenCalledTimes(2)
    } finally {
      await fiber.dispose()
    }
  })

  it.skipIf(process.platform === 'win32')('reviews PTY Ctrl-C after a permission switch', async () => {
    const { ctx, fiber } = await setupSandbox()
    const session = Session.create(SessionId('codex-stdin-interrupt'))
    const agent = { session } as Agent
    setSandboxMode(session, 'danger-full-access')
    let allowInput = false
    const request = vi.fn(async () => allowInput ? 'allowed-once' as const : 'rejected' as const)
    ctx.provide('codexyApproval', { ...askApprovalPolicy, request, hasGrant: () => false } as never)
    try {
      const id = await readyPty(ctx, agent, {
        cmd: 'node -e "process.on(\'SIGINT\',()=>{process.stdout.write(\'interrupted\');process.exit(0)});process.stdout.write(\'READY\\n\');setInterval(()=>{},1000)"',
        login: false,
      })
      setSandboxMode(session, 'read-only')
      const denied = await call(ctx, 'write_stdin', { session_id: id, chars: '\u0003' }, agent)
      expect(denied).toContain('write_stdin input was rejected')
      expect(denied).not.toContain('interrupted')
      expect(request).toHaveBeenCalledTimes(1)
      allowInput = true
      const stopped = await call(ctx, 'write_stdin', { session_id: id, chars: '\u0003', yield_time_ms: 1_000 }, agent)
      expect(stopped).toContain('interrupted')
      expect(request).toHaveBeenCalledTimes(2)
    } finally {
      await fiber.dispose()
    }
  })

  it('does not send approved PTY input after its owning agent is disposed', async () => {
    const { ctx, fiber } = await setupSandbox()
    const session = Session.create(SessionId('codex-stdin-disposed-during-review'))
    const agent = { session } as Agent
    setSandboxMode(session, 'danger-full-access')
    const prompted = Promise.withResolvers<undefined>()
    const grant = Promise.withResolvers<'allowed-once'>()
    const request = vi.fn(async () => {
      prompted.resolve(undefined)
      return grant.promise
    })
    ctx.provide('codexyApproval', { ...askApprovalPolicy, request, hasGrant: () => false } as never)
    try {
      const id = await readyPty(ctx, agent, {
        cmd: 'node -e "process.stdin.once(\'data\',b=>{process.stdout.write(\'received:\'+String(b));process.exit(0)});process.stdout.write(\'READY\\n\')"',
        login: false,
      })
      setSandboxMode(session, 'read-only')
      const pending = call(ctx, 'write_stdin', { session_id: id, chars: 'too late\n' }, agent)
      await prompted.promise
      ctx.emit('agent/disposed', { agent })
      grant.resolve('allowed-once')
      expect(await pending).toContain(`Unknown exec session ID ${id}`)
      expect(request).toHaveBeenCalledTimes(1)
    } finally {
      grant.resolve('allowed-once')
      await fiber.dispose()
    }
  })

  it('keeps empty polls available after a PTY permission switch', async () => {
    const { ctx, fiber } = await setupSandbox()
    const session = Session.create(SessionId('codex-stdin-poll'))
    const agent = { session } as Agent
    setSandboxMode(session, 'danger-full-access')
    const request = vi.fn(async () => 'rejected' as const)
    ctx.provide('codexyApproval', { ...askApprovalPolicy, request, hasGrant: () => false } as never)
    try {
      const id = await readyPty(ctx, agent, {
        cmd: 'node -e "process.stdout.write(\'READY\\n\');setInterval(()=>{},1000)"',
        login: false,
      })
      setSandboxMode(session, 'read-only')
      const polled = await call(ctx, 'write_stdin', { session_id: id, chars: '' }, agent)
      expect(polled).toContain(`Process running with session ID ${id}`)
      expect(request).not.toHaveBeenCalled()
    } finally {
      await fiber.dispose()
    }
  }, 20_000)
})
