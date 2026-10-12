/** Local DSH confinement with Codexy workspace metadata protection. */
import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import LocalSandbox, { type Config as LocalConfig } from '@deepseek-ai/dsh-sandbox-local'
import { canonicalPath, SandboxUnavailableError, type SandboxPolicy, type ConfinedArgv } from '@deepseek-ai/dsh-sandbox'
import { existingMetadataReadOnlyPaths } from './metadata.ts'

/** Standard local runner options plus protection of existing workspace metadata. */
export interface Config extends LocalConfig { protectExistingWorkspaceMetadata?: boolean }
/** Local runner selection and validated metadata protection. */
export const Config = z.intersect([LocalSandbox.Config, z.object({ protectExistingWorkspaceMetadata: z.boolean().default(true) })])
/** Reuse public platform confinement and add read-only metadata binds to bwrap profiles. */
export default class CodexySandbox extends LocalSandbox {
  static Config = Config
  constructor(ctx: Context, private readonly options: Config) { super(ctx, options) }
  /** Protect existing metadata in workspace-write executions.
   * @param argv - Exact process invocation.
   * @param policy - Resolved sandbox mode and canonical workspace.
   * @param signal - Caller cancellation.
   * @returns Original confinement with additional read-only mounts when required.
   */
  override async confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
    const root = canonicalPath(policy.workspaceRoot)
    const paths = this.options.protectExistingWorkspaceMetadata !== false && policy.mode === 'workspace-write'
      ? existingMetadataReadOnlyPaths(root) : []
    const result = await super.confine(argv, { ...policy, workspaceRoot: root }, signal)
    if (paths.length === 0) return result
    if (this.options.runnerCommand?.length !== undefined && this.options.runnerCommand.length > 0 || basename(result.argv[0] ?? '') === 'bwrap') {
      const separator = result.argv.length - argv.length - 1
      if (result.argv[separator] !== '--' || !argv.every((argument, index) => argument === result.argv[separator + 1 + index])) {
        throw new SandboxUnavailableError(policy.mode, 'Local sandbox returned an unsupported runner invocation')
      }
      const mounts = paths.flatMap(path => ['--ro-bind', path, path])
      return { ...result, argv: [...result.argv.slice(0, separator), ...mounts, ...result.argv.slice(separator)] }
    }
    throw new SandboxUnavailableError(policy.mode, 'Selected local runner cannot protect existing workspace metadata')
  }
}
