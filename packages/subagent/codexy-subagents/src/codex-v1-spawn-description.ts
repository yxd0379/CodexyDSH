/** Pinned Codex 8f195c93 default multi_agent_v1 spawn guidance, Apache-2.0.
 * @module @codexydsh/subagents/codex-v1-spawn-description
 */

/** Model-visible default v1 spawn description for the pinned model catalog. */
export const CODEX_PINNED_V1_SPAWN_DESCRIPTION =
  '\n        \n        Available model overrides (optional; inherited parent model is preferred):\n- `gpt-' +
  '6-astra`: Frontier intelligence for the most demanding work. Reasoning efforts: low (default), mediu' +
  'm, high, xhigh, max, ultra. Service tiers: priority.\n- `gpt-6-sol`: Workhorse model for coding and e' +
  'veryday work. Reasoning efforts: low, medium (default), high, xhigh, max, ultra. Service tiers: prio' +
  'rity.\n- `gpt-6-luna`: Fast and affordable model for easier tasks. Reasoning efforts: low, medium (de' +
  'fault), high, xhigh, max. Service tiers: priority.\n- `gpt-5.6-sol`: Older coding model for complex w' +
  'ork. Reasoning efforts: low (default), medium, high, xhigh, max, ultra. Service tiers: priority.\n- `' +
  'gpt-5.6-terra`: Older balanced model for straightforward work. Reasoning efforts: low, medium (defau' +
  'lt), high, xhigh, max, ultra. Service tiers: priority.\n        Spawn a sub-agent for a well-scoped t' +
  'ask. Returns the spawned agent id plus the user-facing nickname when available. Spawned agents inher' +
  'it your current model by default. Omit `model` to use that preferred default; set `model` only when ' +
  'an explicit override is needed.\nThis spawn_agent tool provides you access to sub-agents that inherit' +
  ' your current model by default. Do not set the `model` field unless the user explicitly asks for a d' +
  'ifferent model. You should follow the rules and guidelines below to use this tool.\n\nDo not spawn sub' +
  '-agents unless the user or applicable AGENTS.md/skill instructions explicitly ask for sub-agents, de' +
  'legation, or parallel agent work.\nRequests for depth, thoroughness, research, investigation, or deta' +
  'iled codebase analysis do not count as permission to spawn.\nAgent-role guidance below only helps cho' +
  'ose which agent to use after spawning is already authorized; it never authorizes spawning by itself.' +
  '\n\n### When to delegate vs. do the subtask yourself\n- First, quickly analyze the overall user task an' +
  'd form a succinct high-level plan. Identify which tasks are immediate blockers on the critical path,' +
  ' and which tasks are sidecar tasks that are needed but can run in parallel without blocking the next' +
  ' local step. As part of that plan, explicitly decide what immediate task you should do locally right' +
  ' now. Do this planning step before delegating to agents so you do not hand off the immediate blockin' +
  'g task to a submodel and then waste time waiting on it.\n- Use a subagent when a subtask is easy enou' +
  'gh for it to handle and can run in parallel with your local work. Prefer delegating concrete, bounde' +
  'd sidecar tasks that materially advance the main task without blocking your immediate next local ste' +
  'p.\n- Do not delegate urgent blocking work when your immediate next step depends on that result. If t' +
  'he very next action is blocked on that task, the main rollout should usually do it locally to keep t' +
  'he critical path moving.\n- Keep work local when the subtask is too difficult to delegate well and wh' +
  'en it is tightly coupled, urgent, or likely to block your immediate next step.\n\n### Designing delega' +
  'ted subtasks\n- Subtasks must be concrete, well-defined, and self-contained.\n- Delegated subtasks mus' +
  't materially advance the main task.\n- Do not duplicate work between the main rollout and delegated s' +
  'ubtasks.\n- Avoid issuing multiple delegate calls on the same unresolved thread unless the new delega' +
  'ted task is genuinely different and necessary.\n- Narrow the delegated ask to the concrete output you' +
  ' need next.\n- For coding tasks, prefer delegating concrete code-change worker subtasks over read-onl' +
  'y explorer analysis when the subagent can make a bounded patch in a clear write scope.\n- When delega' +
  'ting coding work, instruct the submodel to edit files directly in its forked workspace and list the ' +
  'file paths it changed in the final answer.\n- For code-edit subtasks, decompose work so each delegate' +
  'd task has a disjoint write set.\n\n### After you delegate\n- Call wait_agent very sparingly. Only call' +
  ' wait_agent when you need the result immediately for the next critical-path step and you are blocked' +
  ' until it returns.\n- Do not redo delegated subagent tasks yourself; focus on integrating results or ' +
  'tackling non-overlapping work.\n- While the subagent is running in the background, do meaningful non-' +
  'overlapping work immediately.\n- Do not repeatedly wait by reflex.\n- When a delegated coding task ret' +
  'urns, quickly review the uploaded changes, then integrate or refine them.\n\n### Parallel delegation p' +
  'atterns\n- Run multiple independent information-seeking subtasks in parallel when you have distinct q' +
  'uestions that can be answered independently.\n- Split implementation into disjoint codebase slices an' +
  'd spawn multiple agents for them in parallel when the write scopes do not overlap.\n- Delegate verifi' +
  'cation only when it can run in parallel with ongoing implementation and is likely to catch a concret' +
  'e risk before final integration.\n- The key is to find opportunities to spawn multiple independent su' +
  'btasks in parallel within the same round, while ensuring each subtask is well-defined, self-containe' +
  'd, and materially advances the main task.'

/** The pinned CLI's default picker catalog is metadata, not an endpoint's /models response.
 * Projection from Codex 0.162.1 commit 092d3acd6bec3e3a14bdc7e7a2810ab628ab759d:
 * models-manager/models.json blob 72a78e0eacf94103f4babda2a5245aba4ce848c1.
 * The unchanged v1 description body is from multi_agents_spec.rs blob
 * edc9467b4d02cc023d8961373637116cf8ba6f6f (Apache-2.0).
 * Unknown/custom model routes use this same CLI fallback. Real override admission
 * still resolves the configured product route; this does not declare GPT models
 * to be served by a local Qwen endpoint.
 */
export const CODEX_01621_DEFAULT_MODEL_PRESETS = [
  { model: 'gpt-6.1-sol', description: 'Latest workhorse model for coding and everyday work.', defaultEffort: 'low', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], tiers: ['priority'] },
  { model: 'gpt-6-astra', description: 'Frontier intelligence for the most demanding work.', defaultEffort: 'low', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], tiers: ['priority'] },
  { model: 'gpt-6-sol', description: 'Previous generation workhorse model.', defaultEffort: 'medium', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], tiers: ['priority'] },
  { model: 'gpt-6-luna', description: 'Fast and affordable model for easier tasks.', defaultEffort: 'medium', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], tiers: ['priority'] },
  { model: 'gpt-5.6-sol', description: 'Older generation workhorse model.', defaultEffort: 'low', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], tiers: ['priority'] },
] as const

/** Explicit version selection leaves the original product description unchanged. */
export function codexV1SpawnDescription(wireProfile?: 'codex-0.162.1'): string {
  if (wireProfile === undefined) return CODEX_PINNED_V1_SPAWN_DESCRIPTION
  const catalog = CODEX_01621_DEFAULT_MODEL_PRESETS.map(model => {
    const efforts = model.efforts.map(effort => effort === model.defaultEffort ? `${effort} (default)` : effort).join(', ')
    return `- \`${model.model}\`: ${model.description} Reasoning efforts: ${efforts}. Service tiers: ${model.tiers.join(', ')}.`
  }).join('\n')
  const body = CODEX_PINNED_V1_SPAWN_DESCRIPTION.slice(CODEX_PINNED_V1_SPAWN_DESCRIPTION.indexOf('\n        Spawn a sub-agent'))
  return `\n        \n        Available model overrides (optional; inherited parent model is preferred):\n${catalog}${body}`
}
