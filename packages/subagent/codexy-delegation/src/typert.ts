/** Host registration of the owned delegation browser controls. */
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry/types'
import { descriptors } from './remote.ts'
export const TYPERT: TypertContribution = { package: '@codexydsh/delegation', face: 'host', schemas: [], invocations: descriptors, model: { services: [], events: [], objects: [] } }
export default TYPERT
