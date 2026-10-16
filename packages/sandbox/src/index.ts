/** Local DSH confinement with Codexy workspace metadata protection. */
import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import LocalSandbox, { type Config as LocalConfig } from '@deepseek-ai/dsh-sandbox-local'
import { canonicalPath, SandboxUnavailableError, type SandboxPolicy, type ConfinedArgv } from '@deepseek-ai/dsh-sandbox'
import { existingMetadataReadOnlyPaths, seatbeltMetadataProtectedPaths } from './metadata.ts'

/** Standard local runner options plus protection of existing workspace metadata. */
export interface Config extends LocalConfig { protectExistingWorkspaceMetadata?: boolean }
/** Local runner selection and validated metadata protection. */
export const Config = z.intersect([LocalSandbox.Config, z.object({ protectExistingWorkspaceMetadata: z.boolean().default(true) })])
/** Reuse public platform confinement and preserve metadata protection in each supported runner dialect. */
export default class CodexySandbox extends LocalSandbox {
  static Config = Config
  constructor(ctx: Context, private readonly options: Config) { super(ctx, options) }
  /** Protect existing metadata in workspace-write executions.
   * @param argv - Exact process invocation.
   * @param policy - Resolved sandbox mode and canonical workspace.
   * @param signal - Caller cancellation.
   * @returns Original confinement with additional metadata protection when required.
   */
  override async confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
    const root = canonicalPath(policy.workspaceRoot)
    const paths = this.options.protectExistingWorkspaceMetadata !== false && policy.mode === 'workspace-write'
      ? existingMetadataReadOnlyPaths(root) : []
    const result = await super.confine(argv, { ...policy, workspaceRoot: root }, signal)
    const runner = basename(result.argv[0] ?? '')
    const customRunner = this.options.runnerCommand !== undefined && this.options.runnerCommand.length > 0
    if (customRunner || runner === 'bwrap') {
      if (paths.length === 0) return result
      const separator = runnerSeparator(result, argv, policy.mode)
      const mounts = paths.flatMap(path => ['--ro-bind', path, path])
      return { ...result, argv: [...result.argv.slice(0, separator), ...mounts, ...result.argv.slice(separator)] }
    }
    if (runner === 'sandbox-exec') {
      const separator = runnerSeparator(result, argv, policy.mode)
      return appendSeatbeltMetadataDenials(
        result,
        seatbeltMetadataProtectedPaths(root, paths),
        separator,
        policy.mode,
      )
    }
    if (paths.length === 0) return result
    throw new SandboxUnavailableError(policy.mode, 'Selected local runner cannot protect existing workspace metadata')
  }
}

/** Find the public runner separator and reject malformed wraps before modifying them. */
function runnerSeparator(result: ConfinedArgv, argv: readonly string[], mode: SandboxPolicy['mode']): number {
  const separator = result.argv.length - argv.length - 1
  if (result.argv[separator] !== '--' || !argv.every((argument, index) => argument === result.argv[separator + 1 + index])) {
    throw new SandboxUnavailableError(mode, 'Local sandbox returned an unsupported runner invocation')
  }
  return separator
}

/** Quote one canonical metadata path for the SBPL profile emitted by the local Seatbelt runner. */
function sbplString(path: string): string {
  return `"${path.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
}

/** Add specific metadata denials after Seatbelt's broad workspace-write allow-list. */
function appendSeatbeltMetadataDenials(
  result: ConfinedArgv,
  paths: readonly string[],
  separator: number,
  mode: SandboxPolicy['mode'],
): ConfinedArgv {
  const profileOption = result.argv.findIndex((argument, index) => index < separator && argument === '-p')
  const profile = result.argv[profileOption + 1]
  if (profileOption < 0 || profileOption + 1 >= separator || profile === undefined) {
    throw new SandboxUnavailableError(mode, 'Seatbelt sandbox returned an unsupported profile invocation')
  }
  // `subpath` does not include the path itself, so protect both forms. The
  // unlink denial closes the rename escape hatch for a protected directory.
  const denials = paths.flatMap(path => [
    `(deny file-write* (literal ${sbplString(path)}))`,
    `(deny file-write* (subpath ${sbplString(path)}))`,
    `(deny file-write-unlink (require-all (literal ${sbplString(path)}) (vnode-type DIRECTORY)))`,
  ]).join(' ')
  return { ...result, argv: result.argv.map((argument, index) => index === profileOption + 1 ? `${profile} ${denials}` : argument) }
}
