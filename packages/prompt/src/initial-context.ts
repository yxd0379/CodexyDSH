/** Full Codexful context reconstructed from a captured assembly and world state. */

import { codexWorldStateMessageSource, fullCodexPermissions } from '@codexydsh/runtime'
import type { CodexWorldStateInput } from '@codexydsh/runtime'
import { createDeveloperMessage, createUserMessage } from '@codexydsh/runtime/llm'
import type { DeveloperMessage, UserMessage } from '@codexydsh/runtime/llm'
import { joinContextSections, renderContextSections } from '@codexydsh/runtime/prompt'
import type { AssembledContext, PromptAssembly } from '@codexydsh/runtime/prompt'

/** Immutable contributions needed to rebuild context after compaction. */
export interface CodexfulInitialContextAssembly {
  readonly contexts: readonly Readonly<AssembledContext>[]
  readonly variables: Readonly<Record<string, string | undefined>>
  readonly contextSnapshotIntro?: 'dsh' | 'none'
}

/**
 * Detach context contributions from a returned mutable prompt assembly.
 * @param assembly - successfully assembled contexts and selected variables.
 * @returns frozen context entries, variables, and context framing.
 */
export function captureCodexfulInitialContextAssembly(assembly: PromptAssembly): CodexfulInitialContextAssembly {
  return Object.freeze({
    contexts: Object.freeze(assembly.contexts.map(section => Object.freeze({ ...section }))),
    variables: Object.freeze({ ...assembly.variables }),
    ...assembly.contextSnapshotIntro === undefined ? {} : { contextSnapshotIntro: assembly.contextSnapshotIntro },
  })
}

/**
 * Rebuild complete fragments instead of retaining permission or environment deltas.
 * @param assembly - captured contributions and their selected model variables.
 * @param worldState - complete environment, permissions and selected role.
 * @param instructions - retained AGENTS instructions in their original order.
 * @param mode - current delegation policy, absent when disabled.
 * @returns full initialization fragments; provider serialization preserves their grouping.
 */
export function buildCodexfulInitialContext(
  assembly: CodexfulInitialContextAssembly,
  worldState: CodexWorldStateInput,
  instructions: readonly UserMessage[],
  mode?: string,
): readonly (UserMessage | DeveloperMessage)[] {
  const generic: PromptAssembly = { ...assembly, sections: [], tools: [], variables: { ...assembly.variables },
    contexts: assembly.contexts.filter(section =>
      section.name !== 'codexful:environment' && section.name !== 'codexful:permissions'
      && section.name !== 'codexful-v2:multi-agent-role') }
  const developerSections = renderContextSections(generic, 'developer')
  const userSections = renderContextSections(generic)
  const messages: (UserMessage | DeveloperMessage)[] = []
  if (developerSections.length > 0) messages.push(createDeveloperMessage({
    content: developerSections.map(section => ({ type: 'text', text: section.text })),
    source: { kind: 'runtime-context', form: 'snapshot', sections: developerSections },
  }))
  const permissions = fullCodexPermissions(worldState.permissions)
  messages.push(createDeveloperMessage({ content: [{ type: 'text', text: permissions }],
    source: codexWorldStateMessageSource({ section: 'permissions', mode: 'full', snapshot: worldState.permissions }, permissions) }))
  const role = worldState.multiAgentRole
  if (role !== undefined && role.length > 0) messages.push(createDeveloperMessage({ content: [{ type: 'text', text: role }],
    source: codexWorldStateMessageSource({ section: 'multi-agent-role', mode: 'full', snapshot: role }, role) }))
  if (mode !== undefined) {
    const text = `<multi_agent_mode>${mode}</multi_agent_mode>`
    messages.push(createDeveloperMessage({ content: [{ type: 'text', text }],
      source: codexWorldStateMessageSource({ section: 'multi-agent-mode', mode: 'full',
        snapshot: { body: mode, role: role ?? null } }, text) }))
  }
  messages.push(...instructions)
  if (userSections.length > 0) messages.push(createUserMessage({
    content: [{ type: 'text', text: joinContextSections(userSections, assembly.contextSnapshotIntro) }],
    source: { kind: 'runtime-context', form: 'snapshot', sections: userSections },
  }))
  const environment = worldState.environment.fullText
  messages.push(createUserMessage({ content: [{ type: 'text', text: environment }],
    source: codexWorldStateMessageSource({ section: 'environment', mode: 'full', snapshot: worldState.environment.snapshot }, environment) }))
  return messages
}
