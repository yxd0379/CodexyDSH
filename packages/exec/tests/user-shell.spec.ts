/** Direct user shell commands through Loader, the real loop, and managed processes. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createUserMessage } from '@codexydsh/runtime/llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@codexydsh/runtime'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies } from '@codexydsh/runtime-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LocalSubprocessRuntime from '@codexydsh/processes'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import * as ShellEnvironment from '@deepseek-ai/dsh-shell-env'
import * as ToolBash from '@codexydsh/exec'
import { MockAdapter, textResponse } from '@codexydsh/runtime-testkit/mock-adapter'

async function boot(options: { timeoutMs?: number; outputBytes?: number; adapter?: MockAdapter } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'codexful-user-shell-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
    vi.restoreAllMocks()
  })
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- name: cordis:loop-dependencies',
    '- name: cordis:loop',
    '  config: { agents: [] }',
    '- name: cordis:commands',
    '- name: cordis:subprocess',
    '- name: cordis:shell-environment',
    '- name: cordis:bash',
    '- name: cordis:user-shell',
    '  config:',
    '    toolFormat: codex',
    '    enableUserShellCommand: true',
    `    userShellTimeoutMs: ${options.timeoutMs ?? 15_000}`,
    `    userShellOutputBytes: ${options.outputBytes ?? 1_048_576}`,
    '',
  ].join('\n'))
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, {
    include: Include,
    'loop-dependencies': async (child: Context) => { await mountAgentLoopTestDependencies(child) },
    loop: AgentLoop,
    commands: CommandRuntime,
    subprocess: LocalSubprocessRuntime,
    'shell-environment': ShellEnvironment,
    bash: LocalBashExecutor,
    'user-shell': ToolBash,
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  const adapter = options.adapter ?? new MockAdapter([textResponse('I can see the shell result.')])
  ctx.effect(() => ctx.codexyRequests.registerAdapter(['mock'], adapter))
  const agent = await ctx.agentLoop.create(SessionId(`user-shell-${root}`), { provider: 'mock', model: 'gpt-5.5' }, { cwd: root })
  return { ctx, root, adapter, agent, execute: (command: string) => ctx.commands.execute(agent, `/shell ${command}`, [], new AbortController().signal) }
}

describe('Codexful user shell through Loader', () => {
  it('uses the current selected model output budget before any model request', async () => {
    const { agent, adapter, execute } = await boot()
    agent.ctx.effect(() => installModelSelection(agent.ctx, { current: { provider: 'mock', model: 'local-model' }, assembled: undefined }))
    const result = await execute(`${process.execPath} -e 'process.stdout.write("a".repeat(12000))'`)
    expect(result?.result.text).toContain('Warning: truncated output')
    expect(result?.result.text).toContain('chars truncated')
    expect(adapter.requests).toHaveLength(0)
    expect(agent.options.model).toBe('gpt-5.5')
  })

  it('executes without a model call and retains the exact result for the next model request and cold replay', async () => {
    const { root, adapter, agent, execute } = await boot()
    const execution = await execute('printf direct-shell > result.txt; cat result.txt; exit 7')
    expect(execution?.result.kind).toBe('success')
    expect(adapter.requests).toHaveLength(0)
    expect(await readFile(join(root, 'result.txt'), 'utf8')).toBe('direct-shell')
    const message = agent.inbox.nextStep.find(message => message.source.kind === 'user-shell-command')
    if (message?.role !== 'user' || message.source.kind !== 'user-shell-command') throw new Error('missing durable user shell result')
    expect(message.source).toMatchObject({ command: 'printf direct-shell > result.txt; cat result.txt; exit 7', cwd: root, exitCode: 7 })
    const text = message.content.find(block => block.type === 'text')
    if (text?.type !== 'text') throw new Error('missing shell output')
    expect(text.text).toMatch(/^<user_shell_command>\n<command>\nprintf direct-shell > result.txt; cat result.txt; exit 7\n<\/command>\n<result>\nExit code: 7\nDuration: \d+\.\d{4} seconds\nOutput:\ndirect-shell\n<\/result>\n<\/user_shell_command>$/)
    expect(execution?.result.text).toBe(text.text)
    expect(Session.create(agent.id, agent.session.snapshotEvents(), agent.session.header).deriveMessages()).toEqual(agent.session.deriveMessages())
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'What did the command do?' }] }))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.messages.some(message => message.content.some(block => block.type === 'text' && block.text === text.text))).toBe(true)
  })

  it('the same Stop action cancels an idle direct command and records the Codex interruption result', async () => {
    const { ctx, adapter, agent, execute } = await boot()
    const ready = Promise.withResolvers<void>()
    const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
    vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
      const handle = spawn(spec)
      handle.stdout?.on('data', (chunk: Buffer) => { if (chunk.toString().includes('READY')) ready.resolve() })
      return handle
    })
    const pending = execute(`${process.execPath} -e 'console.log("READY");setInterval(()=>{},1000)'`)
    await ready.promise
    agent.cancel({ kind: 'user' })
    const execution = await pending
    expect(execution?.result.text).toContain('Exit code: -1\nDuration: 0.0000 seconds\nOutput:\ncommand aborted by user')
    expect(agent.inbox.nextStep.filter(message => message.source.kind === 'user-shell-command')).toHaveLength(1)
    expect(adapter.requests).toHaveLength(0)
    expect(agent.status).toBe('idle')
    expect((await execute('printf resumed'))?.result.text).toContain('Output:\nresumed')
  })

  it('active auxiliary shell results wait at the next boundary without mutating the in-flight request', async () => {
    const adapter = new MockAdapter(['hang', textResponse('The shell returned auxiliary.')])
    const { agent, execute } = await boot({ adapter })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Start the task.' }] }))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    await execute('printf auxiliary')
    expect(adapter.requests[0]?.messages.some(message => message.source?.kind === 'user-shell-command')).toBe(false)
    expect(agent.session.snapshotEvents().some(event => event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => message.source.kind === 'user-shell-command'))).toBe(true)
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    await agent.whenIdle()
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue.' }] }))
    await agent.whenIdle()
    expect(adapter.requests[1]?.messages.some(message => message.content.some(block => block.type === 'text' && block.text.includes('Output:\nauxiliary')))).toBe(true)
  })

  it('retains both ends of large output and refuses a second concurrent command', async () => {
    const { ctx, agent, execute } = await boot({ outputBytes: 128 })
    const result = await execute(`${process.execPath} -e 'process.stdout.write("START"+"x".repeat(1000)+"END")'`)
    expect(result?.result.text).toContain('START')
    expect(result?.result.text).toContain('END')
    expect(result?.result.text).toContain('bytes omitted')
    const ready = Promise.withResolvers<void>()
    const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
    vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
      const handle = spawn(spec)
      handle.stdout?.on('data', (chunk: Buffer) => { if (chunk.toString().includes('READY')) ready.resolve() })
      return handle
    })
    const pending = execute(`${process.execPath} -e 'console.log("READY");setInterval(()=>{},1000)'`)
    await ready.promise
    expect((await execute('printf unexpected'))?.result).toEqual({ kind: 'error', text: 'A user shell command is already running in this Session.' })
    agent.cancel({ kind: 'user' })
    await pending
  })
})
