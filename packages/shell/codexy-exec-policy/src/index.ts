/** Codexful POSIX dangerous-command review inside `exec_command` dispatch.
 * @module @codexydsh/exec-policy
 */

import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import type { ApprovalPolicy } from '@codexydsh/approval'
import type { CodexExecReviewDecision } from '@codexydsh/exec'
import { classifyPosixDangerousCommand, loadBashLanguage, type DangerousCommandMatch } from './classifier.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'codexful-exec-policy'

/** Approval service required by the command tool to resolve a review. */
export const inject = ['codexyApproval']

const MAX_APPROVAL_COMMAND_CHARS = 4_096

/**
 * Map the pinned Codex forced-`rm` fallback to DSH's ask/never policy.
 * @param match - dangerous literal command detected in the shell argv.
 * @param approval - current Session approval policy.
 * @param command - exact shell source shown in the approval reason when it fits the cap.
 * @returns the command tool's review decision.
 */
export function dangerousCommandDecision(
  match: DangerousCommandMatch | undefined,
  approval: ApprovalPolicy,
  command: string,
): CodexExecReviewDecision {
  if (match === undefined) return { kind: 'allow' }
  if (approval === 'never') {
    return { kind: 'deny', reason: match === 'forced-rm'
      ? 'rm -f style commands are not permitted. Use a safer approach'
      : 'blocked by policy' }
  }
  const rendered = command.length <= MAX_APPROVAL_COMMAND_CHARS
    ? command
    : `${command.slice(0, MAX_APPROVAL_COMMAND_CHARS)}… (truncated; sha256 ${createHash('sha256').update(command).digest('hex')})`
  return { kind: 'ask', reason: match === 'forced-rm'
    ? `Command ${JSON.stringify(rendered)} contains an rm force option (-f or --force); approve this exact tool call?`
    : `Command ${JSON.stringify(rendered)} exceeds the static shell wrapper depth; approve this exact tool call?` }
}

/**
 * Register the Codexful-only policy for the selected shell argv. The command
 * tool combines an ask with any sandbox escalation before requesting approval.
 * @param ctx - Cordis scope that owns the review listener.
 * @returns after the parser is ready and the listener is registered.
 */
export async function apply(ctx: Context): Promise<void> {
  await loadBashLanguage()
  ctx.on('tool-bash/codex-exec-review', async (request, next): Promise<CodexExecReviewDecision> => {
    const downstream = await next()
    if (downstream.kind === 'deny' || request.platform !== 'posix') return downstream
    const match = await classifyPosixDangerousCommand(request.argv)
    const decision = dangerousCommandDecision(match, request.approvalPolicy ?? 'ask', request.command)
    if (decision.kind === 'allow') return downstream
    if (decision.kind === 'ask' && downstream.kind === 'ask') {
      return { kind: 'ask', reason: [downstream.reason, decision.reason].filter(Boolean).join('\n') }
    }
    return decision
  }, { prepend: true })
}
