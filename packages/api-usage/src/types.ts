/** Read-only usage totals derived from retained Session logs. */

/** Time filter applied to attempt dispatch, or settlement on older logs. */
export interface UsageRequest {
  /** Inclusive Unix epoch milliseconds; omitted for all retained history. */
  readonly since?: number
  /** Exclusive Unix epoch milliseconds; omitted for no upper bound. */
  readonly until?: number
}

/** Provider-reported token buckets and settled request counts. */
export interface UsageTotals {
  /** Settled attempts, including retries, failures, and cancellations. */
  requests: number
  /** Attempts with provider-reported usage, including reported zero usage. */
  reportedRequests: number
  /** All input tokens, including cache reads and writes. */
  inputTokens: number
  /** Output tokens, including reasoning tokens when reported by the provider. */
  outputTokens: number
  /** Input plus output tokens. */
  totalTokens: number
  /** Input tokens served from the provider cache; a subset of inputTokens. */
  cacheReadTokens: number
  /** Input tokens written to the provider cache; a subset of inputTokens. */
  cacheWriteTokens: number
}

/** One model route's usage; equal model ids from different providers stay distinct. */
export interface ModelUsage extends UsageTotals {
  /** Recorded adapter id, or null when an old attempt has no route metadata. */
  readonly provider: string | null
  /** Recorded model id, or null when an old attempt has no route metadata. */
  readonly model: string | null
}

/** Detached usage response for the active profile's live and persisted Sessions. */
export interface UsageSnapshot {
  /** Time at which collection completed, in Unix epoch milliseconds. */
  readonly capturedAt: number
  /** Total across all models. */
  readonly totals: UsageTotals
  /** Model rows ordered by descending total tokens, then requests and route identity. */
  readonly models: readonly ModelUsage[]
}
