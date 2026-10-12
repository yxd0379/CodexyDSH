/** MCP draft edits preserve write-only credentials and validate process arguments. */
import { describe, expect, it } from 'vitest'
import { draftOf, draftOperations } from '../src/client/model.ts'

describe('MCP server drafts', () => {
  it('writes ordinary fields without overwriting saved authentication', () => {
    const draft = draftOf(3, { serverName: 'docs', transport: 'stdio', autoConnect: true, command: 'node', args: ['server.mjs'] })
    expect(draft.secrets).toBe('')
    expect(draftOperations(draft).map(operation => operation.path)).not.toContainEqual(['servers', 'docs', 'env'])
    expect(draftOperations({ ...draft, secrets: '{}' })).toContainEqual({ op: 'set', path: ['servers', 'docs', 'env'], value: {} })
  })

  it('accepts named stdio and HTTP servers with authentication', () => {
    const draft = { ...draftOf(0), serverName: 'docs', command: 'npx', args: '["-y", "example"]', secrets: '{"API_KEY":"secret"}' }
    expect(draftOperations(draft)).toContainEqual({ op: 'set', path: ['servers', 'docs', 'args'], value: ['-y', 'example'] })
    expect(draftOperations({ ...draft, transport: 'streamable-http', url: 'https://example.com/mcp' }))
      .toContainEqual({ op: 'set', path: ['servers', 'docs', 'headers'], value: { API_KEY: 'secret' } })
  })

  it.each([
    { serverName: 'invalid name' }, { command: '' }, { args: '[1]' }, { secrets: '{"KEY":1}' },
    { transport: 'streamable-http' as const, url: 'ftp://example.com' },
    { transport: 'streamable-http' as const, url: 'https://user:secret@example.com' },
    { transport: 'streamable-http' as const, url: 'invalid-url' }, { args: '[invalid-json' },
  ])('rejects malformed edits %j', (patch) => {
    expect(() => draftOperations({ ...draftOf(0), serverName: 'docs', command: 'node', ...patch })).toThrow()
  })
})
