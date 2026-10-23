import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

/** Nicknames belong to the child, not to a copied parent session prefix. */
export const delegationDomain = defineDomain({
  name: 'codexy_delegation', version: 1,
  tables: {
    identities: domainTable(z.object({ nickname: z.string().min(1), agentPath: z.string().optional() })
      .transform(({ nickname, agentPath }) => ({ nickname, ...agentPath === undefined ? {} : { agentPath } }))),
    fork_windows: domainTable(z.object({ cutoffSeq: z.number().int().nonnegative() })),
  },
})
