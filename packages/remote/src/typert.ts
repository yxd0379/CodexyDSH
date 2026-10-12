/** Host registration of the product-owned Remote SSH invocation definitions. */
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry/types'
import { descriptors } from './remote.ts'
export const TYPERT: TypertContribution = { package: '@codexydsh/remote', face: 'host', schemas: [], invocations: descriptors, model: { services: [], events: [], objects: [] } }
export default TYPERT
