/** Host registration of the shared product RPC descriptors. */
import { invocations } from './protocol.ts'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry/types'
/** Only this product's owned remote methods are registered. */
export const TYPERT = { package: '@codexydsh/api-memory', face: 'host', schemas: [], invocations, model: { services: [], events: [], objects: [] } } satisfies TypertContribution
export default TYPERT
