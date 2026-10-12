/** Agent-owned draft rewrites over the upstream authenticated gateway. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { optimizePromptDraft, PromptOptimizePolicySchema } from './optimize.ts'
import type { PromptOptimizePolicy } from './optimize.ts'

/** Product draft rewrite policy. */
export type Config = PromptOptimizePolicy
export const Config = PromptOptimizePolicySchema

declare module '@deepseek-ai/cordis' {
  interface Context { codexyDraft: DraftController }
}

/** Rewrite drafts without mutating Session history or starting a turn. */
export class DraftController extends TypertRemoteService {
  static inject = ['llm', 'typert']
  static Config = Config
  constructor(ctx: Context, private readonly policy: Config = Config({})) {
    super(ctx, 'codexyDraft', { namespace: 'draft' })
  }

  /** @param agent - Exact receiving Session owner.
   * @param text - Unsent draft.
   * @param signal - Caller cancellation.
   * @returns Rewrite kept editable by the browser.
   */
  @Remote
  async optimize(agent: Agent, text: string, signal: AbortSignal): Promise<{ text: string }> {
    return { text: await optimizePromptDraft(this.ctx, agent, text, signal, this.policy) }
  }
}
export default DraftController
