import { afterEach, describe, expect, it, vi } from 'vitest'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { HarnessError, ToolCallId } from '@codexydsh/runtime/llm'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@codexydsh/processes'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import { SystemPrompt } from '@codexydsh/test-support/host-tools'
import { ToolRuntime } from '@codexydsh/test-support/host-tools'
import type { ToolExecutionResult } from '@codexydsh/runtime/tools'
import * as ToolBash from '@codexydsh/exec'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  vi.restoreAllMocks()
})

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(ShellEnv)
  await ctx.plugin(LocalBashExecutor, {})
  await ctx.plugin(ToolBash, { toolFormat: 'codex' })
  return ctx
}

function processHandle(done: Promise<SubprocessOutcome>, interrupt: () => Promise<void> = async () => {}): SubprocessHandle {
  return {
    stdin: undefined, stdout: Readable.from([]), stderr: Readable.from([]), control: undefined,
    collected: {}, done, terminate() {}, interrupt,
    async waitForExit() { await done; return true },
  }
}

function resultText(result: ToolExecutionResult): string {
  expect(result.content).toHaveLength(1)
  const block = result.content[0]
  if (block?.type !== 'text') throw new Error('expected one model-visible text block')
  return block.text
}

describe('Codex command cancellation results', () => {
  it('records user Stop as structured interruption only after the real process has settled', async () => {
    const ctx = await setup()
    const ready = Promise.withResolvers<undefined>()
    const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
    let running: SubprocessHandle | undefined
    let settled = false
    vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
      running = spawn(spec)
      void running.done.then(() => { settled = true }, () => { settled = true })
      running.stdout?.once('data', () => { ready.resolve(undefined) })
      return running
    })
    const controller = new AbortController()
    const pending = ctx.codexyTools.execute({
      name: 'exec_command', callId: ToolCallId('stop-real-command'),
      arguments: { cmd: 'node -e "process.stdout.write(\'READY\');setInterval(()=>{},1000)"', login: false, yield_time_ms: 30_000 },
      signal: controller.signal,
    })
    await ready.promise
    controller.abort({ kind: 'user' })
    const result = await pending
    expect(result).toMatchObject({ isError: true, error: { info: { name: 'Interrupted', code: 'interrupted' } } })
    expect(resultText(result)).toMatch(/^Wall time: \d+\.\d seconds\naborted by user$/u)
    expect(JSON.stringify(result.content)).not.toContain('[object Object]')
    expect(settled).toBe(true)
    if (running === undefined) throw new Error('the command did not start')
    await expect(running.waitForExit()).resolves.toBe(true)
  })

  it('renders cancelled polling with the pinned short abort body and interruption metadata', async () => {
    const ctx = await setup()
    const closed = Promise.withResolvers<SubprocessOutcome>()
    const entered = Promise.withResolvers<undefined>()
    vi.spyOn(ctx.subprocess, 'spawn').mockReturnValue(processHandle(closed.promise, async () => { entered.resolve(undefined) }))
    const launched = await ctx.codexyTools.execute({
      name: 'exec_command', callId: ToolCallId('launch-polled-command'), signal: new AbortController().signal,
      arguments: { cmd: 'wait for input', login: false, yield_time_ms: 250 },
    })
    const text = launched.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    const id = Number(text.match(/Process running with session ID (\d+)/u)?.[1])
    expect(Number.isSafeInteger(id)).toBe(true)
    const controller = new AbortController()
    const pending = ctx.codexyTools.execute({
      name: 'write_stdin', callId: ToolCallId('stop-command-poll'), signal: controller.signal,
      arguments: { session_id: id, chars: '\u0003', yield_time_ms: 250 },
    })
    await entered.promise
    controller.abort({ kind: 'user' })
    closed.resolve({ exitCode: null, signal: 'SIGINT' })
    const result = await pending
    expect(result).toMatchObject({ isError: true, error: { info: { name: 'Interrupted', code: 'interrupted' } } })
    expect(resultText(result)).toMatch(/^aborted by user after \d+\.\ds$/u)
  })

  it('preserves a separate subprocess failure when cancellation happens before settlement', async () => {
    const ctx = await setup()
    const closed = Promise.withResolvers<SubprocessOutcome>()
    const entered = Promise.withResolvers<undefined>()
    vi.spyOn(ctx.subprocess, 'spawn').mockImplementation(() => {
      entered.resolve(undefined)
      return processHandle(closed.promise)
    })
    const controller = new AbortController()
    const pending = ctx.codexyTools.execute({
      name: 'exec_command', callId: ToolCallId('failed-command-with-stop'), signal: controller.signal,
      arguments: { cmd: 'failed process', login: false, yield_time_ms: 30_000 },
    })
    await entered.promise
    controller.abort({ kind: 'user' })
    closed.reject(new HarnessError('subprocess transport failed', 'SUBPROCESS_FAILURE'))
    const result = await pending
    expect(result).toMatchObject({
      isError: true, content: [{ type: 'text', text: 'Error: subprocess transport failed' }],
      error: { info: { name: 'HarnessError', code: 'SUBPROCESS_FAILURE' } },
    })
  })

  it('keeps a nonzero command exit as ordinary command output', async () => {
    const ctx = await setup()
    vi.spyOn(ctx.subprocess, 'spawn').mockReturnValue(processHandle(Promise.resolve({ exitCode: 7, signal: null })))
    const result = await ctx.codexyTools.execute({
      name: 'exec_command', callId: ToolCallId('nonzero-command'), signal: new AbortController().signal,
      arguments: { cmd: 'nonzero process', login: false, yield_time_ms: 250 },
    })
    expect(result.isError).toBe(false)
    expect(result.error).toBeUndefined()
    expect(resultText(result)).toContain('Process exited with code 7')
  })
})
