import { snapshotProductEvents } from '@codexydsh/runtime/session'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@codexydsh/runtime/llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import PromptRegistry from '@codexydsh/prompt-registry'
import ToolRuntime, { NativeTools } from '@codexydsh/bridges/tools'
import type { ToolExecutionResult } from '@codexydsh/runtime/tools'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import * as ShellEnvPlugin from '@deepseek-ai/dsh-shell-env'
import * as ToolBash from '@codexydsh/exec'
import ApprovalService from '@codexydsh/approval'
import type { ApprovalOutcome, ApprovalRequest } from '@codexydsh/approval'
import { describe, expect, it, vi } from 'vitest'
import * as CodexfulExecPolicy from '../src/index.ts'
import { classifyPosixDangerousCommand } from '../src/classifier.ts'

const classify = (script: string) => classifyPosixDangerousCommand(['/bin/bash', '-lc', script])

describe('pinned Codex POSIX dangerous-command classifier', () => {
  it.each([
    'rm -f /tmp/example',
    '/bin/rm -fr /tmp/example',
    'printf x | rm -rf /tmp/example',
    'if test -d /tmp/example; then rm --force /tmp/example; fi',
    'rm -rf "$TARGET" >/dev/null',
    'for target in /tmp/a /tmp/b; do rm -r -f "$target"; done',
    'echo "$(rm -rf /tmp/example)"',
    "bash -c 'rm -rf /tmp/example'",
    "trap 'rm -rf /tmp/example' EXIT",
    'sudo rm -rf /tmp/example',
    'env TARGET=/tmp/example rm -rf /tmp/example',
  ])('flags a statically known forced rm: %s', async (script) => {
    await expect(classify(script)).resolves.toBe('forced-rm')
  })

  it.each([
    'rm -r /tmp/example',
    'rm -- -f',
    "echo 'rm -rf /tmp/example'",
    'cmd=rm; $cmd -rf /tmp/example',
    'if then rm -rf /tmp/example',
    "trap 'echo rm -rf /tmp/example' EXIT",
  ])('does not classify harmless or dynamic text as forced rm: %s', async (script) => {
    await expect(classify(script)).resolves.toBeUndefined()
  })

  it('follows literal wrappers and caps recursive inspection', async () => {
    await expect(classifyPosixDangerousCommand(['env', '-i', '--', 'sudo', 'rm', '-rf', '/tmp/example']))
      .resolves.toBe('forced-rm')
    await expect(classifyPosixDangerousCommand([...Array<string>(9).fill('env'), 'rm', '-rf', '/tmp/example']))
      .resolves.toBe('other')
  })
})

class ConfiningBashExecutor extends LocalBashExecutor {
  override get sandboxMode() { return 'read-only' as const }
}

class FakeSandbox extends SandboxProvider {
  async confine(argv: readonly string[], _policy: SandboxPolicy): Promise<ConfinedArgv> {
    return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
  }
}

function fakeHandle(): SubprocessHandle {
  return {
    stdin: undefined, stdout: Readable.from([]), stderr: Readable.from([]), control: undefined,
    collected: {}, done: Promise.resolve({ exitCode: 0, signal: null }),
    terminate() {}, async waitForExit() { return true },
  }
}

async function setup(policy: 'ask' | 'never' = 'ask', mode: 'read-only' | 'workspace-write' | 'danger-full-access' = 'read-only') {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(PromptRegistry)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeTools)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(ShellEnvPlugin)
  await ctx.plugin(SandboxPolicyService, { mode })
  await ctx.plugin(FakeSandbox)
  await ctx.plugin(ConfiningBashExecutor, {})
  await ctx.plugin(ApprovalService, { policy })
  await ctx.plugin(ToolBash, { toolFormat: 'codex' })
  const policyFiber = await ctx.plugin(CodexfulExecPolicy)
  vi.spyOn(ctx.subprocess, 'terminalEnvironment').mockResolvedValue({ platform: 'posix', defaultShell: '/bin/bash' })
  const spawned: SubprocessSpawnSpec[] = []
  vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
    spawned.push(spec)
    return fakeHandle()
  })
  const session = Session.create(SessionId('codexful-exec-policy-test'))
  session.append('turn/start', { turn: 1 })
  const agent = { id: session.id, session } as Agent
  return { ctx, agent, policyFiber, spawned }
}

async function call(ctx: Context, agent: Agent, cmd: string, extras: object = {}) {
  return ctx.tools.execute({
    name: 'exec_command', callId: ToolCallId('preflight-test'),
    arguments: { cmd, ...extras }, agent, signal: new AbortController().signal,
  })
}

function outputText(result: ToolExecutionResult): string {
  return result.content.map(block => block.type === 'text' ? block.text : '').join('\n')
}

function settledOutputHandle(stdoutText: string, stderrText: string, exitCode: number): SubprocessHandle {
  const stdout = Readable.from(stdoutText.length === 0 ? [] : [stdoutText])
  const stderr = Readable.from(stderrText.length === 0 ? [] : [stderrText])
  const stdoutEnded = Promise.withResolvers<undefined>()
  const stderrEnded = Promise.withResolvers<undefined>()
  stdout.once('end', () => { stdoutEnded.resolve(undefined) })
  stderr.once('end', () => { stderrEnded.resolve(undefined) })
  return {
    stdin: undefined, stdout, stderr, control: undefined, collected: {},
    done: Promise.all([stdoutEnded.promise, stderrEnded.promise]).then(() => ({ exitCode, signal: null })),
    terminate() {}, async waitForExit() { return true },
  }
}

function sandboxDenialFixture(ctx: Context, spawned: SubprocessSpawnSpec[], diagnostic = 'TEST_FILE_DENIAL', exitCode = 1) {
  const confined = vi.spyOn(ctx.sandbox, 'confine').mockImplementation(argv => Promise.resolve({
    argv: ['codexful-test-confined', ...argv], enforcement: 'full',
    denialSignatures: ['TEST_FILE_DENIAL'],
    runnerFailureRules: [{ fatalSignatures: ['TEST_RUNNER_FAILURE'] }],
  }))
  vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
    spawned.push(spec)
    return spec.argv[0] === 'codexful-test-confined'
      ? settledOutputHandle('', diagnostic, exitCode)
      : settledOutputHandle('codexful-safe', '', 0)
  })
  return confined
}

describe('Codexful exec review with the real command tool and a fake subprocess', () => {
  it('rejects a forced rm under Never before spawning, including full access', async () => {
    const { ctx, agent, spawned } = await setup('never', 'danger-full-access')
    try {
      const result = await call(ctx, agent, 'rm -f /tmp/example')
      expect(result.isError).toBe(true)
      expect(result.content).toEqual([{ type: 'text', text: 'Error: rm -f style commands are not permitted. Use a safer approach' }])
      expect(spawned).toHaveLength(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('asks once for default permissions and then uses the standing sandbox mode', async () => {
    const { ctx, agent, spawned } = await setup()
    const confined = vi.spyOn(ctx.sandbox, 'confine')
    const asked: ApprovalRequest[] = []
    ctx.on('codexy-approval/request', (request) => {
      asked.push(request)
      return Promise.resolve<ApprovalOutcome>('allowed-once')
    })
    try {
      const result = await call(ctx, agent, 'rm -f /tmp/example')
      expect(result.isError).toBe(false)
      expect(spawned).toHaveLength(1)
      expect(confined.mock.calls[0]?.[1].mode).toBe('read-only')
      expect(asked).toHaveLength(1)
      expect(asked[0]?.reason).toContain('rm -f /tmp/example')
      expect(asked[0]?.reason).toContain('rm force option')
      expect(ctx.sandboxPolicy.resolve({ session: agent.session }).mode).toBe('read-only')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('combines forced-rm and explicit escalation into one approval without a reusable grant', async () => {
    const { ctx, agent, spawned } = await setup()
    const asked: ApprovalRequest[] = []
    ctx.on('codexy-approval/request', (request) => { asked.push(request); return Promise.resolve<ApprovalOutcome>('allowed-once') })
    try {
      const result = await call(ctx, agent, 'rm -f /tmp/example', {
        sandbox_permissions: 'require_escalated', justification: 'Run the requested cleanup',
      })
      expect(result.isError).toBe(false)
      expect(spawned).toHaveLength(1)
      expect(asked).toHaveLength(1)
      expect(asked[0]?.reason).toContain('rm -f /tmp/example')
      expect(asked[0]?.reason).toContain('rm force option')
      expect(asked[0]?.reason).toContain('danger-full-access')
      expect(asked[0]?.reason).toContain('Run the requested cleanup')
      expect(asked[0]?.sessionGrantKey).toBeUndefined()
      expect(asked[0]?.prefixGrantKey).toBeUndefined()
      expect(asked[0]?.prefixRule).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not spawn a restricted forced-rm escalation when its one approval is rejected', async () => {
    const { ctx, agent, spawned } = await setup()
    const asked: ApprovalRequest[] = []
    ctx.on('codexy-approval/request', (request) => { asked.push(request); return Promise.resolve<ApprovalOutcome>('rejected') })
    try {
      const result = await call(ctx, agent, 'rm -f /tmp/example', {
        sandbox_permissions: 'require_escalated', justification: 'Run the requested cleanup',
      })
      expect(result.isError).toBe(true)
      expect(spawned).toHaveLength(0)
      expect(asked).toHaveLength(1)
      expect(asked[0]?.reason).toContain('danger-full-access')
      expect(asked[0]?.reason).toContain('rm force option')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not reuse a prior prefix grant for a forced-rm wrapper', async () => {
    const { ctx, agent, spawned } = await setup()
    const asked: ApprovalRequest[] = []
    ctx.on('codexy-approval/request', (request) => {
      asked.push(request)
      return Promise.resolve<ApprovalOutcome | 'allow-prefix-for-session'>(
        request.prefixRule === undefined ? 'rejected' : 'allow-prefix-for-session',
      )
    })
    try {
      const safe = await call(ctx, agent, "trap 'echo safe' EXIT", {
        sandbox_permissions: 'require_escalated', justification: 'Register a reusable trap prefix',
        prefix_rule: ['trap'],
      })
      expect(safe.isError).toBe(false)
      expect(spawned).toHaveLength(1)
      expect(asked).toHaveLength(1)
      expect(asked[0]?.prefixRule).toEqual(['trap'])

      const dangerous = await call(ctx, agent, "trap 'rm -rf /tmp/example' EXIT")
      expect(dangerous.isError).toBe(true)
      expect(spawned).toHaveLength(1)
      expect(asked).toHaveLength(2)
      expect(asked[1]?.reason).toContain('rm force option')
      expect(asked[1]?.prefixRule).toBeUndefined()
      expect(asked[1]?.sessionGrantKey).toBeUndefined()

      const escalated = await call(ctx, agent, "trap 'rm -rf /tmp/example' EXIT", {
        sandbox_permissions: 'require_escalated', justification: 'Retry outside the sandbox',
      })
      expect(escalated.isError).toBe(true)
      expect(spawned).toHaveLength(1)
      expect(asked).toHaveLength(3)
      expect(asked[2]?.reason).toContain('danger-full-access')
      expect(asked[2]?.reason).toContain('rm force option')
      expect(asked[2]?.prefixRule).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not issue an exact Session grant for a dangerous escalation', async () => {
    const { ctx, agent, spawned } = await setup()
    const asked: ApprovalRequest[] = []
    let answer: 'allow-for-session' | 'allowed-once' = 'allow-for-session'
    ctx.on('codexy-approval/request', (request) => {
      asked.push(request)
      return Promise.resolve<ApprovalOutcome | 'allow-for-session'>(answer)
    })
    try {
      const args = { sandbox_permissions: 'require_escalated', justification: 'Run the requested cleanup' }
      expect((await call(ctx, agent, 'rm -f /tmp/example', args)).isError).toBe(true)
      expect(spawned).toHaveLength(0)
      answer = 'allowed-once'
      expect((await call(ctx, agent, 'rm -f /tmp/example', args)).isError).toBe(false)
      expect((await call(ctx, agent, 'rm -f /tmp/example', args)).isError).toBe(false)
      expect(spawned).toHaveLength(2)
      expect(asked).toHaveLength(3)
      expect(asked.every(request => request.sessionGrantKey === undefined && request.prefixGrantKey === undefined)).toBe(true)
      expect(snapshotProductEvents(agent.session).some(event => event.type === 'approval/decided' && event.data.sessionGrantKey !== undefined)).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('still asks on explicit escalation when the standing mode is already full access', async () => {
    const { ctx, agent, spawned } = await setup('ask', 'danger-full-access')
    let asked = 0
    ctx.on('codexy-approval/request', () => { asked += 1; return Promise.resolve<ApprovalOutcome>('rejected') })
    try {
      const result = await call(ctx, agent, 'rm --force /tmp/example', {
        sandbox_permissions: 'require_escalated', justification: 'Run the requested cleanup',
      })
      expect(result.isError).toBe(true)
      expect(spawned).toHaveLength(0)
      expect(asked).toBe(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('combines another Codex command review reason with the forced-rm warning', async () => {
    const { ctx, agent, spawned } = await setup()
    const asked: ApprovalRequest[] = []
    ctx.on('codexy-approval/request', (request) => {
      asked.push(request)
      return Promise.resolve<ApprovalOutcome>('allowed-once')
    })
    ctx.on('tool-bash/codex-exec-review', () => Promise.resolve({ kind: 'ask', reason: 'Workspace policy review' }))
    try {
      const result = await call(ctx, agent, 'rm -f /tmp/example')
      expect(result.isError).toBe(false)
      expect(spawned).toHaveLength(1)
      expect(asked).toHaveLength(1)
      expect(asked[0]?.reason).toContain('Workspace policy review')
      expect(asked[0]?.reason).toContain('rm force option')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('passes safe shell commands through unchanged', async () => {
    const { ctx, agent, spawned } = await setup()
    try {
      expect((await call(ctx, agent, "echo 'rm -rf /tmp/example'")).isError).toBe(false)
      expect((await call(ctx, agent, 'rm -r /tmp/example')).isError).toBe(false)
      expect(spawned).toHaveLength(2)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('removes the review when the Codexful policy plugin unloads', async () => {
    const { ctx, agent, policyFiber, spawned } = await setup('never', 'danger-full-access')
    try {
      expect((await call(ctx, agent, 'rm -f /tmp/example')).isError).toBe(true)
      await policyFiber.dispose()
      expect((await call(ctx, agent, 'rm -f /tmp/example')).isError).toBe(false)
      expect(spawned).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('Codexful sandbox denial and explicit approval retry', () => {
  it.each(['allowed-once', 'rejected', 'cancelled', 'unavailable'] satisfies ApprovalOutcome[])(
    'keeps the workspace-write command confined until its retry approval is %s', async (outcome) => {
      const { ctx, agent, spawned } = await setup('ask', 'workspace-write')
      const confined = sandboxDenialFixture(ctx, spawned)
      const entered = Promise.withResolvers<undefined>()
      const release = Promise.withResolvers<undefined>()
      const asked: ApprovalRequest[] = []
      ctx.on('codexy-approval/request', async (request) => {
        asked.push(request)
        entered.resolve(undefined)
        await release.promise
        return outcome
      })
      const cmd = 'printf codexful-safe'
      try {
        const denied = await call(ctx, agent, cmd, { login: false })
        expect(denied.isError).toBe(false)
        expect(outputText(denied)).toContain('Process exited with code 1')
        expect(outputText(denied)).toContain('[sandbox: file access denied under workspace-write mode]')
        expect(outputText(denied)).toContain('retry this exact command once with sandbox_permissions')
        expect(spawned).toHaveLength(1)
        expect(asked).toHaveLength(0)

        const pending = call(ctx, agent, cmd, {
          login: false, sandbox_permissions: 'require_escalated',
          justification: 'May I retry this command outside the file sandbox?',
        })
        expect(await Promise.race([
          entered.promise.then(() => 'asked'), pending.then(() => 'settled'),
        ])).toBe('asked')
        expect(spawned).toHaveLength(1)
        expect(asked).toHaveLength(1)
        expect(asked[0]?.callId).toBe(ToolCallId('preflight-test'))
        expect(asked[0]?.toolName).toBe('exec_command')
        expect(asked[0]?.reason).toContain('May I retry this command outside the file sandbox?')
        release.resolve(undefined)
        const retried = await pending

        expect(retried.isError).toBe(outcome !== 'allowed-once')
        expect(spawned).toHaveLength(outcome === 'allowed-once' ? 2 : 1)
        expect(confined).toHaveBeenCalledTimes(1)
        if (outcome === 'allowed-once') {
          expect(outputText(retried)).toContain('codexful-safe')
          expect(outputText(retried)).toContain('Process exited with code 0')
          expect(spawned[1]?.argv).toEqual(spawned[0]?.argv.slice(1))
          expect(spawned[1]?.cwd).toBe(spawned[0]?.cwd)
          expect(spawned[1]?.env).toEqual(spawned[0]?.env)
        }
        expect(ctx.sandboxPolicy.resolve({ session: agent.session }).mode).toBe('workspace-write')
        const audit = snapshotProductEvents(agent.session)
        const questions = audit.filter(event => event.type === 'approval/asked')
        const decisions = audit.filter(event => event.type === 'approval/decided')
        expect(questions).toHaveLength(1)
        expect(decisions).toHaveLength(1)
        expect(decisions[0]?.data.id).toBe(questions[0]?.data.id)
        expect(decisions[0]?.data.outcome).toBe(outcome)
        expect(decisions[0]?.data.sessionGrantKey).toBeUndefined()
      } finally {
        release.resolve(undefined)
        await ctx.fiber.dispose()
      }
    },
  )

  it('returns a read-only denial under never and refuses an escalation before asking or spawning again', async () => {
    const { ctx, agent, spawned } = await setup('never', 'read-only')
    const confined = sandboxDenialFixture(ctx, spawned)
    const asked: ApprovalRequest[] = []
    ctx.on('codexy-approval/request', (request) => { asked.push(request); return Promise.resolve<ApprovalOutcome>('allowed-once') })
    try {
      const denied = await call(ctx, agent, 'printf codexful-safe', { login: false })
      expect(denied.isError).toBe(false)
      expect(outputText(denied)).toContain('[sandbox: file access denied under read-only mode]')
      expect(outputText(denied)).not.toContain('[sandbox: escalation available')
      const refused = await call(ctx, agent, 'printf codexful-safe', {
        login: false, sandbox_permissions: 'require_escalated', justification: 'May I retry outside the sandbox?',
      })
      expect(refused.isError).toBe(true)
      expect(outputText(refused)).toContain('approval policy is Never')
      expect(spawned).toHaveLength(1)
      expect(confined).toHaveBeenCalledTimes(1)
      expect(asked).toHaveLength(0)
      expect(snapshotProductEvents(agent.session).some(event => event.type === 'approval/asked')).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each([
    { diagnostic: 'command rejected its own arguments', exitCode: 2, isError: false },
    { diagnostic: 'TEST_FILE_DENIAL', exitCode: 0, isError: false },
    { diagnostic: 'TEST_RUNNER_FAILURE TEST_FILE_DENIAL', exitCode: 1, isError: true },
  ])('does not treat $diagnostic with exit $exitCode as a file-policy denial', async ({ diagnostic, exitCode, isError }) => {
    const { ctx, agent, spawned } = await setup('ask', 'workspace-write')
    sandboxDenialFixture(ctx, spawned, diagnostic, exitCode)
    try {
      const result = await call(ctx, agent, 'printf codexful-safe', { login: false })
      expect(result.isError).toBe(isError)
      expect(outputText(result)).not.toContain('[sandbox: file access denied')
      expect(outputText(result)).not.toContain('[sandbox: escalation available')
      if (isError) {
        expect(outputText(result)).toContain('TEST_RUNNER_FAILURE')
        expect(result.error?.info?.code).toBe('SANDBOX_UNAVAILABLE')
      } else {
        expect(outputText(result)).toContain(diagnostic)
        expect(outputText(result)).toContain(`Process exited with code ${exitCode}`)
      }
      expect(spawned).toHaveLength(1)
      expect(snapshotProductEvents(agent.session).some(event => event.type === 'approval/asked')).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('cancels a pending escalation without using a later allowed answer', async () => {
    const { ctx, agent, spawned } = await setup('ask', 'workspace-write')
    sandboxDenialFixture(ctx, spawned)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    ctx.on('codexy-approval/request', async () => {
      entered.resolve(undefined)
      await release.promise
      return 'allowed-once'
    })
    const controller = new AbortController()
    try {
      expect((await call(ctx, agent, 'printf codexful-safe', { login: false })).isError).toBe(false)
      const pending = ctx.tools.execute({
        name: 'exec_command', callId: ToolCallId('cancelled-retry'), agent, signal: controller.signal,
        arguments: {
          cmd: 'printf codexful-safe', login: false, sandbox_permissions: 'require_escalated',
          justification: 'May I retry this command outside the file sandbox?',
        },
      })
      expect(await Promise.race([
        entered.promise.then(() => 'asked'), pending.then(() => 'settled'),
      ])).toBe('asked')
      controller.abort()
      expect((await pending).isError).toBe(true)
      release.resolve(undefined)
      expect(spawned).toHaveLength(1)
      const decisions = snapshotProductEvents(agent.session).filter(event => event.type === 'approval/decided')
      expect(decisions).toHaveLength(1)
      expect(decisions[0]?.data.outcome).toBe('cancelled')
      expect(decisions[0]?.data.sessionGrantKey).toBeUndefined()
    } finally {
      release.resolve(undefined)
      await ctx.fiber.dispose()
    }
  })
})
