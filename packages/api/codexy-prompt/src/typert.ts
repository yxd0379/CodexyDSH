/** Host registration for the product draft RPC descriptor. */
import { descriptor } from './remote.ts'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry/types'
export const TYPERT = { package: '@codexydsh/api-prompt', face: 'host', schemas: [], invocations: [descriptor], model: { services: [], events: [], objects: [] } } satisfies TypertContribution
export default TYPERT
