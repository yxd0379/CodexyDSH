/** Original DSH agent service and Codexy lifecycle events. */
export * from '@deepseek-ai/dsh-agent'
export { installModelSelection } from './model-selection.ts'
import type { Agent, AgentCancelCause, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { LlmCallConfig, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { PreparedLlmModel } from './llm.ts'
import type { PromptPreparation } from './prompt.ts'

declare module '@deepseek-ai/dsh-agent' {
  interface CancelOptions { resumeInbox?: boolean | undefined }
}
declare module '@deepseek-ai/cordis' {
  interface Events {
    'agent/cancelled'(this: Scoped<Agent>, payload: { agent: Agent; cause: AgentCancelCause }): void
    'agent/tool-output-inject'(this: Scoped<Agent>, payload: { agent: Agent; message: ToolResultMessage; historyTruncationTokenLimit?: number; originalText?: string; signal?: AbortSignal }, next: () => Promise<void>): Promise<void>
    'codexy-agent/pre-step'(this: Scoped<Agent>, payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal; promptPreparation?: PromptPreparation; preparedModel?: PreparedLlmModel }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>
    'codexy-agent/request'(this: Scoped<Agent>, payload: { agent: Agent; turn: number; step: number; signal: AbortSignal; promptPreparation?: PromptPreparation; preparedModel?: PreparedLlmModel }, next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig>
    'agent/request-enter'(this: Scoped<Agent>, payload: { agent: Agent; turn: number; step: number; attempt: number; signal: AbortSignal; config: Readonly<LlmCallConfig>; promptPreparation: PromptPreparation; preparedModel?: PreparedLlmModel }): Promise<void>
    'agent/request-input'(this: Scoped<Agent>, payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal; config: Readonly<LlmCallConfig>; promptPreparation: PromptPreparation; preparedModel?: PreparedLlmModel }, next: () => Promise<UserMessage[]>): Promise<UserMessage[]>
    'agent/step-completed'(this: Scoped<Agent>, payload: { agent: Agent; turn: number; step: number; signal: AbortSignal; needsFollowUp: boolean }): Promise<void> | void
  }
}
