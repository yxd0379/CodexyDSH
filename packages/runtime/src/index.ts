/** Codexy application-owned agent driver over the unmodified DSH service APIs. */
import { AgentLoop } from './loop/index.ts'
import { codexfulInputAdmission } from './input-admission.ts'
import type { InputAdmissionPolicy } from './loop/input-admission.ts'
import './ports.ts'

/** The sole AgentFactory for a Codexy application. */
export class CodexyAgentLoop extends AgentLoop {
  protected override inputAdmissionPolicy(): InputAdmissionPolicy {
    return codexfulInputAdmission
  }
}

export * from './loop/index.ts'
export { codexfulInputAdmission } from './input-admission.ts'
export default CodexyAgentLoop
