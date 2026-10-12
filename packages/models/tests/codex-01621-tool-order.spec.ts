/** Pure product ordering; no server, model, account or filesystem mutation. */
import { describe, expect, it } from 'vitest'
import { orderCodex01621Tools } from '../src/codex-01621-tool-order.ts'

const fn = (name: string) => ({ type: 'function', name, description: `original ${name}`, parameters: { type: 'object', properties: {} }, strict: false })
const namespace = () => ({ type: 'namespace', name: 'multi_agent_v1', description: 'original namespace',
  tools: ['spawn_agent', 'send_input', 'resume_agent', 'wait_agent', 'close_agent'].map(fn) })

describe('explicit Codex 0.162.1 declaration order', () => {
  it('restores the source-driven V5 native top-level and namespace ordering without changing declarations', () => {
    const original = { input: ['unchanged'], tools: [fn('get_goal'), fn('create_goal'), fn('update_goal'),
      { type: 'web_search', search_context_size: 'high' }, fn('view_image'), fn('write_stdin'), fn('exec_command'), fn('request_user_input'), namespace()] }
    const before = structuredClone(original)
    const result = orderCodex01621Tools(original, 'codex-0.162.1')
    const tools = result['tools'] as Record<string, unknown>[]
    expect(tools.map(tool => tool['name'] ?? tool['type'])).toEqual([
      'exec_command', 'write_stdin', 'request_user_input', 'view_image', 'multi_agent_v1',
      'get_goal', 'create_goal', 'update_goal', 'web_search',
    ])
    expect((tools[4]!['tools'] as { name: string }[]).map(tool => tool.name)).toEqual([
      'close_agent', 'resume_agent', 'send_input', 'spawn_agent', 'wait_agent',
    ])
    for (const tool of tools) if (tool['type'] !== 'namespace') expect(original.tools).toContain(tool)
    expect(tools[4]).toEqual({ ...original.tools[8] as object, tools: (original.tools[8] as ReturnType<typeof namespace>).tools.toSorted((a, b) => a.name < b.name ? -1 : 1) })
    expect(result['input']).toBe(original.input)
    expect(original).toEqual(before)
  })

  it.each([undefined, 'codex-other'])('leaves generic profiles and their original namespace order unchanged (%s)', profile => {
    const original = { tools: [fn('update_goal'), namespace(), fn('exec_command')] }
    expect(orderCodex01621Tools(original, profile)).toBe(original)
  })

  it('retains unknown/custom/product tools, duplicates and a separate local web_search function', () => {
    const extras = [fn('schedule'), { type: 'custom', name: 'product_custom', format: { type: 'text' }, extension: true },
      fn('web_search'), { type: 'namespace', name: 'unknown_namespace', tools: [fn('z'), fn('a')] },
      { type: 'future_hosted', unknown: ['exact'] }, fn('multi_agent_v1')]
    const duplicate = fn('exec_command')
    const original = { tools: [extras[0], { type: 'web_search' }, duplicate, ...extras.slice(1), duplicate, fn('write_stdin')] }
    const result = orderCodex01621Tools(original, 'codex-0.162.1')['tools'] as Record<string, unknown>[]
    expect(result).toHaveLength(original.tools.length)
    expect(result.filter(tool => tool === duplicate)).toHaveLength(2)
    expect(result.slice(3, -1).map(tool => tool['name'] ?? tool['type'])).toEqual(extras.map(tool => tool.name ?? tool.type))
    expect(result.at(-1)).toEqual({ type: 'web_search' })
    expect(result).toContain(extras[2])
    expect(result.find(tool => tool['name'] === 'unknown_namespace')).toEqual({ ...extras[3], tools: [fn('a'), fn('z')] })
  })

  it('uses Rust UTF-8 lexical child ordering rather than locale or UTF-16 sorting, preserving unknown child slots', () => {
    const opaque = { type: 'future', name: 'opaque', original: true }
    const original = { tools: [{ type: 'namespace', name: 'arbitrary', tools: [fn('\u{10000}'), opaque, fn('\ue000'), fn('a')] }] }
    const sorted = orderCodex01621Tools(original, 'codex-0.162.1')['tools'] as { tools: unknown[] }[]
    expect(sorted[0]?.tools).toEqual([fn('a'), opaque, fn('\ue000'), fn('\u{10000}')])
    expect(sorted[0]?.tools[1]).toBe(opaque)
  })

  it('preserves missing/non-array tools and the actual compaction tools:[] shape', () => {
    for (const original of [{ input: [] }, { tools: null }, { tools: [] }]) expect(orderCodex01621Tools(original, 'codex-0.162.1')).toBe(original)
  })
})
