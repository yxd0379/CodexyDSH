/** Explicit Codex skill selection from user text and linked instruction paths. */

import type { SkillDefinition, SkillSummary } from '@deepseek-ai/dsh-skill'
import type { UserMessage } from '@codexydsh/runtime/session'

const MENTIONS = /\[\$([\w:-]+)\]\s*\(([^)]+)\)|\$([\w:-]+)/g
const ENV_NAMES = new Set(['PATH', 'HOME', 'USER', 'SHELL', 'PWD', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'TERM', 'XDG_CONFIG_HOME'])

function normalizedPath(path: string): string {
  return path.replace(/^skill:\/\//, '').replaceAll('\\', '/')
}

/**
 * Select catalog entries by exact linked path before unambiguous plain names.
 * Only user-owned text participates; application/MCP/plugin links never select skills.
 * @param messages - current step inputs.
 * @param catalog - invocation-neutral winning skill catalog in discovery order.
 * @returns each selected skill once, path selections before plain-name selections.
 */
export function selectCodexSkillMentions(messages: readonly UserMessage[], catalog: readonly SkillSummary[]): SkillSummary[] {
  const selected: SkillSummary[] = []
  const seen = new Set<string>()
  const counts = new Map<string, number>()
  for (const skill of catalog) counts.set(skill.name, (counts.get(skill.name) ?? 0) + 1)
  for (const message of messages) {
    if (message.source.kind !== 'user') continue
    for (const block of message.content) {
      if (block.type !== 'text') continue
      const paths = new Set<string>()
      const names = new Set<string>()
      for (const match of block.text.matchAll(MENTIONS)) {
        const name = match[1] ?? match[3] ?? ''
        if (ENV_NAMES.has(name.toUpperCase())) continue
        const path = match[2]?.trim()
        if (path === undefined) names.add(name)
        else if (!/^(?:app|mcp|plugin):\/\//.test(path)) paths.add(normalizedPath(path))
      }
      const include = (skill: SkillSummary): void => {
        const identity = skill.path === undefined ? `${skill.provider}:${skill.name}` : normalizedPath(skill.path)
        if (!skill.invocation.userInvocable || seen.has(identity)) return
        seen.add(identity)
        selected.push(skill)
      }
      for (const skill of catalog) {
        if (skill.path !== undefined && paths.has(normalizedPath(skill.path))) include(skill)
      }
      for (const skill of catalog) {
        if (names.has(skill.name) && counts.get(skill.name) === 1) include(skill)
      }
    }
  }
  return selected
}

/**
 * Render the pinned Codex explicit skill fragment; local file content retains its frontmatter.
 * @param skill - loaded instruction file or provider-backed definition.
 * @returns user-role context fragment placed after the invoking user input.
 */
export function renderCodexSkillInvocation(skill: SkillDefinition): string {
  const path = skill.path ?? (skill.resourceBase?.kind === 'url' ? skill.resourceBase.url : `skill://${skill.provider}/${skill.name}`)
  return `<skill>\n<name>${skill.name}</name>\n<path>${path}</path>\n${'rawContent' in skill && typeof skill.rawContent === 'string' ? skill.rawContent : skill.content}\n</skill>`
}
