/** Product loop fixtures assembled from original DSH services and owned provider ports. */
import type { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentOptions, Inbox, InboxTarget } from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session/types'
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import StockPrompt from '@deepseek-ai/dsh-system-prompt'
import type { Config as PromptConfig } from '@deepseek-ai/dsh-system-prompt'
import type { Config as ToolConfig } from '@deepseek-ai/dsh-tools'
import { AgentLoop as Runtime } from '@codexydsh/runtime'
import { RequestProviders } from '@codexydsh/bridges'
import { NativeToolRuntime, NativeTools } from '@codexydsh/bridges/tools'
import ProductPrompt from '@codexydsh/prompt-registry'
export { createInboxStub, unsupportedInbox } from './inbox.ts'
export { provideWorkingDirectoryFixture } from './working-directory-fixture.ts'

/** Configuration for original prompt and tool execution services. */
export interface AgentLoopTestDependenciesOptions {
  readonly systemPrompt?: PromptConfig
  readonly tools?: ToolConfig
}
/** Production Agent creation and explicit test-only Inbox admission. */
export interface AgentLoopTestHarness {
  create(id: SessionId, options?: AgentOptions, meta?: Pick<SessionHeader, 'cwd'>): Promise<Agent>
  claim(agent: Agent, target: InboxTarget, turn: number): UserMessage[]
}
interface DriverInbox extends Inbox { claim(target: InboxTarget, turn: number): UserMessage[] }
/** Mount prerequisites; adapters register through codexyRequests and native tools through codexyTools. */
export async function mountAgentLoopTestDependencies(ctx: Context, options: AgentLoopTestDependenciesOptions = {}): Promise<void> {
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(StockPrompt, options.systemPrompt ?? {})
  await ctx.plugin(NativeToolRuntime, options.tools ?? {})
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ProductPrompt, options.systemPrompt ?? {})
  await ctx.plugin(NativeTools)
  await ctx.plugin(RequestProviders)
}
/** Mount the owned AgentFactory after load-order-sensitive test plugins. */
export async function mountAgentLoopTestHarness(ctx: Context): Promise<AgentLoopTestHarness> {
  await ctx.plugin(Runtime, { agents: [] })
  return {
    create: (id, options = {}, meta = {}) => ctx.agentLoop.create(id, options, meta),
    claim: (agent, target, turn) => (agent.inbox as DriverInbox).claim(target, turn),
  }
}

/** Mount native tool preparation over public execution without requiring an Agent or LLM service. */
export async function mountProductToolTestDependencies(ctx: Context, config: ToolConfig = {}): Promise<void> {
  if (ctx.get('systemPrompt') === undefined) await ctx.plugin(StockPrompt)
  if (ctx.get('codexyPrompt') === undefined) await ctx.plugin(ProductPrompt)
  if (ctx.get('tools') === undefined) await ctx.plugin(NativeToolRuntime, config)
  if (ctx.get('codexyTools') === undefined) await ctx.plugin(NativeTools)
}
