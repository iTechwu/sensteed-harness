/** Register DeepSeek Messages with live configuration and request-local credentials. */
import type {} from '@deepseek-ai/dsh-settings'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { Context } from '@deepseek-ai/cordis'
import { assertUsableApiKey, LlmError } from '@deepseek-ai/dsh-llm'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { registerDeepSeekProvider } from './host.ts'
import { catalogModelInfo } from './model-info.ts'
import { plainOptions, resolveAdapterOptions } from './config.ts'
import type { DesktopEntryConfig, ResolvedDeepSeekOptions } from './config.ts'
import type { DeepSeekRequestAuth } from './types.ts'

export { deepSeekConfigFields, plainOptions, resolveAdapterOptions, PUBLIC_BASE_URL } from './config.ts'
export { DesktopEntryConfig as Config } from './config.ts'
export type { Options, ResolvedDeepSeekOptions } from './config.ts'
export {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_FILE_EXPIRY_SECONDS,
  DEFAULT_FILE_QUOTA_CLEANUP_BATCH,
  DEFAULT_FILE_REFRESH_MARGIN_SECONDS,
  DEFAULT_FILES_API_TIMEOUT_MS,
  DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM,
  DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM,
  DEFAULT_INLINE_IMAGE_OFFLOAD_BYTE_QUANTUM,
  DEFAULT_MAX_INLINE_REQUEST_IMAGE_BYTES,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
} from './defaults.ts'
export { DeepSeekAdapter } from './adapter.ts'
export { catalogModelInfo, modelMaxTokens, resolveRequestMaxTokens } from './model-info.ts'
export { registerDeepSeekProvider } from './host.ts'
export type { DeepSeekRequestAuth, DeepSeekAdapterOptions, DeepSeekCatalogModel, DeepSeekConnectionOptions } from './types.ts'
export {
  DEFAULT_LOW_DETAIL_IMAGE_PIXEL_BUDGET,
  DEFAULT_MAX_IMAGES_PER_REQUEST,
  DEFAULT_MAX_REQUEST_FILES_BYTES,
  DEFAULT_REQUEST_IMAGE_MAX_BYTES,
  REQUEST_IMAGE_MAX_DIMENSION,
  deepSeekImageRequestPricing,
  resolveRequestImageMaxBytes,
  resolveRequestImageTarget,
} from './request-pricing.ts'
export { deepSeekImageTokens, deepSeekRequestImageDimensions } from './image-tokens.ts'
export { DeepSeekFileStore, MAX_IMAGE_BYTES } from './file-store.ts'
export type { DeepSeekFileConnection, DeepSeekFilePolicy, DeepSeekFileReference } from './file-store.ts'
export { DeepSeekFilesClient, MAX_FILE_EXPIRY_SECONDS, MAX_FILE_UPLOAD_BYTES, MAX_STORED_FILE_BYTES, MAX_STORED_FILE_COUNT, MIN_FILE_EXPIRY_SECONDS } from './files-api.ts'
export type { DeepSeekFileObject, DeepSeekFilePage } from './files-api.ts'
export { DeepSeekFileId } from './file-id.ts'
export type { DeepSeekFileId as DeepSeekFileIdType } from './file-id.ts'
export { DeepSeekUploadIndex, deepSeekFileScope } from './upload-index.ts'
export type { DeepSeekUploadRecord } from './upload-index.ts'
export type { RequestDefaults } from './types.ts'

export const name = 'llm-deepseek'
export const inject = ['llm']

const NS = 'llm-deepseek'
const PROVIDER = 'deepseek-official'

export function apply(ctx: Context, config: DesktopEntryConfig): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  // `composition` pins the entry's credential reference and endpoint: settings
  // updates keep advising every other field, but these two facts always
  // resolve from the composition values captured here.
  let ownedFacts: { apiKeyEnv: string; baseURL?: string } | undefined
  if (config.connectionPolicy === 'composition') {
    const apiKeyEnv = config.apiKeyEnv.get()
    if (apiKeyEnv === undefined) {
      throw new Error('llm-deepseek: composition pins the credential reference (apiKeyEnv) but supplies none')
    }
    const baseURL = config.baseURL.get()
    ownedFacts = { apiKeyEnv, ...baseURL === undefined ? {} : { baseURL } }
  }
  const options = (): ResolvedDeepSeekOptions => {
    const plain = plainOptions(config)
    return resolveAdapterOptions(
      ownedFacts === undefined ? plain : { ...plain, ...ownedFacts },
      launchEnvironmentOf(ctx),
    )
  }
  options()

  const resolveApiKey = async (): Promise<string> => {
    // The credential reference resolves per request; composition keeps it
    // pinned so a rejected settings generation cannot move the endpoint's key.
    const refName = ownedFacts?.apiKeyEnv ?? config.apiKeyEnv.get()
    if (refName === undefined) {
      throw new LlmError('llm-deepseek: composition supplies no credential reference (apiKeyEnv); '
        + 'the native DeepSeek default was removed', 'MISSING_CREDENTIAL')
    }
    const ref = credentialRef(refName)
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'llm-deepseek', ref)
    } else {
      // Without the seam there is no managed store to rank against, so the
      // environment is the whole credential plane.
      const ambient = launchEnvironmentOf(ctx).get(ref)
      if (ambient !== undefined && ambient.value.length > 0) {
        return assertUsableApiKey(ambient.value, 'llm-deepseek', ref)
      }
    }
    throw new LlmError(
      `llm-deepseek: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials`
      + ` service (the web Models page writes it), or export ${ref} in the launching environment`,
      'MISSING_CREDENTIAL',
    )
  }

  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'DeepSeek', settingsNs: ctx.fiber.entry?.options.id ?? NS, settingsPath: [] },
  ])
  // The gateway account credential is an API key: account sign-in wins per endpoint
  // when the account service has provisioned for it; otherwise the API-key route falls
  // back to the composed credential reference.
  registerDeepSeekProvider(ctx, PROVIDER, {
    options,
    providerName: 'DeepSeek',
    resolveAuth: async (connection): Promise<DeepSeekRequestAuth> => {
      const accountToken = await ctx.get('deepseekAccount')?.resolveToken(connection.baseURL)
      if (accountToken !== undefined) return { headers: { 'x-api-key': accountToken } }
      return { headers: { 'x-api-key': await resolveApiKey() } }
    },
    discoverModels: (provider) => {
      const connection = options()
      return Promise.resolve(connection.models.map(model => catalogModelInfo(provider, model)))
    },
  })
}
