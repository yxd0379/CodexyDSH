/** Owner-local tool fixtures assembled from the released platform and product ports. */
import type { Context } from '@deepseek-ai/cordis'
import PlatformPrompt, { type Config as PromptConfig } from '@deepseek-ai/dsh-system-prompt'
import PlatformLlm from '@deepseek-ai/dsh-llm'
import type { Config as ToolConfig } from '@deepseek-ai/dsh-tools'
import ProductPrompt from '@codexydsh/prompt-registry'
import RequestProviders from '@codexydsh/bridges'
import { NativeToolRuntime, NativeTools } from '@codexydsh/bridges/tools'
import type { AssembleContext, PromptAssembly } from '@codexydsh/runtime/prompt'

/** Mount both public prompt contributions and native request assembly. */
export const SystemPrompt = {
  Config: PlatformPrompt.Config,
  async apply(ctx: Context, config: PromptConfig): Promise<void> {
    await ctx.plugin(PlatformPrompt, config)
    await ctx.plugin(ProductPrompt, config)
  },
}
/** Mount the public execution pipeline and the owned native tool port. */
export const ToolRuntime = {
  inject: ['codexyPrompt'],
  Config: NativeToolRuntime.Config,
  async apply(ctx: Context, config: ToolConfig): Promise<void> {
    await ctx.plugin(NativeToolRuntime, config)
    await ctx.plugin(NativeTools)
  },
}
/** Mount public provider discovery and owned generation dispatch. */
export const LlmRuntime = {
  async apply(ctx: Context): Promise<void> {
    await ctx.plugin(PlatformLlm)
    await ctx.plugin(RequestProviders)
  },
}

/** Prepare variables and assemble one prompt through the product provider APIs.
 * @param ctx - Mounted product prompt provider.
 * @param context - Scope, agent, and request contributions.
 * @returns Prompt assembled using the prepared variables.
 */
export async function assemblePrompt(ctx: Context, context: AssembleContext = {}): Promise<PromptAssembly> {
  const preparation = await ctx.codexyPrompt.prepare(context)
  return ctx.codexyPrompt.assemble(context, preparation)
}
