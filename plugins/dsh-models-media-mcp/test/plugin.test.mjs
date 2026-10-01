import { readFile } from 'node:fs/promises'
import { expect, test } from 'vitest'
import { apply } from '../index.js'

const patchUrl = new URL('../cordis.patch.yml', import.meta.url)
const montageGuidanceUrl = new URL('../../dsh-openmontage-mcp/index.js', import.meta.url)

test('registers only the fixed public media MCP endpoint', async () => {
  const patch = await readFile(patchUrl, 'utf8')
  expect(patch).toMatch(/url: 'https:\/\/ai.hozonauto.com\/mcp\/media'/)
  expect(patch).toMatch(/authorizationCredential: MODELS_API_KEY/)
  expect(patch).not.toMatch(/process\.env\.MODELS_API_KEY/)
  expect(patch).not.toMatch(/MCP_BASE_URL|MEDIA_MCP_URL|MEDIA_BASE_URL/)
  expect(patch).not.toMatch(/172\.30\.30\.11|127\.0\.0\.1|localhost/)
})

test('guidance preserves the direct-media and OpenMontage boundary', () => {
  let section
  apply({
    systemPrompt: {
      section(value) {
        section = value
      },
    },
  })

  expect(section.name).toBe('models-media:guidance')
  expect(section.text).toMatch(/mcp__media__create_image_task/)
  expect(section.text).toMatch(/mcp__media__create_video_task/)
  expect(section.text).toMatch(/mcp__openmontage__/)
  expect(section.text).toMatch(/idempotencyKey/)
  expect(section.text).toMatch(/get_generation_task/)
})

test('OpenMontage guidance owns only complex video and exposes no internal topology', async () => {
  const source = await readFile(montageGuidanceUrl, 'utf8')
  expect(source).toMatch(/mcp__media__create_video_task/)
  expect(source).toMatch(/脚本、分镜、多镜头/)
  expect(source).not.toMatch(/127\.0\.0\.1|host\.docker\.internal|OPENMONTAGE_ALLOW_PRIVATE_URLS/)
})
