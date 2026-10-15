import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@codexydsh/runtime/llm'
import { SystemPrompt, ToolRuntime } from '@codexydsh/test-support/host-tools'
import LocalSubprocessRuntime from '@codexydsh/processes'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import ApprovalService from '@codexydsh/approval'
import * as ToolBash from '@codexydsh/exec'
import * as ExecPolicy from '@codexydsh/exec-policy'
import { formatCodexExecReviewDenied } from '../src/codex-rejection.ts'

const fixture: { argv: string[]; reason: string; expected: string; expectedSha256: string } = JSON.parse(await readFile(
  new URL('./fixtures/codex-0.162.1-command-denial.json', import.meta.url), 'utf8'))
const quoteCases: { word: string; quoted: string }[] = JSON.parse(await readFile(
  new URL('./fixtures/shlex-1.3.0-quote-cases.json', import.meta.url), 'utf8'))
const unicodeFixture: { argv: string[]; reason: string; expected: string } = JSON.parse(await readFile(
  new URL('./fixtures/codex-0.162.1-unicode-denial.json', import.meta.url), 'utf8'))
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  vi.restoreAllMocks()
})

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(ShellEnv)
  await ctx.plugin(LocalBashExecutor, {})
  await ctx.plugin(ApprovalService, { policy: 'never' })
  await ctx.plugin(ToolBash, { toolFormat: 'codex' })
  await ctx.plugin(ExecPolicy)
  return ctx
}

describe('pinned Codex review-denial error content', () => {
  it.each(quoteCases)('preserves the shlex 1.3.0 primary quote oracle for $word', ({ word, quoted }) => {
    const rendered = formatCodexExecReviewDenied([word], 'blocked by policy')
    const message = /^exec_command failed: CreateProcess \{ message: (.*) \}$/u.exec(rendered)?.[1]
    if (message === undefined) throw new Error('missing native CreateProcess message')
    const rejected: string = JSON.parse(message)
    expect(JSON.parse(rejected.slice('Rejected('.length, -1))).toBe(`\`${quoted}\` rejected: blocked by policy`)
  })

  it('escapes non-ASCII whitespace with native Rust Debug scalar notation', () => {
    const rendered = formatCodexExecReviewDenied(['/bin/bash', '-c', 'rm -f target'], 'no\u00a0space\u1680here')
    const message = /^exec_command failed: CreateProcess \{ message: (.*) \}$/u.exec(rendered)?.[1]
    if (message === undefined) throw new Error('missing native CreateProcess message')
    const rejected: string = JSON.parse(message)
    expect(rejected).toContain('no\\u{a0}space\\u{1680}here')
    expect(rendered).not.toContain('\u00a0')
    expect(rendered).not.toContain('\u1680')
  })

  it('uses the Rust Debug Grapheme_Extend rule for combining marks and variation selectors', () => {
    const rendered = formatCodexExecReviewDenied(['/bin/bash', '-c', 'rm -f target'], 'a\u0301\ufe0f\u09be\u093e')
    const message = /^exec_command failed: CreateProcess \{ message: (.*) \}$/u.exec(rendered)?.[1]
    if (message === undefined) throw new Error('missing native CreateProcess message')
    const rejected: string = JSON.parse(message)
    expect(rejected).toContain('a\\u{301}\\u{fe0f}\\u{9be}\u093e')
  })

  it('preserves native UTF-8 prefix/suffix boundaries and Unicode scalar removal counts', () => {
    const rendered = formatCodexExecReviewDenied(unicodeFixture.argv, unicodeFixture.reason)
    expect(rendered).toBe(unicodeFixture.expected)
    expect(rendered).not.toContain('\ufffd')
  })

  it('matches all 926 observed native bytes for the long multiline Anko command', () => {
    const actual = formatCodexExecReviewDenied(fixture.argv, fixture.reason)
    expect(actual).toBe(fixture.expected)
    expect(createHash('sha256').update(actual).digest('hex')).toBe(fixture.expectedSha256)
    expect(actual).toContain('…6168 chars truncated…')
  })

  it('keeps the real policy denial before spawn and returns the exact native content without a generic Error prefix', async () => {
    const ctx = await setup()
    const spawn = vi.spyOn(ctx.subprocess, 'spawn')
    const result = await ctx.codexyTools.execute({
      name: 'exec_command', arguments: { cmd: fixture.argv[2]!, shell: fixture.argv[0]!, login: true },
      callId: ToolCallId('native-observed-denial'), signal: new AbortController().signal,
    })
    expect(spawn).not.toHaveBeenCalled()
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'codex-exec-review-rejected' } } })
    expect(result.content).toEqual([{ type: 'text', text: fixture.expected }])
  })

  it('rejects a short command before its leading write or deletion runs', async () => {
    const ctx = await setup()
    const root = await mkdtemp(join(tmpdir(), 'codex-denial-keeps-files-'))
    const sentinel = join(root, 'sentinel'), before = join(root, 'before-denial')
    await writeFile(sentinel, 'keep')
    const spawn = vi.spyOn(ctx.subprocess, 'spawn')
    const cmd = `printf changed > ${before}; rm -f ${sentinel}`
    const result = await ctx.codexyTools.execute({ name: 'exec_command', arguments: { cmd, shell: '/bin/bash', login: false },
      callId: ToolCallId('short-command-denial'), signal: new AbortController().signal })
    expect(spawn).not.toHaveBeenCalled()
    expect(await readFile(sentinel, 'utf8')).toBe('keep')
    await expect(readFile(before)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: formatCodexExecReviewDenied(['/bin/bash', '-c', cmd], fixture.reason) }])
  })

  it('leaves an unrelated validation failure in its existing generic error format', async () => {
    const ctx = await setup()
    const spawn = vi.spyOn(ctx.subprocess, 'spawn')
    const result = await ctx.codexyTools.execute({ name: 'exec_command', arguments: { cmd: '' },
      callId: ToolCallId('invalid-command'), signal: new AbortController().signal })
    expect(spawn).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: cmd must be a non-empty command' }])
  })
})
