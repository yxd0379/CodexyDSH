// @vitest-environment jsdom
/** Codexy tool records use the native terminal, diff, and recorded-agent cards. */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { useDisclosure } from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/use-disclosure.ts'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { terminalCardModel, localizeTerminalCardModel, terminalFailed } from '../src/client/tool/models/terminal-card-model.ts'
import { diffCardModel } from '../src/client/tool/models/diff-card-model.ts'
import { detailsCardModel } from '../src/client/tool/models/details-card-model.ts'
import { toolRowModel } from '../src/client/tool/models/tool-call-model.ts'
import { BashRow } from '../src/client/tool/toolviews/bash-sample.tsx'
import { FileMutationRow } from '../src/client/tool/toolviews/file-mutation-row.tsx'

const t = makeTranslate(en, commonZh)
afterEach(cleanup)

function result(name: string, args: Record<string, unknown>, text: string): ToolResultNode {
  const argsRaw = JSON.stringify(args)
  return {
    kind: 'tool-result', seq: 10, time: 2000, callTime: 1000, callId: 'codex-call', name,
    args: PartialArguments.fromText(argsRaw), call: { name, argsRaw },
    content: [{ type: 'text', text }], isError: false, subCalls: [],
  }
}

function output(text: string, status: string): string {
  return `Chunk ID: 91a230\nWall time: 0.1023 seconds\n${status}\nOriginal token count: 3\nOutput:\n${text}`
}

describe('unified exec presentation', () => {
  it('shows real command/output and exit failure instead of the provider header or JSON', () => {
    const block = result('exec_command', { cmd: 'printf failure; exit 2', workdir: '/workspace' }, output('failure', 'Process exited with code 2'))
    const card = terminalCardModel(block)
    expect(card?.card).toMatchObject({ cwd: '/workspace', output: 'failure', exitCode: 2, running: false })
    expect(card !== null && terminalFailed(card)).toBe(true)
    const view = render(<BashRow {...{ toolName: 'exec_command', block, useDisclosure, t } as Parameters<typeof BashRow>[0]} />)
    expect(view.getByText('exit code 2')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { expanded: false }))
    expect(view.getAllByText('printf failure; exit 2').length).toBeGreaterThan(0)
    expect(view.getByText('failure')).toBeTruthy()
    expect(view.queryByText(/Chunk ID:/u)).toBeNull()
  })

  it('keeps a yielded process and subsequent output associated with its actual terminal id', () => {
    const launch = terminalCardModel(result('exec_command', { cmd: 'long-job' }, output('started', 'Process running with session ID 41')))
    expect(launch?.card).toMatchObject({ output: 'started', running: true, exitCode: undefined })
    expect(launch === null ? '' : localizeTerminalCardModel(launch, t).description).toBe('long-job · Terminal 41')
    const poll = terminalCardModel(result('write_stdin', { session_id: 41 }, output('finished', 'Process exited with code 0')))
    expect(poll?.card).toMatchObject({ output: 'finished', exitCode: 0, running: false })
    expect(poll === null ? null : localizeTerminalCardModel(poll, t)).toMatchObject({ description: 'Terminal 41', card: { command: '(read output)' } })
  })

  it('does not call an unrecognized, denied, or interrupted command successful', () => {
    const block = result('exec_command', { cmd: 'work' }, 'approval was rejected')
    expect(terminalCardModel(block)).toBeNull()
    const interrupted = { ...block, isError: true, error: { name: 'Interrupted', code: 'interrupted' } }
    expect(toolRowModel('exec_command', interrupted).state).toBe('stopped')
    const view = render(<BashRow {...{ toolName: 'exec_command', block: interrupted, useDisclosure, t } as Parameters<typeof BashRow>[0]} />)
    fireEvent.click(view.getByRole('button', { expanded: false }))
    expect(view.getByText('approval was rejected')).toBeTruthy()
  })
})

describe('Codex patch and agent cards', () => {
  it('renders all applied files from recorded metadata, never a guessed patch result', () => {
    const block = {
      ...result('apply_patch', { patch: '*** Begin Patch\n*** Update File: notes.txt\n@@\n-old\n+new\n*** End Patch' }, 'Success.'),
      meta: { diffs: [{ path: 'notes.txt', oldText: 'old', newText: 'new' }, { path: 'new.txt', oldText: null, newText: 'added' }] },
    }
    expect(diffCardModel(block)?.card.diffs).toHaveLength(2)
    expect(diffCardModel({ ...block, isError: true })).toBeNull()
    const view = render(<FileMutationRow {...{ toolName: 'apply_patch', block, useDisclosure, t } as Parameters<typeof FileMutationRow>[0]} />)
    fireEvent.click(view.getByRole('button', { expanded: false }))
    expect(view.getByText('new.txt')).toBeTruthy()
    expect(view.getByText('added')).toBeTruthy()
    expect(view.queryByText(/"patch"/u)).toBeNull()
  })

  it('shows spawn as started and follow-up as accepted, not as completed work', () => {
    const spawn = detailsCardModel(result('spawn_agent', { task_name: 'review', message: 'Review the change' }, '{"task_name":"/root/review"}'), t, 'en')
    expect(spawn?.items[0]).toMatchObject({ title: 'review', badge: { label: 'Started' }, fields: [{ label: 'Agent ID', value: '/root/review' }] })
    const followup = detailsCardModel(result('followup_task', { target: '/root/review', message: 'Check the UI too' }, ''), t, 'en')
    expect(followup?.items[0]).toMatchObject({ title: '/root/review', badge: { label: 'Accepted' }, description: 'Check the UI too' })
  })

  it('reads actual v2 statuses and v1 wait replies without flattening them to JSON', () => {
    const list = detailsCardModel(result('list_agents', {}, JSON.stringify({ agents: [
      { agent_name: '/root/running', agent_status: 'running' },
      { agent_name: '/root/done', agent_status: { completed: 'Checked the UI' } },
      { agent_name: '/root/failed', agent_status: { errored: 'Build failed' } },
    ] })), t, 'en')
    expect(list?.items.map(item => item.badge?.label)).toEqual(['Running', 'Completed', 'Failed'])
    expect(list?.items[1]?.markdown).toBe('Checked the UI')
    const wait = detailsCardModel(result('multi_agent_v1__wait_agent', { targets: ['session-child'] }, '{"status":{"session-child":{"completed":"Finished"}},"timed_out":false}'), t, 'en')
    expect(wait?.items[0]).toMatchObject({ title: 'session-child', badge: { label: 'Completed' }, markdown: 'Finished' })
  })
})
