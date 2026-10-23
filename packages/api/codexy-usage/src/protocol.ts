/** Owned usage method descriptors on the fixed platform Remote protocol. */
import { z } from 'zod'
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'

const usage_snapshot_parameter_0Schema = () => z.object({
  'since': z.number().readonly().optional(),
  'until': z.number().readonly().optional(),
});
const usage_snapshot_resultSchema = () => z.object({
  'capturedAt': z.number().readonly(),
  'totals': z.object({
  'requests': z.number(),
  'reportedRequests': z.number(),
  'inputTokens': z.number(),
  'outputTokens': z.number(),
  'totalTokens': z.number(),
  'cacheReadTokens': z.number(),
  'cacheWriteTokens': z.number(),
}).readonly(),
  'models': z.array(z.object({
  'provider': z.union([z.literal(null), z.string()]).readonly(),
  'model': z.union([z.literal(null), z.string()]).readonly(),
  'requests': z.number(),
  'reportedRequests': z.number(),
  'inputTokens': z.number(),
  'outputTokens': z.number(),
  'totalTokens': z.number(),
  'cacheReadTokens': z.number(),
  'cacheWriteTokens': z.number(),
})).readonly(),
});

/** Strict codecs for the product's methods; shared by Host and Client. */
export const invocations: readonly InvocationDescriptor[] = [
    {
      id: '@codexydsh/api-usage#usage/snapshot',
      service: 'usageController',
      namespace: 'usage',
      method: 'snapshot',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: '@codexydsh/api-usage/types#UsageRequest',
            create: usage_snapshot_parameter_0Schema,
          },
        },
      ],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: '@codexydsh/api-usage/types#UsageSnapshot',
        create: usage_snapshot_resultSchema,
      },
    },
  ]
