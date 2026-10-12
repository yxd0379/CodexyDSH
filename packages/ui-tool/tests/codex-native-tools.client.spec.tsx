// @vitest-environment jsdom
/** Native Codex patch, plan, and collaboration results retain readable outcomes and raw fallback. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@codexydsh/test-support/client'
import { en, zh } from '@codexydsh/ui-conversation/src/client/locales.ts'
import { commonEn } from '@codexydsh/test-support/client'
import { commonZh } from '@codexydsh/test-support/client'
import { useDisclosure } from '@codexydsh/ui-chat/src/client/chat/use-disclosure.ts'
import type { ToolResultNode } from '@codexydsh/ui-chat/client'
import { diffCardModel } from '../src/client/tool/models/diff-card-model.ts'
import { codexPlanModel } from '../src/client/tool/models/codex-plan-model.ts'
import { detailsCardModel } from '../src/client/tool/models/details-card-model.ts'
import { FileMutationRow } from '../src/client/tool/toolviews/file-mutation-row.tsx'
import { CodexPlanRow } from '../src/client/tool/toolviews/todo-row.tsx'
import { DetailsRow } from '../src/client/tool/toolviews/details-row.tsx'

const t = makeTranslate(en, commonEn)
const plan = [
  { step: 'Read the implementation', status: 'completed' },
  { step: 'Update the interface', status: 'in_progress' },
  { step: 'Verify the result', status: 'pending' },
]
const patch = '*** Begin Patch\n*** Update File: src/example.ts\n@@\n-old\n+new\n*** End Patch'
const diffs = [
  { path: 'src/example.ts', oldText: 'old\n', newText: 'new\n' },
  { path: 'src/added.ts', oldText: null, newText: 'added\n' },
  { path: 'src/deleted.ts', oldText: 'deleted\n', newText: '' },
]

function result(name: string, args: object, text: string, over: Partial<ToolResultNode> = {}): ToolResultNode {
  return { kind: 'tool-result', seq: 10, time: 2000, callTime: 1000, callId: 'native-call',
    call: { name, argsRaw: JSON.stringify(args) }, content: [{ type: 'text', text }],
    isError: false, subCalls: [], ...over }
}

function expand(container: HTMLElement): void {
  const row = container.querySelector('[data-expandable]')
  if (row === null) throw new Error('the tool row must remain expandable')
  fireEvent.click(row)
}

afterEach(cleanup)

describe('native Codex patch presentation', () => {
  it('renders applied multi-file changes from recorded metadata rather than inventing changes from patch text', () => {
    const block = result('apply_patch', { patch }, 'Success. Updated the following files:', { meta: { diffs } })
    expect(diffCardModel(block)?.card.diffs).toEqual(diffs)
    const view = render(<FileMutationRow {...{ phase: 'result', block, toolName: 'apply_patch',
      useDisclosure, t, openFile: vi.fn(), inspect: vi.fn() } as Parameters<typeof FileMutationRow>[0]} />)
    expect(screen.getByText('Edited')).toBeTruthy()
    expect(screen.getByText('src/example.ts, src/added.ts, src/deleted.ts')).toBeTruthy()
    expect(screen.getByText('+2 -2')).toBeTruthy()
    expect(view.container.querySelector('[data-diff][data-variant="inline"]')).not.toBeNull()
    expect(screen.getByText('new')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull()
    expand(view.container)
    expect(view.container.querySelector('[data-diff][data-variant="inline"]')).not.toBeNull()
    expect(view.container.querySelector('[data-diff]')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Inspect' })).toBeTruthy()
  })

  it('opens one changed file and retains errors and missing metadata as raw feedback', () => {
    const openFile = vi.fn()
    const block = result('apply_patch', { patch }, 'Patch rejected: context did not match', { meta: { diffs: [diffs[0]] } })
    const props = { phase: 'result', block, toolName: 'apply_patch', useDisclosure, t, openFile } as Parameters<typeof FileMutationRow>[0]
    const view = render(<FileMutationRow {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'src/example.ts' }))
    expect(openFile).toHaveBeenCalledExactlyOnceWith('src/example.ts')
    view.unmount()
    const failed = { ...block, isError: true }
    expect(diffCardModel(failed)).toBeNull()
    expect(diffCardModel({ ...block, meta: undefined })).toBeNull()
    expect(diffCardModel({ ...block, meta: { diffs: [] } })).toBeNull()
    const errorView = render(<FileMutationRow {...props} phase="result" block={failed} />)
    expect(errorView.container.querySelector('[data-state="error"]')).not.toBeNull()
    expect(screen.queryByText('Edited')).toBeNull()
    expand(errorView.container)
    expect(errorView.container.querySelector('[data-diff]')).toBeNull()
    expect(errorView.container.textContent).toContain('*** Begin Patch')
    expect(errorView.container.textContent).toContain('Patch rejected: context did not match')
  })
})

describe('native Codex plans', () => {
  it('expands ordered steps, their statuses, and the reason for a successful plan update', () => {
    const block = result('update_plan', { plan, explanation: 'The interface is the next dependency.' }, 'Plan updated')
    const view = render(<CodexPlanRow {...{ phase: 'result', block, toolName: 'update_plan',
      useDisclosure, t, inspect: vi.fn() } as Parameters<typeof CodexPlanRow>[0]} />)
    expect(screen.getByText('Update plan')).toBeTruthy()
    expect(screen.getByText('1/3 completed · Update the interface')).toBeTruthy()
    expand(view.container)
    expect(screen.getAllByRole('listitem').map(item => item.textContent)).toEqual([
      'Read the implementationCompleted', 'Update the interfaceIn progress', 'Verify the resultPending',
    ])
    expect(screen.getByText('Plan updated · The interface is the next dependency.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Inspect' })).toBeTruthy()
  })

  it('keeps pending updates distinct from applied plans, accepts empty and repeated steps, and rejects unknown statuses', () => {
    const block = result('update_plan', { plan }, 'Plan updated')
    const running = { phase: 'start' as const, callId: block.callId, name: 'update_plan', argsRaw: block.call!.argsRaw,
      turn: 1, step: 1, time: 1000, subCalls: [] }
    expect(codexPlanModel(running, t)?.details.caption).toBe('Updating plan; not yet confirmed')
    expect(codexPlanModel(result('update_plan', { plan: [] }, 'Plan updated'), t)?.details.empty).toBe('The plan is empty')
    expect(codexPlanModel(result('update_plan', { plan: [{ step: '', status: 'pending' }, ...plan, plan[0]] }, 'Plan updated'), t)?.details.items).toHaveLength(5)
    expect(codexPlanModel(result('update_plan', { plan: [{ step: 'bad', status: 'unknown' }] }, 'Plan updated'), t)).toBeNull()
    expect(codexPlanModel({ ...block, isError: true }, t)).toBeNull()
    expect(codexPlanModel({ ...block, content: [{ type: 'text', text: 'Plan was not saved' }] }, t)).toBeNull()
    const stopped = render(<CodexPlanRow {...{ phase: 'result', block: { ...block, isError: true, error: { name: 'Interrupted', code: 'interrupted' } },
      toolName: 'update_plan', useDisclosure, t } as Parameters<typeof CodexPlanRow>[0]} />)
    expect(stopped.container.querySelector('[data-state="stopped"]')).not.toBeNull()
    expand(stopped.container)
    expect(screen.queryByRole('list')).toBeNull()
  })
})

describe('Codex multi-agent v2 recorded results', () => {
  it('shows the interaction target, submitted message, and receipt without requiring expansion', () => {
    const block = result('send_message', { target: '/root/reviewer', message: 'Check cancellation and cleanup.' }, '')
    const view = render(<DetailsRow {...{ phase: 'result', block, toolName: 'send_message', useDisclosure, t,
      inspect: vi.fn() } as Parameters<typeof DetailsRow>[0]} />)
    expect(screen.getByText('Interacted with')).toBeTruthy()
    expect(screen.getByText('/root/reviewer')).toBeTruthy()
    expect(screen.getByText('Send message · Message submitted')).toBeTruthy()
    expect(screen.getByText('Check cancellation and cleanup.')).toBeTruthy()
    expect(screen.getAllByText('/root/reviewer')).toHaveLength(1)
    expect(screen.queryByText('Recorded result')).toBeNull()
    expect(screen.queryByText('Completed')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'View full details' }))
    expect(view.container.querySelector('[data-activity-preview]')).toBeNull()
    expect(screen.getByText('Check cancellation and cleanup.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Inspect' })).toBeTruthy()
  })

  it.each(['spawn_agent', 'send_message', 'followup_task', 'list_agents', 'interrupt_agent', 'wait_agent'])(
    'keeps %s execution errors and user interruption reachable instead of presenting a success receipt', (name) => {
      const args = { task_name: 'helper', target: '/root/helper', message: 'Review this change' }
      const failed = result(name, args, 'Provider connection failed', { isError: true })
      expect(detailsCardModel(failed, t, 'en')).toBeNull()
      const props = { phase: 'result' as const, block: failed, toolName: name, useDisclosure, t,
        inspect: vi.fn() } as Parameters<typeof DetailsRow>[0]
      const view = render(<DetailsRow {...props} />)
      expect(view.container.querySelector('[data-state="error"]')).not.toBeNull()
      expand(view.container)
      expect(view.container.textContent).toContain('Provider connection failed')
      expect(view.container.textContent).toContain('Review this change')
      expect(screen.getByRole('button', { name: 'Inspect' })).toBeTruthy()
      view.unmount()
      const stopped = { ...failed, error: { name: 'Interrupted', code: 'interrupted' } }
      const stoppedView = render(<DetailsRow {...props} phase="result" block={stopped} />)
      expect(stoppedView.container.querySelector('[data-state="stopped"]')).not.toBeNull()
      expand(stoppedView.container)
      expect(stoppedView.container.textContent).toContain('Review this change')
    },
  )

  it.each([
    ['pending_init', 'Provisioning'], ['running', 'Running'], ['interrupted', 'Interrupted'],
    ['shutdown', 'Shut down'], ['not_found', 'Not found'],
    [{ completed: null }, 'Completed'], [{ completed: 'The task output.' }, 'Completed'], [{ errored: 'Provider failed' }, 'Failed'],
  ])('shows an agent name and the recorded %j status', (agent_status, label) => {
    const block = result('list_agents', {}, JSON.stringify({ agents: [{ agent_name: '/root/helper', agent_status }] }))
    const model = detailsCardModel(block, t, 'en')
    expect(model?.items[0]).toMatchObject({ title: '/root/helper', badge: { label } })
    if (typeof agent_status === 'object' && agent_status !== null && 'completed' in agent_status && agent_status.completed !== null) {
      expect(model?.items[0]?.markdown).toBe(agent_status.completed)
    }
    if (typeof agent_status === 'object' && agent_status !== null && 'errored' in agent_status) {
      expect(model?.items[0]?.description).toBe(agent_status.errored)
    }
  })

  it('covers spawn, empty message/follow-up receipts, wait timeout, and prior interruption status without inventing live state', () => {
    const model = (name: string, args: object, output: unknown) => detailsCardModel(result(name, args,
      output === '' ? '' : JSON.stringify(output)), t, 'en')
    expect(model('spawn_agent', { task_name: 'helper', message: 'Investigate the bug', model: 'small' }, { task_name: '/root/helper' })?.items[0])
      .toMatchObject({ title: '/root/helper', description: 'Investigate the bug', fields: [{ label: 'Model', value: 'small' }] })
    expect(model('send_message', { target: '/root/helper', message: 'Keep the result brief' }, '')?.items[0]?.badge?.label).toBe('Message submitted')
    expect(model('followup_task', { target: '/root/helper', message: 'Continue the fix' }, '')?.items[0]?.badge?.label).toBe('Follow-up task submitted')
    expect(model('interrupt_agent', { target: '/root/helper' }, { previous_status: { errored: 'network unavailable' } })?.items[0]?.description).toBe('network unavailable')
    expect(model('wait_agent', {}, { message: 'Wait timed out.', timed_out: true })?.items[0]?.badge?.label).toBe('Wait timed out')
    expect(model('wait_agent', {}, { message: 'Wait completed.', timed_out: false })?.items[0]?.description).toBe('Wait completed.')
    expect(model('list_agents', {}, { agents: [] })?.items).toEqual([])
    expect(model('list_agents', {}, { agents: [{ agent_name: '/root/helper', agent_status: { completed: 5 } }] })).toBeNull()
  })

  it('renders completed output and failures in localized expandable rows', () => {
    const block = result('list_agents', {}, JSON.stringify({ agents: [
      { agent_name: '/root/helper', agent_status: { completed: 'Keep this final output.' } },
      { agent_name: '/root/other', agent_status: { errored: 'Connection was interrupted.' } },
    ] }))
    const chinese = makeTranslate(zh, commonZh)
    const view = render(<DetailsRow {...{ phase: 'result', block, toolName: 'list_agents', useDisclosure, t: chinese,
      inspect: vi.fn() } as Parameters<typeof DetailsRow>[0]} />)
    expand(view.container)
    expect(screen.getByText('已完成')).toBeTruthy()
    expect(screen.getByText('失败')).toBeTruthy()
    expect(screen.getByText('Keep this final output.')).toBeTruthy()
    expect(screen.getByText('Connection was interrupted.')).toBeTruthy()
    expect(screen.getByRole('button', { name: '查看' })).toBeTruthy()
  })
})
