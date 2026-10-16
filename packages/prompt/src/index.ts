import { deriveProductMessages } from '@codexydsh/runtime/session'
import { currentToolRequestBinding } from '@codexydsh/bridges/tools'
import { requestHeaderOf } from '@codexydsh/runtime/session'
import type {} from '@codexydsh/compaction/service'
/**
 * Codexful coding prompt and runtime environment for an agent application.
 * @module @codexydsh/prompt
 */

import { readFileSync, readlinkSync } from 'node:fs'
import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@codexydsh/runtime'
import { CODEX_EXPLICIT_MULTI_AGENT_MODE, CODEX_PROACTIVE_MULTI_AGENT_MODE } from '@codexydsh/runtime'
import type { CodexEnvironmentSnapshot, CodexWorldStateInput } from '@codexydsh/runtime'
import { ReasoningEffortId, type AssistantMessage, type LlmCallConfig, type PreparedLlmModel, type UserMessage } from '@codexydsh/runtime/llm'
import type {} from '@deepseek-ai/dsh-compaction'
import type { Session } from '@codexydsh/runtime/session'
import type {} from '@codexydsh/retry'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@codexydsh/delegation'
import type {} from '@deepseek-ai/dsh-session-projection'
import { RUN_CODE_NAME } from '@codexydsh/runtime/tools'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type {} from '@codexydsh/approval'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { ApprovalPolicy, ApprovalReviewer } from '@codexydsh/approval'
import type { PromptAssembly, PromptPreparation } from '@codexydsh/runtime/prompt'
import { withPromptPreparationFinalizer } from '@codexydsh/prompt-registry'
import { DSH_HOST_ADAPTATION, type CodexfulToolMode } from './prompts.ts'
import { codexfulMultiAgentVersion, promptDomain, recordCodexfulMultiAgentVersion } from './multi-agent-version.ts'
import { buildCodexfulInitialContext, captureCodexfulInitialContextAssembly } from './initial-context.ts'
import type { CodexfulInitialContextAssembly } from './initial-context.ts'
import { captureCodexfulDeployment, codexfulPreparationOf, prepareCodexfulVariables } from './preparation.ts'
import type { CodexfulPreparationSnapshot } from './preparation.ts'
import { captureResponseMetadata, ResponseWorkspaceEnrichment } from './response-metadata.ts'
import type { ResponseMetadataConfig, ResponseMetadataPolicy } from './response-metadata.ts'

export { codexfulModelProfile, codexfulToolProfile } from './prompts.ts'
export { codexfulPreparationOf } from './preparation.ts'
export type { CodexfulPreparationSnapshot, CodexfulDeploymentSnapshot } from './preparation.ts'
export type { CodexfulModelProfile, CodexfulMultiAgentVersion, CodexfulToolMode, CodexfulToolProfile } from './prompts.ts'

/** Cordis plugin name. */
export const name = 'codexful-prompt'

/** Services that supply the active shell, file policy, and approval policy. */
export const inject = ['codexyPrompt', 'sandboxPolicy', 'codexyApproval', 'subprocess', 'agentLoop', 'llmRetry', 'tools', 'sessionProjections', 'storageDomain']

const MAX_ENVIRONMENT_SUBAGENTS = 8
const MAX_ENVIRONMENT_SUBAGENT_BYTES = 1_024

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Query command prefixes valid for the current default exec_command context.
     * @param request - the agent and cancellation for the current assembly.
     * @mode waterfall
     */
    'codexful/active-prefixes'(request: { agent: Agent; signal?: AbortSignal }, next: () => Promise<readonly (readonly string[])[]>): Promise<readonly (readonly string[])[]>
  }
}

/** Codexful model-tool selection, network facts, and retry allowances. */
export interface Config {
  /** Daily JSON editing tools, or pinned Codex defaults for patch and plan visibility. */
  toolProfile?: CodexfulToolMode
  /** Prefer pinned Codex input serialization; request equivalence is checked by the evaluator. */
  strictModelInput?: boolean
  /** Opt into the versioned Codex Responses wire format; omitted preserves current behavior. */
  wireProfile?: 'codex-0.162.1'
  /** Actual application identity, entry and collection facts for the explicit wire profile. */
  metadata?: ResponseMetadataConfig
  /** Describe Codexful's existing-path shell metadata protection when the mounted runner enables it. */
  protectExistingWorkspaceMetadata?: boolean
  /** Explicit update_plan exposure; Codex's pinned config defaults to disabled. */
  updatePlan?: boolean
  /**
   * Operator-confirmed network reachability of the execution provider. Leave
   * unknown unless the mounted executor enforces or verifies this value.
   */
  networkAccess?: 'enabled' | 'disabled' | 'unknown'
  /** Server Retry-After ceiling that can raise this application's provider policy cap, in milliseconds. */
  maxProviderRetryAfterMs?: number
  /** Additional transient failure codes eligible for this application's finite retries. */
  additionalRetryableCodes?: string[]
}

/** Runtime schema for the network fact shown to the model. */
export const Config: z<Config> = z.object({
  toolProfile: z.union(['daily', 'codex-pinned'] as const).default('daily'),
  strictModelInput: z.boolean().default(false),
  wireProfile: z.union(['codex-0.162.1'] as const),
  metadata: z.object({
    installationId: z.string().min(1),
    threadSource: z.string().min(1),
    turnTrigger: z.string().min(1),
    analyticsEnabled: z.boolean(),
    modelPolicy: z.object({
      nodeReplDisabled: z.boolean(),
      nodeReplAutoReviewRequired: z.boolean(),
    }),
  }),
  protectExistingWorkspaceMetadata: z.boolean().default(false),
  updatePlan: z.boolean(),
  networkAccess: z.union(['enabled', 'disabled', 'unknown'] as const).default('unknown'),
  maxProviderRetryAfterMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS),
  additionalRetryableCodes: z.array(z.string().min(1)),
})

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function codexLocalTimezone(): string {
  if (process.platform === 'linux') {
    let link: string | undefined
    try {
      link = readlinkSync('/etc/localtime')
    } catch (_error) {
      // Linux may provide /etc/timezone without a /etc/localtime symlink.
    }
    if (link !== undefined) {
      for (const prefix of ['/usr/share/zoneinfo/', '../usr/share/zoneinfo/', '/etc/zoneinfo/', '../etc/zoneinfo/']) {
        if (link.startsWith(prefix)) return link.slice(prefix.length)
      }
    }
    try {
      const timezone = readFileSync('/etc/timezone', 'utf8').trimEnd()
      if (timezone) return timezone
    } catch (_error) {
      // The host timezone is still available through Intl when this file is absent.
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

function currentDateAndTimezone(): { date: string; timezone: string } {
  const timezone = codexLocalTimezone()
  const parts = Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const part = (name: string) => parts.find(entry => entry.type === name)?.value ?? ''
  return { date: `${part('year')}-${part('month')}-${part('day')}`, timezone }
}

/** Read the Responses message phase carried by pi-ai's completed text-item signature. */
function isCommentaryItem(replayState: unknown, index = 0): boolean {
  if (typeof replayState !== 'object' || replayState === null || Array.isArray(replayState)) return false
  const blocks: unknown = Reflect.get(replayState, 'blocks')
  const item: unknown = Array.isArray(blocks) ? blocks[index] : undefined
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return false
  const signature: unknown = Reflect.get(item, 'textSignature')
  if (typeof signature !== 'string') return false
  let parsed: unknown
  try {
    parsed = JSON.parse(signature)
  } catch (_error) {
    // Other providers can use an opaque text signature.
    return false
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    && Reflect.get(parsed, 'v') === 1
    && typeof Reflect.get(parsed, 'id') === 'string'
    && Reflect.get(parsed, 'phase') === 'commentary'
}

/** A non-commentary text item closes the current answer in Codex's mailbox policy. */
function endsWithAssistantAnswer(message: AssistantMessage | undefined): boolean {
  if (message === undefined) return false
  const last = message.content.at(-1)
  return last?.type === 'text' && last.text.trim().length > 0
    && !isCommentaryItem(message.source.replayState, message.content.length - 1)
}

/** Inputs resolved at one prompt assembly, after session permission changes. */
export interface EnvironmentFacts {
  /** Captured effective working directory, or the immutable header's legacy fallback. */
  cwd: string
  /** Default shell reported by the execution provider. */
  shell: string
  /** DSH file-sandbox policy enforced by shell and filesystem operations. */
  sandbox: SandboxExecutionPolicy
  /** Effective ask/never policy for this Session. */
  approval: ApprovalPolicy
  /** Active reviewer; omitted facts describe interactive user approval. */
  approvalReviewer?: ApprovalReviewer
  /** Network reachability declared for the execution provider. */
  network: 'enabled' | 'disabled' | 'unknown'
  /** Current calendar date in the host's timezone. */
  date: string
  /** Host timezone name. */
  timezone: string
  /** Direct child task paths visible in this step's environment. */
  subagents?: readonly string[]
  /** Loaded legacy children, with their durable nickname and optional canonical path. */
  legacySubagents?: CodexEnvironmentSnapshot['legacySubagents']
}

/**
 * Render a Codex-style environment message with DSH's actual permission facts.
 * @param facts - execution environment and current Session policies.
 * @returns XML-formatted model-visible runtime context.
 */
export function renderEnvironmentContext(facts: EnvironmentFacts): string {
  const snapshot = environmentSnapshot(facts)
  return renderEnvironmentUpdate(snapshot)
}

function boundedSubagents(paths: readonly string[] = []): string[] {
  const entries: string[] = []
  let renderedBytes = Buffer.byteLength('  <subagents>\n  </subagents>\n')
  for (const path of paths) {
    if (entries.length === MAX_ENVIRONMENT_SUBAGENTS) break
    const line = `<agent name="${escapeXml(path)}" />`
    const lineBytes = Buffer.byteLength(`    ${line}\n`)
    if (renderedBytes + lineBytes <= MAX_ENVIRONMENT_SUBAGENT_BYTES) {
      renderedBytes += lineBytes
      entries.push(path)
    }
  }
  return entries
}

function legacySubagentLines(entries: NonNullable<CodexEnvironmentSnapshot['legacySubagents']>): string[] {
  return entries.map((entry) => {
    const reference = entry.agentPath === undefined ? entry.id : entry.agentPath.split('/').at(-1) ?? 'root'
    return entry.nickname === undefined || entry.nickname.length === 0
      ? `- ${reference}` : `- ${reference}: ${entry.nickname}`
  })
}

function compareLegacySubagents(
  left: NonNullable<CodexEnvironmentSnapshot['legacySubagents']>[number],
  right: NonNullable<CodexEnvironmentSnapshot['legacySubagents']>[number],
): number {
  const leftPath = left.agentPath ?? ''
  const rightPath = right.agentPath ?? ''
  return leftPath < rightPath ? -1 : leftPath > rightPath ? 1
    : left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

function environmentSnapshot(facts: EnvironmentFacts, pinned = false): CodexEnvironmentSnapshot {
  const escaped = (value: string) => escapeXml(value)
  const workspaceRoot = escaped(facts.sandbox.workspaceRoot)
  const fileSystem = facts.sandbox.mode === 'danger-full-access'
    ? '<permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile>'
    : '<permission_profile type="managed"><file_system type="restricted">'
      + '<entry access="read"><special>:root</special></entry>'
      + (facts.sandbox.mode === 'workspace-write'
        ? `<entry access="write"><path>${workspaceRoot}</path></entry>`
          + '<entry access="write"><special>:slash_tmp</special></entry>'
          + '<entry access="write"><special>:tmpdir</special></entry>'
        : '')
      + '</file_system></permission_profile>'
  return {
    cwd: facts.cwd, shell: facts.shell, date: facts.date, timezone: facts.timezone,
    network: pinned ? '' : facts.network === 'unknown' ? '<network status="unknown" />'
      : `<network enabled="${facts.network === 'enabled' ? 'true' : 'false'}"></network>`,
    filesystem: `<filesystem><workspace_roots><root>${workspaceRoot}</root></workspace_roots>${fileSystem}</filesystem>`,
    subagents: boundedSubagents(facts.subagents),
    ...facts.legacySubagents === undefined ? {} : {
      legacySubagents: facts.legacySubagents.map(entry => ({ ...entry })).sort(compareLegacySubagents),
    },
  }
}

function renderEnvironmentUpdate(current: CodexEnvironmentSnapshot, previous?: CodexEnvironmentSnapshot): string {
  const changedCwd = previous === undefined || current.cwd !== previous.cwd
  const changedShell = previous === undefined || current.shell !== previous.shell
  const lines = [
    '<environment_context>',
    ...changedCwd ? [`  <cwd>${escapeXml(current.cwd)}</cwd>`] : [],
    ...changedShell ? [`  <shell>${escapeXml(current.shell)}</shell>`] : [],
    `  <current_date>${escapeXml(current.date)}</current_date>`,
    `  <timezone>${escapeXml(current.timezone)}</timezone>`,
    ...current.network.length > 0 ? [`  ${current.network}`] : [],
    `  ${current.filesystem}`,
  ]
  const subagentLines = current.legacySubagents === undefined
    ? current.subagents.map(path => `<agent name="${escapeXml(path)}" />`)
    : legacySubagentLines(current.legacySubagents)
  if (subagentLines.length) lines.push('  <subagents>', ...subagentLines.map(line => `    ${line}`), '  </subagents>')
  lines.push('</environment_context>')
  return lines.join('\n')
}

/**
 * Render a single-environment delta; unchanged cwd and shell stay in cached history.
 * @param current - current model-visible environment fields.
 * @param previous - last retained environment snapshot.
 * @returns a new XML fragment only when an environment field other than the child roster changed.
 */
export function renderEnvironmentDiff(current: CodexEnvironmentSnapshot, previous: CodexEnvironmentSnapshot): string | undefined {
  const { subagents: _currentPaths, legacySubagents: _currentLegacy, ...currentEnvironment } = current
  const { subagents: _previousPaths, legacySubagents: _previousLegacy, ...previousEnvironment } = previous
  return JSON.stringify(currentEnvironment) === JSON.stringify(previousEnvironment)
    ? undefined : renderEnvironmentUpdate(current, previous)
}

/**
 * Explain the current file and approval policy using the tools this application
 * actually mounts. The agent loop records changes in the prepared route's
 * native developer role or in a separate user-role fallback.
 * @param facts - execution environment and current Session policies.
 * @param hiddenTools - model tools omitted by the current profile.
 * @param protectExistingWorkspaceMetadata - whether the mounted shell runner protects existing workspace metadata.
 * @returns model-visible permission instructions for this step.
 */
export function renderPermissionInstructions(
  facts: EnvironmentFacts,
  hiddenTools: ReadonlySet<string> = new Set(),
  protectExistingWorkspaceMetadata = false,
): string {
  if (facts.sandbox.mode === 'danger-full-access' && facts.approval === 'never' && facts.network === 'enabled') {
    return 'Filesystem sandboxing defines which files can be read or written. `sandbox_mode` is `danger-full-access`: No filesystem sandboxing - all commands are permitted. Network access is enabled.\n\n'
      + 'Approval policy is currently never. Do not provide the `sandbox_permissions` for any reason, commands will be rejected.'
  }
  const patchEscalationMode = facts.sandbox.mode === 'read-only' ? 'workspace-write' : 'danger-full-access'
  const patchAvailable = !hiddenTools.has('apply_patch')
  const sandboxRules: Record<SandboxExecutionPolicy['mode'], string> = {
    'read-only': `The standing file sandbox allows reads but denies file writes by exec_command${patchAvailable ? ' and apply_patch' : ''}.`,
    'workspace-write': 'The standing file sandbox allows writes under the workspace root shown in <filesystem> and some platform temporary areas; writes elsewhere may be denied. Treat top-level .git, .agents, .codex, and .aws workspace metadata as protected. '
      + (patchAvailable ? 'The active apply_patch implementation enforces this, but ' : 'The ')
      + (patchAvailable ? 'the ' : '')
      + (protectExistingWorkspaceMetadata
        ? 'shell protection depends on the runner and whether a metadata path already exists; do not modify metadata with exec_command.'
        : 'shell sandbox does not protect those paths separately; do not modify them with exec_command.'),
    'danger-full-access': 'The DSH file sandbox does not restrict file writes. A sandbox escalation cannot grant wider file access.',
  }
  const approvalRules: Record<ApprovalPolicy, string> = {
    ask: facts.sandbox.mode === 'danger-full-access'
      ? `Approval policy is ask, but ordinary exec_command${patchAvailable ? ' and apply_patch' : ''} calls do not request approval when they already have full file access. Follow the user's authorization for destructive actions.`
      : `Approval policy is ask. If you know a required exec_command needs file access outside the standing sandbox, set sandbox_permissions: "require_escalated" and include a short user-facing question in justification on that tool call. If a required command fails because the sandbox denied it, retry the same command with those parameters. An approved command runs without the DSH file sandbox. ${patchAvailable ? `If apply_patch is denied, retry the patch with sandbox_permissions: "${patchEscalationMode}" and a justification. ` : ''}The tool call requests approval; do not ask separately in assistant text. A rejected or unavailable approval grants no wider access; do not work around it through another tool.`,
    never: 'Approval policy is never. Do not set sandbox_permissions or justification; requests for wider access are rejected automatically. Use operations available under the standing mode and explain any blocked work.',
  }
  return [
    '# Permissions',
    'The DSH local file sandbox governs writes; it does not isolate reads or network traffic. Network reachability is reported as '
      + `${facts.network}; do not infer it from the file sandbox mode.`,
    sandboxRules[facts.sandbox.mode],
    approvalRules[facts.approval],
    ...facts.approvalReviewer === 'auto_review'
      ? ['`approvals_reviewer` is `auto_review`: Sandbox escalations with require_escalated will be reviewed for compliance with the policy. If a rejection happens, you should proceed only with a materially safer alternative, or inform the user of the risk and send a final message to ask for approval.']
      : [],
    ...facts.approval === 'ask' && facts.sandbox.mode !== 'danger-full-access'
      ? ['For a literal single command under a system POSIX shell, exec_command may include prefix_rule with require_escalated to propose a Session-scoped grant. The approval UI shows the exact token prefix; if approved, later matching literal commands in this Session may run outside the file sandbox without another prompt. Shell operators, expansion, redirection, globbing, broad interpreter prefixes, Windows shells, and arbitrary shell paths cannot use a prefix grant. A sandbox or approval-policy switch invalidates it.']
      : [],
  ].join('\n\n')
}

/**
 * Prefer the bundled Codex permission templates when they describe the actual
 * DSH policy; otherwise render the actual policy instead of rejecting a turn.
 * @param facts - execution environment and current Session policies.
 * @returns pinned template sentences with their single section separator; the caller adds fragment tags.
 */
export function renderPinnedPermissionInstructions(facts: EnvironmentFacts): string {
  if (!hasPinnedPermissions(facts)) return renderPermissionInstructions(facts)
  const sandbox = facts.sandbox.mode === 'danger-full-access'
    ? 'Filesystem sandboxing defines which files can be read or written. `sandbox_mode` is `danger-full-access`: No filesystem sandboxing - all commands are permitted. Network access is enabled.'
    : 'Filesystem sandboxing defines which files can be read or written. `sandbox_mode` is `read-only`: The sandbox only permits reading files. Network access is enabled.'
  return `${sandbox}\nApproval policy is currently never. Do not provide the \`sandbox_permissions\` for any reason, commands will be rejected.`
}

function hasPinnedPermissions(facts: EnvironmentFacts): boolean {
  return facts.approval === 'never' && facts.network === 'enabled'
    && (facts.sandbox.mode === 'danger-full-access' || facts.sandbox.mode === 'read-only')
}

function toolAdaptation(hiddenTools: ReadonlySet<string>): string {
  let text = DSH_HOST_ADAPTATION
  if (hiddenTools.has('apply_patch')) {
    text = text.replace('Use JSON apply_patch with its required patch field for focused edits.',
      'apply_patch is unavailable on this model route; use exec_command for file edits when the current permissions allow it.')
  }
  if (hiddenTools.has('update_plan')) {
    text = text.replace('Use update_plan for meaningful multi-step plans.',
      'update_plan is unavailable on this model route; keep the plan in ordinary assistant text when useful.')
  }
  return text
}

/** Successful assembly owned by one Agent and one opaque preparation token. */
interface CapturedCodexfulAssembly {
  readonly owner: Agent
  readonly promptPreparation: PromptPreparation
  readonly assembly: CodexfulInitialContextAssembly
  readonly preparation: CodexfulPreparationSnapshot
  readonly worldState: CodexWorldStateInput
  readonly preparedModel: PreparedLlmModel | undefined
  readonly restoredReasoningEffort: string | undefined
  readonly delegates: boolean
  readonly metadataPolicy: ResponseMetadataPolicy
}

/**
 * Install a Codex-derived coding prompt and current environment for agents in
 * this agent scope. Reject a later request route that differs from the route
 * captured at assembly so it cannot silently receive another model's prompt.
 * @param ctx - scoped agent context.
 * @param config - deployment choices for prompt preparation and Agent lifecycle effects.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  captureCodexfulDeployment(config)
  const workspaceEnrichment = new ResponseWorkspaceEnrichment(ctx.subprocess)
  ctx.effect(() => () => workspaceEnrichment.dispose())
  const domain = await ctx.storageDomain.open(promptDomain)
  ctx.effect(() => () => domain.close(), 'codexy-prompt.domainClose')
  const selections = domain.table('delegation')
  const hiddenToolsByAgent = new WeakMap<Agent, ReadonlySet<string>>()
  const assembledWorldState = new WeakMap<PromptAssembly, CodexWorldStateInput>()
  const currentAssemblies = new WeakMap<Session, CapturedCodexfulAssembly>()
  const preparedAssemblies = new WeakMap<PromptPreparation, CapturedCodexfulAssembly>()
  const pendingAssemblies = new WeakMap<PromptPreparation, Omit<CapturedCodexfulAssembly, 'assembly' | 'delegates'> & {
    readonly hiddenTools: ReadonlySet<string>
  }>()
  const requestConfigurations = new WeakMap<PromptPreparation, Readonly<LlmCallConfig>>()
  const capturedFor = (
    owner: { readonly session: Session }, promptPreparation?: PromptPreparation,
  ): CapturedCodexfulAssembly | undefined => {
    const captured = promptPreparation === undefined ? currentAssemblies.get(owner.session) : preparedAssemblies.get(promptPreparation)
    if (promptPreparation !== undefined && (captured === undefined || captured.owner !== owner)) {
      throw new Error('Codexful preparation has no successful assembly owned by this agent')
    }
    return captured
  }
  ctx.on('agent/request-enter', ({ agent, promptPreparation, config: request }) => {
    capturedFor(agent, promptPreparation)
    requestConfigurations.set(promptPreparation, request)
    return Promise.resolve()
  })
  ctx.on('codexy-prompt/assembled', (assembly, context) => {
    const promptPreparation = context.promptPreparation
    if (promptPreparation === undefined) return
    const pending = pendingAssemblies.get(promptPreparation)
    if (pending === undefined || pending.owner !== context.agent) return
    const { hiddenTools, ...facts } = pending
    const captured: CapturedCodexfulAssembly = Object.freeze({
      ...facts,
      assembly: captureCodexfulInitialContextAssembly(assembly),
      delegates: assembly.tools.some(tool => tool.name === 'spawn_agent'),
    })
    assembledWorldState.set(assembly, captured.worldState)
    hiddenToolsByAgent.set(pending.owner, hiddenTools)
    preparedAssemblies.set(promptPreparation, captured)
    currentAssemblies.set(pending.owner.session, captured)
  })
  ctx.on('codexy-prompt/prepare', async (_variables, context, next) => {
    const agent = context.agent
    if (agent === undefined) return next()
    const deployment = captureCodexfulDeployment(config)
    const selectedVersion = codexfulMultiAgentVersion(selections, agent.session)
    const fallback = { provider: agent.options.provider, model: agent.options.model, reasoningEffort: agent.options.reasoningEffort }
    const variables = await next()
    return withPromptPreparationFinalizer(variables, finalVariables =>
      prepareCodexfulVariables(finalVariables, deployment, selectedVersion, fallback))
  })
  ctx.on('codexy-prompt/assemble', async (_assembly, context, next) => {
    if (context.agent !== undefined && context.promptPreparation !== undefined
      && codexfulPreparationOf(context.promptPreparation).deployment.wireProfile === 'codex-0.162.1') {
      const cwd = ctx.codexyPrompt.preparedWorkingDirectory(context.promptPreparation)
        ?? context.agent.session.header.cwd ?? process.cwd()
      workspaceEnrichment.start(context.agent.session, cwd, context.signal)
    }
    const assembled = await next()
    const agent = context.agent
    if (agent === undefined) return assembled
    if (ctx.tools.get(RUN_CODE_NAME, agent) !== undefined
      || assembled.tools.some(tool => tool.name === RUN_CODE_NAME)) {
      throw new Error('Codexful DSH requires native JSON tools; run_code, PTC, and both-mode presentation are unsupported')
    }
    if (context.promptPreparation === undefined) throw new Error('Codexful assembly requires a prompt preparation token')
    const preparation = codexfulPreparationOf(context.promptPreparation)
    const { provider, model, multiAgentVersion: version, deployment, toolProfile } = preparation
    const mode = deployment.toolProfile
    if (assembled.variables.provider !== undefined && assembled.variables.provider !== provider
      || assembled.variables.model !== undefined && assembled.variables.model !== model) {
      throw new Error('Codexful assembly route differs from its captured preparation')
    }
    await recordCodexfulMultiAgentVersion(selections, agent.session, version)
    const hiddenTools = new Set<string>(toolProfile.hiddenTools)
    const policy = ctx.sandboxPolicy.resolve({ session: agent.session })
    const approval = ctx.codexyApproval.overrideOf(agent.session) ?? ctx.codexyApproval.config.policy ?? 'ask'
    const terminal = await ctx.subprocess.terminalEnvironment(context.signal)
    const shell = basename(terminal.defaultShell ?? (terminal.platform === 'windows' ? 'powershell.exe' : '/bin/bash'))
    const { date, timezone } = currentDateAndTimezone()
    const subagents = ctx.get('codexySubagents')
    const children = subagents === undefined ? [] : await subagents.listChildren(agent.id, context.signal)
    const liveAgents = ctx.get('agents')
    if (subagents !== undefined && liveAgents === undefined) {
      throw new Error('Codexful subagent environment requires the agents service')
    }
    const legacySubagents: NonNullable<CodexEnvironmentSnapshot['legacySubagents']>[number][] = []
    if (version === 'v1' && subagents !== undefined) {
      for (const child of children) {
        if (child.mode !== 'continuable') continue
        // A resumed resident survives tool reload before its parent result is committed.
        const live = subagents.loadedContinuable(agent, child.id)
        if (live === undefined) continue
        const identity = subagents.identityOf(live.session.id)
        legacySubagents.push({ id: child.id,
          ...identity === null ? {} : {
            nickname: identity.nickname,
            ...identity.agentPath === undefined ? {} : { agentPath: identity.agentPath },
          },
        })
      }
    }
    const effectiveCwd = ctx.codexyPrompt.preparedWorkingDirectory(context.promptPreparation)
    const currentDirectories = assembled.contexts.filter(section => section.name === 'working-directory:current')
    const currentDirectory = currentDirectories.length === 1 ? currentDirectories[0] : undefined
    const mappedDirectory = effectiveCwd !== undefined && currentDirectory?.interpolate === false
      && currentDirectory.role === undefined
      && currentDirectory.text === `Current working directory: ${JSON.stringify(effectiveCwd)}.`
    // The ordinary platform context is already represented by durable environment facts.
    // Unrecognized or additional context remains model-visible instead of being discarded.
    const runtimeContexts = mappedDirectory
      ? assembled.contexts.filter(section => section !== currentDirectory) : assembled.contexts
    const approvalReviewer = ctx.codexyApproval.reviewerOf(agent.session)
    const facts: EnvironmentFacts = {
      cwd: effectiveCwd ?? agent.session.header.cwd ?? process.cwd(),
      shell,
      sandbox: policy,
      approval,
      approvalReviewer,
      network: deployment.networkAccess,
      date,
      timezone,
      subagents: version === 'v1' ? [] : children.flatMap(child => child.mode === 'continuable' && liveAgents?.get(child.id) !== undefined
        ? [child.label] : []).sort(),
      ...version === 'v1' ? { legacySubagents } : {},
    }
    const metadataPolicy = Object.freeze({ sandboxMode: policy.mode,
      autoReviewEnabled: approval === 'ask' && approvalReviewer === 'auto_review' })
    const strict = deployment.strictModelInput
    const pinnedPermissions = strict && hasPinnedPermissions(facts)
    const permissions = pinnedPermissions
      ? renderPinnedPermissionInstructions(facts)
      : renderPermissionInstructions(facts, hiddenTools, deployment.protectExistingWorkspaceMetadata)
    const visibleTools = assembled.tools.filter(tool => !hiddenTools.has(tool.name))
    // Preserve mounted product capabilities. Differences from Codex belong in
    // the evaluator's request report, not in a pre-dispatch product whitelist.
    const retainedContexts = runtimeContexts.filter(section =>
      section.name !== 'sandbox:policy' && section.name !== 'approval:policy'
      && section.name !== 'subagent:delegation'
      && !(hiddenTools.has('spawn_agent') && section.name === 'codexful-v2:multi-agent-role'))
    const permissionContext = {
      name: 'codexful:permissions',
      role: 'developer' as const,
      text: `<permissions instructions>\n${permissions}\n</permissions instructions>`,
    }
    const snapshot = environmentSnapshot(facts, pinnedPermissions)
    Object.freeze(snapshot.subagents)
    if (snapshot.legacySubagents !== undefined) {
      for (const child of snapshot.legacySubagents) Object.freeze(child)
      Object.freeze(snapshot.legacySubagents)
    }
    Object.freeze(snapshot)
    const environmentContext = {
      name: 'codexful:environment',
      text: renderEnvironmentUpdate(snapshot),
    }
    const prefixes = await ctx.waterfall('codexful/active-prefixes', {
      agent, ...context.signal === undefined ? {} : { signal: context.signal },
    },
    () => Promise.resolve<readonly (readonly string[])[]>([]))
    const result: PromptAssembly = {
      ...assembled,
      contextSnapshotIntro: 'none',
      sections: mode === 'codex-pinned' ? [{
        name: 'codexful:base',
        text: preparation.baseInstructions,
        interpolate: false,
      }] : [
        {
          name: 'codexful:base',
          text: preparation.baseInstructions,
          interpolate: false,
        },
        ...assembled.sections.filter(section =>
          section.name !== 'harness:identity'
          && section.name !== 'deployment:persona-prefix'
          && section.name !== 'deployment:persona-suffix'
          && section.name !== 'ui:deliverable-file-references'),
        {
          name: 'codexful:host-adaptation',
          text: toolAdaptation(hiddenTools),
          interpolate: false,
        },
      ],
      contexts: mode === 'codex-pinned'
        ? [...retainedContexts, permissionContext, environmentContext]
        : [...retainedContexts, environmentContext, permissionContext],
      tools: visibleTools,
    }
    const worldState: CodexWorldStateInput = Object.freeze({
      environment: Object.freeze({
        snapshot, fullText: environmentContext.text,
        diffText: (previous: CodexEnvironmentSnapshot) => renderEnvironmentDiff(snapshot, previous),
      }),
      permissions: Object.freeze({ instructions: permissionContext.text,
        prefixes: Object.freeze(prefixes.map(prefix => Object.freeze([...prefix]))) }),
      ...retainedContexts.some(section => section.name === 'codexful-v2:multi-agent-role') ? {
        multiAgentRole: retainedContexts.find(section => section.name === 'codexful-v2:multi-agent-role')?.text ?? '',
      } : {},
    })
    const header = requestHeaderOf(agent.session)
    pendingAssemblies.set(context.promptPreparation, Object.freeze({
      owner: agent,
      promptPreparation: context.promptPreparation,
      preparation,
      worldState,
      metadataPolicy,
      preparedModel: context.preparedModel,
      restoredReasoningEffort: header !== undefined && header.config.provider === provider && header.config.model === model
        && header.adapterDefaults?.reasoningEffort !== true ? header.config.reasoningEffort : undefined,
      hiddenTools,
    }))
    return result
  }, { prepend: true })
  ctx.on('codexy-compaction/initial-context', async ({ agent: owner, signal, promptPreparation }, next) => {
    const captured = capturedFor(owner, promptPreparation)
    if (captured === undefined) return next()
    const { assembly, preparation, worldState: state, preparedModel, restoredReasoningEffort } = captured
    const preparedConfig = requestConfigurations.get(captured.promptPreparation)
    const { provider, model: modelId } = preparation
    if (provider === undefined || modelId === undefined) {
      throw new Error('Codexful compaction requires a captured provider and model')
    }
    let mode: string | undefined
    if (captured.delegates) {
      const llm = ctx.get('codexyRequests')
      if (llm === undefined) throw new Error('Codexful delegation compaction requires the llm service')
      let effort: string | undefined = preparedConfig?.reasoningEffort
      if (preparedConfig === undefined) {
        const model = preparedModel?.model ?? await llm.resolveModelInfo(provider, modelId, signal)
        effort = preparation.configuredReasoningEffort
          ?? (preparation.inheritPersistedReasoningEffort ? restoredReasoningEffort : undefined)
          ?? model.reasoning?.defaultEffort ?? preparation.defaultReasoningEffort
      }
      mode = effort === 'ultra' ? CODEX_PROACTIVE_MULTI_AGENT_MODE : CODEX_EXPLICIT_MULTI_AGENT_MODE
    }
    const instructions = deriveProductMessages(owner.session).filter((message): message is UserMessage => {
      const kind: string = message.source.kind
      return message.role === 'user' && kind === 'agent-instructions'
    })
    return buildCodexfulInitialContext(assembly, state, instructions, mode)
  })
  ctx.on('codexy-agent/pre-step', async ({ agent, promptPreparation }, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const preparation = capturedFor(agent, promptPreparation)?.preparation
    if (preparation === undefined) throw new Error('Codexful input placement requires its captured preparation snapshot')
    const mode = preparation.deployment.toolProfile
    return {
      ...decision,
      ...mode === 'codex-pinned' ? {} : { developerContextPlacement: 'after-agent-instructions' as const },
    }
  }, { prepend: true })
  ctx.on('codexy-agent/request', async ({ agent, signal, promptPreparation, preparedModel }, next) => {
    const request = await next()
    const captured = capturedFor(agent, promptPreparation)
    if (!captured?.preparation.provider || !captured.preparation.model) {
      throw new Error('Codexful prompt needs a provider and model before assembly; select a route in agent options or model selection')
    }
    const { preparation } = captured
    if (request.provider !== preparation.provider || request.model !== preparation.model) {
      throw new Error(`Codexful prompt was assembled for ${preparation.provider}/${preparation.model}, but the request resolved to ${request.provider}/${request.model}`)
    }
    const strictModelInput = preparation.deployment.strictModelInput
    const reasoningSummary = preparation.reasoningSummary
    const pinnedEffort = request.reasoningEffort === undefined ? preparation.defaultReasoningEffort : undefined
    let defaultEffort: ReturnType<typeof ReasoningEffortId> | undefined
    if (pinnedEffort !== undefined) {
      const llm = ctx.get('codexyRequests')
      if (llm === undefined) throw new Error('Codexful reasoning defaults require the llm service')
      const model = preparedModel?.model ?? await llm.resolveModelInfo(request.provider, request.model, signal)
      if (model.reasoning?.defaultEffort === undefined) defaultEffort = ReasoningEffortId(pinnedEffort)
    }
    const reasoningEffort = defaultEffort ?? request.reasoningEffort
    const effectiveEffort = reasoningEffort ?? preparedModel?.model.reasoning?.defaultEffort
      ?? captured.preparedModel?.model.reasoning?.defaultEffort
    const workspaces = workspaceEnrichment.read(agent.session)
    const clientMetadata = preparation.deployment.wireProfile === 'codex-0.162.1'
      ? captureResponseMetadata(agent.session, preparation.deployment.responseMetadata, captured.metadataPolicy,
        { model: request.model, ...effectiveEffort === undefined ? {} : { reasoningEffort: effectiveEffort },
          ...workspaces === undefined ? {} : { workspaces } })
      : undefined
    const proposedRequest: LlmCallConfig = {
      ...request,
      ...defaultEffort === undefined ? {} : { reasoningEffort: defaultEffort },
      codexfulResponses: {
        omitDefaultMaxTokens: request.maxTokens === undefined,
        reasoningSummary,
        ...preparation.deployment.wireProfile === undefined ? {} : { wireProfile: preparation.deployment.wireProfile },
        ...clientMetadata === undefined ? {} : { clientMetadata },
        ...strictModelInput ? { strictModelInput: true as const } : {},
      },
    }
    return proposedRequest
  }, { prepend: true })
  ctx.on('agent/created', async ({ agent, source }) => {
    agent.ctx.effect(() => () => workspaceEnrichment.cancel(agent.session), 'codexful.workspaceEnrichment')
    const deployment = captureCodexfulDeployment(config)
    if (deployment.toolProfile !== 'codex-pinned') {
      await recordCodexfulMultiAgentVersion(selections, agent.session, 'v2')
    } else if (codexfulMultiAgentVersion(selections, agent.session) === null) {
      const parentId = agent.session.header.parentSession
      const parent = parentId === undefined ? undefined : ctx.get('agents')?.get(parentId)
      const inherited = parent === undefined ? null
        : codexfulMultiAgentVersion(selections, parent.session)
      if (inherited !== null) {
        await recordCodexfulMultiAgentVersion(selections, agent.session, inherited)
      } else if (source === 'resume' || agent.session.header.isSeeded) {
        await recordCodexfulMultiAgentVersion(selections, agent.session, 'v1')
      }
    }
    agent.ctx.effect(() => ctx.agentLoop.enableCodexWorldState(agent, (assembly) => {
      const state = assembledWorldState.get(assembly)
      if (state === undefined) throw new Error('Codexful world state requires this step\'s assembled facts')
      return state
    }), 'codexful.worldState')
    agent.ctx.effect(() => ctx.agentLoop.enableCodexModelSwitch(agent, (assembly) => {
      const base = assembly.sections.find(section => section.name === 'codexful:base')
      if (base === undefined || base.interpolate !== false) {
        throw new Error('Codexful model switch requires assembled codexful:base instructions')
      }
      return base.text
    }), 'codexful.modelSwitch')
    agent.ctx.effect(() => ctx.agentLoop.enableInterruptedTurnMarker(agent), 'codexful.interruptedTurnMarker')
    agent.ctx.effect(() => ctx.agentLoop.enableCodexToolArgumentFeedback(agent), 'codexful.toolArgumentFeedback')
    agent.ctx.effect(() => ctx.agentLoop.enableCodexToolConcurrency(agent), 'codexful.toolConcurrency')
    agent.ctx.effect(() => ctx.agentLoop.enableCodexInputOrder(agent, message =>
      message.source.kind === 'agent-message' || message.source.kind === 'subagent-settled', (message) => {
      const kind: string = message.source.kind
      return kind === 'user-shell-command'
    }), 'codexful.inputOrder')
    agent.ctx.effect(() => ctx.agentLoop.enableCodexMailboxDeferral(agent, (message, pending) =>
      endsWithAssistantAnswer(message) && pending.length > 0
      && pending.every(input => input.source.kind === 'agent-message' && input.source.queueOnly === true)),
    'codexful.mailboxDeferral')
    agent.ctx.effect(() => ctx.tools.guard(exec =>
      exec.agent === agent && currentToolRequestBinding() === undefined && hiddenToolsByAgent.get(agent)?.has(exec.name)
        ? `${exec.name} is unavailable in the current Codexful model tool profile`
        : undefined), 'codexful.modelToolProfile')
    const limitMs = deployment.maxProviderRetryAfterMs
    const additionalRetryableCodes = deployment.additionalRetryableCodes
    if (limitMs !== undefined || additionalRetryableCodes?.length) {
      agent.ctx.effect(
        () => ctx.llmRetry.registerAgentRetryOverrides(agent, {
          ...limitMs === undefined ? {} : { maxProviderRetryAfterMs: limitMs },
          ...additionalRetryableCodes === undefined ? {} : { additionalRetryableCodes },
        }),
        'codexful.retryOverrides',
      )
    }
  })
}
