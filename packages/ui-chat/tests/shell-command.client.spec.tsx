// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { makeTranslate } from '@codexydsh/test-support/client'
import { commonEn } from '@codexydsh/test-support/client'
import { ShellCommandCard } from '../src/client/chat/ShellCommandCard.tsx'
import { en } from '../src/client/locale.ts'

afterEach(cleanup)

function props(text?: string, failed = false): Parameters<typeof ShellCommandCard>[0] {
  return {
    node: {
      kind: 'command', commandId: 'shell-1', name: 'shell', seq: 1, time: 1,
      args: ' pwd', outcome: text === undefined ? null : { kind: failed ? 'error' : 'success', text },
    },
    t: makeTranslate(en, commonEn),
  } as Parameters<typeof ShellCommandCard>[0]
}

describe('Human shell command card', () => {
  it('shows the direct command during execution without a model reply', () => {
    const view = render(<ShellCommandCard {...props()} />)
    expect(view.getByText('Your shell command')).toBeTruthy()
    expect(view.getByText('pwd')).toBeTruthy()
  })

  it('renders the recorded exit code, duration, and output without XML wrappers', () => {
    const text = '<user_shell_command>\n<command>\npwd\n</command>\n<result>\nExit code: 1\nDuration: 0.1234 seconds\nOutput:\npermission denied\n</result>\n</user_shell_command>'
    const view = render(<ShellCommandCard {...props(text)} />)
    expect(view.getByText('permission denied')).toBeTruthy()
    expect(view.getByText('Exit code 1')).toBeTruthy()
    expect(view.getByText('0.1234s')).toBeTruthy()
    expect(view.queryByText('<user_shell_command>')).toBeNull()
    expect(view.getByRole('button', { name: 'Copy' })).toBeTruthy()
  })

  it('keeps unsupported or failed command results on the generic readable path', () => {
    const view = render(<ShellCommandCard {...props('Shell working directory is unavailable.', true)} />)
    expect(view.getByText('Shell working directory is unavailable.')).toBeTruthy()
  })

  it('keeps a result for another command intact instead of pairing it with the displayed command', () => {
    const text = '<user_shell_command>\n<command>\nother\n</command>\n<result>\nExit code: 0\nDuration: 0.1000 seconds\nOutput:\nother result\n</result>\n</user_shell_command>'
    const view = render(<ShellCommandCard {...props(text)} />)
    expect(view.container.querySelector('[data-user-shell-command]')).toBeNull()
    expect(view.container.textContent).toContain('<command>')
  })
})
