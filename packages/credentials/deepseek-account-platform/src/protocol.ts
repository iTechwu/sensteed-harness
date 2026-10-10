/** Validated Sensteed gateway HTTP messages and restricted loopback login origins. */
import { z } from 'zod'
import type { SignInErrorCode } from '@deepseek-ai/dsh-deepseek-account/types'

/** Fixed deployment identity of the Sensteed desktop OAuth client on the SSO service. */
export const SSO_CLIENT_ID = 'sensteed-desktop'
/** Fixed company code the gateway requires on the desktop key bridge. */
export const COMPANY_CODE = 'sensteed'
/** OAuth scopes requested for desktop sign-in; `offline_access` yields a refresh token. */
export const AUTHORIZE_SCOPE = 'openid profile email tenant offline_access'
/** Redirect path registered for the desktop client; the port stays dynamic per RFC 8252. */
export const CALLBACK_PATH = '/callback'

/** Protocol errors expose a stable code, never a response body or authorization URL. */
export class PlatformAuthError extends Error {
  /** @param code - safe error classification. */
  constructor(readonly code: SignInErrorCode) { super(`account: ${code}`) }
}

/** An authenticated gateway request was rejected with HTTP 401. */
export class AccountUnauthorizedError extends PlatformAuthError {
  constructor() { super('expired') }
}

/**
 * Accept an HTTPS API base, or explicitly configured loopback development HTTP.
 * Unlike a bare origin, a deployment path prefix (for example `/api`) is kept.
 * @param value - configured API base.
 * @param allowLoopbackHttp - development-only opt-in.
 * @returns normalized base without a trailing slash.
 */
export function apiOrigin(value: string, allowLoopbackHttp: boolean): string {
  const url = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.search || url.hash
    || !(url.protocol === 'https:' || (allowLoopbackHttp && loopback && url.protocol === 'http:'))) {
    throw new Error('account: API origin must be an HTTPS URL or explicitly enabled loopback HTTP URL')
  }
  return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`
}

/**
 * Accept a browser-accessible loopback HTTP origin for local or SSH-forwarded login.
 * @param value - loopback HTTP origin with an explicit port supplied by the authenticated initiating client.
 * @returns normalized origin; remote domains and path-based proxies are unsupported.
 */
export function loginOrigin(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new PlatformAuthError('protocol') }
  const explicitPort = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):([0-9]+)\/?$/i.exec(value)?.[1]
  if (explicitPort === undefined || Number(explicitPort) === 0
    || url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new PlatformAuthError('protocol')
  }
  return `${url.protocol}//${url.hostname}:${Number(explicitPort)}`
}

/** Successful OAuth authorization-code token response from the SSO service. */
export const oidcTokenResponse = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
  expires_in: z.number().positive(),
  refresh_token: z.string().optional(),
  id_token: z.string().optional(),
  scope: z.string().optional(),
})

/** Successful desktop key provisioning response; unused fields stay unvalidated. */
export const provisionKeyResponse = z.object({
  key: z.string().min(1),
  rotated: z.boolean().optional(),
  user: z.object({
    ssoSub: z.string().min(1),
    name: z.string().optional(),
    avatar: z.string().optional(),
  }).optional(),
})

/**
 * Build the SSO authorization URL for one sign-in attempt.
 * @param ssoApiOrigin - validated SSO API base.
 * @param redirectUri - loopback callback URI registered for this attempt.
 * @param state - attempt state whose comparison uses a timing-safe check.
 * @param codeChallenge - S256 PKCE challenge derived from the attempt verifier.
 * @returns the authorization URL the browser opens.
 */
export function buildAuthorizeUrl(ssoApiOrigin: string, redirectUri: string, state: string, codeChallenge: string): string {
  const url = new URL(`${ssoApiOrigin}/oauth/authorize`)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', SSO_CLIENT_ID)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('scope', AUTHORIZE_SCOPE)
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  return url.href
}

/** Error payload shape of the SSO token endpoint; only the OAuth error code is read. */
const oauthError = z.object({ error: z.string() })

/**
 * Exchange one authorization code for the signed-in identity's access token.
 * @param ssoApiOrigin - validated SSO API base.
 * @param body - authorization-code grant parameters, never logged.
 * @param signal - attempt cancellation and timeout.
 * @returns the validated token response.
 */
export async function requestSsoToken(ssoApiOrigin: string, body: Record<string, string>,
  signal: AbortSignal): Promise<z.infer<typeof oidcTokenResponse>> {
  return gatewayRequest(`${ssoApiOrigin}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, signal, oidcTokenResponse, (status, payload) => {
    if (status === 400 && oauthError.safeParse(payload).success
      && oauthError.parse(payload).error === 'invalid_grant') return 'expired'
    return status >= 400 && status < 500 ? 'protocol' : 'network'
  })
}

/**
 * Provision or rotate the caller's gateway API key through the desktop bridge.
 * @param gatewayApiOrigin - validated gateway API base.
 * @param accessToken - SSO access token carrying the verified Feishu identity.
 * @param signal - attempt cancellation and timeout.
 * @returns the validated provisioning response holding the full key.
 */
export async function requestProvisionKey(gatewayApiOrigin: string, accessToken: string,
  signal: AbortSignal): Promise<z.infer<typeof provisionKeyResponse>> {
  return gatewayRequest(`${gatewayApiOrigin}/auth/desktop/provision-key`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'x-company-code': COMPANY_CODE },
  }, signal, provisionKeyResponse, (status) => {
    if (status === 401) return 'expired'
    if (status === 429) return 'network'
    return status >= 400 && status < 500 ? 'protocol' : 'network'
  })
}

/**
 * Read one bounded gateway JSON response with stable, non-secret diagnostics.
 * @param url - endpoint URL.
 * @param init - request options; the body is never logged.
 * @param signal - attempt cancellation and timeout.
 * @param schema - success payload validation.
 * @param rejectStatus - maps a non-2xx status plus parsed body to a sign-in error code.
 * @returns the validated payload.
 */
async function gatewayRequest<T>(url: string, init: RequestInit, signal: AbortSignal,
  schema: z.ZodType<T>, rejectStatus: (status: number, payload: unknown) => SignInErrorCode): Promise<T> {
  const path = new URL(url).pathname
  console.info('[deepseek-account] request', { path, method: init.method })
  let response: Response
  try {
    response = await fetch(url, { ...init, redirect: 'error', signal })
  } catch {
    console.info('[deepseek-account] request failed', { path, errorCode: 'no-response', aborted: signal.aborted })
    throw new PlatformAuthError('no-response')
  }
  console.info('[deepseek-account] response', { path, status: response.status })
  const reader = response.body?.getReader()
  let stage = 'read-status'
  try {
    const payload = await readBoundedJson(reader, () => { stage = 'body-limit' })
    stage = 'validate'
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new PlatformAuthError(rejectStatus(response.status, payload))
    }
    const parsed = schema.safeParse(payload)
    if (!parsed.success) {
      console.info('[deepseek-account] payload rejected', {
        path, issues: parsed.error.issues.map(issue => ({ path: issue.path, code: issue.code })),
      })
      throw new PlatformAuthError('protocol')
    }
    return parsed.data
  } catch (error) {
    console.info('[deepseek-account] response rejected', { path, stage,
      errorCode: error instanceof PlatformAuthError ? error.code : 'protocol' })
    if (error instanceof PlatformAuthError) throw error
    throw new PlatformAuthError('protocol')
  } finally {
    await reader?.cancel().catch(() => undefined)
    reader?.releaseLock()
  }
}

/** Read one bounded JSON body through the acquired stream reader. */
async function readBoundedJson(reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
  onLimit: () => void): Promise<unknown> {
  if (reader === undefined) throw new PlatformAuthError('protocol')
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    size += next.value.byteLength
    if (size > 65_536) { onLimit(); throw new PlatformAuthError('protocol') }
    chunks.push(next.value)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
