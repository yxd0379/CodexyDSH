/** Locale-owned native command-management states. */

import { expect, it } from 'vitest'
import { zh } from '../src/locale.ts'
import { presentCommandManagement } from '../src/command-management.ts'

it('shows installation, repair/removal and shadowed command locations', () => {
  const messages = zh
  const destination = '/usr/local/bin/codexydsh'
  const missing = presentCommandManagement({ managed: false, available: false, destination }, messages, 'darwin')
  expect(missing.buttons).toEqual([messages.cliCommandInstall, messages.cancel])
  expect(missing.cancelId).toBe(1)
  const installed = presentCommandManagement({ managed: true, available: true, destination, activeCommand: destination }, messages, 'darwin')
  expect(installed.buttons).toEqual([messages.cliCommandClose, messages.cliCommandRepair, messages.cliCommandRemove])
  expect(installed.cancelId).toBe(0)
  const shadowed = presentCommandManagement({ managed: true, available: true, destination, activeCommand: '/opt/homebrew/bin/codexydsh' }, messages, 'darwin')
  expect(shadowed.type).toBe('warning')
  expect(shadowed.detail).toContain('/opt/homebrew/bin/codexydsh')
  expect(shadowed.detail).toContain(messages.cliCommandShadowed)
  const unknown = presentCommandManagement({ managed: false, available: false, destination, selectionUnknown: true }, messages, 'darwin')
  expect(unknown.detail).toContain(messages.cliCommandSelectionUnknown)
})

it.each(['darwin', 'win32'] as const)('records command status on %s', async (platform) => {
  const destination = platform === 'darwin' ? '/usr/local/bin/codexydsh' : 'C:\\Users\\user\\AppData\\Local\\Programs\\CodexyDSH\\resources\\runtime\\cli\\bin\\codexydsh.cmd'
  const other = platform === 'darwin' ? '/opt/homebrew/bin/codexydsh' : 'C:\\Program Files\\nodejs\\codexydsh.cmd'
  const states = [
    { managed: false, available: false, destination },
    { managed: true, available: true, destination, activeCommand: destination },
    { managed: true, available: false, destination },
    { managed: true, available: true, destination, activeCommand: other },
    { managed: false, available: false, destination, selectionUnknown: true },
  ]
  await expect(JSON.stringify({
    dialogs: states.map(state => presentCommandManagement(state, zh, platform)),
  }, null, 2) + '\n').toMatchFileSnapshot(`./expected/command-management-${platform}-zh-CN.json`)
})
