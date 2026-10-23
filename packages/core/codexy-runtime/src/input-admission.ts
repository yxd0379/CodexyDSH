/** Codexful ordering of the model-visible input committed for one step. */

import { defaultInputAdmission } from './loop/input-admission.ts'
import type { AdmittedInput, InputAdmission, InputAdmissionPolicy } from './loop/input-admission.ts'
import { createDeveloperMessage } from './llm.ts'

/**
 * Keep instruction and environment fragments together before the user's task.
 * @param input - accepted step input and retained Session nodes.
 * @returns messages to commit in Codexful request order.
 */
export const codexfulInputAdmission: InputAdmissionPolicy = (input: InputAdmission): readonly AdmittedInput[] => {
  if (input.codexContextMode === undefined && input.permission === undefined && input.multiAgentRole === undefined) {
    return defaultInputAdmission(input)
  }
  const admitted: AdmittedInput[] = []
  const append = (message: AdmittedInput['message'], replaces?: AdmittedInput['replaces']): void => {
    admitted.push(replaces === undefined ? { message } : { message, replaces })
  }
  if (input.developer !== undefined) append(input.developer, input.developerSeq)
  if (input.permission !== undefined) append(input.permission)
  if (input.fallback !== undefined) append(input.fallback, input.fallbackSeq)

  const instructions: InputAdmission['messages'][number][] = []
  const developerContext: InputAdmission['messages'][number][] = []
  const environment: InputAdmission['messages'][number][] = []
  const other: InputAdmission['messages'][number][] = []
  for (const message of input.messages) {
    if (input.omitModelSelectionNotice
      && message.source.kind === 'model-selection' && message.source.form === 'notice') continue
    const kind: string = message.source.kind
    switch (kind) {
      case 'agent-instructions':
        instructions.push(message)
        break
      case 'runtime-context':
        if ('form' in message.source && message.source.form === 'instructions') {
          developerContext.push(message)
        } else {
          environment.push(message)
        }
        break
      default:
        other.push(message)
    }
  }
  for (const message of developerContext) {
    append(message, input.repair?.message === message ? input.repair.seq : undefined)
  }
  const appendRoleAndMode = (): void => {
    if (input.multiAgentRole !== undefined) append(input.multiAgentRole)
    if (input.multiAgentMode !== undefined) append(input.multiAgentMode)
  }
  if (input.codexContextMode === 'full') appendRoleAndMode()
  for (const message of [...instructions, ...environment]) {
    append(message, input.repair?.message === message ? input.repair.seq : undefined)
  }
  if (input.codexContextMode !== 'full') appendRoleAndMode()
  for (const message of other) {
    const kind: string = message.source.kind
    const admittedMessage = input.nativeDeveloperHistory === true && kind === 'user-approval'
      && 'approvedActionId' in message.source
      ? createDeveloperMessage({ content: message.content, source: message.source }) : message
    append(admittedMessage, input.repair?.message === message ? input.repair.seq : undefined)
  }
  return admitted
}
