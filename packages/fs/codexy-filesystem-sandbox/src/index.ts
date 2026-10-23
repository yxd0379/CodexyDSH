/**
 * `SandboxedFileSystem`: the sandbox-enforcing implementation of the
 * `@codexydsh/filesystem` Service Definition. It extends `LocalFileSystem` so all
 * text-storage mechanics — resolve, stat, read/stream, list, the atomic
 * write and the read-match-write edit critical section — are the local
 * implementation's, verbatim; this package adds only the per-call POLICY fence
 * on the two mutations. Reads pass through untouched: every mode permits
 * reading.
 *
 * The fence is a policy check in TRUSTED code over a MODEL-CONTROLLED path,
 * NOT a kernel boundary — the operations are the seam's own (open, rename),
 * and only the target path is untrusted, so canonicalize-then-contain is the
 * complete answer to this surface. This is containment, not a security
 * boundary; kernel-grade isolation of untrusted CODE stays `ctx.shell`'s job
 * (`@deepseek-ai/dsh-bash-sandbox`). The residual
 * TOCTOU (an ancestor symlink swapped between the containment re-check and the
 * syscall) is narrowed by re-canonicalizing immediately before delegating and
 * is accepted for this threat model.
 *
 * Per-call policy: `read-only` denies every mutation; `workspace-write` allows
 * a mutation only when the target canonicalizes under the policy's workspace
 * root or a platform temp area from the shared `writableRoots` policy;
 * an optional backend setting also excludes top-level workspace metadata.
 * `danger-full-access` delegates unfenced. A denial throws the structured
 * `FS_SANDBOX_DENIED`.
 *
 * @module @codexydsh/filesystem-sandbox
 */

import { Context } from '@deepseek-ai/cordis'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { LocalFileSystem } from '@codexydsh/filesystem-local'
import type { Config as LocalConfig } from '@codexydsh/filesystem-local'
import { FsError } from '@codexydsh/filesystem'
import type { FsEditOutcome, FsEditRequest, FsTarget, FsVersion, FsWriteIntent, FsWriteOutcome } from '@codexydsh/filesystem'
import { writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { isPathUnder } from './containment.ts'

/**
 * Plugin config: local backend settings plus optional protection for workspace
 * metadata in this filesystem backend. The sandbox mode and workspace root
 * still come from `ctx.sandboxPolicy` for each call.
 */
export interface Config extends LocalConfig {
  /** Deny mutations to top-level `.git`, `.agents`, `.codex`, and `.aws` under the workspace root. Defaults to false. */
  protectWorkspaceMetadata?: boolean
}

const PROTECTED_WORKSPACE_METADATA_NAMES = ['.git', '.agents', '.codex', '.aws'] as const

/**
 * Sandbox-enforcing filesystem backend. Registers as `ctx.codexyFs` (loading it
 * INSTEAD OF `dsh-fs-local`, together with a `ctx.sandboxPolicy`, is the whole
 * swap — the model-facing tools are untouched). Its configured default mode is
 * the capability fact exposed by {@link sandboxMode}; `dsh-tool-fs` resolves
 * each session's mode and cwd into a policy for every mutation, while an
 * approved escalation may stamp a strictly wider mode for one call.
 */
export class SandboxedFileSystem extends LocalFileSystem {
  static override Config: z<Config> = z.intersect([
    LocalFileSystem.Config,
    z.object({ protectWorkspaceMetadata: z.boolean().default(false) }),
  ])

  static inject = ['sandboxPolicy']

  private readonly defaultMode: SandboxMode
  private readonly protectWorkspaceMetadata: boolean
  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    this.defaultMode = ctx.sandboxPolicy.defaultMode
    this.protectWorkspaceMetadata = config.protectWorkspaceMetadata ?? false
  }

  /** The deployment default mode — the capability fact the tool layer reads to advertise escalation. */
  override get sandboxMode(): SandboxMode {
    return this.defaultMode
  }

  /**
   * Fence the write by the per-call policy, then delegate to the inherited
   * atomic write. See {@link checkedTarget}.
   * @param target - the resolved target to write.
   * @param content - the full new file content.
   * @param expected - the write intent guarding the write; omit for unconditional.
   * @param signal - aborts before atomic publication takes effect.
   * @param sandboxPolicy - the per-call mode and workspace root; omit to use
   *   the deployment fallback.
   * @returns the write outcome from the inherited backend.
   */
  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    return super.writeText(await this.checkedTarget(target, sandboxPolicy), content, expected, signal)
  }

  /**
   * Fence the edit by the per-call policy, then delegate to the inherited
   * atomic edit. See {@link checkedTarget}.
   * @param target - the resolved target to edit.
   * @param edit - the literal search/replace request.
   * @param expected - the version guard; omit for an unconditional edit.
   * @param signal - aborts before atomic publication takes effect.
   * @param sandboxPolicy - the per-call mode and workspace root; omit to use
   *   the deployment fallback.
   * @returns the edit outcome from the inherited backend.
   */
  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    return super.editText(await this.checkedTarget(target, sandboxPolicy), edit, expected, signal)
  }

  /**
   * Fence deletion by the same per-call mode used for writes and edits.
   * @param target - resolved file to remove.
   * @param expected - optional stale-version guard.
   * @param signal - aborts before removal.
   * @param sandboxPolicy - current session's permission policy.
   * @returns once the file has been removed.
   */
  override async deleteFile(
    target: FsTarget,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<void> {
    return super.deleteFile(await this.checkedTarget(target, sandboxPolicy), expected, signal)
  }

  /**
   * Enforce the per-call policy against `target` and return the EXACT target the
   * mutation must use, so the checked identity is the mutated one (no
   * check-here-write-there TOCTOU). `read-only` denies; `workspace-write`
   * re-canonicalizes NOW (`resolve` realpaths the deepest existing ancestor,
   * reflecting a concurrently swapped symlink), requires containment under a
   * writable root, optionally excludes protected workspace metadata, and
   * returns THAT fresh target; `danger-full-access` returns the caller's target
   * unfenced. Throws the structured `FS_SANDBOX_DENIED` on
   * refusal — the tool layer maps it to the model-facing `[sandbox: …]` marker
   * and the escalation hint.
   */
  private async checkedTarget(target: FsTarget, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsTarget> {
    const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    const { mode } = policy
    if (mode === 'danger-full-access') return target
    if (mode === 'read-only') {
      throw new FsError(`cannot write "${target.displayPath}": file access denied under read-only mode`, 'FS_SANDBOX_DENIED')
    }
    // workspace-write: containment on the FRESH canonical path (catches a
    // symlink ancestor swapped since the tool resolved this target), and the
    // mutation delegates with THIS fresh target — never the stale one.
    const fresh = await this.resolve(target.displayPath)
    let contained = false
    for (const root of writableRoots(policy)) {
      if (await isPathUnder(fresh.targetKey, root)) {
        contained = true
        break
      }
    }
    if (!contained) {
      throw new FsError(`cannot write "${target.displayPath}": file access denied under workspace-write mode`, 'FS_SANDBOX_DENIED')
    }
    if (this.protectWorkspaceMetadata && await this.isProtectedWorkspaceMetadata(fresh, policy.workspaceRoot)) {
      throw new FsError(`cannot write "${target.displayPath}": protected workspace metadata is read-only under workspace-write mode`, 'FS_SANDBOX_DENIED')
    }
    return fresh
  }

  /** Check both the requested spelling and resolved target so metadata aliases cannot bypass the fence. */
  private async isProtectedWorkspaceMetadata(target: FsTarget, workspaceRoot: string): Promise<boolean> {
    const workspace = await this.resolve(workspaceRoot)
    for (const name of PROTECTED_WORKSPACE_METADATA_NAMES) {
      const metadata = await this.resolve(join(workspace.displayPath, name))
      if (await isPathUnder(target.displayPath, join(workspace.displayPath, name))
        || await isPathUnder(target.targetKey, metadata.targetKey)) return true
    }
    const gitdir = await this.worktreeGitDirectory(workspace.displayPath)
    if (gitdir && await isPathUnder(target.targetKey, gitdir.targetKey)) return true
    return false
  }

  /** A worktree's `.git` pointer can place its writable Git metadata outside `.git` itself. */
  private async worktreeGitDirectory(workspaceRoot: string): Promise<FsTarget | undefined> {
    const dotGit = join(workspaceRoot, '.git')
    try {
      if (!(await stat(dotGit)).isFile()) return undefined
      const contents = (await readFile(dotGit, 'utf8')).trim()
      const separator = contents.indexOf(':')
      if (separator < 0 || contents.slice(0, separator).trim() !== 'gitdir') return undefined
      const gitdir = contents.slice(separator + 1).trim()
      if (gitdir.length === 0) return undefined
      return await this.resolve(resolve(workspaceRoot, gitdir))
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return undefined
      throw error
    }
  }
}

export default SandboxedFileSystem
