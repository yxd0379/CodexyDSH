import { deriveProductMessages } from '@codexydsh/runtime/session'
/** Optional Codex memories namespace tools; default deployments use ordinary shell retrieval. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@codexydsh/tool-schema'
import type { Memory } from './service.ts'
import type { MemoryMatchMode } from './service.ts'

/** A dedicated memory note requires an explicit current human remember/forget/correction request. */
function noteAuthorized(agent: Agent | undefined): boolean {
  const current = (agent === undefined ? [] : deriveProductMessages(agent.session)).findLast(message => message.role === 'user' && message.source.kind === 'user')
  if (current === undefined) return false
  const text = current.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  return /\b(?:remember|forget)\b|(?:update|correct|edit|add|remove|save).{0,30}\bmemor(?:y|ies)\b|记住|忘记|(?:更新|修改|修正|保存|删除|添加).{0,10}记忆/i.test(text)
}

/** Install bounded retrieval tools and explicit ad-hoc notes as Cordis effects.
 * @param ctx - Injected tool registry.
 * @param memory - The installed local memory service.
 */
export function installMemoryTools(ctx: Context, memory: Memory): void {
  ctx.effect(() => ctx.codexyTools.register(defineTool({
    name: 'memories__list',
    description: 'List immediate files and directories under a path in the Codex memories store.',
    closedParameters: true,
    parameters: {
      path: { type: 'string' }, cursor: { type: 'string' }, max_results: { type: 'integer', description: 'Positive maximum entry count.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }], codeModeResult: (_args, value) => value },
    async execute(args, exec) {
      const result = await memory.list(args, { ...exec.agent === undefined ? {} : { session: exec.agent.session }, signal: exec.signal })
      return { ...result, entries: result.entries.map(entry => ({ ...entry })) }
    },
    presentCall: args => ({ card: 'generic', kind: 'read', title: 'List memory', input: args.path ?? '' }),
  })), 'memory.listTool')
  ctx.effect(() => ctx.codexyTools.register(defineTool({
    name: 'memories__read',
    description: 'Read a Codex memory file by relative path, optionally starting at a 1-indexed line offset and limiting the number of lines returned.',
    closedParameters: true,
    parameters: {
      path: { type: 'string', required: true }, line_offset: { type: 'integer', description: '1-indexed starting line.' }, max_lines: { type: 'integer', description: 'Positive maximum line count.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }], codeModeResult: (_args, value) => value },
    async execute(args, exec) {
      const { revision: _revision, ...result } = await memory.read(args, { ...exec.agent === undefined ? {} : { session: exec.agent.session }, signal: exec.signal })
      return result
    },
    presentCall: args => ({ card: 'generic', kind: 'read', title: 'Read memory', input: args.path, locations: [{ path: args.path, ...args.line_offset === undefined ? {} : { line: args.line_offset } }] }),
  })), 'memory.readTool')
  ctx.effect(() => ctx.codexyTools.register(defineTool({
    name: 'memories__search',
    description: 'Search Codex memory files for substring matches, optionally normalizing separators or requiring all query substrings on the same line or within a line window.',
    closedParameters: true,
    parameters: {
      queries: { type: 'array', required: true, items: { type: 'string' } },
      match_mode: { type: 'object', additionalProperties: false, properties: {
        type: { type: 'string', required: true, enum: ['any', 'all_on_same_line', 'all_within_lines'] }, line_count: { type: 'integer', description: 'Positive line window for all_within_lines.' },
      } },
      path: { type: 'string' }, cursor: { type: 'string' }, context_lines: { type: 'integer', description: 'Non-negative adjacent line count.' },
      case_sensitive: { type: 'boolean' }, normalized: { type: 'boolean' }, max_results: { type: 'integer', description: 'Positive maximum match count.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }], codeModeResult: (_args, value) => value },
    async execute(args, exec) {
      const { match_mode: mode, ...selection } = args
      const matchMode: MemoryMatchMode | undefined = mode === undefined ? undefined
        : mode.type === 'all_within_lines' ? { type: 'all_within_lines', line_count: mode.line_count ?? 0 }
          : { type: mode.type }
      const result = await memory.search({ ...selection, ...matchMode === undefined ? {} : { match_mode: matchMode } }, { ...exec.agent === undefined ? {} : { session: exec.agent.session }, signal: exec.signal })
      return { ...result, queries: [...result.queries], match_mode: { ...result.match_mode }, matches: result.matches.map(match => ({ ...match, matched_queries: [...match.matched_queries] })) }
    },
    presentCall: args => ({ card: 'generic', kind: 'search', title: 'Search memory', input: args.queries.join(' | ') }),
  })), 'memory.searchTool')
  ctx.effect(() => ctx.codexyTools.register(defineTool({
    name: 'memories__add_ad_hoc_note',
    description: 'Add a small timestamp-slug Markdown note describing an explicit user-requested memory addition, correction, or forget request. Only use when the user explicitly asks to update memory.',
    closedParameters: true,
    parameters: { filename: { type: 'string', required: true }, note: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [{ type: 'text', text: '{}' }], codeModeResult: () => ({}) },
    async execute(args, exec) {
      if (exec.agent === undefined || !noteAuthorized(exec.agent)) throw new Error('Memory updates require an explicit current user remember, forget, or correction request.')
      await memory.addNote(args, { session: exec.agent.session, signal: exec.signal })
      return {}
    },
    presentCall: args => ({ card: 'generic', kind: 'edit', title: 'Update memory', input: args.filename }),
  })), 'memory.noteTool')
}
