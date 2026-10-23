/** Conversation naming commands using the upstream Session title service. */
import type { Context } from '@deepseek-ai/cordis'
import { SessionTitleLlmConfigSchema } from './title-llm.ts'
import type { SessionTitleLlmConfig } from './title-llm.ts'
import z from '@deepseek-ai/schemastery'
import { registerSessionRenameCommand, RENAME_SUGGESTION_POLICY } from './rename-command.ts'

/** Bounds for the auxiliary naming suggestion. */
export interface Config { renameSuggestion?: SessionTitleLlmConfig }
export const Config: z<Config> = z.object({ renameSuggestion: SessionTitleLlmConfigSchema.default(RENAME_SUGGESTION_POLICY) })
export const inject = ['commands', 'sessionTitle']

/** Register the naming command without replacing the upstream Session controller. */
export function apply(ctx: Context, config: Config): void {
  registerSessionRenameCommand(ctx, config.renameSuggestion)
}
