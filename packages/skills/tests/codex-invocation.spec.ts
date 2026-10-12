/** Codex skill mentions and the model-visible instruction fragment. */
import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@codexydsh/runtime/llm'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import { renderCodexSkillInvocation, selectCodexSkillMentions } from '../src/codex-invocation.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'codex-invocation-test': { kind: 'codex-invocation-test' }
  }
}

function skill(name: string, path = `/skills/${name}/SKILL.md`, userInvocable = true): SkillSummary {
  return { name, path, description: name, invocation: { modelInvocable: true, userInvocable }, source: 'custom', provider: 'files' }
}

function user(text: string) {
  return createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
}

describe('Codex explicit skill invocation', () => {
  it('selects linked files before plain names and deduplicates repeated references', () => {
    const catalog = [skill('first'), skill('second')]
    expect(selectCodexSkillMentions([
      user('$first then [$different-name] (/skills/second/SKILL.md), $second $first'),
      user('$first'),
    ], catalog)).toEqual([catalog[1], catalog[0]])
  })

  it('does not fall back from an unknown link, an app link, or environment variables', () => {
    const catalog = [skill('first'), skill('path'), skill('home'), skill('second')]
    expect(selectCodexSkillMentions([user('[$first](/unknown/SKILL.md) [$second](app://files) $PATH $home')], catalog)).toEqual([])
    expect(selectCodexSkillMentions([user('[$first](/unknown/SKILL.md) $first')], catalog)).toEqual([catalog[0]])
  })

  it('only reads user-owned text and skips user-disabled or ambiguous names', () => {
    const catalog = [skill('first'), skill('first', '/other/SKILL.md'), skill('disabled', undefined, false)]
    const injected = createUserMessage({ source: { kind: 'codex-invocation-test' }, content: [{ type: 'text', text: '$first' }] })
    expect(selectCodexSkillMentions([user('$first $disabled'), injected], catalog)).toEqual([])
    expect(selectCodexSkillMentions([user('[$first](/skills/first/SKILL.md)')], catalog)).toEqual([catalog[0]])
  })

  it('injects the complete raw instruction file, including its frontmatter', () => {
    const selected = skill('first')
    const rawContent = '---\nname: first\ndescription: example\n---\n\nRun the focused tests.\n'
    expect(renderCodexSkillInvocation({ ...selected, content: 'Run the focused tests.', rawContent })).toBe(
      `<skill>\n<name>first</name>\n<path>/skills/first/SKILL.md</path>\n${rawContent}\n</skill>`,
    )
    const { path: _filePath, ...virtual } = selected
    expect(renderCodexSkillInvocation({ ...virtual, content: 'Virtual instructions' })).toContain('<path>skill://files/first</path>')
  })
})
