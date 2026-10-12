/** Permission catalog RPC shared by the owned Host and browser plugins. */
import { z } from 'zod'
import type { InvocationDescriptor, RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { PermissionCatalog } from './types.ts'

const option = z.object({ value: z.string(), name: z.string(), description: z.string().optional() })
/** Process catalog retains the existing UI namespace and uses the owned service. */
export const descriptor: InvocationDescriptor = {
  id: '@codexydsh/permissions#permissionPresets/catalog', service: 'codexyPermissions',
  namespace: 'permissionPresets', method: 'catalog', invocation: { kind: 'direct' }, parameters: [],
  result: { mode: 'strict', typeSymbol: '@codexydsh/permissions/types#PermissionCatalog',
    create: () => z.object({ options: z.array(option), defaultOptions: z.array(option), defaultPreset: z.string() }) },
}
/** Browser mount contribution for permission discovery. */
export const TYPERT_REMOTE: TypertRemoteContribution = { package: '@codexydsh/permissions', descriptors: [descriptor] }
export default TYPERT_REMOTE

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap { 'permissionPresets/catalog': () => Promise<RemoteResult<PermissionCatalog>> }
  interface TypertRemoteNamespaceMap { permissionPresets: { catalog: TypertRemoteMap['permissionPresets/catalog'] } }
}
