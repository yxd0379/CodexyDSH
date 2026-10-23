/** Host registration of the product-owned Session MCP catalog invocation. */
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry/types'
import { descriptor } from './remote.ts'
export const TYPERT: TypertContribution = { package: '@codexydsh/mcp', face: 'host', schemas: [], invocations: [descriptor], model: { services: [], events: [], objects: [] } }
export default TYPERT
