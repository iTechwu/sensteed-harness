/** API-key configuration resolved together with one Messages endpoint generation. */
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { deepSeekConfigFields, type Config as ProtocolConfig, plainOptions as protocolOptions, resolveAdapterOptions as resolveProtocolOptions } from '@deepseek-ai/dsh-llm-deepseek'
import type { Options as ProtocolOptions, DeepSeekConnectionOptions } from '@deepseek-ai/dsh-llm-deepseek'

/** Messages configuration with a per-request API-key reference. */
export interface Config extends ProtocolConfig {
  /** Credential reference resolved per request; the composition must supply it. */
  apiKeyEnv: Volatile<string | undefined>
}
export const Config = z.object({
  ...deepSeekConfigFields,
  apiKeyEnv: z.string().role('credential-ref').volatile(),
})
/** Placeholder reference for transport-level constructions that never resolve credentials. */
export const UNCOMPOSED_API_KEY_REF = 'DSH_UNCOMPOSED_API_KEY'
/** Plain deployment inputs for the API-key provider. */
export type Options = ProtocolOptions & { apiKeyEnv?: string }
/** Endpoint and credential reference captured from the same configuration generation. */
export interface ResolvedDeepSeekOptions extends DeepSeekConnectionOptions {
  /** Credential reference used only for this connection snapshot. */
  apiKeyEnv: CredentialRef
}
/** Read one validated provider configuration.
 * @param config - live plugin configuration.
 * @returns detached resolver inputs.
 */
export function plainOptions(config: Config): Options {
  return { ...protocolOptions(config), apiKeyEnv: config.apiKeyEnv.get() }
}
/** Resolve API-key and protocol settings together.
 * @param config - raw deployment settings.
 * @param environment - application launch environment.
 * @returns validated endpoint facts and the matching credential reference.
 */
export function resolveAdapterOptions(config: Options, environment?: LaunchEnvironmentSnapshot): ResolvedDeepSeekOptions {
  // The sentinel only ever reaches a resolve call through a composition bug: the
  // plugin's apply rejects a composition without `apiKeyEnv` before any request.
  return { ...resolveProtocolOptions(config, environment), apiKeyEnv: credentialRef(config.apiKeyEnv ?? UNCOMPOSED_API_KEY_REF) }
}
