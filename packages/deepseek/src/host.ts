/** Shared effect-owned registration without conflating API-key and account routes. */
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { Context } from '@deepseek-ai/cordis'
import { resolveImageAttachmentAccess } from '@codexydsh/runtime/llm'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { getOrCreateAnonymousUserId, type AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { DeepSeekAdapter } from './adapter.ts'
import type { DeepSeekAdapterOptions } from './types.ts'

export type ProviderDependencies = Pick<DeepSeekAdapterOptions,
  'options' | 'providerName' | 'resolveApiKey' | 'resolveAccountToken' | 'resolveAuth' | 'discoverModels'>

/** Keep transport services, native capture, and policy-generation behavior identical across routes. */
export function registerDeepSeekProvider(ctx: Context, provider: string, dependencies: ProviderDependencies): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  dependencies.options()
  let userId: AnonymousUserId | undefined
  const adapter = new DeepSeekAdapter({
    ...dependencies,
    onReplayDegrade: ({ provider, model, reason }) => {
      ctx.logger.warn(`llm-deepseek: unusable Messages replay state on assistant history for route "${provider}/${model}"; sending provider-neutral content (${reason})`)
    },
    resolveUserId: () => userId ??= getOrCreateAnonymousUserId(),
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments, hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath), ref,
    ),
    prepareExtensions: request => ctx.get('deepseekLlmApiExtensions')?.prepare(request)
      ?? Promise.resolve({ fields: {}, accept: () => Promise.resolve() }),
  })
  const registration = ctx.codexyRequests.registerAdapter([provider], adapter)
  let registeredPolicy = dependencies.options().retryPolicy
  ctx.on('loader/volatile-update', () => {
    let policy: ReturnType<ProviderDependencies['options']>['retryPolicy']
    try { policy = dependencies.options().retryPolicy } catch (error) {
      ctx.logger.warn(error)
      return
    }
    if (deepEqualJson(policy, registeredPolicy)) return
    // Atomic replacement preserves the route while the captured retry policy changes.
    registration.replace([provider])
    registeredPolicy = policy
  })
}
