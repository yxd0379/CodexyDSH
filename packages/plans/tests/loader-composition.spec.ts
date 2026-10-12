// Proves `allowParallelInProgress` is real configurability and not a constant:
// the flag is set in a cordis.yml booted through the real Loader, and both faces
// it controls — the model-facing description and the accepted input — follow it.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@codexydsh/runtime/llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SystemPrompt } from '@codexydsh/test-support/host-tools'
import { ToolRuntime } from '@codexydsh/test-support/host-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as ToolTodo from '@codexydsh/plans'
import { unsupportedInbox } from '@codexydsh/runtime-testkit'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function agent(ctx: Context): Promise<Agent> {
  const scope = ctx.plugin(() => {})
  const id = SessionId('todo-loader-agent')
  const session = Session.create(id)
  const value: Agent = {
    id, options: {}, session, inbox: unsupportedInbox(),
    status: 'idle', ctx: scope.ctx,
    followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(value)
  return value
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/**
 * Boot a cordis.yml carrying the given tool-todo config block.
 * @param configLines - YAML lines nested under the tool's `config:` key.
 * @returns the booted context.
 */
async function boot(configLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-todo-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@codexydsh/runtime/prompt'",
    "- name: '@codexydsh/runtime/tools'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@codexydsh/plans'",
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@codexydsh/runtime/prompt', SystemPrompt],
    ['@codexydsh/runtime/tools', ToolRuntime],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@codexydsh/plans', ToolTodo],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return ctx
}

const PARALLEL_TODOS = [
  { content: 'run subagent a', status: 'in_progress' },
  { content: 'run subagent b', status: 'in_progress' },
]

describe('tool-todo real Loader composition through cordis.yml', () => {
  it('exposes Codex update_plan while keeping the session task list visible', async () => {
    const ctx = await boot(['    allowParallelInProgress: false', '    toolFormat: codex'])
    const schema = ctx.codexyTools.schemas().find(s => s.name === 'update_plan')
    if (schema === undefined || schema.kind === 'freeform') throw new Error('update_plan must have a function schema')
    expect(schema?.description).toBe('Updates the task plan.\nProvide an optional explanation and a list of plan items, each with a step and status.\nAt most one step can be in_progress at a time.\n')
    expect(schema?.parameters.additionalProperties).toBe(false)
    expect(ctx.codexyTools.schemas().some(s => s.name === 'todo_write')).toBe(false)
    expect(Object.keys((schema?.parameters as { properties: Record<string, unknown> }).properties)).toEqual(['explanation', 'plan'])
    const plan = (schema?.parameters.properties as { plan: { items: { properties: Record<string, unknown> } } } | undefined)?.plan
    expect(Object.keys(plan?.items.properties ?? {})).toEqual(['status', 'step'])

    const owner = await agent(ctx)
    const result = await ctx.codexyTools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('codex-plan'),
      name: 'update_plan',
      arguments: { explanation: 'Start with the failing test', plan: [
        { step: 'Reproduce the failure', status: 'in_progress' },
        { step: 'Fix the cause', status: 'pending' },
      ] },
      agent: owner,
    })
    expect(result.isError).toBe(false)
    expect(resultText(result)).toBe('Plan updated')
    expect(owner.session.snapshotEvents().findLast(e => e.type === 'todo/write')?.data.todos).toEqual([
      { content: 'Reproduce the failure', status: 'in_progress' },
      { content: 'Fix the cause', status: 'pending' },
    ])
  }, 30_000)

  it('records Codex steps verbatim even when they are empty, repeated, or simultaneously active', async () => {
    const ctx = await boot(['    allowParallelInProgress: false', '    toolFormat: codex'])
    const owner = await agent(ctx)
    const plan = [
      { step: '', status: 'in_progress' },
      { step: ' same ', status: 'in_progress' },
      { step: ' same ', status: 'in_progress' },
    ]
    const result = await ctx.codexyTools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('codex-plan-unrestricted'),
      name: 'update_plan',
      arguments: { plan },
      agent: owner,
    })

    expect(result.isError).toBe(false)
    expect(resultText(result)).toBe('Plan updated')
    expect(owner.session.snapshotEvents().findLast(e => e.type === 'todo/write')?.data.todos).toEqual(
      plan.map(item => ({ content: item.step, status: item.status })),
    )
  }, 30_000)

  it('rejects incompatible parallel-plan configuration at load', async () => {
    await expect(boot(['    allowParallelInProgress: true', '    toolFormat: codex']))
      .rejects.toThrow('update_plan requires allowParallelInProgress: false')
  }, 30_000)

  it('allowParallelInProgress: false narrows the description and rejects a parallel write', async () => {
    const ctx = await boot(['    allowParallelInProgress: false'])
    const description = ctx.codexyTools.schemas().find(s => s.name === 'todo_write')?.description ?? ''
    expect(description).toContain('Keep AT MOST ONE todo `in_progress`')
    expect(description).not.toContain('several at once')

    const owner = await agent(ctx)
    const result = await ctx.codexyTools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('parallel'),
      name: 'todo_write',
      arguments: { todos: PARALLEL_TODOS },
      agent: owner,
    })
    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain('at most one task may be in_progress')
    expect(owner.session.snapshotEvents().some(e => e.type === 'todo/write')).toBe(false)
  }, 30_000)

  it('allowParallelInProgress: true permits a parallel write end to end', async () => {
    const ctx = await boot(['    allowParallelInProgress: true'])
    const description = ctx.codexyTools.schemas().find(s => s.name === 'todo_write')?.description ?? ''
    expect(description).toContain('several at once when work genuinely runs in parallel')

    const owner = await agent(ctx)
    const result = await ctx.codexyTools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('parallel-enabled'),
      name: 'todo_write',
      arguments: { todos: PARALLEL_TODOS },
      agent: owner,
    })
    expect(result.isError).toBe(false)
    expect(owner.session.snapshotEvents().findLast(e => e.type === 'todo/write')?.data.todos).toEqual(PARALLEL_TODOS)
  }, 30_000)

  it.each([
    { label: 'is omitted', configLines: [], failure: '$.allowParallelInProgress missing required value' },
    { label: 'is not boolean', configLines: ['    allowParallelInProgress: "no"'], failure: '$.allowParallelInProgress expected boolean' },
  ])('fails loading when allowParallelInProgress $label', async ({ configLines, failure }) => {
    // The policy is self-contained, so misconfiguration fails at load: the
    // entry's apply rejects and boot never reaches a running tool.
    await expect(boot(configLines)).rejects.toThrow(failure)
  }, 30_000)
})
