// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StartedToolCall, ToolResultNode } from '@codexydsh/ui-chat/client'
import { useDisclosure } from '@codexydsh/ui-chat/src/client/chat/use-disclosure.ts'
import { makeTranslate } from '@codexydsh/test-support/client'
import { en } from '@codexydsh/ui-conversation/src/client/locales.ts'
import { commonEn } from '@codexydsh/test-support/client'
import { codexShellModel } from '../src/client/tool/models/codex-shell-model.ts'
import { CodexShellRow } from '../src/client/tool/toolviews/codex-shell-row.tsx'

afterEach(cleanup)

const command = "ls subagent\nrg -n 'subagent|collaboration' cordis.patch.yml\nsed -n '1,160p' cordis.patch.yml"

function running(cmd = command): StartedToolCall {
  return { phase: 'start', callId: 'explore', name: 'exec_command', argsRaw: JSON.stringify({ cmd }), turn: 1, step: 1, time: 1, subCalls: [] }
}

function result(cmd = command, output = 'files found', exitCode = 0): ToolResultNode {
  return {
    kind: 'tool-result', seq: 4, time: 2, callId: 'explore', callTime: 1,
    call: { name: 'exec_command', argsRaw: JSON.stringify({ cmd }) },
    content: [{ type: 'text', text: `Chunk ID: a\nWall time: 0.1234 seconds\nProcess exited with code ${exitCode}\nOriginal token count: 8\nOutput:\n${output}` }],
    isError: false, subCalls: [],
  }
}

function props(block: StartedToolCall | ToolResultNode): Parameters<typeof CodexShellRow>[0] {
  return {
    callId: block.callId, toolName: 'exec_command',
    ...('kind' in block ? { phase: 'result' as const, block } : { phase: 'start' as const, block }),
    useShellHistory: selector => selector(undefined),
    useDisclosure, openFile: vi.fn(), t: makeTranslate(en, commonEn), inspect: vi.fn(),
  } as Parameters<typeof CodexShellRow>[0]
}

describe('Codex shell activity', () => {
  it('shows inspection steps as a tree, while retaining full command and output behind disclosure', () => {
    const view = render(<CodexShellRow {...props(result())} />)
    const toggle = view.getByRole('button', { name: /Explored/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(view.getByText('3 actions')).toBeTruthy()
    expect(view.queryByText('List')).toBeNull()
    fireEvent.click(toggle)
    expect(view.getByText('List')).toBeTruthy()
    expect(view.getByText('Search')).toBeTruthy()
    expect(view.getByText('Read')).toBeTruthy()
    expect(view.getByText('subagent|collaboration · cordis.patch.yml')).toBeTruthy()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(view.getByText('files found')).toBeTruthy()
    expect(view.container.querySelector('[data-command-source]')?.textContent).toBe(command)
    expect(view.getByText('0.1234s')).toBeTruthy()
    expect(view.getByRole('button', { name: 'Copy' })).toBeTruthy()
    expect(view.getByRole('button', { name: 'Copy command' })).toBeTruthy()
    fireEvent.click(toggle)
    expect(view.queryByText('files found')).toBeNull()
  })

  it('retains nonzero exit status and stderr on ordinary command rows', () => {
    const view = render(<CodexShellRow {...props(result('pnpm test', 'assertion failed', 1))} />)
    expect(view.getByRole('status').textContent).toBe('Failed')
    expect(view.queryByText('assertion failed')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: /Ran/ }))
    expect(view.getByText('assertion failed')).toBeTruthy()
    expect(view.getByText('exit code 1')).toBeTruthy()
  })

  it('expands once to a bounded preview and routes longer output to the inspector', () => {
    const output = Array.from({ length: 30 }, (_, i) => `result ${i + 1}`).join('\n')
    const input = props(result('python script.py', output))
    const view = render(<CodexShellRow {...input} />)
    expect(view.queryByText('result 1')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: /Ran/ }))
    expect(view.getByText('result 1')).toBeTruthy()
    expect(view.getByText('result 30')).toBeTruthy()
    expect(view.queryByText('result 10')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Command details', exact: true }))
    expect(input.inspect).toHaveBeenCalledOnce()
    expect(view.queryByText('result 10')).toBeNull()
  })

  it('caps long lines without an inner scrollbar and preserves the full copy payload', () => {
    const output = 'x'.repeat(1000)
    const view = render(<CodexShellRow {...props(result('python script.py', output))} />)
    fireEvent.click(view.getByRole('button', { name: /Ran/ }))
    expect(view.queryByText(output)).toBeNull()
    expect(view.getByText(`${'x'.repeat(120)} … ${'x'.repeat(120)}`)).toBeTruthy()
  })

  it('does not classify shell substitutions, pipes, or mixed programs as read-only exploration', () => {
    for (const cmd of ['cat file | python run.py', 'cat file && pnpm test', 'cat $(whoami)', 'cat file; echo changed > output', "sed -i 's/a/b/' file", 'find . -delete']) {
      expect(codexShellModel('exec_command', running(cmd))?.entries).toEqual([])
    }
    expect(codexShellModel('exec_command', running("cat 'a;b'"))?.entries).toEqual([{ kind: 'read', detail: 'a;b' }])
    expect(codexShellModel('exec_command', running('ls'))?.entries).toEqual([{ kind: 'list', detail: '.' }])
  })

  it('groups labeled inspection pipelines as exploration', () => {
    const command = 'cd /home/yuxd/repos/expr-graph-link && echo "=== faiss_tool 用法 ===" && grep -n "用法\\|usage\\|使用" build_graph/convert/faiss/faiss_tool.cpp | head && sed -n \'1,30p\' build_graph/convert/faiss/faiss_tool.cpp && echo "=== build_graph/scripts/build_faiss_tool.sh ===" && cat build_graph/scripts/build_faiss_tool.sh'
    expect(codexShellModel('exec_command', running(command))?.entries).toEqual([
      { kind: 'search', detail: '用法|usage|使用 · build_graph/convert/faiss/faiss_tool.cpp' },
      { kind: 'read', detail: 'build_graph/convert/faiss/faiss_tool.cpp' },
      { kind: 'read', detail: 'build_graph/scripts/build_faiss_tool.sh' },
    ])
    expect(codexShellModel('exec_command', running('printf "heading"; cat README.md'))?.entries)
      .toEqual([{ kind: 'read', detail: 'README.md' }])
  })

  it('never treats exit-looking output as execution metadata', () => {
    const model = codexShellModel('exec_command', result('echo test', 'Process exited with code 9'))
    expect(model?.exitCode).toBe(0)
    expect(model?.state).toBe('ok')
    expect(model?.output).toBe('Process exited with code 9')
  })

  it('labels an executing command and a retained background process distinctly', () => {
    const view = render(<CodexShellRow {...props(running('pnpm dev'))} />)
    expect(view.getByRole('status').textContent).toBe('Running')
    const active = result('pnpm dev')
    view.rerender(<CodexShellRow {...props({ ...active, content: [{ type: 'text', text: 'Chunk ID: a\nWall time: 1 seconds\nProcess running with session ID 42\nOutput:\nready' }] })} />)
    expect(view.getByRole('status').textContent).toBe('Process still running')
  })
})
