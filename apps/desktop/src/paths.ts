/** Filesystem ownership for the Electron-managed desktop installation. */

import { join, resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Stable desktop installation paths under the shared Harness home. */
export interface DesktopPaths {
  readonly profile: string
  readonly lock: string
}

/**
 * Resolve every Electron-owned path without changing the shared data roots.
 * @param dshHome - Harness home shared with npm-installed dsh.
 * @returns immutable desktop path set.
 */
export function resolveDesktopPaths(dshHome: string = resolveDshHome()): DesktopPaths {
  return {
    profile: join(dshHome, 'profiles', 'desktop'),
    lock: join(dshHome, 'profiles', 'desktop', 'lock'),
  }
}

/**
 * Resolve Electron data independently of the official DSH application.
 * @param appData - Operating-system application-data directory.
 * @param configured - Explicit Electron user-data directory; omission uses CodexyDSH's directory.
 * @returns absolute Electron user-data directory, including its single-instance lock.
 */
export function resolveDesktopUserData(appData: string, configured?: string): string {
  return configured === undefined ? join(appData, 'CodexyDSH') : resolve(configured)
}
