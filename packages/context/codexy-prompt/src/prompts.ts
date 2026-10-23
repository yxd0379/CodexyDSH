/** Model prompts copied from Codex and the DSH host adaptation that follows them.
 * Pinned Codex prompt strings remain verbatim under Apache-2.0.
 * @module @codexydsh/prompt/prompts
 */

import { CODEX_MODEL_PROMPTS } from './codex-model-prompts.ts'
import { CODEX_EXTRA_MODEL_PROMPTS } from './codex-extra-model-prompts.ts'
import { CODEX_FALLBACK_PROMPT } from './codex-fallback-prompt.ts'

/** Stable identifier for the pinned source text plus this DSH host adaptation. */
export const CODEXFUL_PROMPT_VERSION = 'codex-8f195c93-verbatim-v4'

const CODEX_PINNED_MODEL_PROMPTS = { ...CODEX_MODEL_PROMPTS, ...CODEX_EXTRA_MODEL_PROMPTS }

const CODEX_PINNED_REASONING_DEFAULTS = {
  'gpt-6-astra': 'low',
  'gpt-6-sol': 'medium',
  'gpt-6-luna': 'medium',
  'gpt-5.6-sol': 'low',
  'gpt-5.6-terra': 'medium',
  'gpt-5.6-luna': 'medium',
  'gpt-5.5': 'medium',
} as const satisfies Record<keyof typeof CODEX_PINNED_MODEL_PROMPTS, 'low' | 'medium'>

const CODEX_V2_MODEL_DEFAULTS = {
  multiAgentVersion: 'v2', responsesLite: true, toolMode: 'code_mode_only', skillsUsageInstructions: false,
} as const

const CODEX_PINNED_MODEL_DEFAULTS = {
  'gpt-6-astra': CODEX_V2_MODEL_DEFAULTS,
  'gpt-6-sol': CODEX_V2_MODEL_DEFAULTS,
  'gpt-6-luna': CODEX_V2_MODEL_DEFAULTS,
  'gpt-5.6-sol': CODEX_V2_MODEL_DEFAULTS,
  'gpt-5.6-terra': CODEX_V2_MODEL_DEFAULTS,
  'gpt-5.6-luna': {
    multiAgentVersion: 'v1', responsesLite: true, toolMode: 'code_mode_only', skillsUsageInstructions: false,
  },
  'gpt-5.5': {
    multiAgentVersion: null, responsesLite: false, toolMode: null, skillsUsageInstructions: true,
  },
} as const satisfies Record<keyof typeof CODEX_PINNED_MODEL_PROMPTS, {
  readonly multiAgentVersion: 'v1' | 'v2' | null
  readonly responsesLite: boolean
  readonly toolMode: 'code_mode_only' | null
  readonly skillsUsageInstructions: boolean
}>

/** Daily tools or pinned Codex defaults for patch, plan, and subagent visibility. */
export type CodexfulToolMode = 'daily' | 'codex-pinned'

/** Delegation interface selected once per Session, before model-visible tools. */
export type CodexfulMultiAgentVersion = 'v1' | 'v2'

/** Internal bindings for the five Codex v1 namespace functions. */
export const CODEXFUL_V1_TOOL_NAMES = [
  'multi_agent_v1__spawn_agent', 'multi_agent_v1__send_input', 'multi_agent_v1__wait_agent',
  'multi_agent_v1__resume_agent', 'multi_agent_v1__close_agent',
] as const

/** Flat multi-agent v2 tool names from pinned Codex, available on its five v2 models. */
export const CODEXFUL_V2_TOOL_NAMES = [
  'spawn_agent', 'send_message', 'followup_task', 'wait_agent', 'interrupt_agent', 'list_agents',
] as const

/** Model metadata that controls the Codexful tool list for one request. */
export interface CodexfulToolProfile {
  /** Configured tool selection mode. */
  readonly mode: CodexfulToolMode
  /** Tool names absent from the model request and denied on execution. */
  readonly hiddenTools: readonly ('apply_patch' | 'update_plan' | typeof CODEXFUL_V1_TOOL_NAMES[number] | typeof CODEXFUL_V2_TOOL_NAMES[number])[]
  /** Pinned Codex's default truncation for this model, before DSH adaptation. */
  readonly sourceTruncation: { readonly mode: 'tokens' | 'bytes'; readonly limit: 10000 }
  /** Whether the pinned model entry selects Responses Lite. */
  readonly sourceResponsesLite: boolean
  /** Pinned Codex's patch interface; DSH exposes JSON when patch is available. */
  readonly sourcePatch: 'freeform' | null
  /** Effective pinned Codex multi-agent interface with its enabled v1 fallback. */
  readonly sourceMultiAgentVersion: CodexfulMultiAgentVersion
  /** Pinned Codex's tool-mode selector. */
  readonly sourceToolMode: 'code_mode_only' | null
  /** Pinned Codex's shell tool selection; DSH presents its JSON command tools. */
  readonly sourceShellType: 'shell_command' | 'unified_exec'
  /** Whether the pinned model adds skill-usage guidance to its skill catalog. */
  readonly sourceSkillsUsageInstructions: boolean
  /** Whether ordinary Responses requests permit parallel tool calls before Lite conversion. */
  readonly sourceParallelToolCalls: boolean
}

/** DSH tool and message instructions appended after the unchanged source prompt. */
export const DSH_HOST_ADAPTATION = '# DSH runtime adaptation\n\nThe preceding instructions are the Codex model prompt. This session runs inside DeepSeek Harness. Use the tools in the current request schema as the authority for available operations and their parameters. Tool names mentioned above that do not appear in that schema are unavailable here.\n\nFor shell work use the JSON exec_command tool. A command that remains active returns a session_id; use write_stdin to poll or send input. Use JSON apply_patch with its required patch field for focused edits. Use update_plan for meaningful multi-step plans. The Codex functions.exec JavaScript orchestrator and functions.apply_patch freeform interface are not available. To run independent tools in parallel, make separate independent tool calls when the provider supports them; otherwise run them sequentially. Do not put a JavaScript Promise.allSettled expression in a shell command.\n\nFor a user question use ask_user_question when its schema is present. Progress and final replies are ordinary assistant text in this DSH session; the Codex commentary and final channel names do not designate separate DSH channels. Send a short progress message before a related group of tool calls when the provider supports text before tools, and give the final result after the work. Do not assume access to Codex app connectors, plugin discovery, skills.list/read, or other host-only tools. If the session publishes a <skills_instructions> catalog, follow its loading guidance: call the skill tool when its schema is present, or read the listed SKILL.md file with an available file or shell tool. A directly injected <skill_content> block is already loaded.\n\nThe environment_context and AGENTS.md messages appended by DSH describe the actual working directory and available permissions. Network access marked unknown is unverified, not permission to assume connectivity. The exec_command schema may expose sandbox_permissions for an approval request; follow its actual schema and the current approval policy. Tool errors and sandbox denials arrive as results to inspect and correct. These DSH-specific statements take precedence over conflicting Codex host instructions above.'

/** One source-model prompt selected for a DSH request route. */
export interface CodexfulModelProfile {
  /** Codex models.json slug, or `fallback` for other provider models. */
  readonly sourceModel: keyof typeof CODEX_PINNED_MODEL_PROMPTS | 'fallback'
  /** Version of the source prompt and DSH adaptation. */
  readonly promptVersion: typeof CODEXFUL_PROMPT_VERSION
  /** Verbatim model instructions or generic fallback; the host adaptation follows separately. */
  readonly prompt: string
}

/**
 * Choose the verbatim Codex source model text for the assembled route.
 * Unknown model slugs use Codex's generic model-manager fallback; the application
 * separately chooses JSON tool visibility for the selected route and mode.
 * @param model - model id captured by scoped prompt assembly.
 * @returns the source prompt and version identity.
 */
export function codexfulModelProfile(model: string | undefined): CodexfulModelProfile {
  if (model !== undefined && Object.hasOwn(CODEX_PINNED_MODEL_PROMPTS, model)) {
    const sourceModel = model as keyof typeof CODEX_PINNED_MODEL_PROMPTS
    return { sourceModel, promptVersion: CODEXFUL_PROMPT_VERSION, prompt: CODEX_PINNED_MODEL_PROMPTS[sourceModel] }
  }
  return { sourceModel: 'fallback', promptVersion: CODEXFUL_PROMPT_VERSION, prompt: CODEX_FALLBACK_PROMPT }
}

/**
 * Select the pinned Codex model's default effort for a route without its own default.
 * @param model - exact model id selected before request preparation.
 * @returns the pinned default, or undefined for a generic fallback model.
 */
export function codexfulReasoningDefault(model: string): 'low' | 'medium' | undefined {
  return Object.hasOwn(CODEX_PINNED_REASONING_DEFAULTS, model)
    ? CODEX_PINNED_REASONING_DEFAULTS[model as keyof typeof CODEX_PINNED_REASONING_DEFAULTS]
    : undefined
}

/**
 * Remove Codex-owned checklist guidance when update_plan is unavailable.
 * The pinned CLI applies this transformation to its model instructions before
 * composing the request; source prompt constants remain unchanged.
 * @param instructions - selected Codex model or fallback prompt.
 * @returns instructions without the pinned CLI's plan-tool guidance.
 */
export function withoutUpdatePlanInstructions(instructions: string): string {
  const lines: string[] = []
  for (let start = 0; start < instructions.length;) {
    const newline = instructions.indexOf('\n', start)
    if (newline < 0) {
      lines.push(instructions.slice(start))
      break
    }
    lines.push(instructions.slice(start, newline + 1))
    start = newline + 1
  }
  let rendered = ''
  for (let index = 0; index < lines.length;) {
    const current = lines[index]
    if (current === undefined) break
    const line = current.trimEnd()
    if (line === '## Planning' || line === '## `update_plan`'
      || line === '## Plan tool' || line === '## Plan Mode vs update_plan tool') {
      let end = index + 1
      while (end < lines.length && !lines[end]?.startsWith('# ') && !lines[end]?.startsWith('## ')) end++
      const isChecklistSection = line !== '## Planning'
        || lines.slice(index, end).some(item => item.startsWith('You have access to an `update_plan` tool')
          || item.startsWith('When `update_plan` is available, follow this section'))
      if (isChecklistSection) {
        index = end
        continue
      }
    }
    if (line === 'Progress visibility:'
      && lines[index + 1]?.startsWith('If update_plan is available')) {
      index += 2
      if (lines[index]?.trim().length === 0) index++
      continue
    }
    if (line.startsWith('- Use the plan tool ')
      || line.startsWith('- If you create a checklist or task list,')) {
      index++
      while (index < lines.length && (lines[index]?.startsWith(' ') || lines[index]?.startsWith('\t'))) index++
      continue
    }
    rendered += current
    index++
  }
  return rendered
}

/**
 * Resolve the pinned model's tool defaults without removing the daily JSON
 * editing and v2 delegation tools unless the operator explicitly selects Codex's model defaults.
 * @param model - model id selected before prompt assembly.
 * @param mode - daily DSH adaptation or pinned Codex patch and plan defaults.
 * @param updatePlan - explicit plan-tool override; pinned Codex defaults to off.
 * @param sessionVersion - previously selected Session delegation interface, when available.
 * @returns tool visibility and source-model metadata for this request.
 */
export function codexfulToolProfile(
  model: string | undefined,
  mode: CodexfulToolMode,
  updatePlan?: boolean,
  sessionVersion?: CodexfulMultiAgentVersion,
): CodexfulToolProfile {
  const sourceModel = codexfulModelProfile(model).sourceModel
  const defaults = sourceModel === 'fallback' ? undefined : CODEX_PINNED_MODEL_DEFAULTS[sourceModel]
  const multiAgentVersion = sessionVersion ?? defaults?.multiAgentVersion ?? 'v1'
  const hiddenTools: ('apply_patch' | 'update_plan' | typeof CODEXFUL_V1_TOOL_NAMES[number] | typeof CODEXFUL_V2_TOOL_NAMES[number])[] = []
  if (mode === 'codex-pinned') {
    if (defaults === undefined) hiddenTools.push('apply_patch')
    if (multiAgentVersion !== 'v1') hiddenTools.push(...CODEXFUL_V1_TOOL_NAMES)
    if (multiAgentVersion !== 'v2') hiddenTools.push(...CODEXFUL_V2_TOOL_NAMES)
    if (updatePlan !== true) hiddenTools.push('update_plan')
  } else {
    hiddenTools.push(...CODEXFUL_V1_TOOL_NAMES)
    if (updatePlan === false) hiddenTools.push('update_plan')
  }
  return {
    mode,
    hiddenTools,
    sourceTruncation: { mode: defaults === undefined ? 'bytes' : 'tokens', limit: 10000 },
    sourceResponsesLite: defaults?.responsesLite ?? false,
    sourcePatch: defaults === undefined ? null : 'freeform',
    sourceMultiAgentVersion: multiAgentVersion,
    sourceToolMode: defaults?.toolMode ?? null,
    sourceShellType: defaults === undefined ? 'unified_exec' : 'shell_command',
    sourceSkillsUsageInstructions: defaults?.skillsUsageInstructions ?? false,
    sourceParallelToolCalls: true,
  }
}
