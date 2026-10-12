/** Deployment settings shared by the memory browser and its Host schema. */

/** Human memory browser configuration. */
export interface MemoryUiConfig {
  /** Status polling interval in milliseconds while an open dialog observes background generation. */
  statusPollMs?: number
}

/** Default browser interval also declared by the Host configuration schema. */
export const DEFAULT_STATUS_POLL_MS = 1500

/** Resolve the accepted browser interval, including an omitted deployment value.
 * @param config - Latest Host-projected settings, if already available.
 * @returns Delay between settled status reads.
 */
export function resolveStatusPollMs(config: MemoryUiConfig | undefined): number {
  return config?.statusPollMs ?? DEFAULT_STATUS_POLL_MS
}
