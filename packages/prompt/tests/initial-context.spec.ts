import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@codexydsh/runtime/llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { CodexWorldStateInput } from '@codexydsh/runtime'
import type { PromptAssembly } from '@codexydsh/runtime/prompt'
import { buildCodexfulInitialContext, captureCodexfulInitialContextAssembly } from '../src/initial-context.ts'
import { renderEnvironmentContext, renderEnvironmentDiff } from '../src/index.ts'

const worldState: CodexWorldStateInput = {
  environment: {
    snapshot: { cwd: '/work', shell: 'bash', date: '2026-09-30', timezone: 'UTC', network: '', filesystem: '<filesystem />', subagents: [] },
    fullText: '<environment_context>\n  <cwd>/work</cwd>\n  <shell>bash</shell>\n</environment_context>',
    diffText: () => '<environment_context>\n  <current_date>2026-09-30</current_date>\n</environment_context>',
  },
  permissions: { instructions: '<permissions instructions>\nask\n</permissions instructions>', prefixes: [['git', 'status']] },
  multiAgentRole: 'plain bundled root role',
}

const assembly: PromptAssembly = {
  sections: [], tools: [], variables: {}, contextSnapshotIntro: 'none',
  contexts: [
    { name: 'skills:one', role: 'developer', text: 'skill one' },
    { name: 'skills:two', role: 'developer', text: 'skill two' },
    { name: 'codexful:permissions', role: 'developer', text: 'outdated permissions' },
    { name: 'codexful:environment', text: 'environment delta' },
    { name: 'codexful-v2:multi-agent-role', role: 'developer', text: 'mixed role' },
  ],
}

describe('Codexful full compaction context', () => {
  it('detaches context entries and interpolation variables from the returned assembly', () => {
    const mutable: PromptAssembly = {
      sections: [], tools: [], variables: { skill: 'captured skill' }, contextSnapshotIntro: 'none',
      contexts: [{ name: 'skills', role: 'developer', text: '{{skill}}' }],
    }
    const captured = captureCodexfulInitialContextAssembly(mutable)
    expect(Object.isFrozen(captured)).toBe(true)
    expect(Object.isFrozen(captured.contexts)).toBe(true)
    expect(Object.isFrozen(captured.contexts[0])).toBe(true)
    expect(Object.isFrozen(captured.variables)).toBe(true)
    mutable.contexts[0]!.text = 'changed context'
    mutable.variables.skill = 'changed variable'
    mutable.contexts.splice(0)
    expect(buildCodexfulInitialContext(captured, worldState, [])[0]?.content)
      .toEqual([{ type: 'text', text: 'captured skill' }])
    const { contextSnapshotIntro: _intro, ...withoutIntro } = mutable
    expect(captureCodexfulInitialContextAssembly(withoutIntro)).not.toHaveProperty('contextSnapshotIntro')
  })

  it('rebuilds full permissions and environment, retaining ordinary blocks and standalone role/mode', () => {
    const instructions = createUserMessage({ content: [{ type: 'text', text: 'AGENTS' }], source: { kind: 'user' } })
    const captured = buildCodexfulInitialContext(assembly, worldState, [instructions], 'explicit')
    expect(captured.map(message => message.role)).toEqual(['developer', 'developer', 'developer', 'developer', 'user', 'user'])
    expect(captured[0]?.content).toEqual([{ type: 'text', text: 'skill one' }, { type: 'text', text: 'skill two' }])
    expect(captured[1]?.content).toHaveLength(1)
    expect(captured[1]?.content[0]).toHaveProperty('text', expect.stringContaining('- ["git", "status"]'))
    expect(captured[2]?.content).toEqual([{ type: 'text', text: 'plain bundled root role' }])
    expect(captured[2]?.source).toMatchObject({ codexMultiAgentWorldState: { section: 'multi-agent-role', mode: 'full', snapshot: 'plain bundled root role' } })
    expect(captured[3]?.source).toMatchObject({ codexMultiAgentWorldState: { section: 'multi-agent-mode', mode: 'full', snapshot: { body: 'explicit', role: 'plain bundled root role' } } })
    expect(captured[4]).toBe(instructions)
    expect(captured[5]?.content).toEqual([{ type: 'text', text: worldState.environment.fullText }])
    expect(captured[5]?.source).toMatchObject({ codexWorldState: { section: 'environment', mode: 'full', snapshot: worldState.environment.snapshot } })
    expect(JSON.stringify(captured)).not.toContain('environment delta')
    expect(JSON.stringify(captured)).not.toContain('outdated permissions')
  })

  it('retains frozen memory retrieval instructions when compaction builds a new context window', () => {
    const mutable: PromptAssembly = {
      ...assembly,
      contexts: [
        { name: 'codexful:memory:0', role: 'developer', interpolate: false, text: 'Read /memories/MEMORY.md for prior work. Keep {{cwd}} literal.' },
        { name: 'codexful:memory:1', role: 'developer', text: 'User preference: preserve user files.' },
      ],
    }
    const frozen = captureCodexfulInitialContextAssembly(mutable)
    mutable.contexts[0]!.text = 'A newer global summary must wait for another session.'
    const captured = buildCodexfulInitialContext(frozen, worldState, [])
    expect(captured[0]?.role).toBe('developer')
    expect(captured[0]?.content).toEqual([
      { type: 'text', text: 'Read /memories/MEMORY.md for prior work. Keep {{cwd}} literal.' },
      { type: 'text', text: 'User preference: preserve user files.' },
    ])
    expect(captured[0]?.source).toMatchObject({ kind: 'runtime-context', form: 'snapshot', sections: frozen.contexts.map(({ name, text }) => ({ name, text })) })
    expect(JSON.stringify(captured)).not.toContain('A newer global summary')
  })

  it('omits disabled delegation instead of carrying an old mode into the new window', () => {
    const { multiAgentRole: _previousRole, ...withoutRole } = worldState
    const captured = buildCodexfulInitialContext({ ...assembly, contexts: [] }, withoutRole, [])
    expect(captured.map(message => message.role)).toEqual(['developer', 'user'])
    expect(JSON.stringify(captured)).not.toContain('multi_agent')
  })

  it('restores ordinary user context before the full environment using captured variables and framing', () => {
    const captured = buildCodexfulInitialContext({
      contexts: [{ name: 'project:cwd', text: 'Project directory: {{cwd}}' }],
      variables: { cwd: '/captured/project' }, contextSnapshotIntro: 'none',
    }, worldState, [])
    expect(captured.map(message => message.role)).toEqual(['developer', 'developer', 'user', 'user'])
    expect(captured[2]?.content).toEqual([{ type: 'text', text: 'Project directory: /captured/project' }])
    expect(captured[2]?.source).toMatchObject({ kind: 'runtime-context', form: 'snapshot',
      sections: [{ name: 'project:cwd', text: 'Project directory: /captured/project' }],
    })
    expect(captured[3]?.content).toEqual([{ type: 'text', text: worldState.environment.fullText }])
  })

  it('restores the current legacy roster after compaction even when its change added no environment delta', () => {
    const legacySubagents = [{ id: SessionId('child'), nickname: 'Euclid', agentPath: '/root/research' }]
    const current = { ...worldState.environment.snapshot, legacySubagents }
    expect(renderEnvironmentDiff(current, worldState.environment.snapshot)).toBeUndefined()
    const fullText = renderEnvironmentContext({
      cwd: '/work', shell: 'bash', date: '2026-09-30', timezone: 'UTC',
      sandbox: { mode: 'danger-full-access', workspaceRoot: '/work' },
      approval: 'never', network: 'enabled', legacySubagents,
    })
    const captured = buildCodexfulInitialContext(assembly, {
      ...worldState,
      environment: { snapshot: current, fullText, diffText: previous => renderEnvironmentDiff(current, previous) },
    }, [])
    const environment = captured.at(-1)
    expect(environment?.content).toEqual([{ type: 'text', text: fullText }])
    expect(environment?.content[0]).toHaveProperty('text', expect.stringContaining('    - research: Euclid'))
    expect(environment?.source).toMatchObject({ codexWorldState: {
      section: 'environment', mode: 'full', snapshot: { subagents: [], legacySubagents },
    } })
    expect(JSON.stringify(captured)).not.toContain('environment delta')
  })
})
