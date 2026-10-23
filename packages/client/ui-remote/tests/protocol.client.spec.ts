import { expect, it } from 'vitest'
import { acceptsFrameOrigin, frameTargetOrigin, snapshotSchema } from '../src/client/protocol.ts'

it('keeps Web origins exact while supporting the privileged Desktop origin serialization', () => {
  const web = { origin: 'http://127.0.0.1:3082', protocol: 'http:', host: '127.0.0.1:3082' }
  expect(acceptsFrameOrigin(web.origin, web)).toBe(true)
  expect(acceptsFrameOrigin('http://other-host:3082', web)).toBe(false)
  expect(acceptsFrameOrigin('null', web)).toBe(false)
  const desktop = { origin: 'null', protocol: 'dsh-app:', host: 'app' }
  expect(acceptsFrameOrigin('null', desktop)).toBe(true)
  expect(acceptsFrameOrigin('dsh-app://app', desktop)).toBe(true)
  expect(acceptsFrameOrigin('dsh-app://other', desktop)).toBe(false)
  expect(frameTargetOrigin(desktop)).toBe('*')
  expect(acceptsFrameOrigin('null', { origin: 'null', protocol: 'file:', host: '' })).toBe(false)
})

it('restores native required optional-valued group fields after JSON and omits absent optional properties', () => {
  const value = snapshotSchema.parse({ selectedSessionId: undefined, home: undefined, groups: [{
    key: '', label: '', expanded: true, containsCurrent: false, sessionCount: 1,
    sessions: [{ id: 's', title: '', blank: false, running: false, runningSubagentCount: 0,
      completed: false, pinned: false, archived: false, updatedAt: 1, pendingInteraction: undefined }],
  }] })
  expect(value).not.toHaveProperty('selectedSessionId')
  expect(value).not.toHaveProperty('home')
  expect(value.groups[0]).toHaveProperty('workspaceId', undefined)
  expect(value.groups[0]).toHaveProperty('cwd', undefined)
  expect(value.groups[0]).toHaveProperty('createdAt', undefined)
  expect(value.groups[0]?.sessions[0]).not.toHaveProperty('pendingInteraction')
})
