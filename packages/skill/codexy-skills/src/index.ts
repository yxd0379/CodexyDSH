import { deriveProductMessages } from '@codexydsh/runtime/session'
/**
 * Durable session skill catalog and model-facing `skill` loader tool.
 *
 * @module @codexydsh/skills
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@codexydsh/runtime/agent'
import type {} from '@codexydsh/runtime/prompt'
import { defineTool } from '@codexydsh/tool-schema'
import { createUserMessage } from '@codexydsh/runtime/llm'
import { SessionSeq, type UserMessage } from '@codexydsh/runtime/session'
import {
  escapeText,
  isModelInvocable,
  isSkillName,
  isUserInvocable,
  renderSkillContent,
  type SkillInvocationSource,
  type SkillSummary,
} from '@deepseek-ai/dsh-skill'
import { renderCodexSkillInvocation, selectCodexSkillMentions } from './codex-invocation.ts'
import { renderCodex01621FileCatalog } from './codex-catalog.ts'

export const name = 'tool-skill'
export const inject = ['agents', 'tools', 'skills', 'codexyTools']

const DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH = 500
const CODEX_SKILLS_OPEN = '<skills_instructions>'
const CODEX_SKILLS_CLOSE = '</skills_instructions>'
const CODEX_SKILLS_SECTION = 'codexful:skills'
const CODEX_SKILLS_USAGE_INSTRUCTIONS = [
  '### How to use skills',
  '- Discovery: The list above contains the skills available in this session, with each name, description, and file path or provider when supplied.',
  '- Trigger rules: If the user names a skill (with `$SkillName` or plain text), or the task clearly matches a listed description, use that skill for this turn. Use every applicable skill. Do not carry skills across turns unless re-mentioned.',
  '- Missing/blocked: If a named skill is absent or cannot be loaded, say so briefly and continue with the best fallback.',
  '- How to use a skill (progressive disclosure):',
  '  1) Call the `skill` tool with the exact listed name and read its complete `<skill_content>` before taking task actions. If the result is truncated, use its resource guidance to read the missing instructions before acting.',
  '  2) Resolve relative file paths against the base directory reported by the loaded skill. For provider-managed or URL resources, use the access mechanism and base URL described in its result; do not invent a local path.',
  '  3) If the skill points to extra files or folders such as `references/`, follow its routing instructions and read each required instruction or reference yourself before acting. Do not delegate reading or interpreting those instructions to a subagent.',
  '  4) Prefer running or patching provided scripts over retyping large code blocks. Reuse provided assets and templates.',
  '- Coordination and sequencing: If multiple skills apply, use the minimal set that covers the task and state the order. Announce which skills you are using and why in one short line; if you skip an obvious skill, say why.',
  '- Context hygiene: Read the selected skill completely, but load only relevant references and resources. Avoid deep reference chasing, and select only the variant that fits the task.',
  '- Safety and fallback: If a skill cannot be applied cleanly because files are missing or instructions are unclear, state the issue, choose the next best approach, and continue.',
].join('\n')
const CODEX_FILESYSTEM_SKILLS_USAGE_INSTRUCTIONS = [
  '### How to use skills',
  '- Discovery: The list above contains the skills available in this session, with each name, description, and file path.',
  '- Trigger rules: If the user names a skill (with `$SkillName` or plain text), or the task clearly matches a listed description, use that skill for this turn. Use every applicable skill. Do not carry skills across turns unless re-mentioned.',
  '- Missing/blocked: If a named skill is absent or its file cannot be read, say so briefly and continue with the best fallback.',
  '- How to use a skill (progressive disclosure):',
  '  1) Open the listed `SKILL.md` path and read it completely before taking task actions. If the result is truncated, continue reading until the end.',
  '  2) Resolve relative paths in `SKILL.md` against the directory containing that file.',
  '  3) If the skill points to extra files or folders such as `references/`, follow its routing instructions and read each required instruction or reference yourself before acting. Do not delegate reading or interpreting those instructions to a subagent.',
  '  4) Prefer running or patching provided scripts over retyping large code blocks. Reuse provided assets and templates.',
  '- Coordination and sequencing: If multiple skills apply, use the minimal set that covers the task and state the order. Announce which skills you are using and why in one short line; if you skip an obvious skill, say why.',
  '- Context hygiene: Read the selected skill completely, but load only relevant references and resources. Avoid deep reference chasing, and select only the variant that fits the task.',
  '- Safety and fallback: If a skill cannot be applied cleanly because files are missing or instructions are unclear, state the issue, choose the next best approach, and continue.',
].join('\n')
/**
 * Durable provider and item records for one published session skill catalog. The catalog is a
 * `catalog`-form context, so it records the entries it published beside the
 * model-facing prose: a consumer presenting the list must not re-parse the
 * `<available_skills>` block, whose framing exists for the model.
 */
export interface SkillCatalogSource {
  readonly kind: 'skill-catalog'
  readonly form: 'catalog'
  /** Marks a replacement catalog rather than this session's first publication. */
  readonly update?: true
  /** Exactly the entries this message published, in catalog order. */
  readonly entries: readonly { readonly name: string; readonly description: string }[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'skill-catalog': SkillCatalogSource
  }
}

/** Durable entry list mirroring the rendered catalog lines, for non-model consumers. */
function catalogSourceEntries(
  skills: SkillSummary[],
  descriptionMaxLength: number,
): SkillCatalogSource['entries'] {
  return skills.map(skill => ({
    name: skill.name,
    description: catalogDescription(skill.description, descriptionMaxLength),
  }))
}

/** Model-facing skill catalog configuration. */
export interface Config {
  /** Maximum normalized description length rendered in the session catalog; minimum 3. */
  catalogDescriptionMaxLength?: number
  /** Codexful-only developer context, or the ordinary user-role catalog. */
  catalogFormat?: 'dsh' | 'codex'
  /** Codex catalog loading through this plugin's tool or directly from listed files. */
  codexCatalogAccess?: 'skill-tool' | 'filesystem'
  /** Opt-in pinned host-file framing; default catalogs retain their existing format. */
  catalogWireProfile?: 'codex-0.162.1'
  /** Model ids whose Codex-style catalog includes usage guidance after the skill list. */
  codexUsageInstructionModels?: string[]
}

/** Validate and default the model-facing skill catalog configuration. */
export const Config: z<Config> = z.object({
  catalogDescriptionMaxLength: z.number().default(DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH),
  catalogFormat: z.union(['dsh', 'codex'] as const).default('dsh'),
  codexCatalogAccess: z.union(['skill-tool', 'filesystem'] as const).default('skill-tool'),
  catalogWireProfile: z.union(['codex-0.162.1'] as const),
  codexUsageInstructionModels: z.array(z.string().min(1)).default([]),
})

/**
 * Register the model-facing skill loader and durable session catalog. In the
 * default mode, the catalog is emitted only while this exact loader is visible.
 * Codex filesystem mode publishes only skills with file paths and omits the
 * loader; its developer context is recorded by the agent loop.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const catalogDescriptionMaxLength = config.catalogDescriptionMaxLength ?? DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH
  const catalogFormat = config.catalogFormat ?? 'dsh'
  const codexCatalogAccess = config.codexCatalogAccess ?? 'skill-tool'
  const pinnedFileCatalog = config.catalogWireProfile === 'codex-0.162.1' && codexCatalogAccess === 'filesystem'
  const codexUsageInstructionModels = new Set(config.codexUsageInstructionModels ?? [])
  assertPositiveInteger('catalogDescriptionMaxLength', catalogDescriptionMaxLength, 3)
  if ([...codexUsageInstructionModels].some(model => model.length === 0)) {
    throw new Error('tool-skill: codexUsageInstructionModels must contain non-empty model ids')
  }
  if (catalogFormat === 'codex' && !ctx.reflect.get('codexyPrompt')) {
    throw new Error('tool-skill: catalogFormat codex requires the systemPrompt service')
  }
  if (codexCatalogAccess === 'filesystem' && catalogFormat !== 'codex') {
    throw new Error('tool-skill: codexCatalogAccess filesystem requires catalogFormat codex')
  }

  const skillTool = defineTool({
    name: 'skill',
    description: 'Load the full instructions for an available skill. Call this with the exact skill name from the session skill catalog before acting on a task that names or clearly matches that skill.',
    parameters: {
      name: { type: 'string', required: true, description: 'The exact skill name from the available skills list.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          provider: { type: 'string', required: true },
          resourceBase: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'directory' },
                  path: { type: 'string', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'url' },
                  url: { type: 'string', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'opaque' },
                  description: { type: 'string', required: true },
                },
              },
            ],
          },
          content: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSkillContent(value) }],
    },
    async execute(args, exec) {
      if (!isSkillName(args.name)) {
        throw new Error(`invalid skill name "${args.name}"`)
      }
      // The agent is its own scope key, so the lookup resolves the layered
      // registry exactly as this agent's composition sees it.
      const lookup = { cwd: exec.agent?.session.header.cwd, signal: exec.signal, scope: exec.agent }
      const summary = (await ctx.skills.list(lookup)).find(skill => skill.name === args.name)
      if (!summary) {
        throw new Error(`skill "${args.name}" is unknown or no longer available`)
      }
      if (!isModelInvocable(summary)) {
        throw new Error(`skill "${args.name}" is not available for model invocation`)
      }
      const skill = await ctx.skills.get(args.name, lookup)
      if (!skill) {
        throw new Error(`skill "${args.name}" is unknown or no longer available`)
      }
      if (!isModelInvocable(skill)) {
        throw new Error(`skill "${args.name}" is not available for model invocation`)
      }
      return {
        name: skill.name,
        provider: skill.provider,
        ...skill.resourceBase !== undefined ? {
          resourceBase: { ...skill.resourceBase },
        } : {},
        content: skill.content,
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Load skill ${args.name}`, kind: 'read', rawInput: args.name }
    },
  })
  if (codexCatalogAccess === 'skill-tool') ctx.codexyTools.register(skillTool)

  if (catalogFormat === 'codex') {
    ctx.on('codexy-prompt/assemble', async (_assembly, context, next) => {
      const assembled = await next()
      const agent = context.agent
      if (agent === undefined) return assembled
      context.signal?.throwIfAborted()
      const catalogAvailable = codexCatalogAccess === 'filesystem'
        || ctx.codexyTools.get(skillTool.name, agent) === skillTool
      const snapshot = catalogAvailable
        ? await ctx.skills.snapshot({ cwd: agent.session.header.cwd, signal: context.signal, scope: agent })
        : { skills: [], complete: true }
      context.signal?.throwIfAborted()
      const skills = snapshot.skills.filter(skill => isModelInvocable(skill)
        && (codexCatalogAccess === 'skill-tool' || skill.path !== undefined))
      const retained = !snapshot.complete || skills.length === 0 ? retainedCodexCatalog(agent) : undefined
      const model = assembled.variables.model ?? agent.options.model
      const text = snapshot.complete
        ? renderCodexCatalog(skills, catalogDescriptionMaxLength, retained !== undefined,
          model !== undefined && codexUsageInstructionModels.has(model), codexCatalogAccess, pinnedFileCatalog)
        : retained
      return text === undefined ? assembled : {
        ...assembled,
        // Public interpolation is non-recursive in both pinned runtime versions.
        // A variable value preserves {{literal}} metadata even in rc.2, whose
        // context renderer does not yet honor interpolate:false.
        ...(pinnedFileCatalog ? { variables: { ...assembled.variables, codexy_skills_catalog_wire_text: text } } : {}),
        contexts: [{ name: CODEX_SKILLS_SECTION, role: 'developer',
          text: pinnedFileCatalog ? '{{codexy_skills_catalog_wire_text}}' : text }, ...assembled.contexts],
      }
    })
  }

  // Direct user input selects /name in DSH mode or $name and exact linked
  // instruction paths in Codex mode. Instructions follow other injections.
  ctx.on('codexy-agent/pre-step', async (
    { agent, messages, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    signal.throwIfAborted()
    const lookup = { cwd: agent.session.header.cwd, signal, scope: agent }
    const names = catalogFormat === 'codex'
      ? selectCodexSkillMentions(messages, (await ctx.skills.list(lookup))).map(skill => skill.name)
      : invokedSkillNames(messages)
    if (names.length === 0) return decision
    const injections: UserMessage[] = []
    for (const name of names) {
      const skill = await ctx.skills.get(name, lookup)
      signal.throwIfAborted()
      // Unknown names and user-disabled skills stay plain prose: the
      // gesture was never a claim this boundary recognizes. The check sits
      // on the loaded definition — the single lookup that produces what is
      // actually injected.
      if (skill === undefined || !isUserInvocable(skill)) continue
      const source: SkillInvocationSource = { kind: 'skill-invocation', name, form: 'instructions' }
      injections.push(createUserMessage({
        content: [{ type: 'text', text: catalogFormat === 'codex' ? renderCodexSkillInvocation(skill) : renderSkillContent(skill) }],
        source,
      }))
    }
    if (injections.length === 0) return decision
    return { ...decision, messages: [...decision.messages, ...injections] }
  })

  // Register after the tool so reverse teardown removes guidance first. Exact definition
  // identity prevents a scoped shadow merely named `skill` from inheriting this catalog.
  //
  // The comparison is against the definition this plugin registered, not against
  // a lookup of its own name: `register()` files into the CALLING context's
  // scope, so a plugin mounted inside an agent preset registers for that agent
  // alone and an unscoped lookup correctly finds nothing.
  ctx.on('codexy-agent/pre-step', async (
    { agent, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    if (catalogFormat === 'codex') return decision
    signal.throwIfAborted()
    const toolVisible = ctx.codexyTools.get(skillTool.name, agent) === skillTool
    const snapshot = toolVisible
      ? await ctx.skills.snapshot({ cwd: agent.session.header.cwd, signal, scope: agent })
      : { skills: [], complete: true }
    signal.throwIfAborted()
    if (!snapshot.complete) return decision
    const skills = snapshot.skills.filter(isModelInvocable)
    const entries = catalogSourceEntries(skills, catalogDescriptionMaxLength)
    const digest = digestCatalogEntries(entries)
    const history = catalogHistory(agent)
    const existing = catalogMessage(decision.messages)
    if (history.visibleDigest === digest) {
      return existing === undefined
        ? decision
        : { ...decision, messages: decision.messages.filter(message => message.id !== existing.message.id) }
    }
    if (existing !== undefined && digestCatalogEntries(existing.entries) === digest) return decision
    if (!history.published && skills.length === 0) {
      return existing === undefined
        ? decision
        : { ...decision, messages: decision.messages.filter(message => message.id !== existing.message.id) }
    }
    const catalog = history.published
      ? renderCatalogUpdate(entries)
      : renderCatalogMessage(entries)
    return {
      ...decision,
      messages: existing === undefined
        ? [...decision.messages, catalog]
        : decision.messages.map(message => message.id === existing.message.id ? catalog : message),
    }
  })
}

function renderCatalogMessage(entries: SkillCatalogSource['entries']): UserMessage {
  return createUserMessage({
    content: [{
      type: 'text',
      text: [
        '<system-reminder>',
        'A skill is a reusable set of task-specific instructions. The following skills are available in this session:',
        '',
        '<available_skills>',
        ...renderCatalogEntries(entries),
        '</available_skills>',
        '',
        "If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.",
        'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
        '</system-reminder>',
      ].join('\n'),
    }],
    source: {
      kind: 'skill-catalog',
      form: 'catalog',
      entries,
    },
  })
}

function renderCatalogUpdate(entries: SkillCatalogSource['entries']): UserMessage {
  const availability = entries.length === 0
    ? [
      'No skills are currently available through the `skill` tool. Do not use names from earlier skill catalogs.',
      'A user may still invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool for it.',
    ]
    : [
      'Use only names in this replacement catalog. If the user names a listed skill, or the task clearly matches its description, call the `skill` tool with the exact name before acting.',
      'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
    ]
  return createUserMessage({
    content: [{
      type: 'text',
      text: [
        '<system-reminder>',
        'The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:',
        '',
        '<available_skills>',
        ...renderCatalogEntries(entries),
        '</available_skills>',
        '',
        ...availability,
        '</system-reminder>',
      ].join('\n'),
    }],
    source: {
      kind: 'skill-catalog',
      form: 'catalog',
      update: true,
      entries,
    },
  })
}

/**
 * Model-facing catalog lines, projected from the same entries the source records.
 * The pseudo-XML escaping belongs to this frame, not to the published fact, so it
 * is applied here and never stored. Names are `isSkillName`-validated and carry
 * no escapable character.
 */
function renderCatalogEntries(entries: SkillCatalogSource['entries']): string[] {
  return entries.map(entry => `- \`${entry.name}\`: ${escapeText(entry.description)}`)
}

/** Render one Codex-style developer fragment from the selected accessible skills. */
function renderCodexCatalog(
  skills: SkillSummary[],
  descriptionMaxLength: number,
  previouslyVisible: boolean,
  includeUsageInstructions: boolean,
  catalogAccess: 'skill-tool' | 'filesystem',
  pinnedFileCatalog = false,
): string | undefined {
  if (skills.length === 0) {
    return previouslyVisible
      ? `${CODEX_SKILLS_OPEN}\n## Host skills update\nNo host skills are currently available.\n${CODEX_SKILLS_CLOSE}`
      : undefined
  }
  if (pinnedFileCatalog) {
    return renderCodex01621FileCatalog(skills, includeUsageInstructions, CODEX_FILESYSTEM_SKILLS_USAGE_INSTRUCTIONS)
  }
  const lines = skills.map((skill) => {
    const description = escapeCatalogContextText(catalogDescription(skill.description, descriptionMaxLength))
    const locator = skill.path === undefined
      ? `provider: ${escapeCatalogContextText(skill.provider)}`
      : `file: ${escapeCatalogContextText(skill.path)}`
    return `- ${skill.name}: ${description} (${locator})`
  })
  return [
    CODEX_SKILLS_OPEN,
    '## Skills',
    'A skill is a set of instructions provided through a `SKILL.md` source. Below is the list of skills that can be used. Each entry includes a name, description, and location when the provider supplies one.',
    '### Available skills',
    ...lines,
    ...(includeUsageInstructions ? [catalogAccess === 'filesystem'
      ? CODEX_FILESYSTEM_SKILLS_USAGE_INSTRUCTIONS : CODEX_SKILLS_USAGE_INSTRUCTIONS] : []),
    CODEX_SKILLS_CLOSE,
  ].join('\n')
}

/** Context sections interpolate `{{variables}}`; skill metadata is literal provider text. */
function escapeCatalogContextText(value: string): string {
  return escapeText(value).replaceAll('{{', '&#123;&#123;')
}

/** Read only this plugin's last visible developer section when discovery is incomplete. */
function retainedCodexCatalog(agent: Agent): string | undefined {
  for (const message of deriveProductMessages(agent.session).toReversed()) {
    if (message.role !== 'developer' && message.role !== 'user') continue
    const source: object = message.source
    if (!('kind' in source) || source.kind !== 'runtime-context') continue
    const form = 'form' in source ? source.form : undefined
    if (message.role === 'user' && form !== 'instructions') continue
    if (form === 'snapshot') {
      if (!('sections' in source) || !Array.isArray(source.sections)) {
        throw new Error('Codexful skill catalog cannot restore malformed developer sections')
      }
      for (const raw of source.sections) {
        const section: unknown = raw
        if (typeof section !== 'object' || section === null || !('name' in section)
          || section.name !== CODEX_SKILLS_SECTION) continue
        if (!('text' in section) || typeof section.text !== 'string') {
          throw new Error('Codexful skill catalog cannot restore a malformed skill section')
        }
        return checkedCodexCatalog(section.text)
      }
      return undefined
    }
    if (form === 'instructions') {
      const [block] = message.content
      if (message.content.length !== 1 || block?.type !== 'text') {
        throw new Error('Codexful skill catalog cannot restore a non-text developer fallback')
      }
      const start = block.text.indexOf(CODEX_SKILLS_OPEN)
      if (start < 0) return undefined
      const end = block.text.indexOf(CODEX_SKILLS_CLOSE, start + CODEX_SKILLS_OPEN.length)
      if (end < 0) throw new Error('Codexful skill catalog has an unterminated developer fallback')
      return checkedCodexCatalog(block.text.slice(start, end + CODEX_SKILLS_CLOSE.length))
    }
  }
  return undefined
}

function checkedCodexCatalog(text: string): string {
  if (!text.startsWith(`${CODEX_SKILLS_OPEN}\n`) || !text.endsWith(`\n${CODEX_SKILLS_CLOSE}`)) {
    throw new Error('Codexful skill catalog has malformed framing in Session history')
  }
  return text
}

/**
 * Catalog identity over the durable entry list rather than the rendered prose.
 * The entries are what changes; the surrounding `<system-reminder>` framing is
 * written for the model and must not decide whether a republish is needed.
 */
function digestCatalogEntries(entries: SkillCatalogSource['entries']): string {
  // JSON per entry rather than a separator character: every separator is itself
  // a legal description character, so only quoting makes the boundary exact.
  const canonical = entries.map(entry => JSON.stringify([entry.name, entry.description])).join('\n')
  return createHash('sha256')
    .update(canonical)
    .digest('hex')
}

/**
 * Entries of one durable catalog message, or undefined when the record is not a
 * usable catalog.
 *
 * `agent.session.snapshotEvents()` may contain a resumed, forked, or externally written seed,
 * and seed validation only guarantees a source object with a non-empty `kind`;
 * no per-kind field is checked there. An unreadable record is therefore treated
 * as "not this plugin's catalog" — the posture the replaced content digest had —
 * rather than throwing inside the step listener, which would fail every
 * subsequent turn of that session.
 */
function readCatalogEntries(source: unknown): SkillCatalogSource['entries'] | undefined {
  const entries = (source as { entries?: unknown }).entries
  if (!Array.isArray(entries)) return undefined
  const readable: { name: string; description: string }[] = []
  for (const entry of entries as readonly unknown[]) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const { name, description } = entry as { name?: unknown; description?: unknown }
    if (typeof name !== 'string' || name === '' || typeof description !== 'string') return undefined
    readable.push({ name, description })
  }
  return readable
}

function catalogHistory(agent: Agent): { visibleDigest?: string; published: boolean } {
  const visible = new Set(agent.session.surface.nodes)
  let published = false
  for (let index = agent.session.seq - 1; index >= 0; index -= 1) {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const event = agent.session.eventAt(SessionSeq(index))
    if (event === undefined) {
      throw new Error(`skill catalog cannot read seq ${String(index)} below the current Session length`)
    }
    if (event.type !== 'user/message' || event.data.source.kind !== 'skill-catalog') continue
    const entries = readCatalogEntries(event.data.source)
    if (entries === undefined) continue
    const digest = digestCatalogEntries(entries)
    published = true
    if (visible.has(event.seq)) return { visibleDigest: digest, published }
  }
  return { published }
}

function catalogMessage(
  messages: readonly UserMessage[],
): { message: UserMessage; entries: SkillCatalogSource['entries'] } | undefined {
  for (const message of messages) {
    if (message.source.kind !== 'skill-catalog') continue
    const entries = readCatalogEntries(message.source)
    if (entries !== undefined) return { message, entries }
  }
  return undefined
}

function catalogDescription(value: string, maxLength: number): string {
  const normalized = value.replaceAll(/\s+/g, ' ').trim()
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`
}

function assertPositiveInteger(name: string, value: number, minimum = 1): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`tool-skill: ${name} must be an integer greater than or equal to ${minimum}`)
  }
}

/**
 * A whitespace-bounded `/name` token (the public skill-name grammar) anywhere
 * in the text — the same word-boundary shape the transcript chip decoration
 * uses, so a gesture reads as one wherever it sits in the sentence. A second
 * `/` or any non-boundary character breaks the match, which keeps file paths
 * (`/usr/bin`) and fractions (`5/8`) out.
 */
const SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g

/**
 * `/name` gesture tokens from the claimed user messages, deduplicated in
 * first-seen order. Every text block of direct user input is scanned; no
 * other source can forge a gesture.
 * @param messages - the step's claimed batch.
 * @returns candidate skill names, unvalidated against the registry.
 */
function invokedSkillNames(messages: readonly UserMessage[]): string[] {
  const names: string[] = []
  for (const message of messages) {
    if ((message.source as { kind?: unknown }).kind !== 'user') continue
    for (const block of message.content) {
      if (block.type !== 'text') continue
      for (const match of block.text.matchAll(SKILL_GESTURE)) {
        const name = match[2]
        if (name !== undefined && !names.includes(name)) names.push(name)
      }
    }
  }
  return names
}
