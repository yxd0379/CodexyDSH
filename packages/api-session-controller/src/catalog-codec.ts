/** Browser-safe codec preserving native model-picker metadata. */
import { z } from 'zod'
const selection = z.object({ provider: z.string(), model: z.string(), reasoningEffort: z.string().optional() })
const effort = z.object({ id: z.string(), name: z.string(), description: z.string().optional() })
const model = z.object({ id: z.string(), name: z.string(), description: z.string().optional(),
  showInPicker: z.boolean().optional(), multiAgentVersion: z.enum(['disabled', 'v1', 'v2']).optional(),
  serviceTiers: z.array(z.string()).readonly().optional(),
  reasoning: z.object({ efforts: z.array(effort), defaultEffort: z.string().optional() }).optional(),
})
export const catalog = z.object({ default: selection, routableProviders: z.array(z.string()),
  groups: z.array(z.object({ id: z.string(), name: z.string(), models: z.array(model) })),
  failures: z.array(z.object({ id: z.string(), name: z.string(), message: z.string() })),
})
