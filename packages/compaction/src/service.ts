/** Product compaction context capture over the released DSH compaction service. */
export * from '@deepseek-ai/dsh-compaction'
import type { CompactionAgentContext } from '@deepseek-ai/dsh-compaction'
import type { UserMessage, DeveloperMessage } from '@codexydsh/runtime/llm'
import type { PromptPreparation } from '@codexydsh/runtime/prompt'

/** Position of rebuilt context in a Codex replacement history. */
export type CompactionInitialContextInjection = 'do-not-inject' | 'before-last-user-message'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Capture context from the same preparation as the triggering model request.
     * @param payload - Owner, cancellation and captured preparation.
     * @param next - Next contributor.
     * @mode waterfall
     */
    'codexy-compaction/initial-context'(payload: { agent: CompactionAgentContext; signal?: AbortSignal; promptPreparation?: PromptPreparation }, next: () => Promise<readonly (UserMessage | DeveloperMessage)[] | undefined>): Promise<readonly (UserMessage | DeveloperMessage)[] | undefined>
  }
}
