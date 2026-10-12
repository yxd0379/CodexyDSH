/** Existing workspace metadata paths protected by the local bwrap profile. @module @deepseek-ai/dsh-sandbox-local/metadata */

import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'

const METADATA_NAMES = ['.git', '.agents', '.codex', '.aws'] as const

/**
 * Find existing metadata paths that the bwrap writable-root bind must remount read-only.
 * @param workspaceRoot - canonical workspace root for one confined command.
 * @returns existing metadata paths, including a worktree gitdir inside the workspace.
 */
export function existingMetadataReadOnlyPaths(workspaceRoot: string): string[] {
  const paths: string[] = []
  for (const name of METADATA_NAMES) {
    const path = join(workspaceRoot, name)
    let metadata: ReturnType<typeof lstatSync>
    try {
      metadata = lstatSync(path)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue
      throw new SandboxUnavailableError('workspace-write', `Cannot inspect protected metadata path ${path}: ${String(error)}`)
    }
    if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
      throw new SandboxUnavailableError('workspace-write', `Protected metadata path ${path} is not a regular file or directory`)
    }
    paths.push(path)
    if (name !== '.git' || !metadata.isFile()) continue

    let pointer: string
    try {
      if (metadata.size > 4_096) throw new Error('gitdir pointer is larger than 4096 bytes')
      pointer = readFileSync(path, 'utf8').trim()
    } catch (error) {
      throw new SandboxUnavailableError('workspace-write', `Cannot inspect worktree gitdir pointer ${path}: ${String(error)}`)
    }
    const match = /^gitdir:\s*(.+)$/u.exec(pointer)
    const gitdirRaw = match?.[1]
    if (gitdirRaw === undefined) continue
    const gitdir = resolve(workspaceRoot, gitdirRaw)
    let resolved: string
    try {
      resolved = realpathSync(gitdir)
    } catch (error) {
      throw new SandboxUnavailableError('workspace-write', `Cannot resolve worktree gitdir ${gitdir}: ${String(error)}`)
    }
    const withinRoot = relative(workspaceRoot, resolved)
    if (withinRoot === '..' || withinRoot.startsWith(`..${sep}`) || isAbsolute(withinRoot)) continue
    const pointerWithinRoot = relative(workspaceRoot, gitdir)
    const pointerIsWritable = pointerWithinRoot !== '..'
      && !pointerWithinRoot.startsWith(`..${sep}`) && !isAbsolute(pointerWithinRoot)
    if (pointerIsWritable && resolved !== gitdir) {
      throw new SandboxUnavailableError('workspace-write', `Worktree gitdir ${gitdir} crosses a symbolic link inside the writable workspace`)
    }
    paths.push(resolved)
  }
  return [...new Set(paths)]
}
