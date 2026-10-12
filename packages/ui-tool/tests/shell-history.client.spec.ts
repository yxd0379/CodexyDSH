/** Shell process identities survive polling, history prepends and reused numeric IDs. */
import { describe, expect, it } from 'vitest'
import { ConversationNodeAssembler } from '@codexydsh/ui-conversation/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { shellCallDefinition, shellHistoryView, type ShellHistory } from '../src/client/tool/models/shell-history.ts'
import { shellExploration } from '../src/client/tool/models/shell-exploration.ts'

function entry(seq: number, type: string, data: unknown): SessionLiveEventEntry {
  return { type: 'event', event: { seq, time: seq * 1000, type, data } as SessionEvent }
}
const call = (seq: number, callId: string, name: string, args: object) => entry(seq, 'tool/call', { turn: 1, step: seq, callId, name, arguments: JSON.stringify(args) })
const result = (seq: number, callId: string, header: string) => entry(seq, 'tool/result', { turn: 1, step: seq - 1, message: { role: 'tool', source: { kind: 'tool', callId }, content: [{ type: 'text', text: `${header}\nOutput:\nresult` }] } })

it('associates a completed poll with the original command and keeps earlier snapshots immutable', () => {
  const assembler = new ConversationNodeAssembler({ entries: () => [shellCallDefinition], fallbackEntry: () => undefined }, { entries: () => [shellHistoryView] })
  assembler.activateTarget('tool-shell-history')
  assembler.replaceWindow([
    call(1, 'run', 'exec_command', { cmd: 'pnpm test' }), result(2, 'run', 'Process running with session ID 353'),
    call(3, 'poll', 'write_stdin', { session_id: 353, chars: '' }),
  ], false)
  assembler.flush()
  const before = assembler.snapshot('tool-shell-history') as ShellHistory
  expect(before.get('poll')).toMatchObject({ command: 'pnpm test', originCallId: 'run' })
  assembler.append(result(4, 'poll', 'Process exited with code 0'))
  assembler.flush()
  const after = assembler.snapshot('tool-shell-history') as ShellHistory
  expect(after.get('run')?.latest.exitCode).toBe(0)
  expect(before.get('run')?.latest.exitCode).toBeUndefined()
  assembler.append(call(5, 'another', 'exec_command', { cmd: 'python script.py' }))
  assembler.append(result(6, 'another', 'Process running with session ID 353'))
  assembler.flush()
  expect((assembler.snapshot('tool-shell-history') as ShellHistory).get('poll')?.command).toBe('pnpm test')
})

it('repairs missing command associations when older history loads', () => {
  const assembler = new ConversationNodeAssembler({ entries: () => [shellCallDefinition], fallbackEntry: () => undefined }, { entries: () => [shellHistoryView] })
  assembler.activateTarget('tool-shell-history')
  assembler.replaceWindow([call(3, 'poll', 'write_stdin', { session_id: 353 }), result(4, 'poll', 'Process exited with code 1')], true)
  assembler.flush()
  expect((assembler.snapshot('tool-shell-history') as ShellHistory).get('poll')).toBeUndefined()
  assembler.prepend([call(1, 'run', 'exec_command', { cmd: 'pnpm test' }), result(2, 'run', 'Process running with session ID 353')], false)
  assembler.flush()
  expect((assembler.snapshot('tool-shell-history') as ShellHistory).get('poll')).toMatchObject({ command: 'pnpm test', latest: { exitCode: 1 } })
})

describe('inspection presentation', () => {
  it.each([
    ['rg -n tool src 2>/dev/null | head -20', ['search']],
    ['cd /repo && rg -n "approval|sandbox" src | head -20', ['search']],
    ["LC_ALL=C /usr/bin/rg --files -g '*.ts' | sort", ['list']],
    ["env LC_ALL=C cat 'path with spaces.ts' | head -n 20", ['read']],
    ["pwd && ls src; sed -n '1,80p' src/a.ts", ['list', 'read']],
    ['# browse\ncat a\\\nb', ['read']],
  ])('recognizes %s', (command, kinds) => {
    expect(shellExploration(command).map(entry => entry.kind)).toEqual(kinds)
  })
  it.each(['cat a > output', 'cat a | tee out', 'find . -exec cat {} \\;', "sed -n '1e' file", 'rg --pre=script hello .', 'cat "$(touch file)"', 'rg query . && npm test', 'cat a | sort -o result', "cat 'unterminated"])(
    'keeps %s as an ordinary run', (command) => { expect(shellExploration(command)).toEqual([]) },
  )
})
