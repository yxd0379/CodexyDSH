import type {} from '@codexydsh/instructions'
import { describe, expect, it } from 'vitest'
import { createDeveloperMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@codexydsh/runtime/llm'
import type { RequestMessage } from '@codexydsh/runtime/llm'
import { groupStrictCodexfulInput } from '../src/strict-input.ts'

function inputItem(message: RequestMessage) {
  return {
    type: 'message', role: message.role, id: `msg_${message.id}`,
    content: message.content.map((block) => {
      if (block.type !== 'text') throw new Error('missing context text')
      return { type: 'input_text', text: block.text }
    }),
  }
}

function ordinaryDeveloper(...texts: string[]) {
  return createDeveloperMessage({
    content: texts.map(text => ({ type: 'text', text })),
    source: { kind: 'runtime-context', form: 'snapshot', sections: texts.map((text, index) => ({ name: `codexful:section:${index}`, text })) },
  })
}

function permissions(mode: 'full' | 'delta') {
  const text = `${mode} permissions`
  return createDeveloperMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'codexful:world-state:permissions', text }],
      codexWorldState: { section: 'permissions', mode, snapshot: { instructions: text, prefixes: [] } },
    },
  })
}

function agentRole(mode: 'full' | 'delta', text = 'You are the root agent.') {
  return createDeveloperMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'codexful-v2:multi-agent-role', text }],
      codexMultiAgentWorldState: { section: 'multi-agent-role', mode, snapshot: text },
    },
  })
}

function agentMode(mode: 'full' | 'delta') {
  const text = '<multi_agent_mode>Delegation is active.</multi_agent_mode>'
  return createDeveloperMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'codexful-v2:multi-agent-mode', text }],
      codexMultiAgentWorldState: { section: 'multi-agent-mode', mode, snapshot: { body: 'Delegation is active.', role: 'You are the root agent.' } },
    },
  })
}

describe('Codexful strict Responses input', () => {
  const instructions = createUserMessage({
    content: [{ type: 'text', text: '# AGENTS.md instructions\n\n<INSTRUCTIONS>Rule.</INSTRUCTIONS>' }],
    source: { kind: 'agent-instructions', form: 'instructions', changes: [] },
  })
  const environment = createUserMessage({
    content: [{ type: 'text', text: '<environment_context>\n  <cwd>/work</cwd>\n</environment_context>' }],
    source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'codexful:environment', text: '<environment_context>\n  <cwd>/work</cwd>\n</environment_context>' }] },
  })
  const task = createUserMessage({ content: [{ type: 'text', text: 'Run pwd.' }], source: { kind: 'user' } })
  const input = [instructions, environment, task].map(message => ({
    type: 'message', role: 'user', id: `msg_${message.id}`,
    content: [{ type: 'input_text', text: message.content[0]?.type === 'text' ? message.content[0].text : '' }],
  }))

  it('keeps one durable AGENTS item ID and both text blocks in native order', () => {
    const payload = { input }
    const grouped = groupStrictCodexfulInput(payload, [instructions, environment, task])
    expect(grouped.input).toEqual([
      { ...input[0], content: [...input[0]!.content, ...input[1]!.content] },
      input[2],
    ])
    expect(payload.input).toEqual(input)
  })

  it('rejects a converter that separates the logged adjacent contexts', () => {
    expect(() => groupStrictCodexfulInput({ input: [input[0], input[2], input[1]] },
      [instructions, environment, task])).toThrow('separated adjacent mergeable context items')
  })

  it('preserves each ordinary developer fragment before separate initial role and mode items', () => {
    const context = ordinaryDeveloper('Skills.', 'Coding conventions.')
    const permission = permissions('full')
    const role = agentRole('full')
    const mode = agentMode('full')
    const messages = [context, permission, role, mode, instructions, environment, task]
    const items = messages.map(inputItem)
    const payload = { input: items }
    const grouped = groupStrictCodexfulInput(payload, messages)
    expect(grouped.input).toEqual([
      { ...items[0], content: [...items[0]!.content, ...items[1]!.content] },
      items[2], items[3],
      { ...items[4], content: [...items[4]!.content, ...items[5]!.content] },
      items[6],
    ])
    expect(groupStrictCodexfulInput(payload, messages)).toEqual(grouped)
    expect(payload.input).toEqual(items)
  })

  it('groups a restored compacted developer context from its retained sections without rewriting its source', () => {
    const original = ordinaryDeveloper('Skills.', 'Coding conventions.')
    const compacted = createDeveloperMessage({ content: original.content,
      source: { ...original.source, form: 'instructions' } })
    const permission = permissions('full')
    const messages = [compacted, permission, task]
    const before = structuredClone(messages)
    const items = messages.map(inputItem)
    expect(groupStrictCodexfulInput({ input: items }, messages).input).toEqual([
      { ...items[0], content: [...items[0]!.content, ...items[1]!.content] }, items[2],
    ])
    expect(messages).toEqual(before)
    expect(compacted.source).toMatchObject({ form: 'instructions', sections: [
      { name: 'codexful:section:0', text: 'Skills.' }, { name: 'codexful:section:1', text: 'Coding conventions.' },
    ] })
  })

  it('does not infer a mergeable group for unattributed instructions or user-role developer fallback', () => {
    const ungrouped = createDeveloperMessage({ content: [{ type: 'text', text: 'Unattributed instructions.' }],
      source: { kind: 'runtime-context', form: 'instructions' } })
    const original = ordinaryDeveloper('Compacted skills.')
    const fallback = createUserMessage({ content: original.content, source: { ...original.source, form: 'instructions' } })
    for (const middle of [ungrouped, fallback]) {
      const messages = [permissions('full'), middle, permissions('delta')]
      const items = messages.map(inputItem)
      expect(groupStrictCodexfulInput({ input: items }, messages).input).toEqual(items)
    }
  })

  it('merges adjacent developer permission and mode deltas while keeping the role delta separate', () => {
    const permission = permissions('delta')
    const mode = agentMode('delta')
    const role = agentRole('delta', '<multi_agent_role>Updated root role.</multi_agent_role>')
    const later = ordinaryDeveloper('Later developer instructions.')
    const laterPermissions = permissions('delta')
    const messages = [permission, mode, role, later, laterPermissions, task]
    const items = messages.map(inputItem)
    expect(groupStrictCodexfulInput({ input: items }, messages).input).toEqual([
      { ...items[0], content: [...items[0]!.content, ...items[1]!.content] },
      items[2],
      { ...items[3], content: [...items[3]!.content, ...items[4]!.content] },
      items[5],
    ])
  })

  it.each(['codexful-v2:multi-agent-role', 'codexful-v2:multi-agent-mode'])(
    'treats legacy %s snapshots and restored instructions without world-state metadata as separate items', (name) => {
      for (const form of ['snapshot', 'instructions'] as const) {
        const before = ordinaryDeveloper('Before.')
        const legacy = createDeveloperMessage({
          content: [{ type: 'text', text: 'Legacy delegation instructions.' }],
          source: { kind: 'runtime-context', form, sections: [{ name, text: 'Legacy delegation instructions.' }] },
        })
        const after = permissions('delta')
        const messages = [before, legacy, after]
        const items = messages.map(inputItem)
        expect(groupStrictCodexfulInput({ input: items }, messages).input).toEqual(items)
      }
    },
  )

  it('keeps tasks, tool results, unrelated developer history, and role changes between context groups', () => {
    const permission = permissions('delta')
    const mode = agentMode('delta')
    const unrelated = createDeveloperMessage({
      content: [{ type: 'text', text: 'Historical developer message.' }],
      source: { kind: 'model', provider: 'local', model: 'qwen3.8' },
    })
    const tool = createToolResultMessage({ callId: ToolCallId('call_test'), content: [{ type: 'text', text: 'tool result' }], isError: false })
    for (const middle of [task, tool, unrelated, environment]) {
      const messages = [permission, middle, mode]
      const items = [inputItem(permission), middle.role === 'tool'
        ? { type: 'function_call_output', id: `fco_${middle.id}`, call_id: middle.toolCallId, output: 'tool result' }
        : inputItem(middle), inputItem(mode)]
      expect(groupStrictCodexfulInput({ input: items }, messages).input).toEqual(items)
    }
  })

  it('uses source ownership rather than delegation-looking instruction text', () => {
    const context = ordinaryDeveloper('<multi_agent_role>Quoted example.</multi_agent_role>', 'Coding conventions.')
    const permission = permissions('full')
    const messages = [context, permission]
    const items = messages.map(inputItem)
    expect(groupStrictCodexfulInput({ input: items }, messages).input).toEqual([
      { ...items[0], content: [...items[0]!.content, ...items[1]!.content] },
    ])
  })

  it('rejects altered developer fragment count and content before grouping', () => {
    const context = ordinaryDeveloper('First.', 'Second.')
    const permission = permissions('full')
    const first = inputItem(context)
    const second = inputItem(permission)
    for (const changed of [
      { ...first, content: [{ type: 'input_text', text: 'First.Second.' }] },
      { ...first, content: [{ type: 'input_text', text: 'First.' }, { type: 'input_text', text: 'changed' }] },
    ]) {
      expect(() => groupStrictCodexfulInput({ input: [changed, second] }, [context, permission])).toThrow()
    }
  })

  it('sends historical assistant output text with only Codex ContentItem fields', () => {
    const assistant = {
      type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: 'working', annotations: [] }],
    }
    const payload = { input: [...input, assistant] }
    const grouped = groupStrictCodexfulInput(payload, [instructions, environment, task])
    expect(grouped.input).toEqual([
      { ...input[0], content: [...input[0]!.content, ...input[1]!.content] },
      input[2],
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'working' }] },
    ])
    expect(payload.input[3]).toEqual(assistant)
  })
})
