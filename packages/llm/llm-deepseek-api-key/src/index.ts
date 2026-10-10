/** API-key authentication and credential-gated discovery for the official DeepSeek route. */
import type { Context } from '@deepseek-ai/cordis'
import { assertUsableApiKey, LlmError } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { registerDeepSeekProvider, catalogModelInfo } from '@deepseek-ai/dsh-llm-deepseek'
import { Config, plainOptions, resolveAdapterOptions } from './config.ts'
import type { ResolvedDeepSeekOptions } from './config.ts'

export { Config, plainOptions, resolveAdapterOptions } from './config.ts'
export type { Options, ResolvedDeepSeekOptions } from './config.ts'
export const name = 'llm-deepseek-api-key'
export const inject = ['llm']

const PROVIDER = 'deepseek-official'

export function apply(ctx: Context, config: Config): void {
  // `composition` pins the entry's credential reference and endpoint: settings
  // updates keep advising every other field, but these two facts always
  // resolve from the composition values captured here.
  let ownedFacts: { apiKeyEnv: string; baseURL?: string } | undefined
  if (config.connectionPolicy === 'composition') {
    ownedFacts = { apiKeyEnv: config.apiKeyEnv.get() }
    const baseURL = config.baseURL.get()
    if (baseURL !== undefined) ownedFacts.baseURL = baseURL
  }
  const options = () => {
    const plain = plainOptions(config)
    return resolveAdapterOptions(
      ownedFacts === undefined ? plain : { ...plain, ...ownedFacts },
      launchEnvironmentOf(ctx),
    )
  }
  // Composition-level loud failure: without a composed reference the provider can never
  // resolve a key, and the sentinel fallback in resolveAdapterOptions must never leak.
  if (config.apiKeyEnv.get() === undefined) {
    throw new Error('llm-deepseek: composition supplies no credential reference (apiKeyEnv); '
      + 'the native DeepSeek default was removed')
  }
  options()
  const resolveApiKey = async (connection: ResolvedDeepSeekOptions): Promise<string> => {
    const ref = connection.apiKeyEnv
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'llm-deepseek', ref)
    } else {
      const ambient = launchEnvironmentOf(ctx).get(ref)
      if (ambient !== undefined && ambient.value.length > 0) return assertUsableApiKey(ambient.value, 'llm-deepseek', ref)
    }
    throw new LlmError(
      `llm-deepseek: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials`
      + ` service (the web Models page writes it), or export ${ref} in the launching environment`,
      'MISSING_CREDENTIAL',
    )
  }
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'DeepSeek', settingsNs: ctx.fiber.entry?.options.id ?? name, settingsPath: [] },
  ])
  registerDeepSeekProvider(ctx, PROVIDER, {
    options, providerName: 'DeepSeek',
    resolveAuth: async connection => ({ headers: { 'x-api-key': await resolveApiKey(connection) } }),
    discoverModels: async (provider) => {
      const connection = options()
      try { await resolveApiKey(connection) }
      catch (error) {
        if (error instanceof LlmError && error.code === 'MISSING_CREDENTIAL') return []
        throw error
      }
      return connection.models.map(model => catalogModelInfo(provider, model))
    },
  })
}
