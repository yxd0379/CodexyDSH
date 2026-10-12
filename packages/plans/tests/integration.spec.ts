import { createUserMessage } from '@codexydsh/runtime/llm'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@codexydsh/runtime'
import { mountAgentLoopTestDependencies } from '@codexydsh/runtime-testkit'
import * as ToolTodo from '@codexydsh/plans'
import { MockAdapter, textResponse, toolCallResponse } from '@codexydsh/runtime-testkit/mock-adapter'

/**
 * Full-loop integration: a scripted mock model drives the REAL planning tool
 * through the agent loop, exercising the same execution paths a live model would — the
 * tool/call + tool/result session events AND the todo/write event the tool
 * appends. Only the model is mocked; the tool and the session log are real.
 */
async function harness(adapter: MockAdapter, toolFormat: 'dsh' | 'codex' = 'dsh'): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ToolTodo, { allowParallelInProgress: toolFormat === 'dsh', toolFormat })
  ctx.codexyRequests.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function findEvent<T extends SessionEvent['type']>(
  log: readonly SessionEvent[],
  type: T,
  position: 'first' | 'last' = 'first',
): Extract<SessionEvent, { type: T }> {
  const found = position === 'first'
    ? log.find(event => event.type === type)
    : log.findLast(event => event.type === type)
  if (!found) throw new Error(`no ${type} event in the session log`)
  return found as Extract<SessionEvent, { type: T }>
}

describe('todo_write tool through the agent loop', () => {
  it('model calls todo_write: a tool/call, a non-error tool/result, and a todo/write snapshot land', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'todo_write', {
        todos: [
          { content: 'read the code', status: 'in_progress' },
          { content: 'write the fix', status: 'pending' },
        ],
      }, 'Planning the work.'),
      textResponse('Plan recorded.'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('it-todo'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'plan a two-step task' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const log = agent.session.snapshotEvents()
    expect(findEvent(log, 'tool/call').data.name).toBe('todo_write')
    expect(findEvent(log, 'tool/result').data.message.isError).toBe(false)

    const todoEvent = findEvent(log, 'todo/write')
    expect(todoEvent.data.todos).toEqual([
      { content: 'read the code', status: 'in_progress' },
      { content: 'write the fix', status: 'pending' },
    ])
  })

  it('a second todo_write replaces the list (last-write-wins on the log)', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'todo_write', { todos: [{ content: 'step one', status: 'in_progress' }] }),
      toolCallResponse('call-2', 'todo_write', {
        todos: [
          { content: 'step one', status: 'completed' },
          { content: 'step two', status: 'in_progress' },
        ],
      }),
      textResponse('Done planning.'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('it-todo-2'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'plan then update' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const todoEvents = agent.session.snapshotEvents().filter(e => e.type === 'todo/write')
    expect(todoEvents).toHaveLength(2)
    expect(findEvent(agent.session.snapshotEvents(), 'todo/write', 'last').data.todos).toEqual([
      { content: 'step one', status: 'completed' },
      { content: 'step two', status: 'in_progress' },
    ])
  })
})

describe('update_plan through the agent loop', () => {
  it('retains the explanation in tool/call and returns Codex text for a verbatim plan', async () => {
    const plan = [
      { step: '', status: 'in_progress' },
      { step: ' same ', status: 'in_progress' },
      { step: ' same ', status: 'in_progress' },
    ]
    const args = { explanation: 'Tasks are running together', plan }
    const adapter = new MockAdapter([
      toolCallResponse('call-plan', 'update_plan', args),
      textResponse('Plan recorded.'),
    ])
    const ctx = await harness(adapter, 'codex')
    const agent = await ctx.agentLoop.create(SessionId('it-codex-plan'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'record the plan' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const log = agent.session.snapshotEvents()
    expect(findEvent(log, 'tool/call').data).toMatchObject({
      name: 'update_plan', arguments: JSON.stringify(args),
    })
    const result = findEvent(log, 'tool/result').data.message
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: 'Plan updated' }])
    expect(findEvent(log, 'todo/write').data.todos).toEqual(
      plan.map(item => ({ content: item.step, status: item.status })),
    )
  })
})
