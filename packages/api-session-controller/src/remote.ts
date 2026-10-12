/** Public browser Session endpoints with native model-picker metadata preserved. */
import platform from '@deepseek-ai/dsh-api-session-controller/remote'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { catalog } from './catalog-codec.ts'
/** Preserve the published endpoint parameters while retaining native model metadata in responses. */
export const TYPERT_REMOTE: TypertRemoteContribution = { ...platform, package: '@codexydsh/api-session-controller',
  descriptors: platform.descriptors.map(descriptor => descriptor.namespace === 'session' && descriptor.method === 'modelCatalog'
    ? { ...descriptor, result: { ...descriptor.result, create: () => catalog } } : descriptor),
}
export default TYPERT_REMOTE
