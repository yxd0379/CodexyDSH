/** Public Session codecs with the product model metadata retained by the catalog endpoint. */
import { TYPERT as platformMetadata } from '@deepseek-ai/dsh-api-session-controller/typert'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry/types'
import { catalog } from './catalog-codec.ts'
// The pinned public metadata is exported as unknown; its registry validates contributions.
const platform = platformMetadata as TypertContribution
/** Keep endpoint identities and parameter codecs compatible with the published browser client. */
export const TYPERT: TypertContribution = { ...platform, package: '@codexydsh/api-session-controller',
  invocations: platform.invocations.map(descriptor => descriptor.namespace === 'session' && descriptor.method === 'modelCatalog'
    ? { ...descriptor, result: { ...descriptor.result, create: () => catalog } } : descriptor),
}
