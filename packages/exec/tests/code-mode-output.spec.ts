import { assemblePrompt } from '@codexydsh/test-support/host-tools'
import { currentToolRequestBinding } from '@codexydsh/bridges/tools'
/** Real nested command execution keeps program output independent of model rendering. */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolCallId } from '@codexydsh/runtime/llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SystemPrompt } from '@codexydsh/test-support/host-tools'
import { ToolRuntime } from '@codexydsh/test-support/host-tools'
import { TOOL_REQUEST_CAPTURE } from '@codexydsh/runtime/tools'
import type { ToolExecutionResult } from '@codexydsh/runtime/tools'
import LocalSubprocessRuntime from '@codexydsh/processes'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalFileSystem from '@codexydsh/filesystem-local'
import * as ToolFs from '@codexydsh/files'
import * as BashEnv from '@deepseek-ai/dsh-shell-env'
import * as ToolBash from '../src/index.ts'

async function harness(config: {
  codexOutputBufferBytes?: number
  codexMaxOutputTokens?: number
  codexOutputPolicy?: 'fixed-tokens' | 'codexful-model'
} = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(BashEnv)
  await ctx.plugin(LocalBashExecutor, {})
  await ctx.plugin(ToolBash, { toolFormat: 'codex', ...config })
  let serial = 0
  async function run(name: string, args: object, agent?: Agent) {
    let nested: ToolExecutionResult | undefined
    const dispose = ctx.codexyTools.register({
      name: 'program_caller', description: 'Program caller', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
      async execute(_args, exec) {
        const requestBinding = currentToolRequestBinding()
        if (requestBinding === undefined) throw new Error('expected a captured request binding')
        nested = await ctx.codexyTools.execute({
          name, arguments: args, callId: ToolCallId(`nested-${++serial}`), signal: exec.signal,
          parent: exec.token, rootCallId: exec.rootCallId, requestBinding,
          ...exec.agent === undefined ? {} : { agent: exec.agent },
        })
        return 'program complete'
      },
    })
    try {
      const capture = await ctx.codexyTools.prepareRequest({ context: { scope: agent }, variables: {} })
      const assembly = await assemblePrompt(ctx, { [TOOL_REQUEST_CAPTURE]: capture,
        ...agent === undefined ? {} : { scope: agent } })
      const binding = ctx.codexyTools.bindAssembly(capture,
        assembly.tools.filter(schema => schema.name === 'program_caller'),
        assembly.tools.filter(schema => schema.name === name))
      const outer = await ctx.codexyTools.execute({
        name: 'program_caller', arguments: {}, callId: ToolCallId(`root-${++serial}`),
        signal: new AbortController().signal, requestBinding: binding,
        ...agent === undefined ? {} : { agent },
      })
      if (outer.isError) throw new Error(outer.error.message)
      if (nested === undefined) throw new Error('program did not dispatch its nested command')
      return nested
    } finally {
      dispose()
    }
  }
  return { ctx, run }
}

function programOf(result: ToolExecutionResult) {
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error(`expected successful command: ${result.error.message}`)
  const value = result.codeModeValue
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected structured command output')
  }
  return value
}

function rendered(result: ToolExecutionResult): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

describe('Codex command program output', () => {
  it('returns an intercepted patch with zero wall time and no process metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-code-mode-patch-'))
    let ctx: Context | undefined
    try {
      const bench = await harness()
      ctx = bench.ctx
      await ctx.plugin(LocalFileSystem, { cwd: root })
      await ctx.plugin(ToolFs, { applyPatch: true, applyPatchOnly: true })
      const result = await bench.run('exec_command', {
        cmd: "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: program.txt\n+patched\n*** End Patch\nPATCH",
        workdir: root, login: false,
      })
      const raw = 'Success. Updated the following files:\nA program.txt\n'
      expect(programOf(result)).toEqual({ wall_time_seconds: 0, output: raw })
      expect(rendered(result)).toBe(`Wall time: 0.0000 seconds\nOutput:\n${raw}`)
      expect(await readFile(join(root, 'program.txt'), 'utf8')).toBe('patched\n')
    } finally {
      await ctx?.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns unrequested raw output beyond the model byte allowance with matching observation metadata', async () => {
    const { ctx, run } = await harness({ codexOutputPolicy: 'codexful-model' })
    const session = Session.create(SessionId('program-raw-output'))
    session.append('request/header', { reason: 'initial', header: { config: { provider: 'test', model: 'deepseek-v4-flash' } } })
    const raw = `HEAD${'x'.repeat(20_000)}TAIL`
    try {
      const result = await run('exec_command', {
        cmd: 'node -e "process.stdout.write(\'HEAD\'+\'x\'.repeat(20000)+\'TAIL\')"', login: false,
      }, { session } as Agent)
      const program = programOf(result)
      const text = rendered(result)
      expect(program['output']).toBe(raw)
      expect(text).toContain('chars truncated')
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(12_000)
      expect(Object.keys(program).sort()).toEqual(['chunk_id', 'exit_code', 'original_token_count', 'output', 'wall_time_seconds'])
      expect(program['chunk_id']).toMatch(/^[0-9a-f]{6}$/)
      expect(text).toContain(`Chunk ID: ${program['chunk_id'] as string}`)
      expect(program['exit_code']).toBe(0)
      expect(program['original_token_count']).toBe(5002)
      expect(program['wall_time_seconds']).toBeGreaterThanOrEqual(0)
      expect(typeof program['wall_time_seconds']).toBe('number')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('uses an explicit program budget without the direct result or header allowance', async () => {
    const { ctx, run } = await harness({ codexMaxOutputTokens: 70 })
    const raw = `HEAD${'x'.repeat(4_000)}TAIL`
    try {
      const result = await run('exec_command', {
        cmd: 'node -e "process.stdout.write(\'HEAD\'+\'x\'.repeat(4000)+\'TAIL\')"', login: false,
        max_output_tokens: 2_000,
      })
      expect(programOf(result)['output']).toBe(raw)
      expect(rendered(result)).toContain('tokens truncated')
      expect(Buffer.byteLength(rendered(result))).toBeLessThanOrEqual(336)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps the collector omission marker in raw program output and the original pre-collection count', async () => {
    const { ctx, run } = await harness({ codexOutputBufferBytes: 80 })
    try {
      const result = await run('exec_command', {
        cmd: 'node -e "process.stdout.write(\'HEAD\'+\'.\'.repeat(400)+\'TAIL\')"', login: false,
      })
      expect(programOf(result)['output']).toBe(`HEAD${'.'.repeat(36)}\n... 328 bytes omitted ...\n${'.'.repeat(36)}TAIL`)
      expect(programOf(result)['original_token_count']).toBe(102)
      expect(rendered(result)).toContain('... 328 bytes omitted ...')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('applies a smaller explicit program budget and retains head and tail', async () => {
    const { ctx, run } = await harness()
    try {
      const result = await run('exec_command', {
        cmd: 'node -e "process.stdout.write(\'HEAD\'+\'.\'.repeat(400)+\'TAIL\')"', login: false,
        max_output_tokens: 20,
      })
      const program = programOf(result)
      expect(program['output']).toBe(`Warning: truncated output (original token count: 102)\nTotal output lines: 1\n\nHEAD${'.'.repeat(36)}…82 tokens truncated…${'.'.repeat(36)}TAIL`)
      expect(program['original_token_count']).toBe(102)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('polls one running terminal through the same program fields and consumes only new output', async () => {
    const { ctx, run } = await harness({ codexMaxOutputTokens: 70 })
    try {
      const started = await run('exec_command', {
        cmd: 'node -e "process.stdout.write(\'READY\\n\');process.stdin.once(\'data\',()=>{process.stdout.write(\'HEAD\'+\'x\'.repeat(4000)+\'TAIL\');process.exit(0)})"',
        login: false, tty: true, yield_time_ms: 250,
      })
      let observation = programOf(started)
      const sessionId = observation['session_id']
      expect(typeof sessionId).toBe('number')
      for (let poll = 0; poll < 3 && (typeof observation['output'] !== 'string' || !observation['output'].includes('READY')); poll += 1) {
        observation = programOf(await run('write_stdin', { session_id: sessionId, chars: '' }))
      }
      expect(observation['output']).toContain('READY')
      expect(observation).not.toHaveProperty('exit_code')
      const finished = await run('write_stdin', {
        session_id: sessionId, chars: 'go\n', yield_time_ms: 30_000, max_output_tokens: 2_000,
      })
      const program = programOf(finished)
      expect(program['exit_code']).toBe(0)
      expect(program).not.toHaveProperty('session_id')
      expect(program['output']).not.toContain('READY')
      expect(program['output']).toContain(`HEAD${'x'.repeat(4_000)}TAIL`)
      expect(rendered(finished)).toContain('tokens truncated')
      const stale = await run('write_stdin', { session_id: sessionId })
      expect(stale.isError).toBe(true)
      expect(stale).not.toHaveProperty('codeModeValue')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
