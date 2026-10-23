/** JSON-callable Codex patch text over the DSH filesystem service. */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@codexydsh/tool-schema'
import type { DiffResultView, ToolResult } from '@codexydsh/tool-schema'
import { FsError } from '@codexydsh/filesystem'
import type { FileSystem, FsTarget, FsVersion } from '@codexydsh/filesystem'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { ToolExecution } from '@codexydsh/tool-schema'
import { diffsFromMeta } from './diff.ts'
import { remediateFsError } from './error.ts'
import { sessionResolveOptions } from './session-cwd.ts'
import { applyUpdate, parsePatch } from './patch-parser.ts'
import type { FsSandboxController } from './sandbox.ts'

interface PatchArgs {
  patch: string
  sandbox_permissions?: string
  justification?: string
}

interface AppliedDiff {
  path: string
  oldText: string | null
  newText: string
}

/** File permissions and path resolution for one patch application. */
export interface PatchRunOptions {
  /** The resolved shell cwd for Codexful exec interception; ordinary calls use their Session cwd. */
  cwd?: string
  /** The policy used by every file mutation in this patch. */
  policy: SandboxExecutionPolicy | undefined
  /** Translate provider errors without changing the patch's partial-commit semantics. */
  mapError(error: unknown): unknown
}

/** The canonical result shared by JSON apply_patch and Codexful shell interception. */
export interface AppliedPatch {
  message: string
  diffs: AppliedDiff[]
}

/**
 * Apply a Codex Begin Patch through the filesystem service.
 * @param ctx - owning Cordis context for observation events and policy waterfalls.
 * @param fs - filesystem provider selected by the caller.
 * @param patch - complete patch text.
 * @param exec - the outer tool call, including its cancellation and Session owner.
 * @param options - resolved cwd, mutation policy, and provider error mapping.
 * @returns the success message and replayable file diffs.
 */
export async function runCodexPatch(
  ctx: Context, fs: FileSystem, patch: string, exec: ToolExecution, options: PatchRunOptions,
): Promise<AppliedPatch> {
  const changes = parsePatch(patch)
  const paths = sessionResolveOptions(exec, options.cwd ?? options.policy?.workspaceRoot)
  const added: string[] = []
  const modified: string[] = []
  const deleted: string[] = []
  const diffs: AppliedDiff[] = []
  const operations: { source: FsTarget; apply: () => Promise<void> }[] = []
  const targetKeys = new Set<FsTarget['targetKey']>()

  async function resolve(path: string): Promise<FsTarget> {
    return fs.resolve(path, paths)
  }

  async function current(target: FsTarget): Promise<{ content: string; version: FsVersion } | undefined> {
    const info = await fs.stat(target, exec.signal)
    if (!info) {
      ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
      return undefined
    }
    if (info.type !== 'file') throw new FsError(`cannot patch "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    const content = await fs.readText(target, exec.signal)
    ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
    return { content, version: info.version }
  }

  async function write(target: FsTarget, content: string, prior: { version: FsVersion } | undefined): Promise<void> {
    const intent = await ctx.waterfall('fs/write-intent', target, exec, () => prior
      ? { kind: 'replaceIfVersion', version: prior.version }
      : { kind: 'createIfAbsent' })
    const outcome = await fs.writeText(target, content, intent, exec.signal, options.policy)
    ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
  }

  for (const change of changes) {
    const source = await resolve(change.path)
    try {
      if (targetKeys.has(source.targetKey)) {
        throw new Error(`multiple operations target ${source.displayPath}`)
      }
      targetKeys.add(source.targetKey)
      if (change.kind === 'add') {
        const prior = await current(source)
        operations.push({ source, apply: async () => {
          await write(source, change.content, prior)
          diffs.push({ path: change.path, oldText: prior?.content ?? null, newText: change.content })
          added.push(change.path)
        } })
      } else if (change.kind === 'delete') {
        const prior = await current(source)
        if (!prior) throw new FsError(`cannot delete "${source.displayPath}": not found`, 'FS_NOT_FOUND')
        operations.push({ source, apply: async () => {
          await fs.deleteFile(source, { version: prior.version }, exec.signal, options.policy)
          ctx.emit('fs/observed', source, { kind: 'absent' }, exec)
          diffs.push({ path: change.path, oldText: prior.content, newText: '' })
          deleted.push(change.path)
        } })
      } else {
        const prior = await current(source)
        if (!prior) throw new FsError(`cannot update "${source.displayPath}": not found`, 'FS_NOT_FOUND')
        const content = applyUpdate(prior.content, change.chunks, change.path)
        if (change.moveTo === undefined) {
          operations.push({ source, apply: async () => {
            await write(source, content, prior)
            diffs.push({ path: change.path, oldText: prior.content, newText: content })
            modified.push(change.path)
          } })
        } else {
          const moveTo = change.moveTo
          const destination = await resolve(moveTo)
          if (destination.targetKey === source.targetKey) {
            throw new Error(`Move destination "${destination.displayPath}" resolves to the source file`)
          }
          const destinationPrior = await current(destination)
          operations.push({ source, apply: async () => {
            await write(destination, content, destinationPrior)
            try {
              await fs.deleteFile(source, { version: prior.version }, exec.signal, options.policy)
            } catch (error: unknown) {
              const message = `Move wrote "${destination.displayPath}" but could not remove "${source.displayPath}"; both files may remain`
              if (error instanceof FsError) throw new FsError(`${message}: ${error.message}`, error.code, { cause: error })
              throw new Error(`${message}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
            }
            ctx.emit('fs/observed', source, { kind: 'absent' }, exec)
            diffs.push({ path: change.path, oldText: prior.content, newText: '' })
            diffs.push({ path: moveTo, oldText: destinationPrior?.content ?? null, newText: content })
            modified.push(moveTo)
          } })
        }
      }
    } catch (error: unknown) {
      throw remediateFsError(options.mapError(error), source.displayPath)
    }
  }
  for (const operation of operations) {
    try {
      await operation.apply()
    } catch (error: unknown) {
      throw remediateFsError(options.mapError(error), operation.source.displayPath)
    }
  }
  const lines = ['Success. Updated the following files:',
    ...added.map(path => `A ${path}`), ...modified.map(path => `M ${path}`), ...deleted.map(path => `D ${path}`)]
  return { message: `${lines.join('\n')}\n`, diffs }
}

/**
 * Register the JSON wrapper for Codex's Begin Patch language.
 * @param ctx - plugin context carrying tools and filesystem services.
 * @param sandbox - per-call file permission controller.
 */
export function applyPatchTool(ctx: Context, sandbox: FsSandboxController): void {
  ctx.codexyTools.register(defineTool({
    name: 'apply_patch',
    description: 'Edit files with a Codex-style patch. Supply the complete *** Begin Patch ... *** End Patch text in the patch string.',
    closedParameters: true,
    parameters: {
      patch: { type: 'string', required: true, description: 'Complete patch text with Begin Patch and End Patch markers.' },
      ...sandbox.escalationModes.length > 0 ? sandbox.schemaFields() : {},
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false, properties: {
          message: { type: 'string', required: true },
          diffs: { type: 'array', required: true, items: {
            type: 'object', additionalProperties: false, properties: {
              path: { type: 'string', required: true },
              oldText: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
              newText: { type: 'string', required: true },
            },
          } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
      codeModeResult: () => ({}),
      presentationMeta: (_args, value) => ({ diffs: value.diffs }),
    },
    async execute(args: PatchArgs, exec) {
      parsePatch(args.patch)
      const policy = await sandbox.resolvePolicy('apply_patch', args, exec)
      return runCodexPatch(ctx, ctx.codexyFs, args.patch, exec, { policy, mapError: error => sandbox.mapError(error, policy) })
    },
    presentCall(args) {
      let locations: { path: string }[] = []
      try { locations = parsePatch(args.patch).map(change => ({ path: change.path })) } catch (error: unknown) {
        // The tool result reports the parser error; a pending UI card has no validated paths.
        void error
      }
      return { card: 'generic', title: 'Apply patch', kind: 'edit', locations }
    },
    presentResult(_args, result: ToolResult): DiffResultView | undefined {
      if (result.isError) return undefined
      const diffs = diffsFromMeta(result.meta)
      return diffs ? { card: 'diff', title: 'Apply patch', diffs } : undefined
    },
  }))
}
