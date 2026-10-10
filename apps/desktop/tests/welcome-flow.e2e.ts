/** Built Desktop Host acceptance; run after the repository build, without provider credentials. */

import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopHostProcess } from '../src/host-process.ts'
import { DesktopProjectManager } from '../src/project-manager.ts'
import { resolveDesktopPaths } from '../src/paths.ts'
import { desktopClientMetadata } from '../src/client-metadata.ts'
import { connectDesktopWelcome, type DesktopWelcomeBackend } from '../src/welcome-backend.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { prepareDevelopmentProject } from '../scripts/development-project.ts'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const builtHost = join(repository, 'apps/desktop-host/lib/index.js')
afterEach(() => { vi.unstubAllEnvs() })

function version(path: string): string {
  return (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version
}

async function mockGateway() {
  let origin = ''
  let failToken = false
  const server = createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(404).end(); return }
    req.setEncoding('utf8')
    let body = ''
    req.on('data', (chunk: string) => { body += chunk })
    req.on('end', () => {
      if (req.url === '/oauth/token') {
        if (req.headers.authorization !== undefined) { res.writeHead(400).end(); return }
        const input = JSON.parse(body) as Record<string, string>
        // The real SSO validates redirect_uri against the client registration; the loopback
        // port is dynamic, so this mock only pins the registered path.
        if (input.client_id !== 'sensteed-desktop' || input.grant_type !== 'authorization_code'
          || new URL(input.redirect_uri ?? 'invalid:').pathname !== '/callback') { res.writeHead(400).end(); return }
        const challenge = createHash('sha256').update(input.code_verifier ?? '').digest('base64url')
        if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) { res.writeHead(400).end(); return }
        if (failToken) { res.writeHead(503).end(); return }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ access_token: 'sso-mock-access-token', token_type: 'Bearer', expires_in: 3600 }))
        return
      }
      if (req.url === '/auth/desktop/provision-key') {
        if (req.headers.authorization !== 'Bearer sso-mock-access-token') { res.writeHead(401).end(); return }
        if (req.headers['x-company-code'] !== 'sensteed') { res.writeHead(403).end(); return }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({
          key: 'sk-mock-composition-test', rotated: false,
          user: { ssoSub: 'mock-user', name: 'Mock User' },
        }))
        return
      }
      res.writeHead(404).end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing mock listener')
  origin = `http://127.0.0.1:${String(address.port)}`
  return {
    origin,
    failToken: (value: boolean) => { failToken = value },
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }),
  }
}

describe.skipIf(!existsSync(builtHost))('built Desktop welcome flow', () => {
  it('persists explicit API keys and browser account login independently across Host restarts', async () => {
    vi.stubEnv('DSH_CLIENT_VERSION', '1.2.3')
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-welcome-'))
    let host: DesktopHostProcess | undefined
    const gateway = await mockGateway()
    try {
      for (const name of Object.keys(process.env)) {
        if (/KEY|TOKEN|SECRET|PASSWORD/u.test(name)) vi.stubEnv(name, undefined)
      }
      const home = join(root, 'home')
      mkdirSync(home)
      vi.stubEnv('DSH_HOME', home)
      vi.stubEnv('DSH_TELEMETRY_MODE', 'DISABLED')
      const project = prepareDevelopmentProject({
        projectDir: join(root, 'project'),
        cliDir: join(repository, 'apps/cli'),
        hostDir: join(repository, 'apps/desktop-host'),
        dependencyDir: join(repository, 'node_modules/.pnpm/node_modules'),
        release: {
          schemaVersion: 1,
          version: version(join(repository, 'apps/desktop/package.json')),
          pnpmVersion: version(join(repository, 'apps/desktop/node_modules/pnpm/package.json')),
          nodeVersion: process.versions.node,
          hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
        },
        // This suite assembles a synthetic project on hosts that prepare no Desktop target, and
        // nothing it exercises compares the descriptor's platform/arch outside packaging.
        target: 'mac-x64',
      })
      cpSync(join(repository, 'packages/skill/skill-office/assets'), join(root, 'runtime/office-skills'), { recursive: true })
      const nodeBin = join(root, 'runtime/primary-runtime/dependencies/node/bin')
      mkdirSync(nodeBin, { recursive: true })
      cpSync(process.execPath, join(nodeBin, process.platform === 'win32' ? 'node.exe' : 'node'))
      const paths = resolveDesktopPaths(home)
      const manager = new DesktopProjectManager(paths, {
        dsh: project,
      })
      await manager.applyRelease()
      writeFileSync(join(paths.profile, 'cordis.patch.yml'), `- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n- id: deepseek-account\n  config:\n    ssoApiOrigin: ${gateway.origin}\n    gatewayApiOrigin: ${gateway.origin}\n    credentialRefName: SENSTEED_GATEWAY_API_KEY\n    allowLoopbackHttp: true\n`)
      let backend: DesktopWelcomeBackend
      let hostUrl = ''
      /** Callback for the Host webServer, echoing the live attempt's state parameter. */
      const callbackFor = (authorizeUrl: string | undefined): string => {
        const state = authorizeUrl === undefined ? '' : new URL(authorizeUrl).searchParams.get('state') ?? ''
        return `http://127.0.0.1:${new URL(hostUrl).port}/callback?code=test&state=${state}`
      }
      const restart = async (): Promise<void> => {
        await host?.stop()
        host = new DesktopHostProcess(process.execPath, project, paths.profile)
        const { url } = await host.start()
        hostUrl = url
        let cookie = ''
        const send: typeof fetch = async (input, init) => {
          const headers = new Headers(init?.headers)
          if (cookie !== '') headers.set('cookie', cookie)
          const response = await fetch(input, { ...init, headers, redirect: 'manual' })
          if (response.status !== 303) return response
          cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
          await response.body?.cancel()
          return fetch(new URL(response.headers.get('location')!, url), { headers: { cookie } })
        }
        backend = await connectDesktopWelcome(url, send, () => Promise.resolve(cookie))
      }
      const status = async () => backend.read()
      const fingerprint = (): string => createHash('sha256')
        .update(readFileSync(join(home, '.credentials.yaml'))).digest('hex')
      await restart()
      expect(await status()).toMatchObject({ hasApiKey: false, localePreference: null })
      const before = fingerprint()
      await host!.stop()
      writeFileSync(join(paths.profile, 'cordis.patch.yml'),
        readFileSync(join(paths.profile, 'cordis.patch.yml'), 'utf8') + '- id: locale\n  config:\n    preference: zh\n')
      await restart()
      expect(await status()).toMatchObject({ hasApiKey: false, localePreference: 'zh' })
      expect(fingerprint()).toBe(before)
      expect(await backend!.save('sk-local-onboarding-test')).toEqual({ ok: true })
      expect(await status()).toMatchObject({ hasApiKey: true, localePreference: 'zh' })
      await restart()
      expect(await status()).toMatchObject({ hasApiKey: true })
      await backend!.account.start(desktopClientMetadata('en'))
      await expect.poll(async () => (await backend!.account.state()).attempt?.phase).toBe('waiting-browser')
      const waiting = await backend!.account.state()
      const callbackUrl = callbackFor(waiting.attempt?.authorizeUrl)
      expect(new URL(callbackUrl).pathname).toBe('/callback')
      await gateway.failToken(true)
      const failed = await fetch(callbackUrl, { redirect: 'manual' })
      expect(failed.status).toBe(204)
      expect(await backend!.account.state()).toMatchObject({ status: 'signed-out', attempt: { phase: 'failed' } })
      expect(await status()).toMatchObject({ hasApiKey: true, loggedIn: false })
      gateway.failToken(false)
      await backend!.account.start(desktopClientMetadata('en'))
      await expect.poll(async () => (await backend!.account.state()).attempt?.phase).toBe('waiting-browser')
      const response = await fetch(callbackFor((await backend!.account.state()).attempt?.authorizeUrl), { redirect: 'manual' })
      expect(response.status).toBe(204)
      await expect.poll(async () => (await backend!.account.state()).status).toBe('credential-stored')
      expect(await status()).toMatchObject({ hasApiKey: true, loggedIn: true })
      await restart()
      expect(await status()).toMatchObject({ hasApiKey: true, loggedIn: true })
      // Sign-out removes the key reference and record locally; the gateway keeps no session to revoke.
      await backend!.account.signOut(desktopClientMetadata('en'))
      expect(await status()).toMatchObject({ hasApiKey: true, loggedIn: false })
      await backend!.account.start(desktopClientMetadata('en'))
      await expect.poll(async () => (await backend!.account.state()).attempt?.phase).toBe('waiting-browser')
      const lateWaiting = await backend!.account.state()
      const late = callbackFor(lateWaiting.attempt?.authorizeUrl)
      await backend!.account.cancel(lateWaiting.attempt!.id)
      expect((await fetch(late, { redirect: 'manual' })).status).not.toBe(204)
      expect(await status()).toMatchObject({ loggedIn: false })
    } finally {
      await host?.stop()
      await gateway.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
