import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import * as filesystem from '../src/index.ts'

const contexts: Context[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-host-policy-'))
  dirs.push(dir)
  const root = join(dir, 'trusted')
  await mkdir(root)
  await mkdir(join(dir, 'untrusted'))
  await writeFile(join(dir, 'untrusted', 'rogue.md'), '---\nname: rogue\ndescription: Untrusted skill\n---\nUntrusted content')
  await writeFile(join(root, 'safe.md'), '---\nname: safe\ndescription: Trusted skill\n---\nHost content')
  const ctx = new Context()
  contexts.push(ctx)
  filesystem.installFilesystemSkillRootPolicy(ctx, { generationId: 'g1', providerName: 'hub-generation', roots:[{ path:root, source: 'hub', rank: 100 }] })
  return { ctx, dir, root }
}
describe('Host-only filesystem roots through real Cordis Loader', () => {
  it('composes YAML providers while excluding defaults and scoped impersonation', async () => {
    const { ctx, dir } = await setup()
    ctx.baseUrl = pathToFileURL(dir).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([['@deepseek-ai/dsh-skill',SkillRegistry],['@deepseek-ai/dsh-skill-filesystem',filesystem]])
    const internal: ModuleLoaderV2 = {
      version: 'v2', loadCache: new Map(),
      async import(name: string) { if (!modules.has(name)) throw new Error('Unexpected module'); return modules.get(name) },
      register(): never { throw new Error('Unexpected module hook') },
      getOrCreateModuleJob(): never { throw new Error('Unexpected module job') },
      resolveSync(): never { throw new Error('Unexpected module resolution') },
      load(): never { throw new Error('Unexpected module load') },
    }
    ctx.loader.internal = internal
    await ctx.loader.create({ name: 'cordis:include',config:{ path:new URL('./fixtures/host-policy/cordis.yml',import.meta.url).href } })
    await ctx.loader.await()
    expect([...ctx.loader.entries()].filter(e => e.fiber === undefined && !e.disabled)).toEqual([])
    const scoped = createScope(ctx,{ agent: 'untrusted' })
    await scoped.ctx.plugin(filesystem,{ providerName: 'hub-generation', watch: false })
    expect((await ctx.skills.list({ scope:scopeOf(scoped.ctx) })).map(s => [s.name,s.provider,s.source])).toEqual([['safe','hub-generation','hub']])
    expect((await ctx.skills.get('safe'))?.content).toContain('Host content')
    expect(() => filesystem.installFilesystemSkillRootPolicy(scoped.ctx,{ generationId: 'g2', providerName: 'other', roots:[] })).toThrow('Host context')
  })
  it.skipIf(process.platform === 'win32')('rejects forged locators, sources, providers and symlink escapes', async () => {
    const { ctx, dir, root } = await setup()
    const provider = new filesystem.FileSystemSkillProvider(ctx,{ invalidate(){}, signal:new AbortController().signal }, { providerName: 'hub-generation', watch: false })
    const observation = await provider.list({})
    const candidate = Array.isArray(observation) ? observation[0] : observation.candidates[0]
    if (candidate === undefined) throw new Error('Trusted fixture was not discovered')
    expect(await provider.get({ ...candidate, source: 'custom' }, {})).toBeUndefined()
    expect(await provider.get({ ...candidate,provider: 'other' }, {})).toBeUndefined()
    expect(await provider.get({ ...candidate, locator:{ path:join(root,'safe.md'), directory:dir } }, {})).toBeUndefined()
    await writeFile(join(dir,'outside.md'),'---\nname: outside\ndescription: Outside\n---\nprivate')
    await symlink(join(dir,'outside.md'),join(root,'escape.md'))
    expect((await provider.list({}))).toHaveLength(1)
    expect(await provider.get({ ...candidate, locator:{ path:join(root,'escape.md'), directory:root } }, {})).toBeUndefined()
    await provider.dispose()
  })
})
