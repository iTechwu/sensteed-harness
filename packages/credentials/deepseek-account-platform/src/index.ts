/** Sensteed gateway account provider; browser approval never bypasses local cancellation. */
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { platform, release } from 'node:os'
import { promises as streamPromises } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { DeepSeekAccount, platformWireLocale, type AccountView, type SignInAttemptId, type SignInAttemptView } from '@deepseek-ai/dsh-deepseek-account'
import type { AccountClientMetadata, AccountDetails, AccountUserId } from '@deepseek-ai/dsh-deepseek-account'
import { credentialKey, credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { apiOrigin, buildAuthorizeUrl, loginOrigin, requestProvisionKey, requestSsoToken,
  CALLBACK_PATH, PlatformAuthError, SSO_CLIENT_ID } from './protocol.ts'

const KEY = credentialKey('deepseek-account-platform', 'default')
const DEVICE = credentialKey('deepseek-account-platform', 'device')
/** Provisioned-key metadata; the key itself lives in the credentials refs section. */
const record = z.object({
  version: z.literal(2),
  user: z.object({ ssoSub: z.string().min(1), name: z.string().optional(), avatarUrl: z.string().optional() }),
  provisionedAt: z.string(),
  ssoApiOrigin: z.string(),
  gatewayApiOrigin: z.string(),
  credentialRefName: z.string(),
})
const device = z.object({ id: z.uuid() })

/** Deployment-specific gateway endpoints and request deadlines. */
export interface Config {
  /** SSO API base serving OAuth authorize and token endpoints, including any deployment path prefix. */
  ssoApiOrigin?: string
  /** Gateway API base serving the desktop key bridge and model inference, including any path prefix. */
  gatewayApiOrigin?: string
  /** Credentials ref the provisioned gateway key is written to and read from. */
  credentialRefName?: string
  /** Allow HTTP only on loopback for the development Mock. */
  allowLoopbackHttp?: boolean
  /** Deadline for each gateway HTTP request. */
  requestTimeoutMs?: number
  /** Upper bound for the entire local attempt, even if the server advertises a longer TTL. */
  attemptTimeoutMs?: number
}
/** Validated deployment choices. */
export const Config = Schema.object({
  ssoApiOrigin: Schema.string(),
  gatewayApiOrigin: Schema.string(),
  credentialRefName: Schema.string().role('credential-ref'),
  allowLoopbackHttp: Schema.boolean().default(false),
  requestTimeoutMs: Schema.number().min(1).max(120_000).default(30_000),
  attemptTimeoutMs: Schema.number().min(1).max(3_600_000).default(600_000),
})

interface Attempt {
  view: SignInAttemptView
  controller: AbortController
  done: Promise<void>
  running: Promise<void>
  origin: string
  locale: 'zh_CN' | 'en_US'
  loginSource: 'web' | 'desktop'
  disposeCallback?: () => Promise<void>
  callback?: ServerResponse
}

/** The gateway implementation owns login state and the provisioned-key metadata record. */
export class PlatformAccount extends DeepSeekAccount {
  static inject = ['credentials', 'authorization']
  static Config = Config
  private readonly ssoApiOrigin: string | undefined
  private readonly gatewayApiOrigin: string | undefined
  private readonly credentialRefName: string | undefined
  private readonly credentialRef: CredentialRef | undefined
  private readonly requestTimeout: number
  private readonly attemptTimeout: number
  private attempt: Attempt | undefined
  private readonly listeners = new Set<() => void>()
  private closed = false
  private removing: Promise<AccountView> | undefined

  /** @param ctx - Host with authorization and credentials services. @param config - deployment options. */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    const resolved = Config(config)
    this.ssoApiOrigin = resolved.ssoApiOrigin === undefined
      ? undefined
      : apiOrigin(resolved.ssoApiOrigin, resolved.allowLoopbackHttp)
    this.gatewayApiOrigin = resolved.gatewayApiOrigin === undefined
      ? undefined
      : apiOrigin(resolved.gatewayApiOrigin, resolved.allowLoopbackHttp)
    this.credentialRefName = resolved.credentialRefName
    this.credentialRef = resolved.credentialRefName === undefined ? undefined : credentialRef(resolved.credentialRefName)
    this.requestTimeout = resolved.requestTimeoutMs
    this.attemptTimeout = resolved.attemptTimeoutMs
    ctx.authorization.registerFlow({
      key: KEY, label: 'Sensteed', methods: [{ id: 'browser', label: 'Sensteed' }],
      run: (session) => {
        const attempt = this.attempt
        if (attempt === undefined) return Promise.reject(new PlatformAuthError('protocol'))
        attempt.running = this.run(session, attempt)
        return attempt.running
      },
    })
    ctx.on('credentials/record-updated', (key) => {
      if (key !== KEY) return
      this.changed()
    })
    ctx.effect(() => async () => {
      this.closed = true
      const active = this.attempt
      if (active !== undefined) {
        if (active.view.phase !== 'committing') active.controller.abort()
        await active.done
      }
      await this.removing
      this.changed()
    }, 'account: active attempt lifetime')
  }

  async [Service.init](): Promise<void> {
    const current = await this.ctx.credentials.readRecord(KEY)
    if (current === undefined) return
    if (current.kind !== 'grant') throw new PlatformAuthError('storage')
    const parsed = record.safeParse(current.payload)
    if (parsed.success && this.matchesDeployment(parsed.data)) return
    // Pre-migration grant payloads and records from another deployment cannot answer for this one.
    await this.ctx.credentials.deleteRecord(KEY)
    console.info('[deepseek-account] stored record discarded', { reason: parsed.success ? 'deployment-mismatch' : 'payload-version' })
  }

  /** Whether a stored record was provisioned through exactly this deployment's endpoints and ref. */
  private matchesDeployment(data: z.infer<typeof record>): boolean {
    return data.ssoApiOrigin === this.ssoApiOrigin && data.gatewayApiOrigin === this.gatewayApiOrigin
      && data.credentialRefName === this.credentialRefName
  }

  private requireDeployment(): { ssoApiOrigin: string; gatewayApiOrigin: string; credentialRef: CredentialRef } {
    if (this.ssoApiOrigin === undefined || this.gatewayApiOrigin === undefined || this.credentialRef === undefined) {
      throw new PlatformAuthError('protocol')
    }
    return { ssoApiOrigin: this.ssoApiOrigin, gatewayApiOrigin: this.gatewayApiOrigin, credentialRef: this.credentialRef }
  }

  override async getState(): Promise<AccountView> {
    const current = await this.ctx.credentials.readRecord(KEY)
    if (current !== undefined && (current.kind !== 'grant' || !record.safeParse(current.payload).success)) {
      throw new PlatformAuthError('storage')
    }
    const attempt = this.attempt?.view ?? null
    const webOrigin = this.gatewayApiOrigin === undefined ? '' : new URL(this.gatewayApiOrigin).origin
    return {
      status: current === undefined ? 'signed-out' : 'credential-stored',
      // Credential removal can notify watchers before sign-out finishes clearing the attempt.
      attempt: current === undefined && attempt?.phase === 'succeeded' ? null : attempt,
      links: {
        usageUrl: `${webOrigin}/zh/gateway/api-keys`,
        topUpUrl: `${webOrigin}/zh/gateway/billing`,
      },
    }
  }

  override async getProfile(_client: AccountClientMetadata): Promise<AccountDetails['profile'] | null> {
    const stored = await this.readCurrentRecord()
    if (stored === null) return null
    return {
      status: 'ready',
      value: { id: stored.user.ssoSub as AccountUserId, name: stored.user.name ?? null, contact: null,
        ...stored.user.avatarUrl === undefined ? {} : { avatarUrl: stored.user.avatarUrl } },
    }
  }

  override getBalance(): Promise<AccountDetails['balance'] | null> {
    // The gateway has no recharge-wallet semantics; the UI renders the signed-out-empty state.
    return Promise.resolve(null)
  }

  override getUnnotifiedBonuses(): Promise<null> {
    return Promise.resolve(null)
  }

  override ackBonusNotified(): Promise<boolean> {
    return Promise.resolve(false)
  }

  override async rejectToken(token: string): Promise<void> {
    if (this.credentialRef === undefined) return
    const current = await this.ctx.credentials.resolve(this.credentialRef).catch(() => undefined)
    if (current?.value !== token) return
    await this.expireCredential()
  }

  private async expireCredential(): Promise<void> {
    this.removing ??= (async () => {
      if (this.attempt !== undefined) await this.cancelSignIn(this.attempt.view.id)
      const stored = await this.readCurrentRecord()
      if (this.closed || stored === null || stored.credentialRefName !== this.credentialRefName) return this.getState()
      await this.ctx.credentials.deleteRecord(KEY)
      await this.clearRef()
      this.ctx.emit('deepseek-account/session-expired')
      this.attempt = undefined
      this.ctx.emit('deepseek-account/signed-out')
      this.changed()
      return this.getState()
    })().finally(() => { this.removing = undefined })
    await this.removing
  }

  /** Remove the refs value; shadowing layers may refuse, which never blocks the record removal. */
  private async clearRef(): Promise<void> {
    if (this.credentialRef === undefined) return
    try { await this.ctx.credentials.unset(this.credentialRef) }
    catch (error) { console.info('[deepseek-account] ref removal refused', { error: String(error) }) }
  }

  override async getDeviceIdentity(): Promise<{ deviceId?: string; osVersion: string }> {
    const record_ = await this.ctx.credentials.readRecord(DEVICE)
    const parsed = record_?.kind === 'grant' ? device.safeParse(record_.payload) : undefined
    return {
      ...parsed?.success ? { deviceId: parsed.data.id } : {},
      osVersion: `${platform()} ${release()}`,
    }
  }

  override async getPlatformSession(): Promise<null> {
    // The gateway has no embedded account pages; desktop consumers treat null as not embedded.
    return null
  }

  private async readCurrentRecord(): Promise<z.infer<typeof record> | null> {
    if (this.closed) return null
    const current = await this.ctx.credentials.readRecord(KEY)
    if (current === undefined) return null
    if (current.kind !== 'grant') throw new PlatformAuthError('storage')
    const parsed = record.safeParse(current.payload)
    if (!parsed.success) throw new PlatformAuthError('storage')
    if (!this.matchesDeployment(parsed.data)) throw new PlatformAuthError('protocol')
    return parsed.data
  }

  override async resolveToken(url: string): Promise<string | undefined> {
    if (this.closed || this.removing !== undefined || this.gatewayApiOrigin === undefined || this.credentialRef === undefined) {
      return undefined
    }
    // Only the configured gateway API base may receive the provisioned key.
    if (url !== this.gatewayApiOrigin && !url.startsWith(`${this.gatewayApiOrigin}/`)) return undefined
    const resolved = await this.ctx.credentials.resolve(this.credentialRef).catch(() => undefined)
    return resolved?.value
  }

  override async startSignIn(client: AccountClientMetadata, callbackOrigin: string, loginSource: 'web' | 'desktop'): Promise<AccountView> {
    this.requireDeployment()
    if (this.removing !== undefined) await this.removing
    const origin = loginOrigin(callbackOrigin)
    if (this.closed) throw new PlatformAuthError('protocol')
    if (this.attempt !== undefined && ['initializing', 'waiting-browser', 'exchanging', 'committing'].includes(this.attempt.view.phase)) {
      return this.getState()
    }
    const previous = this.attempt
    if (previous !== undefined) {
      await previous.done
      // Disposal can close the provider while the previous attempt settles.
      if (this.closed) throw new PlatformAuthError('protocol')
      if (this.attempt !== previous) return this.getState()
    }
    const attempt: Attempt = {
      origin, loginSource, locale: platformWireLocale(client.locale),
      view: { id: randomUUID() as SignInAttemptId, phase: 'initializing' },
      controller: new AbortController(), done: Promise.resolve(), running: Promise.resolve(),
    }
    this.attempt = attempt
    attempt.done = this.ctx.authorization.begin({
      key: KEY, signal: attempt.controller.signal,
      interaction: { notify: () => undefined, prompt: () => Promise.reject(new PlatformAuthError('protocol')) },
    }).then((outcome) => {
      this.update(attempt, { phase: outcome.status === 'authorized' ? 'succeeded' : 'cancelled' })
      this.finishBrowserResponse(attempt, outcome.status === 'authorized')
    }).catch((error: unknown) => {
      const code = error instanceof PlatformAuthError ? error.code : 'protocol'
      console.info('[deepseek-account] sign-in failed', { errorCode: code })
      this.update(attempt, { phase: code === 'expired' ? 'expired' : 'failed', errorCode: code })
      this.finishBrowserResponse(attempt, false)
    }).then(async () => {
      // begin() may report cancellation before the HTTP work observes its signal.
      await attempt.running.catch(() => undefined)
      if (attempt.callback !== undefined) {
        await streamPromises.finished(attempt.callback, { cleanup: true }).catch(() => undefined)
      }
      await attempt.disposeCallback?.()
    })
    this.changed()
    return this.getState()
  }

  override async cancelSignIn(id: SignInAttemptId): Promise<AccountView> {
    const attempt = this.attempt
    if (attempt?.view.id === id) {
      if (attempt.view.phase !== 'committing') {
        attempt.controller.abort()
        this.ctx.authorization.cancel(KEY)
      }
      await attempt.done
    }
    return this.getState()
  }

  override signOut(_client: AccountClientMetadata): Promise<AccountView> {
    this.removing ??= (async () => {
      if (this.closed) throw new PlatformAuthError('protocol')
      if (this.attempt !== undefined) await this.cancelSignIn(this.attempt.view.id)
      if (await this.ctx.credentials.readRecord(KEY) !== undefined) await this.ctx.credentials.deleteRecord(KEY)
      await this.clearRef()
      this.attempt = undefined
      this.ctx.emit('deepseek-account/signed-out')
      this.changed()
      return this.getState()
    })().finally(() => { this.removing = undefined })
    return this.removing
  }

  override async *watch(signal: AbortSignal): AsyncIterable<AccountView> {
    let dirty = true
    let wake: (() => void) | undefined
    const changed = (): void => { dirty = true; wake?.() }
    this.listeners.add(changed)
    signal.addEventListener('abort', changed, { once: true })
    try {
      while (!this.closed && !signal.aborted) {
        if (dirty) { dirty = false; yield await this.getState(); continue }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      this.listeners.delete(changed)
      signal.removeEventListener('abort', changed)
    }
  }

  private changed(): void { for (const listener of this.listeners) listener() }

  private update(attempt: Attempt, value: Partial<SignInAttemptView>): void {
    const { authorizeUrl: _url, ...rest } = attempt.view
    attempt.view = { ...rest, ...value }
    this.changed()
  }

  private async run(session: AuthorizationSession, attempt: Attempt): Promise<void> {
    const { ssoApiOrigin, gatewayApiOrigin, credentialRef } = this.requireDeployment()
    const webServer = this.ctx.get('webServer')
    if (webServer === undefined) throw new PlatformAuthError('protocol')
    const verifier = randomBytes(32).toString('base64url')
    const state = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const code = Promise.withResolvers<string>()
    // Callback requests may precede initialization settlement; the rejection is observed immediately.
    void code.promise.catch(() => undefined)
    const deadline = new AbortController()
    const signal = AbortSignal.any([session.signal, deadline.signal])
    const timer = setTimeout(() => { deadline.abort() }, this.attemptTimeout)
    const abort = (): void => { code.reject(new PlatformAuthError('expired')) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      attempt.disposeCallback = this.ctx.effect(() => webServer.register({
        kind: 'exact', path: CALLBACK_PATH, handler: (req, res) => {
          let url: URL
          try { url = new URL(req.url ?? '/', 'http://127.0.0.1') }
          catch { res.writeHead(400, { 'cache-control': 'no-store' }).end(); return }
          const receivedCode = url.searchParams.get('code')
          const receivedState = url.searchParams.get('state') ?? ''
          const validState = Buffer.byteLength(receivedState) === Buffer.byteLength(state)
            && timingSafeEqual(Buffer.from(receivedState), Buffer.from(state))
          if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH || !validState || !receivedCode
            || url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length !== 1) {
            res.writeHead(400, { 'cache-control': 'no-store' }).end(); return
          }
          if (signal.aborted || attempt.callback !== undefined || attempt.view.phase !== 'waiting-browser') {
            res.writeHead(410, { 'cache-control': 'no-store' }).end(); return
          }
          attempt.callback = res
          code.resolve(receivedCode)
        },
      }), 'account: browser callback')
      signal.throwIfAborted()
      const redirectUri = `${attempt.origin}${CALLBACK_PATH}`
      const authorizeUrl = buildAuthorizeUrl(ssoApiOrigin, redirectUri, state, challenge)
      this.update(attempt, { phase: 'waiting-browser', authorizeUrl, expiresAt: Date.now() + this.attemptTimeout })
      const receivedCode = await code.promise
      signal.throwIfAborted()
      this.update(attempt, { phase: 'exchanging' })
      const token = await requestSsoToken(ssoApiOrigin, {
        grant_type: 'authorization_code', code: receivedCode, code_verifier: verifier,
        client_id: SSO_CLIENT_ID, redirect_uri: redirectUri,
      }, AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeout)]))
      const provisioned = await requestProvisionKey(gatewayApiOrigin, token.access_token,
        AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeout)]))
      if (provisioned.user === undefined) throw new PlatformAuthError('protocol')
      this.update(attempt, { phase: 'committing' })
      try {
        await this.ctx.credentials.set(credentialRef, provisioned.key)
        // A shadowing layer (process environment) would win every future resolve and make the
        // provisioned key dead weight; that misconfiguration fails the attempt instead.
        const effective = await this.ctx.credentials.resolve(credentialRef)
        if (effective?.value !== provisioned.key) throw new Error('credential ref resolves to a foreign value')
      } catch { throw new PlatformAuthError('storage') }
      try {
        await session.commit({
          kind: 'grant',
          payload: {
            version: 2 as const,
            user: {
              ssoSub: provisioned.user.ssoSub,
              ...provisioned.user.name === undefined ? {} : { name: provisioned.user.name },
            },
            provisionedAt: new Date().toISOString(),
            ssoApiOrigin, gatewayApiOrigin,
            credentialRefName: this.credentialRefName,
          },
        })
      } catch { throw new PlatformAuthError('storage') }
    } catch (error) {
      if (deadline.signal.aborted) throw new PlatformAuthError('expired')
      throw error
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      // begin() settles the browser response and removes only this attempt's route.
    }
  }

  private finishBrowserResponse(attempt: Attempt, authorized: boolean): void {
    if (attempt.callback === undefined) return
    if (attempt.loginSource !== 'web') {
      // Native account subscribers focus the login window; the browser tab needs no document.
      attempt.callback.writeHead(204, { 'cache-control': 'no-store' }).end()
      return
    }
    if (attempt.loginSource === 'web') {
      const nonce = randomBytes(16).toString('base64url')
      const successMessage = attempt.locale === 'zh_CN' ? '登录成功，请关闭此标签页。' : 'Sign-in succeeded. Close this tab.'
      const failureMessage = attempt.locale === 'zh_CN' ? '登录失败，请关闭此标签页并在原页面重试。'
        : 'Sign-in failed. Close this tab and try again in the original tab.'
      const message = authorized ? successMessage : failureMessage
      attempt.callback.writeHead(200, {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'none'`,
        'referrer-policy': 'no-referrer',
      }).end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${message}</title>`
        + `<body><p>${message}</p><script nonce="${nonce}">window.close()</script></body></html>`)
    } else {
      // Native account subscribers focus the login window; the browser tab needs no document.
      attempt.callback.writeHead(204, { 'cache-control': 'no-store' }).end()
    }
  }
}
export default PlatformAccount
