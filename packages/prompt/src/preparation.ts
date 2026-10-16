/**
 * Frozen Codexful deployment and model settings shared by one prompt preparation.
 * Symbol metadata stays outside rendered variables and durable model input.
 * @module @codexydsh/prompt/preparation
 */

import type { PromptPreparation } from '@codexydsh/runtime/prompt'
import type { Config } from './index.ts'
import { captureResponseMetadataConfig, type ResponseMetadataConfig } from './response-metadata.ts'
import { codexfulModelProfile, codexfulReasoningDefault, codexfulToolProfile, withoutUpdatePlanInstructions } from './prompts.ts'
import type { CodexfulModelProfile, CodexfulMultiAgentVersion, CodexfulToolMode, CodexfulToolProfile } from './prompts.ts'

/** Detached deployment choices; streaming and retry fields apply when Agent effects are installed. */
export interface CodexfulDeploymentSnapshot {
  readonly toolProfile: CodexfulToolMode
  readonly strictModelInput: boolean
  readonly wireProfile: Config['wireProfile']
  readonly responseMetadata: Readonly<ResponseMetadataConfig> | undefined
  readonly protectExistingWorkspaceMetadata: boolean
  readonly updatePlan: boolean | undefined
  readonly networkAccess: 'enabled' | 'disabled' | 'unknown'
  readonly maxProviderRetryAfterMs: number | undefined
  readonly additionalRetryableCodes: readonly string[] | undefined
}

/** Immutable request settings derived once from the captured deployment and selected route. */
export interface CodexfulPreparationSnapshot {
  readonly deployment: CodexfulDeploymentSnapshot
  readonly provider: string | undefined
  readonly model: string | undefined
  readonly modelProfile: CodexfulModelProfile
  readonly toolProfile: CodexfulToolProfile
  readonly multiAgentVersion: CodexfulMultiAgentVersion
  readonly baseInstructions: string
  readonly reasoningSummary: 'auto' | 'none'
  readonly defaultReasoningEffort: 'low' | 'medium' | undefined
  readonly configuredReasoningEffort: string | undefined
  readonly inheritPersistedReasoningEffort: boolean
}

const preparedCodexful = Symbol('Codexful preparation snapshot')

type PreparedCodexfulVariables = Readonly<Record<string, string | undefined>> & {
  readonly [preparedCodexful]?: CodexfulPreparationSnapshot
}

/**
 * Capture deployment values before asynchronous preparation can observe changes.
 * @param config - live deployment configuration.
 * @returns detached frozen choices with resolved defaults.
 */
export function captureCodexfulDeployment(config: Config): CodexfulDeploymentSnapshot {
  const snapshot = Object.freeze({
    toolProfile: config.toolProfile ?? 'daily',
    strictModelInput: config.strictModelInput === true,
    wireProfile: config.wireProfile,
    responseMetadata: captureResponseMetadataConfig(config.metadata),
    protectExistingWorkspaceMetadata: config.protectExistingWorkspaceMetadata === true,
    updatePlan: config.updatePlan,
    networkAccess: config.networkAccess ?? 'unknown',
    maxProviderRetryAfterMs: config.maxProviderRetryAfterMs,
    additionalRetryableCodes: config.additionalRetryableCodes === undefined ? undefined
      : Object.freeze([...config.additionalRetryableCodes]),
  })
  return snapshot
}

/**
 * Attach one derived snapshot and family projection after all route selectors settle.
 * @param variables - final frozen values returned by the complete preparation waterfall.
 * @param deployment - choices captured before its first await.
 * @param selectedVersion - persisted delegation family captured with the deployment.
 * @param fallback - Agent route and effort captured before its first await.
 * @returns variables carrying private frozen settings and the public family projection.
 */
export function prepareCodexfulVariables(
  variables: Readonly<Record<string, string | undefined>>,
  deployment: CodexfulDeploymentSnapshot,
  selectedVersion: CodexfulMultiAgentVersion | null,
  fallback: { readonly provider: string | undefined; readonly model: string | undefined; readonly reasoningEffort: string | undefined },
): PreparedCodexfulVariables {
  const provider = variables.provider ?? fallback.provider
  const model = variables.model ?? fallback.model
  const modelProfile = Object.freeze(codexfulModelProfile(model))
  const resolvedTools = codexfulToolProfile(model, deployment.toolProfile, deployment.updatePlan,
    deployment.toolProfile === 'daily' ? 'v2' : selectedVersion ?? undefined)
  const toolProfile = Object.freeze({
    ...resolvedTools,
    hiddenTools: Object.freeze([...resolvedTools.hiddenTools]),
    sourceTruncation: Object.freeze({ ...resolvedTools.sourceTruncation }),
  })
  const snapshot: CodexfulPreparationSnapshot = Object.freeze({
    deployment, provider, model, modelProfile, toolProfile,
    multiAgentVersion: toolProfile.sourceMultiAgentVersion,
    baseInstructions: toolProfile.hiddenTools.includes('update_plan')
      ? withoutUpdatePlanInstructions(modelProfile.prompt) : modelProfile.prompt,
    reasoningSummary: modelProfile.sourceModel === 'fallback' ? 'auto' : 'none',
    defaultReasoningEffort: codexfulReasoningDefault(model ?? ''),
    configuredReasoningEffort: variables.reasoning_effort === undefined ? fallback.reasoningEffort
      : variables.reasoning_effort || undefined,
    inheritPersistedReasoningEffort: variables.reasoning_effort === undefined,
  })
  return { ...variables, [preparedCodexful]: snapshot, codexful_multi_agent_version: snapshot.multiAgentVersion }
}

/**
 * Read the private settings captured by Codexful's preparation contribution.
 * @param preparation - opaque token supplied by the system-prompt service.
 * @returns the frozen settings; a token without this contribution throws.
 */
export function codexfulPreparationOf(preparation: PromptPreparation): CodexfulPreparationSnapshot {
  const variables: PreparedCodexfulVariables = preparation.variables
  const snapshot = variables[preparedCodexful]
  if (snapshot === undefined) throw new Error('Codexful requires its captured preparation snapshot')
  return snapshot
}
