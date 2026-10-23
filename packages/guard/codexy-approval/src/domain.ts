import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

const reviewSchema = z.object({
  sessionId: z.string(), id: z.string(),
  status: z.enum(['approved', 'denied', 'failed', 'cancelled', 'manual']),
  assessment: z.object({
    risk_level: z.enum(['low', 'medium', 'high', 'critical']),
    user_authorization: z.enum(['unknown', 'low', 'medium', 'high']),
    outcome: z.enum(['allow', 'deny']), rationale: z.string(),
  }).optional(),
  error: z.string().optional(),
})

/** The main approval request and decision remain native session events. */
export const approvalDomain = defineDomain({
  name: 'codexy_approval', version: 1,
  tables: {
    reviews: domainTable(reviewSchema),
    settings: domainTable(z.object({ reviewer: z.enum(['user', 'auto_review']) })),
  },
})
export type StoredReview = z.infer<typeof reviewSchema>
