import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SkillRegistry, { type SkillSummary } from '@deepseek-ai/dsh-skill'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { SystemPrompt, ToolRuntime, assemblePrompt } from '@codexydsh/test-support/host-tools'
import { renderContextSections } from '@codexydsh/runtime/prompt'
import { unsupportedInbox } from '@codexydsh/runtime-testkit'
import { DeveloperContextProjection } from '@codexydsh/runtime-testkit/runtime-context'
import * as toolSkill from '../src/index.ts'
import { renderCodex01621FileCatalog } from '../src/codex-catalog.ts'

// All catalog fixtures are in-memory registrations: no user home or filesystem
// is discovered, and no fixture or historical artifact is removed by this file.
function summary(name: string, path?: string, description = `Full ${name} description.`): SkillSummary {
  return { name, description, ...(path === undefined ? {} : { path }), provider: 'fixture',
    source: 'runtime', invocation: { modelInvocable: true, userInvocable: true } }
}

async function setup(config: toolSkill.Config): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(toolSkill, config)
  return ctx
}

function agent(session = Session.create(SessionId('catalog-wire-fixture')), model?: string): Agent {
  return { ctx: new Context(), id: session.id, session, options: model === undefined ? {} : { model },
    inbox: unsupportedInbox(), status: 'idle', send() {}, followup() {}, steer() {}, inject() {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve() }
}

function register(ctx: Context, skill: SkillSummary): () => void {
  return ctx.skills.register({ ...skill, content: 'Fixture instructions.' })
}

describe('Codex 0.162.1 file catalog wire profile', () => {
  it('derives the system root from actual file paths and renders pinned framing', () => {
    const skills = ['skill-installer', 'imagegen', 'skill-creator', 'openai-docs']
      .map(name => summary(name, `/home/eval/.codex/skills/.system/${name}/SKILL.md`))
    expect(renderCodex01621FileCatalog(skills, false, 'unused')).toBe([
      '<skills_instructions>', '## Skills',
      'A skill is a set of local instructions to follow that is stored in a `SKILL.md` file. Below is the list of skills that can be used. Each entry includes a name, description, and a short path that can be expanded into an absolute path using the skill roots table.',
      '### Skill roots', '- `r0` = `/home/eval/.codex/skills/.system`', '### Available skills',
      ...['imagegen', 'openai-docs', 'skill-creator', 'skill-installer']
        .map(name => `- ${name}: Full ${name} description. (file: r0/${name}/SKILL.md)`),
      '</skills_instructions>',
    ].join('\n'))
  })

  it('preserves complete metadata and literal paths rather than truncating or escaping', () => {
    const description = `Start\n  {{literal}} <tag> & ${'long description '.repeat(120)}终`
    const path = '/custom/真实 {{folder}} <path>/SKILL.md'
    const text = renderCodex01621FileCatalog([summary('literal', path, description)], false, 'unused')
    expect(text).toContain(`- literal: ${description} (file: ${path})`)
    expect(text).not.toContain('### Skill roots')
    expect(text).not.toContain('&#123;')
    expect(text).not.toContain('...')
  })

  it('uses distinct path boundaries and longest matching root without changing identities', () => {
    const skills = [summary('user', '/home/eval/.codex/skills/user/SKILL.md'),
      summary('system', '/home/eval/.codex/skills/.system/system/SKILL.md'),
      summary('literal', '/home/eval/.codex/skills-extra/literal/SKILL.md')]
    const text = renderCodex01621FileCatalog(skills, false, 'unused')
    expect(text).toContain('- `r0` = `/home/eval/.codex/skills/.system`')
    expect(text).toContain('- `r1` = `/home/eval/.codex/skills`')
    expect(text).toContain('(file: r0/system/SKILL.md)')
    expect(text).toContain('(file: r1/user/SKILL.md)')
    expect(text).toContain('(file: /home/eval/.codex/skills-extra/literal/SKILL.md)')
    expect(skills[0]?.path).toBe('/home/eval/.codex/skills/user/SKILL.md')
  })

  it('omits virtual entries rather than inventing filesystem skills', () => {
    expect(renderCodex01621FileCatalog([summary('virtual')], false, 'unused')).toBeUndefined()
    const text = renderCodex01621FileCatalog([summary('virtual'), summary('file', '/actual/file/SKILL.md', '')], false, 'unused')
    expect(text).toContain('- file: (file: /actual/file/SKILL.md)')
    expect(text).not.toContain('virtual')
  })

  it('selects pinned alias usage only when the existing model configuration asks for it', async () => {
    const ctx = await setup({ catalogFormat: 'codex', codexCatalogAccess: 'filesystem',
      catalogWireProfile: 'codex-0.162.1', codexUsageInstructionModels: ['configured-model'] })
    register(ctx, summary('actual', '/home/eval/.codex/skills/.system/actual/SKILL.md'))
    const included = agent(undefined, 'configured-model')
    const excluded = agent(undefined, 'other-model')
    const includedText = renderContextSections(await assemblePrompt(ctx, { agent: included, scope: included }), 'developer')[0]?.text
    const excludedText = renderContextSections(await assemblePrompt(ctx, { agent: excluded, scope: excluded }), 'developer')[0]?.text
    expect(includedText).toContain('### How to use skills')
    expect(includedText).toContain('expand the listed short `path` with the matching alias')
    expect(excludedText).not.toContain('### How to use skills')
    expect(ctx.codexyTools.get('skill')).toBeUndefined()
  })

  it('preserves literal metadata through public non-recursive interpolation and durable restore', async () => {
    const ctx = await setup({ catalogFormat: 'codex', codexCatalogAccess: 'filesystem',
      catalogWireProfile: 'codex-0.162.1', catalogDescriptionMaxLength: 3 })
    const description = `Full\n  {{model}} <literal> & ${'x'.repeat(650)}`
    const path = '/custom/{{actual}} <folder>/SKILL.md'
    register(ctx, summary('literal', path, description))
    ctx.codexyPrompt.variable('model', () => 'must-not-substitute')
    const owner = agent()
    const sections = renderContextSections(await assemblePrompt(ctx, { agent: owner, scope: owner }), 'developer')
    expect(sections[0]?.text).toContain(`- literal: ${description} (file: ${path})`)
    expect(sections[0]?.text).not.toContain('must-not-substitute')
    const projected = new DeveloperContextProjection(ctx, owner.session).project(sections)
    if (projected === undefined) throw new Error('missing catalog projection')
    owner.session.append('developer/message', { turn: 1, step: 1, message: projected }, { surfaceOp: 'append' })
    const restored = Session.fromRestore(owner.session.id, structuredClone(owner.session.snapshotEvents()),
      owner.session.header, SessionLogOffset(0), 'detached')
    expect(restored.deriveMessages()[0]?.content).toEqual(projected.content)
  })

  it('keeps the last durable catalog on incomplete discovery and existing withdrawal behavior', async () => {
    const ctx = await setup({ catalogFormat: 'codex', codexCatalogAccess: 'filesystem', catalogWireProfile: 'codex-0.162.1' })
    const owner = agent()
    const remove = register(ctx, summary('actual', '/home/eval/.codex/skills/.system/actual/SKILL.md'))
    const sections = renderContextSections(await assemblePrompt(ctx, { agent: owner, scope: owner }), 'developer')
    const projected = new DeveloperContextProjection(ctx, owner.session).project(sections)
    if (projected === undefined) throw new Error('missing catalog projection')
    owner.session.append('developer/message', { turn: 1, step: 1, message: projected }, { surfaceOp: 'append' })
    const disposeIncomplete = ctx.skills.registerProvider(() => ({ name: 'incomplete',
      list: () => Promise.resolve({ candidates: [], complete: false }), get: () => Promise.resolve(undefined) }))
    const retained = renderContextSections(await assemblePrompt(ctx, { agent: owner, scope: owner }), 'developer')
    expect(retained).toEqual(sections)
    disposeIncomplete()
    remove()
    const withdrawn = renderContextSections(await assemblePrompt(ctx, { agent: owner, scope: owner }), 'developer')
    expect(withdrawn[0]?.text).toBe('<skills_instructions>\n## Host skills update\nNo host skills are currently available.\n</skills_instructions>')
  })

  it('keeps default filesystem and skill-tool catalogs unchanged without an effective opt-in', async () => {
    const fileCtx = await setup({ catalogFormat: 'codex', codexCatalogAccess: 'filesystem', catalogDescriptionMaxLength: 20 })
    register(fileCtx, summary('actual', '/home/eval/.codex/skills/.system/actual/SKILL.md', 'Full {{literal}} <text> description.'))
    const fileOwner = agent()
    const defaultText = renderContextSections(await assemblePrompt(fileCtx, { agent: fileOwner, scope: fileOwner }), 'developer')[0]?.text
    expect(defaultText).not.toContain('### Skill roots')
    expect(defaultText).toContain('(file: /home/eval/.codex/skills/.system/actual/SKILL.md)')
    expect(defaultText).toContain('Full &#123;&#123;literal}} ...')
    const toolCtx = await setup({ catalogFormat: 'codex', catalogWireProfile: 'codex-0.162.1' })
    register(toolCtx, summary('virtual'))
    const toolOwner = agent()
    const toolText = renderContextSections(await assemblePrompt(toolCtx, { agent: toolOwner, scope: toolOwner }), 'developer')[0]?.text
    expect(toolText).toContain('- virtual: Full virtual description. (provider: fixture)')
    expect(toolCtx.codexyTools.get('skill')).toBeDefined()
  })
})
