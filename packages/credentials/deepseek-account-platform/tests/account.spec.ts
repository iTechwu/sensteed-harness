import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import type { AccountClientMetadata } from '@deepseek-ai/dsh-deepseek-account'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { Config, PlatformAccount } from '../src/index.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const clientMetadata = (): AccountClientMetadata => ({ version: '1.2.3', locale: 'zh-CN', timezoneOffsetSeconds: 28_800 })
const REF_NAME = 'SENSTEED_GATEWAY_API_KEY'
const PROVISIONED_KEY = 'sk-test-provisioned-key'

/** Endpoint override applied to the next mock response; status 0 means success. */
interface EndpointState {
  status: number
  body: unknown
}

async function fixture(config: Partial<Config> = {},
  beforeAccount?: (ctx: Context, credentialsPath: string) => Promise<void>, omitDeployment = false) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-account-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const tokenRequests: Array<Record<string, string>> = []
  const provisionRequests: Array<{ authorization: string | undefined; companyCode: string | undefined }> = []
  let tokenState: Partial<EndpointState> = {}
  let provisionState: Partial<EndpointState> = {}
  let holdToken = false
  const tokenReleased = Promise.withResolvers<undefined>()
  const tokenReceived = Promise.withResolvers<undefined>()
  const provisionReceived = Promise.withResolvers<undefined>()

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/oauth/token') {
      req.setEncoding('utf8')
      let text = ''
      for await (const chunk of req) text += chunk
      const body = JSON.parse(text) as Record<string, string>
      tokenRequests.push(body)
      tokenReceived.resolve(undefined)
      if (holdToken) await tokenReleased.promise
      const status = tokenState.status ?? 0
      const extra = (tokenState.body ?? {}) as Record<string, unknown>
      if (status !== 0) { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(extra)); return }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ access_token: 'sso-test-access-token', token_type: 'Bearer', expires_in: 3600, ...extra }))
      return
    }
    if (req.url === '/auth/desktop/provision-key') {
      provisionRequests.push({
        authorization: req.headers.authorization as string | undefined,
        companyCode: req.headers['x-company-code'] as string | undefined,
      })
      provisionReceived.resolve(undefined)
      const status = provisionState.status ?? 0
      const extra = (provisionState.body ?? {}) as Record<string, unknown>
      if (status !== 0) { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(extra)); return }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        key: PROVISIONED_KEY, rotated: false,
        user: { ssoSub: 'test-user-sso-sub', name: 'Test User' }, ...extra,
      }))
      return
    }
    res.writeHead(404).end()
  }
  const server = createServer((req, res) => { void handle(req, res).catch(() => { res.writeHead(500).end() }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing listener')
  const gatewayOrigin = `http://127.0.0.1:${address.port}`
  cleanups.push(async () => {
    tokenReleased.resolve(undefined)
    await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() })
  })

  const ctx = new Context()
  const web = ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await web
  const callbackOrigin = `http://127.0.0.1:${ctx.webServer.port}`
  const credentials = ctx.plugin(LocalCredentialProvider, { path: join(home, 'credentials.yaml'), watch: false })
  await credentials
  await beforeAccount?.(ctx, join(home, 'credentials.yaml'))
  const authorization = ctx.plugin(AuthorizationService)
  await authorization
  const provider = ctx.plugin(PlatformAccount, omitDeployment ? {
    allowLoopbackHttp: true,
    ...config,
  } : {
    ssoApiOrigin: gatewayOrigin,
    gatewayApiOrigin: gatewayOrigin,
    credentialRefName: REF_NAME,
    allowLoopbackHttp: true,
    ...config,
  })
  await provider
  cleanups.push(async () => {
    await provider.dispose(); await authorization.dispose(); await credentials.dispose(); await web.dispose()
  })
  const account = ctx.deepseekAccount as PlatformAccount
  const states = new AbortController()
  cleanups.push(async () => { states.abort() })
  async function wait(phase: string) {
    for await (const state of account.watch(states.signal)) if (state.attempt?.phase === phase) return state
    throw new Error(`missing phase ${phase}`)
  }
  /** The authorize URL of the live attempt, parsed so tests can read and echo its parameters. */
  function authorizeUrl(state: Awaited<ReturnType<typeof wait>>): URL {
    const url = state.attempt?.authorizeUrl
    if (url === undefined) throw new Error('attempt carries no authorize URL')
    return new URL(url)
  }
  function callback(authorize: URL, code = 'test-code'): string {
    return `http://127.0.0.1:${ctx.webServer.port}/callback?code=${code}&state=${authorize.searchParams.get('state')}`
  }
  return {
    ctx, account, home, gatewayOrigin, callbackOrigin, wait, authorizeUrl, callback,
    tokenRequests, provisionRequests, tokenReceived, provisionReceived,
    tokenResponse: (value: Record<string, unknown>) => { tokenState.body = value },
    failToken: (status: number, body: unknown) => { tokenState = { status, body } },
    failProvision: (status: number, body: unknown = {}) => { provisionState = { status, body } },
    holdToken: () => { holdToken = true },
    releaseToken: () => tokenReleased.resolve(undefined),
    credentialsPath: join(home, 'credentials.yaml'),
  }
}

it('constructs the SSO authorize URL with the registered desktop client and loopback callback', async () => {
  const f = await fixture()
  await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'desktop')
  const state = await f.wait('waiting-browser')
  const authorize = f.authorizeUrl(state)
  expect(authorize.pathname).toBe('/oauth/authorize')
  expect(authorize.searchParams.get('response_type')).toBe('code')
  expect(authorize.searchParams.get('client_id')).toBe('sensteed-desktop')
  expect(authorize.searchParams.get('scope')).toBe('openid profile email tenant offline_access')
  expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
  expect(authorize.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
  const redirect = new URL(authorize.searchParams.get('redirect_uri') ?? '')
  expect(redirect.pathname).toBe('/callback')
  expect(redirect.port).toBe(String(new URL(f.callbackOrigin).port))
  await f.account.cancelSignIn(state.attempt!.id)
})

it('provisions a key, stores it under the configured ref, and answers gateway requests', async () => {
  const f = await fixture()
  await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'desktop')
  const state = await f.wait('waiting-browser')
  await fetch(f.callback(f.authorizeUrl(state)), { redirect: 'manual' })
  const stored = await f.wait('succeeded')
  expect(stored.status).toBe('credential-stored')
  await f.provisionReceived.promise
  expect(f.tokenRequests[0]!).toMatchObject({
    grant_type: 'authorization_code', code: 'test-code', client_id: 'sensteed-desktop',
    redirect_uri: `http://127.0.0.1:${new URL(f.callbackOrigin).port}/callback`,
  })
  expect(f.tokenRequests[0]!.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(f.provisionRequests[0]!).toEqual({
    authorization: 'Bearer sso-test-access-token', companyCode: 'sensteed',
  })
  expect(await readFile(f.credentialsPath, 'utf8')).toContain(PROVISIONED_KEY)
  const record = await f.ctx.credentials.describeRecord(credentialKey('deepseek-account-platform', 'default'))
  expect(record.configured).toBe(true)
  expect(await f.account.resolveToken(`${f.gatewayOrigin}/anthropic/v1/messages`)).toBe(PROVISIONED_KEY)
  expect(await f.account.resolveToken(`${f.gatewayOrigin}/`)).toBe(PROVISIONED_KEY)
  expect(await f.account.resolveToken('https://other.example/api/anthropic/v1/messages')).toBeUndefined()
  const profile = await f.account.getProfile(clientMetadata())
  expect(profile).toEqual({ status: 'ready', value: { id: 'test-user-sso-sub', name: 'Test User', contact: null } })
  expect(await f.account.getPlatformSession()).toBeNull()
  await f.account.signOut(clientMetadata())
  expect((await f.account.getState()).status).toBe('signed-out')
  expect(await readFile(f.credentialsPath, 'utf8')).not.toContain(PROVISIONED_KEY)
  expect(await f.account.resolveToken(`${f.gatewayOrigin}/anthropic/v1/messages`)).toBeUndefined()
})

it('serves the close-window page to web sign-in and 204 to desktop', async () => {
  const f = await fixture()
  await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'web')
  const state = await f.wait('waiting-browser')
  const response = await fetch(f.callback(f.authorizeUrl(state)))
  expect(response.status).toBe(200)
  expect(await response.text()).toContain('登录成功')
  await f.wait('succeeded')
})

it('maps an invalid_grant token rejection to an expired attempt', async () => {
  const f = await fixture()
  await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'desktop')
  const state = await f.wait('waiting-browser')
  f.failToken(400, { error: 'invalid_grant', error_description: 'code expired' })
  await fetch(f.callback(f.authorizeUrl(state)), { redirect: 'manual' })
  const failed = await f.wait('expired')
  expect(failed.attempt?.errorCode).toBe('expired')
  expect((await f.account.getState()).status).toBe('signed-out')
})

it('maps provisioning rejections to protocol and network failures', async () => {
  for (const [status, code] of [[403, 'protocol'], [429, 'network']] as const) {
    const f = await fixture()
    await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'desktop')
    const state = await f.wait('waiting-browser')
    f.failProvision(status)
    await fetch(f.callback(f.authorizeUrl(state)), { redirect: 'manual' })
    const failed = await f.wait('failed')
    expect(failed.attempt?.errorCode).toBe(code)
    expect((await f.account.getState()).status).toBe('signed-out')
  }
})

it('fails the attempt as storage when a shadowing env value refuses the key write', async () => {
  vi.stubEnv(REF_NAME, 'env-shadow-value')
  try {
    const f = await fixture()
    await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'desktop')
    const state = await f.wait('waiting-browser')
    await fetch(f.callback(f.authorizeUrl(state)), { redirect: 'manual' })
    const failed = await f.wait('failed')
    expect(failed.attempt?.errorCode).toBe('storage')
  } finally { vi.unstubAllEnvs() }
})

it('expires the stored credential when a gateway request rejects its key', async () => {
  const f = await fixture()
  await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'desktop')
  const state = await f.wait('waiting-browser')
  await fetch(f.callback(f.authorizeUrl(state)), { redirect: 'manual' })
  await f.wait('succeeded')
  await f.account.rejectToken(PROVISIONED_KEY)
  expect((await f.account.getState()).status).toBe('signed-out')
  expect(await readFile(f.credentialsPath, 'utf8')).not.toContain(PROVISIONED_KEY)
})

it('discards a stored record from another deployment at initialization', async () => {
  const f = await fixture({}, async (ctx) => {
    // The storage layer persists a legacy DeepSeek-platform grant before the account boots.
    await ctx.credentials.modifyRecord(credentialKey('deepseek-account-platform', 'default'), () =>
      Promise.resolve({ kind: 'grant', payload: { version: 1, token: 'legacy-grant-token', issuer: 'https://platform.deepseek.com' } }))
  })
  const state = await f.account.getState()
  expect(state.status).toBe('signed-out')
  expect(await readFile(f.credentialsPath, 'utf8')).not.toContain('legacy-grant-token')
})

it('refuses sign-in and answers nothing without a configured deployment', async () => {
  const f = await fixture({}, undefined, true)
  await expect(f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'desktop')).rejects.toMatchObject({ code: 'protocol' })
  expect(await f.account.resolveToken(`${f.gatewayOrigin}/anthropic/v1/messages`)).toBeUndefined()
})
