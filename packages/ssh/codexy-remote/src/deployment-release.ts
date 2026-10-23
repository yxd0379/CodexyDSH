/** The standalone server archive uploaded once per content digest. */
import { createHash } from 'node:crypto'
import { createReadStream, type Stats } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

/** Local archive identity, shared with the remote installation cache. */
export interface ServerArchive {
  readonly path: string
  readonly key: string
}

/**
 * Resolve deployment input once when the Remote service is constructed.
 * @param configured - Absolute override, or an empty string for the bundled server resource.
 * @param moduleDirectory - Directory containing the source or built Host entry.
 * @returns An absolute Linux ARM64 archive path; existence is checked only for automatic setup.
 */
export function resolveServerArchive(configured: string, moduleDirectory: string): string {
  if (configured === '') return resolve(moduleDirectory, '../server/linux-arm64.tar.gz')
  if (!isAbsolute(configured)) throw new Error('Remote serverArchive must be an absolute path.')
  return configured
}

/**
 * Verify an explicitly selected server archive and compute its cache identity.
 * @param path - Absolute local tar.gz path containing the standalone Linux ARM64 runtime.
 * @returns The unchanged path and SHA-256 digest, without installing or unpacking it.
 */
export async function discoverServerArchive(path: string): Promise<ServerArchive> {
  if (!isAbsolute(path)) throw new Error('Automatic Remote setup requires an absolute serverArchive path to the Linux ARM64 standalone server package.')
  let metadata: Stats
  try { metadata = await stat(path) }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new Error('The packaged Remote server is missing. Build the Linux ARM64 server resource and package CodexyDSH again.', { cause: error })
    throw error
  }
  if (!metadata.isFile()) throw new Error('The configured Remote server archive is not a regular file.')
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return { path, key: digest.digest('hex') }
}
