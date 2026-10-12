/** Ordered Session messages admitted after an agent step's model route is prepared. */

import type { DeveloperMessage } from '../llm.ts'
import type { SessionSeq, UserMessage } from '../session.ts'

/** One message and its optional retained surface node to replace. */
export interface AdmittedInput {
  readonly message: UserMessage | DeveloperMessage
  readonly replaces?: SessionSeq
}

/** All inputs whose order affects the next model request. */
export interface InputAdmission {
  readonly messages: readonly UserMessage[]
  readonly developer?: DeveloperMessage
  readonly developerSeq?: SessionSeq
  readonly fallback?: UserMessage
  readonly fallbackSeq?: SessionSeq
  readonly permission?: UserMessage | DeveloperMessage
  readonly multiAgentRole?: UserMessage | DeveloperMessage
  readonly multiAgentMode?: UserMessage | DeveloperMessage
  readonly codexContextMode?: 'full' | 'delta'
  /** Whether the prepared provider accepts developer-role conversation messages. */
  readonly nativeDeveloperHistory?: boolean
  readonly repair?: { readonly message: UserMessage; readonly seq?: SessionSeq }
  readonly afterAgentInstructions: boolean
  readonly omitModelSelectionNotice: boolean
}

/** Application-owned ordering of model-visible messages within one prepared step. */
export type InputAdmissionPolicy = (input: InputAdmission) => readonly AdmittedInput[]

/**
 * Preserve default DSH placement and put scoped Codex instruction/context input before the direct task.
 * @param input - accepted step input and retained Session nodes.
 * @returns messages to commit in request order.
 */
export const defaultInputAdmission: InputAdmissionPolicy = (input) => {
  const admitted: AdmittedInput[] = []
  const append = (message: UserMessage | DeveloperMessage, replaces?: SessionSeq): void => {
    admitted.push(replaces === undefined ? { message } : { message, replaces })
  }
  let developerAdded = false
  const appendDeveloper = (): void => {
    if (developerAdded || input.developer === undefined) return
    append(input.developer, input.developerSeq)
    developerAdded = true
  }
  if (!input.afterAgentInstructions) appendDeveloper()
  if (input.permission !== undefined) append(input.permission)
  if (input.multiAgentRole !== undefined) append(input.multiAgentRole)
  let fallbackAdded = false
  if (input.fallback !== undefined && input.fallbackSeq !== undefined) {
    append(input.fallback, input.fallbackSeq)
    fallbackAdded = true
  }
  const appendFallback = (): void => {
    if (fallbackAdded || input.fallback === undefined) return
    append(input.fallback)
    fallbackAdded = true
  }
  let modeAdded = false
  const appendMode = (): void => {
    if (modeAdded || input.multiAgentMode === undefined) return
    append(input.multiAgentMode)
    modeAdded = true
  }

  const sourceKind = (message: UserMessage): string => message.source.kind
  const messages = input.permission === undefined && !input.omitModelSelectionNotice ? input.messages : [
    ...input.messages.filter(message => sourceKind(message) === 'agent-instructions'),
    ...input.messages.filter(message => sourceKind(message) === 'runtime-context'),
    ...input.messages.filter(message => sourceKind(message) !== 'agent-instructions'
      && sourceKind(message) !== 'runtime-context'),
  ]
  for (const message of messages) {
    if (input.omitModelSelectionNotice
      && message.source.kind === 'model-selection' && message.source.form === 'notice') continue
    const sourceKind: string = message.source.kind
    if (sourceKind !== 'agent-instructions' && sourceKind !== 'runtime-context') appendMode()
    if (input.afterAgentInstructions && sourceKind !== 'agent-instructions') {
      appendDeveloper()
      appendFallback()
    } else if (!input.afterAgentInstructions
      && sourceKind !== 'agent-instructions' && sourceKind !== 'runtime-context') {
      appendFallback()
    }
    append(message, input.repair?.message === message ? input.repair.seq : undefined)
  }
  if (input.afterAgentInstructions) appendDeveloper()
  appendFallback()
  appendMode()
  return admitted
}
