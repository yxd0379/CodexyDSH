/** Host registration of the owned permission catalog. */
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry/types'
import { descriptor } from './remote.ts'
export const TYPERT: TypertContribution = { package: '@codexydsh/permissions', face: 'host', schemas: [], invocations: [descriptor], model: { services: [], events: [], objects: [] } }
export default TYPERT
