import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

/** Frozen prompt preparation state; rendered developer messages remain in the native session. */
export const memoryDomain = defineDomain({
  name: 'codexy_memory',
  version: 1,
  tables: {
    contexts: domainTable(z.object({ version: z.enum(['v1', 'v2']), fragments: z.array(z.string()) })),
  },
})
