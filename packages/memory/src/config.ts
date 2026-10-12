/** Validated deployment policy for Codex-style local memory. */

import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { MemoryVersion } from './service.ts'

/** Memory storage, background work, and bounded model policy. */
export interface Config {
  /** Application-owned base directory; the selected memories namespace is appended. */
  root: string
  /** Coherent prompt and artifact revision; V1 is the default. */
  version: MemoryVersion
  /** Allow automatic startup and explicit two-phase refresh. */
  generateMemories: boolean
  /** Contribute the initial read instructions and allow dedicated retrieval tools. */
  useMemories: boolean
  /** Expose the four JSON memories tools instead of relying only on ordinary shell retrieval. */
  dedicatedTools: boolean
  /** Exclude source Sessions containing external MCP or web tool context. */
  disableOnExternalContext: boolean
  /** Minimum source idle time in hours; explicit human refresh bypasses this delay. */
  minRolloutIdleHours: number
  /** Maximum source age in days measured from the latest meaningful Session evidence. */
  maxRolloutAgeDays: number
  /** Inactive-record selection expiry in days; historical files are retained. */
  maxUnusedDays: number
  /** Maximum successful source extractions in one startup or explicit refresh. */
  maxRolloutsPerStartup: number
  /** Maximum usage-ranked records considered by consolidation. */
  maxRawMemories: number
  /** Complete auxiliary request byte cap, including system instructions and evidence framing. */
  maxInputBytes: number
  /** Maximum completion tokens for each extraction or consolidation request. */
  maxOutputTokens: number
  /** Summary allowance using the pinned four-byte token heuristic. */
  summaryTokens: number
  /** Read/search output allowance using the pinned four-byte token heuristic. */
  readTokens: number
  /** Maximum complete managed document or extraction-record bytes. */
  maxArtifactBytes: number
  /** Maximum public filesystem entries visited by one search. */
  maxSearchFiles: number
  /** Maximum matches returned in one search page. */
  maxSearchResults: number
  /** Maximum immediate directory entries returned in one list page. */
  maxListResults: number
  /** Maximum bytes in one explicit human correction note. */
  maxNoteBytes: number
  /** Deadline in milliseconds for each auxiliary model request. */
  timeoutMs: number
  /** Expiry of an abandoned memory writer lease, renewed while its owner lives. */
  writerLockStaleMs: number
  /** Failed extraction or exact consolidation-input retry delay in milliseconds; explicit human refresh bypasses it. */
  retryBackoffMs: number
  /** Optional extraction provider override; must be paired with model. */
  provider?: string
  /** Optional extraction model override; must be paired with provider. */
  model?: string
  /** Optional consolidation provider override; must be paired with consolidationModel. */
  consolidationProvider?: string
  /** Optional consolidation model override; must be paired with consolidationProvider. */
  consolidationModel?: string
}

/** Direct construction permits Loader defaults while requiring an explicit storage root. */
export type ConfigInput = Partial<Config> & Pick<Config, 'root'>

/** Loader schema; storage roots remain explicit application-owned paths. */
export const Config: z<Config> = z.object({
  root: z.string().required(),
  version: z.union(['v1', 'v2'] as const).default('v1'),
  generateMemories: z.boolean().default(true),
  useMemories: z.boolean().default(true),
  dedicatedTools: z.boolean().default(false),
  disableOnExternalContext: z.boolean().default(false),
  minRolloutIdleHours: z.number().min(0).default(6),
  maxRolloutAgeDays: z.number().min(1).default(10),
  maxUnusedDays: z.number().min(1).default(30),
  maxRolloutsPerStartup: z.number().step(1).min(1).max(128).default(2),
  maxRawMemories: z.number().step(1).min(1).max(4096).default(256),
  maxInputBytes: z.number().step(1).min(1).default(512_000),
  maxOutputTokens: z.number().step(1).min(1).default(8_192),
  summaryTokens: z.number().step(1).min(1).default(2_500),
  readTokens: z.number().step(1).min(1).default(20_000),
  maxArtifactBytes: z.number().step(1).min(1).default(1_048_576),
  maxSearchFiles: z.number().step(1).min(1).default(2_000),
  maxSearchResults: z.number().step(1).min(1).max(200).default(200),
  maxListResults: z.number().step(1).min(1).max(2_000).default(2_000),
  maxNoteBytes: z.number().step(1).min(1).default(16_384),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(120_000),
  writerLockStaleMs: z.number().step(1).min(5000).max(MAX_TIMER_DELAY_MS).default(10000),
  retryBackoffMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(3_600_000),
  provider: z.string(), model: z.string(),
  consolidationProvider: z.string(), consolidationModel: z.string(),
})

/** Validate direct construction using the same Loader defaults.
 * @param input - Application or test configuration.
 * @returns Detached effective policy; incomplete routes fail immediately.
 */
export function resolveConfig(input: ConfigInput): Config {
  const config = Config(input as Config)
  for (const [provider, model] of [[config.provider, config.model], [config.consolidationProvider, config.consolidationModel]]) {
    if ((provider === undefined) !== (model === undefined) || provider?.trim() === '' || model?.trim() === '') {
      throw new Error('codexful-memory: provider and model must be non-empty and supplied together')
    }
  }
  if (config.root.trim() === '') throw new Error('codexful-memory: root must be non-empty')
  return Object.freeze(config)
}
