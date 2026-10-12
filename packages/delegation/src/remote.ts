/** Browser control RPC definitions for the owned delegation service. */
import { z } from 'zod'
import type { InvocationDescriptor, RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentPromptRequest, SubagentPromptReceipt, SubagentInterruptReceipt } from './control-types.ts'

const id = z.string()
const prompt = z.object({
  requestId: id, parentSessionId: id, childSessionId: id,
  mode: z.literal('continuable'), delivery: z.enum(['queue', 'steer']),
  content: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string() }),
    z.object({ type: z.literal('image'), mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
      data: z.string(), name: z.string().optional() }),
  ])), clientTimeZone: z.string().optional(),
})
/** Explicit public descriptors preserve the existing subagents browser endpoints. */
export const descriptors: InvocationDescriptor[] = [
  { id: '@codexydsh/delegation#subagents/prompt', service: 'codexySubagents', namespace: 'subagents',
    method: 'prompt', invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', codec: { mode: 'strict',
      typeSymbol: '@codexydsh/delegation/client#SubagentPromptRequest', create: () => prompt } }],
    cancellation: { parameter: 'signal' },
    result: { mode: 'strict', typeSymbol: '@codexydsh/delegation/client#SubagentPromptReceipt',
      create: () => z.object({ messageId: id }) },
  },
  { id: '@codexydsh/delegation#subagents/interruptByParent', service: 'codexySubagents', namespace: 'subagents',
    method: 'interruptByParent', invocation: { kind: 'direct' },
    parameters: [
      { name: 'childSessionId', wire: 'childSessionId', source: 'json', codec: { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-session/types#SessionId', create: () => id } },
      { name: 'parentSessionId', wire: 'parentSessionId', source: 'json', codec: { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-session/types#SessionId', create: () => id } },
      { name: 'mode', wire: 'mode', source: 'json', codec: { mode: 'strict', typeSymbol: '@codexydsh/delegation/client#continuable', create: () => z.literal('continuable') } },
    ],
    result: { mode: 'strict', typeSymbol: '@codexydsh/delegation/client#SubagentInterruptReceipt', create: () => z.object({ accepted: z.literal(true) }) },
  },
]
/** Browser namespace registration contribution. */
export const TYPERT_REMOTE: TypertRemoteContribution = { package: '@codexydsh/delegation', descriptors }
export default TYPERT_REMOTE

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'subagents/prompt': (request: SubagentPromptRequest, signal?: AbortSignal) => Promise<RemoteResult<SubagentPromptReceipt>>
    'subagents/interruptByParent': (childSessionId: SessionId, parentSessionId: SessionId, mode: 'continuable') => Promise<RemoteResult<SubagentInterruptReceipt>>
  }
  interface TypertRemoteNamespaceMap {
    subagents: { prompt: TypertRemoteMap['subagents/prompt']; interruptByParent: TypertRemoteMap['subagents/interruptByParent'] }
  }
}
