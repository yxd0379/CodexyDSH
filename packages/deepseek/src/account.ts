/** DeepSeek Account authentication on the product's native-capable Messages route. */
import type {} from '@deepseek-ai/dsh-deepseek-account'
import { interpolate, isJsExpr } from '@deepseek-ai/cordis-plugin-loader'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { ACCOUNT_QUOTA_EXCEEDED_CODE, LlmError, QUOTA_EXCEEDED_CODE } from '@codexydsh/runtime/llm'
import { deepSeekConfigFields, plainOptions, resolveAdapterOptions } from './config.ts'
import type { Config as ProtocolConfig } from './config.ts'
import { registerDeepSeekProvider } from './host.ts'
import { catalogModelInfo } from './model-info.ts'
import type { DeepSeekAuthentication, DeepSeekConnectionOptions } from './types.ts'

/** The account settings have protocol options but no API-key credential plane. */
export interface Config extends Omit<ProtocolConfig, 'apiKeyEnv'> {}
export const Config = z.object(deepSeekConfigFields)
export const name = 'llm-deepseek-account'
export const inject = ['llm', 'codexyRequests']
const PROVIDER = 'deepseek-account'
const ACCOUNT_FIELDS = Object.keys(deepSeekConfigFields) as Array<keyof Config>

function inheritedProtocolOptions(ctx: Context) {
  const tree = ctx.fiber.entry?.parent.tree
  const legacy = tree === undefined ? undefined : [...tree.entries()].find(row =>
    row.parent === tree.root && row.options.id === name
    && row.options.name === '@deepseek-ai/dsh-llm-deepseek-account' && row.disabled)
  if (legacy === undefined) return undefined
  const raw: unknown = legacy.options.config ?? {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || isJsExpr(raw)) {
    throw new Error('llm-deepseek-account: legacy account protocol settings must be a root configuration mapping')
  }
  // Read only the disabled standard composition row. Never revive its plugin,
  // mutate its raw expressions, or copy a credential/config into a profile.
  const selected = Object.fromEntries(ACCOUNT_FIELDS.filter(key => Object.hasOwn(raw, key))
    .map(key => [key, (raw as Record<string, unknown>)[key]]))
  return plainOptions(Config(interpolate(legacy.parent.ctx, selected)))
}

export function apply(ctx: Context, config: Config): void {
  const inherited = inheritedProtocolOptions(ctx)
  const options = () => {
    const current = plainOptions(config)
    if (inherited === undefined) return resolveAdapterOptions(current, launchEnvironmentOf(ctx))
    const raw: unknown = ctx.fiber.entry?.options.config
    // Parsed schema defaults do not count as explicit product overrides.
    // Live product values still resolve once per captured operation.
    const explicit = isJsExpr(raw) ? current : Object.fromEntries(ACCOUNT_FIELDS
      .filter(key => raw !== null && typeof raw === 'object' && Object.hasOwn(raw, key))
      .map(key => [key, current[key]]))
    return resolveAdapterOptions({ ...inherited, ...explicit }, launchEnvironmentOf(ctx))
  }
  options()
  const resolveAuth = async (connection: DeepSeekConnectionOptions): Promise<DeepSeekAuthentication> => {
    const account = ctx.get('deepseekAccount')
    // The public account service authorizes the actual destination and captures
    // one login generation. No platform-session read or API-key fallback exists.
    const token = await account?.resolveToken(connection.baseURL)
    if (token === undefined) throw new LlmError(
      'Sign in to DeepSeek to use DeepSeek Account models. The destination must allow account authentication.',
      'ACCOUNT_SIGN_IN_REQUIRED',
    )
    return {
      key: token,
      accountCredential: true,
      onRequestError: async (error) => {
        if (!(error instanceof LlmError)) return error
        if (error.code === QUOTA_EXCEEDED_CODE || error.failure.status === 402) {
          return new LlmError(error.message, ACCOUNT_QUOTA_EXCEEDED_CODE, { ...error.failure, cause: error })
        }
        if (error.failure.status !== 401) return error
        const rejected = new LlmError(error.message, 'ACCOUNT_TOKEN_INVALID', { ...error.failure, cause: error })
        try { await account?.rejectToken(token) } catch (_credentialUpdateFailed) {
          // A storage failure cannot hide the authoritative request failure.
        }
        return rejected
      },
    }
  }
  ctx.llm.registerConfigurableProviders([{
    provider: PROVIDER, displayName: 'DeepSeek Account',
    settingsNs: ctx.fiber.entry?.options.id ?? name, settingsPath: [],
  }])
  registerDeepSeekProvider(ctx, PROVIDER, {
    options, resolveAuth, providerName: 'DeepSeek Account',
    discoverModels: async (provider, connection) => {
      try { await resolveAuth(connection) } catch (error) {
        if (error instanceof LlmError && error.code === 'ACCOUNT_SIGN_IN_REQUIRED') return []
        throw error
      }
      return connection.models.map(model => catalogModelInfo(provider, model))
    },
  })
}
