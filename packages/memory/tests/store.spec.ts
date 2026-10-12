import { describe, expect, it } from 'vitest'
import { readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveConfig } from '../src/config.ts'
import { MemoryStore } from '../src/store.ts'
import { revisionOf, boundedText, redactSecrets, tokenBoundedText } from '../src/text.ts'
import { memoryInstructions } from '../src/prompts.ts'
import { memoryCitation, memoryPathsFromCommand } from '../src/usage.ts'
import { privateRoot } from './fixtures.ts'

async function store() { return new MemoryStore(resolveConfig({ root: await privateRoot() })) }

describe('private non-destructive memory files', () => {
  it('rejects hidden paths, traversal and symlinks without reading outside the namespace', async () => {
    const files = await store()
    await files.ready()
    await expect(files.read({ path: '../proof.txt' })).rejects.toThrow('relative public path')
    await expect(files.read({ path: '.state/current.json' })).rejects.toThrow('relative public path')
    if (process.platform !== 'win32') {
      await symlink('/etc/passwd', join(files.root, 'escape.md'))
      await expect(files.read({ path: 'escape.md' })).rejects.toThrow('symbolic links')
      expect((await files.list({})).entries).toEqual([])
    }
  })

  it('keeps complete predecessors and rejects stale edits', async () => {
    const files = await store()
    await files.create('MEMORY.md', 'old')
    await files.writing(() => files.replace('MEMORY.md', 'new', revisionOf('old')))
    expect(await files.text('MEMORY.md')).toBe('new')
    await expect(files.writing(() => files.replace('MEMORY.md', 'stale', revisionOf('old')))).rejects.toThrow('changed')
    const generation = (await files.internalNames('.history'))[0]
    expect(generation).toBeDefined()
    expect(await readFile(join(files.root, '.history', generation!, 'MEMORY.md'), 'utf8')).toBe('old')
  })

  it('holds one kernel writer lease across store instances and releases it to quiescence', async () => {
    const config = resolveConfig({ root: await privateRoot() })
    const first = new MemoryStore(config)
    const second = new MemoryStore(config)
    let release!: () => void
    let entered!: () => void
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
    const held = first.writing(async () => { entered(); await new Promise<void>((resolve) => { release = resolve }) })
    await enteredPromise
    try { await expect(second.writing(async () => {})).rejects.toThrow('already running') } finally { release(); await held }
    await expect(second.writing(async () => 'available')).resolves.toBe('available')
  })

  it('serves previous committed documents during publication and recovers interrupted files without deletion', async () => {
    const files = await store()
    await files.create('MEMORY.md', 'old')
    await files.create('.state/publishing.json', JSON.stringify({ state: 'publishing', documents: [
      { path: 'MEMORY.md', previous: 'old', next: 'new' }, { path: 'rollout_summaries/orphan.md', previous: null, next: 'orphan' },
    ] }))
    await writeFile(join(files.root, 'MEMORY.md'), 'new')
    await files.create('rollout_summaries/orphan.md', 'orphan')
    expect(await files.text('MEMORY.md')).toBe('old')
    expect(await files.text('rollout_summaries/orphan.md')).toBeUndefined()
    await files.writing(async () => {})
    expect(await readFile(join(files.root, 'MEMORY.md'), 'utf8')).toBe('old')
    expect(await readFile(join(files.root, 'rollout_summaries/orphan.md'), 'utf8')).toBe('orphan')
    expect(await files.text('rollout_summaries/orphan.md')).toBeUndefined()
  })

  it('preserves an external human correction discovered during crash recovery', async () => {
    const files = await store()
    await files.create('MEMORY.md', 'human correction')
    await files.create('.state/publishing.json', JSON.stringify({ state: 'publishing', documents: [{ path: 'MEMORY.md', previous: 'old', next: 'new' }] }))
    await files.writing(async () => {})
    expect(await files.text('MEMORY.md')).toBe('human correction')
  })

  it('reads line slices and matches any, same-line and bounded-window queries with pagination', async () => {
    const files = await store()
    await files.create('MEMORY.md', 'Alpha\nbeta\nalpha beta\nfoo_bar')
    expect(await files.read({ path: 'MEMORY.md', line_offset: 2, max_lines: 1 })).toMatchObject({ content: 'beta', start_line_number: 2, truncated: true })
    expect((await files.search({ queries: ['alpha', 'beta'], case_sensitive: false, match_mode: { type: 'all_on_same_line' } })).matches).toMatchObject([{ match_line_number: 3 }])
    expect((await files.search({ queries: ['Alpha', 'beta'], match_mode: { type: 'all_within_lines', line_count: 2 } })).matches).toMatchObject([{ match_line_number: 1 }])
    expect((await files.search({ queries: ['foo/bar'], normalized: true })).matches).toHaveLength(1)
    const page = await files.search({ queries: ['beta'], max_results: 1 })
    expect(page.next_cursor).toBe('1')
    expect((await files.search({ queries: ['beta'], cursor: page.next_cursor! })).matches).toMatchObject([{ match_line_number: 3 }])
  })

  it('soft-excludes inactive details from search while preserving exact old pointers', async () => {
    const files = await store()
    await files.create('rollout_summaries/active.md', 'active proof')
    await files.create('rollout_summaries/old.md', 'old proof')
    await files.create('.state/current.json', JSON.stringify({ documentHashes: { 'rollout_summaries/active.md': revisionOf('active proof') } }))
    expect((await files.list({ path: 'rollout_summaries' })).entries.map(entry => entry.path)).toEqual(['rollout_summaries/active.md'])
    expect((await files.search({ queries: ['proof'] })).matches.map(match => match.path)).toEqual(['rollout_summaries/active.md'])
    expect((await files.read({ path: 'rollout_summaries/old.md' })).content).toBe('old proof')
  })
})

describe('model-visible memory text', () => {
  it('preserves whole UTF-8 code points and bounds omission markers inside the allowance', () => {
    expect(boundedText('你你', 4)).toEqual({ text: '你', truncated: true })
    const result = tokenBoundedText('你好'.repeat(200), 40)
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(160)
    expect(result).not.toContain('�')
    expect(result).toContain('memory text truncated')
  })
  it('uses coherent V1/V2 instructions and leaves empty stores out of model context', () => {
    expect(memoryInstructions('v1', '/memory/memories', '', 2500)).toEqual([])
    expect(memoryInstructions('v1', '/memory/memories', 'Summary', 2500).join('')).toContain('Summary')
    const fragments = memoryInstructions('v2', '/memory/memories_v2', '你'.repeat(4000), 2500)
    expect(fragments.every(fragment => Buffer.byteLength(fragment) <= 8_900 && !fragment.includes('�'))).toBe(true)
  })
  it('redacts known credentials and only credits explicit safe reads or complete memory citations', () => {
    expect(redactSecrets('token=abcdefghijklmnop sk-abcdefghijklmnopqrstuvwxyz')).not.toContain('abcdefghijklmnop')
    expect(memoryPathsFromCommand('cat /memory/MEMORY.md', '/memory', '/workspace')).toEqual(['MEMORY.md'])
    expect(memoryPathsFromCommand('echo rm /memory/MEMORY.md', '/memory', '/workspace')).toEqual([])
    expect(memoryPathsFromCommand('cat $(echo /memory/MEMORY.md)', '/memory', '/workspace')).toEqual([])
    expect(memoryCitation('<oai-mem-citation><citation_entries>MEMORY.md:1-2|note=[proof]</citation_entries><rollout_ids>source\nsource</rollout_ids></oai-mem-citation>')).toEqual({ paths: ['MEMORY.md'], sessionIds: ['source'] })
  })
})
