/**
 * Model-facing read, read_image, write, and edit tools over `ctx.codexyFs`. This package owns schemas, validation,
 * read windows, formatting, and observation events, never a concrete provider. An optional
 * event policy supplies mutation guards; without one the tools use unconditional provider calls.
 * @module @codexydsh/files
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@codexydsh/approval'
import { applyReadTool, READ_LIMIT, STREAM_MIN_SIZE } from './read.ts'
import { applyWriteTool } from './write.ts'
import { applyEditTool } from './edit.ts'
import { applyReadImageTool } from './read-image.ts'
import { applyRequestUserInputTool, applyViewImageTool } from './codex-tools.ts'
import { READ_MAX_BYTES, READ_MAX_LINE_LENGTH } from './read-render.ts'
import { FsSandboxController } from './sandbox.ts'
import { applyPatchTool } from './apply-patch.ts'

export { runCodexPatch } from './apply-patch.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-fs'

/** Services required by the filesystem tool suite. */
export const inject = ['tools', 'codexyFs', 'codexyPrompt', 'codexyTools']

/** Plugin config (all optional — `Config` supplies the defaults). */
export interface Config {
  /** Default and maximum number of lines returned by one `read` call. */
  readLimit?: number
  /** Maximum characters returned for a single line before truncation. */
  readMaxLineLength?: number
  /** Maximum bytes returned for the selected lines of one `read` call. */
  readMaxBytes?: number
  /** Files at or above this size stream instead of loading whole into memory. */
  readStreamMinSize?: number
  /** Register a JSON-callable Codex Begin Patch tool (off in the standard DSH preset). */
  applyPatch?: boolean
  /** Register only apply_patch, omitting DSH's read/write/edit/read_image tools. */
  applyPatchOnly?: boolean
  /** Opt into native Codex 0.162.1 view_image/request_user_input interfaces when their real services are mounted. */
  codexTools?: boolean
}

export const Config: z<Config> = z.object({
  readLimit: z.number().default(READ_LIMIT),
  readMaxLineLength: z.number().default(READ_MAX_LINE_LENGTH),
  readMaxBytes: z.number().default(READ_MAX_BYTES),
  readStreamMinSize: z.number().default(STREAM_MIN_SIZE),
  applyPatch: z.boolean().default(false),
  applyPatchOnly: z.boolean().default(false),
  codexTools: z.boolean().default(false),
})

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Config>

/** Every read cap counts lines/chars/bytes — a positive integer, or windowing arithmetic misbehaves silently. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-fs: ${name} must be a positive integer`)
  }
}

/** Register the full `read`/`write`/`edit` filesystem tool suite, plus `read_image` while `attachments` is mounted. */
export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  assertPositiveInteger('readLimit', resolved.readLimit)
  assertPositiveInteger('readMaxLineLength', resolved.readMaxLineLength)
  assertPositiveInteger('readMaxBytes', resolved.readMaxBytes)
  assertPositiveInteger('readStreamMinSize', resolved.readStreamMinSize)
  if (resolved.applyPatchOnly && !resolved.applyPatch) {
    throw new Error('tool-fs: applyPatchOnly requires applyPatch: true')
  }
  // One escalation API shared by both mutating tools: advertisement gating,
  // per-call policy resolution, and denial-marker mapping, all keyed off whether
  // the mounted ctx.codexyFs confines (ctx.codexyFs.sandboxMode).
  const sandbox = new FsSandboxController(ctx)
  if (!resolved.applyPatchOnly) {
    applyReadTool(ctx, {
      limit: resolved.readLimit,
      maxLineLength: resolved.readMaxLineLength,
      maxBytes: resolved.readMaxBytes,
      streamMinSize: resolved.readStreamMinSize,
    })
    // read_image needs durable attachment storage and registers only with it.
    ctx.inject(['attachments'], (imageCtx) => {
      applyReadImageTool(imageCtx)
    })
    applyWriteTool(ctx, sandbox)
    applyEditTool(ctx, sandbox)
  }
  if (resolved.applyPatch) applyPatchTool(ctx, sandbox)
  if (resolved.codexTools) {
    ctx.inject(['attachments'], imageCtx => { applyViewImageTool(imageCtx) })
    ctx.inject(['userQuestions'], questionCtx => { applyRequestUserInputTool(questionCtx) })
  }
}
