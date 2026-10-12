import { assemblePrompt } from '@codexydsh/test-support/host-tools'
import { currentToolRequestBinding } from '@codexydsh/bridges/tools'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { ToolCallId } from '@codexydsh/runtime/llm'
import { SystemPrompt } from '@codexydsh/test-support/host-tools'
import { ToolRuntime } from '@codexydsh/test-support/host-tools'
import { TOOL_REQUEST_CAPTURE } from '@codexydsh/runtime/tools'
import type { ToolExecutionResult } from '@codexydsh/runtime/tools'
import LocalFileSystem from '@codexydsh/filesystem-local'
import { FsError } from '@codexydsh/filesystem'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as ToolFs from '@codexydsh/files'
import { applyUpdate, parsePatch } from '../src/patch-parser.ts'

class DenyingFileSystem extends LocalFileSystem {
  override get sandboxMode(): 'read-only' { return 'read-only' }
  override async deleteFile(): Promise<void> {
    throw new FsError('delete blocked by sandbox', 'FS_SANDBOX_DENIED')
  }
}

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function setup(only = false) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-codex-patch-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(ToolFs, { applyPatch: true, applyPatchOnly: only })
  let serial = 0
  const call = (patch: string) => ctx.codexyTools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`patch-${++serial}`),
    name: 'apply_patch',
    arguments: { patch },
  })
  return { root, ctx, call }
}

describe('Codex Begin Patch parser', () => {
  it('parses all file operations and ordered update chunks', () => {
    expect(parsePatch('*** Begin Patch\n*** Add File: a.txt\n+hello\n*** Delete File: b.txt\n*** Update File: c.txt\n*** Move to: d.txt\n@@ section\n-old\n+new\n*** End Patch')).toEqual([
      { kind: 'add', path: 'a.txt', content: 'hello\n' },
      { kind: 'delete', path: 'b.txt' },
      { kind: 'update', path: 'c.txt', moveTo: 'd.txt', chunks: [{ context: 'section', oldLines: ['old'], newLines: ['new'], endOfFile: false }] },
    ])
  })

  it('requires matching context and honors the end-of-file anchor', () => {
    expect(applyUpdate('a\nb\n', [{ oldLines: ['b'], newLines: ['c'], endOfFile: true }], 'file')).toBe('a\nc\n')
    expect(() => applyUpdate('a\nb\n', [{ oldLines: ['a'], newLines: ['c'], endOfFile: true }], 'file')).toThrow('Failed to find expected lines')
    expect(() => parsePatch('*** Begin Patch\n*** Update File: a\n@@\n-a\n+b')).toThrow('expected *** Begin Patch')
  })

  it('applies later chunks after earlier replacements in document order', () => {
    const [change] = parsePatch('*** Begin Patch\n*** Update File: file.txt\n@@ first\n-old first\n+new first\n@@ second\n-old second\n+new second\n*** End Patch')
    if (change?.kind !== 'update') throw new Error('expected update')
    expect(applyUpdate('first\nold first\nbetween\nsecond\nold second\n', change.chunks, change.path))
      .toBe('first\nnew first\nbetween\nsecond\nnew second\n')
  })

  it('matches trailing and surrounding whitespace after trying every exact position', () => {
    const chunk = (line: string) => [{ oldLines: [line], newLines: ['changed'], endOfFile: false }]
    expect(applyUpdate('first   \n', chunk('first'), 'file')).toBe('changed\n')
    expect(applyUpdate('  second  \n', chunk('second'), 'file')).toBe('changed\n')
    expect(applyUpdate(' target  \n target\n', chunk(' target'), 'file')).toBe(' target  \nchanged\n')
  })
})

describe('JSON apply_patch tool', () => {
  it('returns an empty program object after a real nested patch and preserves errors as errors', async () => {
    const { ctx, root } = await setup(true)
    let patch = '*** Begin Patch\n*** Add File: nested.txt\n+program write\n*** End Patch'
    let nested: ToolExecutionResult | undefined
    ctx.effect(() => ctx.codexyTools.register({
      name: 'program_caller', description: 'Program caller', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
      async execute(_args, exec) {
        const requestBinding = currentToolRequestBinding()
        if (requestBinding === undefined) throw new Error('expected a captured request binding')
        nested = await ctx.codexyTools.execute({
          name: 'apply_patch', arguments: { patch }, callId: ToolCallId('nested-patch'), signal: exec.signal,
          parent: exec.token, rootCallId: exec.rootCallId, requestBinding,
        })
        return 'program complete'
      },
    }))
    const capture = await ctx.codexyTools.prepareRequest({ context: {}, variables: {} })
    const assembly = await assemblePrompt(ctx, { [TOOL_REQUEST_CAPTURE]: capture })
    const binding = ctx.codexyTools.bindAssembly(capture,
      assembly.tools.filter(schema => schema.name === 'program_caller'),
      assembly.tools.filter(schema => schema.name === 'apply_patch'))
    const run = () => ctx.codexyTools.execute({ name: 'program_caller', arguments: {},
      callId: ToolCallId('root-patch'), signal: new AbortController().signal, requestBinding: binding })
    expect((await run()).isError).toBe(false)
    expect(nested?.isError).toBe(false)
    if (nested === undefined || nested.isError) throw new Error('expected successful nested tool')
    expect(nested?.codeModeValue).toEqual({})
    expect(nested?.content).toEqual([{ type: 'text', text: 'Success. Updated the following files:\nA nested.txt\n' }])
    expect(nested?.value).toMatchObject({ message: 'Success. Updated the following files:\nA nested.txt\n' })
    expect(await readFile(join(root, 'nested.txt'), 'utf8')).toBe('program write\n')
    patch = '*** Begin Patch\n*** Update File: nested.txt\n@@\n-absent\n+changed\n*** End Patch'
    expect((await run()).isError).toBe(false)
    expect(nested?.isError).toBe(true)
    expect(nested).not.toHaveProperty('codeModeValue')
    expect(await readFile(join(root, 'nested.txt'), 'utf8')).toBe('program write\n')
  })

  it('can expose apply_patch without the ordinary DSH file tools', async () => {
    const { ctx } = await setup(true)
    expect(ctx.codexyTools.get('apply_patch')).toBeDefined()
    const schema = ctx.codexyTools.schemas().find(tool => tool.name === 'apply_patch')
    if (schema === undefined || schema.kind === 'freeform') throw new Error('apply_patch must have a function schema')
    expect(schema.parameters.additionalProperties).toBe(false)
    for (const name of ['read', 'read_image', 'write', 'edit']) expect(ctx.codexyTools.get(name)).toBeUndefined()
  })

  it('adds, updates, moves, and deletes files inside its own temporary workspace', async () => {
    const { root, call } = await setup()
    await writeFile(join(root, 'old.txt'), 'first\nsecond\n')
    await writeFile(join(root, 'remove.txt'), 'remove me\n')
    const result = await call('*** Begin Patch\n*** Add File: new.txt\n+new content\n*** Update File: old.txt\n*** Move to: moved.txt\n@@\n first\n-second\n+changed\n*** Delete File: remove.txt\n*** End Patch')
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: 'Success. Updated the following files:\nA new.txt\nM moved.txt\nD remove.txt\n' }])
    expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('new content\n')
    expect(await readFile(join(root, 'moved.txt'), 'utf8')).toBe('first\nchanged\n')
    await expect(readFile(join(root, 'old.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(root, 'remove.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('matches Codex add and move replacement semantics for existing files', async () => {
    const { root, call } = await setup()
    await writeFile(join(root, 'add.txt'), 'old add\n')
    await writeFile(join(root, 'source.txt'), 'old source\n')
    await writeFile(join(root, 'destination.txt'), 'old destination\n')
    const result = await call('*** Begin Patch\n*** Add File: add.txt\n+new add\n*** Update File: source.txt\n*** Move to: destination.txt\n@@\n-old source\n+new source\n*** End Patch')
    expect(result.isError).toBe(false)
    expect(await readFile(join(root, 'add.txt'), 'utf8')).toBe('new add\n')
    expect(await readFile(join(root, 'destination.txt'), 'utf8')).toBe('new source\n')
  })

  it('returns parser and unmatched-context errors to the model without changing the file', async () => {
    const { root, call } = await setup()
    await writeFile(join(root, 'source.txt'), 'original\n')
    const malformed = await call('*** Begin Patch\n*** Update File: source.txt\n@@\n-original\n+changed')
    expect(malformed.isError).toBe(true)
    const mismatch = await call('*** Begin Patch\n*** Update File: source.txt\n@@\n-missing\n+changed\n*** End Patch')
    expect(mismatch.isError).toBe(true)
    expect(await readFile(join(root, 'source.txt'), 'utf8')).toBe('original\n')
  })

  it('verifies every change before writing the first file', async () => {
    const { root, call } = await setup()
    const result = await call('*** Begin Patch\n*** Add File: added.txt\n+new\n*** Update File: missing.txt\n@@\n-before\n+after\n*** End Patch')
    expect(result.isError).toBe(true)
    expect(result.content.some(block => block.type === 'text' && block.text.includes('cannot update'))).toBe(true)
    await expect(readFile(join(root, 'added.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects repeated file operations before writing the first change', async () => {
    const { root, call } = await setup()
    const result = await call('*** Begin Patch\n*** Add File: repeated.txt\n+first\n*** Add File: repeated.txt\n+second\n*** End Patch')
    expect(result.isError).toBe(true)
    expect(result.content.some(block => block.type === 'text' && block.text.includes('multiple operations target'))).toBe(true)
    await expect(readFile(join(root, 'repeated.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports a partial move when source removal fails after writing the destination', async () => {
    const { root, ctx, call } = await setup()
    await writeFile(join(root, 'source.txt'), 'before\n')
    const remove = ctx.codexyFs.deleteFile.bind(ctx.codexyFs)
    ctx.codexyFs.deleteFile = async () => { throw new Error('simulated removal failure') }
    try {
      const result = await call('*** Begin Patch\n*** Update File: source.txt\n*** Move to: destination.txt\n@@\n-before\n+after\n*** End Patch')
      expect(result.isError).toBe(true)
      expect(result.content.some(block => block.type === 'text' && block.text.includes('both files may remain'))).toBe(true)
      expect(await readFile(join(root, 'source.txt'), 'utf8')).toBe('before\n')
      expect(await readFile(join(root, 'destination.txt'), 'utf8')).toBe('after\n')
    } finally {
      ctx.codexyFs.deleteFile = remove
    }
  })

  it('rejects a move back onto the source identity without removing it', async () => {
    const { root, call } = await setup()
    await writeFile(join(root, 'same.txt'), 'before\n')
    const result = await call('*** Begin Patch\n*** Update File: same.txt\n*** Move to: same.txt\n@@\n-before\n+after\n*** End Patch')
    expect(result.isError).toBe(true)
    expect(await readFile(join(root, 'same.txt'), 'utf8')).toBe('before\n')
  })

  it('returns a sandbox denial for deletion while preserving the file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-codex-patch-sandbox-'))
    roots.push(root)
    const path = join(root, 'keep.txt')
    await writeFile(path, 'keep\n')
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: root })
    await ctx.plugin(DenyingFileSystem, { cwd: root })
    await ctx.plugin(ToolFs, { applyPatch: true, applyPatchOnly: true })
    const result = await ctx.codexyTools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('patch-sandbox-denial'),
      name: 'apply_patch',
      arguments: { patch: '*** Begin Patch\n*** Delete File: keep.txt\n*** End Patch' },
    })
    expect(result.isError).toBe(true)
    expect(result.content.some(block => block.type === 'text' && block.text.includes('[sandbox: file access denied under read-only mode]'))).toBe(true)
    expect(await readFile(path, 'utf8')).toBe('keep\n')
  })
})
