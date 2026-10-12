/**
 * Opt-in host-file catalog framing from Codex rust-v0.162.1 (commit
 * 092d3acd6bec3e3a14bdc7e7a2810ab628ab759d), ext/skills/src/catalog_prompt.rs
 * and aliases.rs. Entries remain actual public SkillSummary observations.
 */
import type { SkillSummary } from '@deepseek-ai/dsh-skill'

const HOST_ALIASES_INTRO = 'A skill is a set of local instructions to follow that is stored in a `SKILL.md` file. Below is the list of skills that can be used. Each entry includes a name, description, and a short path that can be expanded into an absolute path using the skill roots table.'
const SOURCE_LOCATORS_INTRO = "A skill is a set of instructions provided through a `SKILL.md` source. Below is the list of skills that can be used. Each entry includes a name, description, and source locator. `file` locators are on the host filesystem, `executor package` locators are owned by their execution environment, `cloud package` locators are opaque package identifiers, and `custom resource` locators use their provider's access mechanism."
const HOST_ALIASES_USAGE = [
  '- Discovery: The list above is the skills available in this session (name + description + short path). Skill bodies live on disk at the listed paths after expanding the matching alias from `### Skill roots`.',
  "- Trigger rules: If the user names a skill (with `$SkillName` or plain text) OR the task clearly matches a skill's description shown above, you must use that skill for that turn. Multiple mentions mean use them all. Do not carry skills across turns unless re-mentioned.",
  "- Missing/blocked: If a named skill isn't in the list or the path can't be read, say so briefly and continue with the best fallback.",
  '- How to use a skill (progressive disclosure):',
  '  1) After deciding to use a skill, the main agent must expand the listed short `path` with the matching alias from `### Skill roots`, then open and read its `SKILL.md` completely before taking task actions. If a read is truncated or paginated, continue until EOF.',
  '  2) When `SKILL.md` references relative paths (e.g., `scripts/foo.py`), resolve them relative to the directory containing that expanded `SKILL.md` first, and only consider other paths if needed.',
  '  3) If `SKILL.md` points to extra folders such as `references/`, use its routing instructions to identify the files required for the task. The main agent must read each required instruction or reference file itself before acting on it. Do not delegate reading, summarizing, or interpreting skill instructions to a subagent. Subagents may still perform task work when the selected skill allows it.',
  '  4) If `scripts/` exist, prefer running or patching them instead of retyping large code blocks.',
  '  5) If `assets/` or templates exist, reuse them instead of recreating from scratch.',
  '- Coordination and sequencing:',
  "  - If multiple skills apply, choose the minimal set that covers the request and state the order you'll use them.",
  "  - Announce which skill(s) you're using and why (one short line). If you skip an obvious skill, say why.",
  '- Context hygiene:',
  '  - Progressive disclosure applies to selecting relevant files, not partially reading a selected instruction file. Do not load unrelated references, scripts, or assets.',
  "  - Avoid deep reference-chasing: prefer opening only files directly linked from `SKILL.md` unless you're blocked.",
  '  - When variants exist (frameworks, providers, domains), pick only the relevant reference file(s) and note that choice.',
  "- Safety and fallback: If a skill can't be applied cleanly (missing files, unclear instructions), state the issue, pick the next-best approach, and continue.",
].join('\n')

/**
 * Public SkillSummary has no configured root or Codex alias_root_order. Only
 * standard roots whose boundary is present in the actual path are shortened;
 * unknown/custom roots retain their complete literal locator.
 */
function standardRoot(path: string): string | undefined {
  const root = /^(.*\/(?:\.codex|\.agents)\/skills)(?=\/)/.exec(path)?.[1]
  if (root === undefined) return undefined
  return path.startsWith(`${root}/.system/`) ? `${root}/.system` : root
}

function scopeOrder(skill: SkillSummary): number {
  if (skill.path?.includes('/.codex/skills/.system/') === true || skill.source === 'bundled') return 0
  if (skill.source === 'project-dsh' || skill.source === 'project-agents') return 2
  if (skill.source === 'user-dsh' || skill.source === 'user-agents') return 3
  return 4
}

function compareLiteral(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Render discovered host files only, without normalizing/truncating metadata or
 * copying a recorded catalog. Usage selection remains the caller's existing
 * configured-model decision. This is not the upstream context-budget allocator.
 */
export function renderCodex01621FileCatalog(
  skills: readonly SkillSummary[],
  includeUsageInstructions: boolean,
  unaliasedUsageInstructions: string,
): string | undefined {
  const files = skills.filter((skill): skill is SkillSummary & { path: string } => skill.path !== undefined)
    .toSorted((left, right) => scopeOrder(left) - scopeOrder(right)
      || compareLiteral(left.name, right.name) || compareLiteral(left.path, right.path))
  if (files.length === 0) return undefined
  const roots = [...new Set(files.map(skill => standardRoot(skill.path)).filter(root => root !== undefined))]
  const locator = (path: string): string => {
    const matches = roots.map((root, index) => ({ root, index }))
      .filter(({ root }) => path.startsWith(`${root}/`)).toSorted((left, right) => right.root.length - left.root.length)
    const match = matches[0]
    return match === undefined ? path : `r${match.index}/${path.slice(match.root.length + 1)}`
  }
  return [
    '<skills_instructions>',
    '## Skills',
    roots.length > 0 ? HOST_ALIASES_INTRO : SOURCE_LOCATORS_INTRO,
    ...(roots.length > 0 ? ['### Skill roots', ...roots.map((root, index) => `- \`r${index}\` = \`${root}\``)] : []),
    '### Available skills',
    ...files.map(skill => skill.description.length === 0
      ? `- ${skill.name}: (file: ${locator(skill.path)})`
      : `- ${skill.name}: ${skill.description} (file: ${locator(skill.path)})`),
    ...(includeUsageInstructions ? roots.length > 0
      ? ['### How to use skills', HOST_ALIASES_USAGE] : [unaliasedUsageInstructions] : []),
    '</skills_instructions>',
  ].join('\n')
}
