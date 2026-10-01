import { readFile } from 'node:fs/promises'
import { Context } from '../../../vendor/cordis/src/index.ts'
import AgentLoop from '../../../packages/core/agent-loop/src/index.ts'
import { mountAgentLoopTestDependencies } from '../../../packages/test-support/agent-loop-testkit/src/index.ts'
import { createUserMessage, ToolCallId } from '../../../packages/llm/llm/src/index.ts'
import { SessionId } from '../../../packages/core/session/src/index.ts'
import SessionProjectionRegistry from '../../../packages/session/session-projection/src/index.ts'
import { afterEach, describe, expect, test } from 'vitest'
import { MockAdapter, textResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import * as OpenMontage from '../index.js'

const patchUrl = new URL('../cordis.patch.yml', import.meta.url)
const contexts = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) {
    await ctx.fiber.dispose()
  }
})

test('registers only the public gateway through the credential service', async () => {
  const patch = await readFile(patchUrl, 'utf8')

  expect(patch).toMatch(/url: 'https:\/\/ai.hozonauto.com\/mcp\/montage'/)
  expect(patch).toMatch(/authorizationCredential: MODELS_API_KEY/)
  expect(patch).toMatch(/missing MODELS_API_KEY fails before the client connects/)
  expect(patch).not.toMatch(/process\.env\.MODELS_API_KEY|headers:\s*\n\s*Authorization:/)
  expect(patch).not.toMatch(/172\.30\.30\.11|127\.0\.0\.1|localhost|host\.docker\.internal|:8765/)
})

test('guidance carries the complete client-stage lifecycle', async () => {
  const ctx = await harness()
  const section = (await ctx.systemPrompt.assemble()).sections
    .find(candidate => candidate.name === 'openmontage:guidance')

  expect(section.name).toBe('openmontage:guidance')
  expect(section.text).toMatch(/submit_video_job → begin_client_stage →（按 stageContract\.gatewayTools 调用零次或多次 invoke_openmontage_tool）/)
  expect(section.text).toMatch(/stageContract 为本次执行的权威契约/)
  expect(section.text).toMatch(/jobId、stage、stageAttempt、leaseToken 和 stageContract/)
  expect(section.text).toMatch(/job_id=jobId、stage=stage、stage_attempt=stageAttempt、lease_token=leaseToken/)
  expect(section.text).toMatch(/instructionFiles/)
  expect(section.text).toMatch(/{"path": result\.relative_path, "content_hash": result\.content_hash}/)
  expect(section.text).toMatch(/组成 submit 的 instruction_provenance/)
  expect(section.text).toMatch(/declaredTools 只是 pipeline manifest 的原始术语/)
  expect(section.text).toMatch(/只能把 gatewayTools 中的精确工具名传给 invoke_openmontage_tool/)
  expect(section.text).toMatch(/artifacts 必须以 produces 中的标准产物名为顶层 key/)
  expect(section.text).toMatch(/不能只传 tool_name、operation、inputs/)
  expect(section.text).toMatch(/外层 operation="generate" 只表示网关执行生命周期/)
  expect(section.text).toMatch(/video_compose 必须在 inputs 内另传 operation="render"/)
  expect(section.text).toMatch(/{"research_brief": {"version":"1.0", \.\.\.}}/)
  expect(section.text).toMatch(/不能把 version、topic 等 brief 字段直接放在 artifacts 顶层/)
  expect(section.text).not.toMatch(/172\.30\.30\.11|127\.0\.0\.1|localhost|:8765/)
})

const signal = new AbortController().signal

async function harness(config = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(OpenMontage, config)
  return ctx
}

async function createAgent(ctx, id) {
  return ctx.agentLoop.create(SessionId(id), { provider: 'mock', model: 'mock' })
}

let callSequence = 0

async function execute(ctx, agent, name, args = {}) {
  return ctx.tools.execute({
    signal,
    callId: ToolCallId(`openmontage-${++callSequence}`),
    name,
    arguments: args,
    agent,
  })
}

function registerTextTool(ctx, name, body) {
  ctx.tools.register({
    name,
    description: name,
    parameters: { type: 'object', additionalProperties: true },
    output: {
      schema: { type: 'array', items: { type: 'object', additionalProperties: true } },
      render: (_args, value) => value,
    },
    async execute(args) {
      const text = await body(args)
      return [{ type: 'text', text }]
    },
  })
}

function schemaNames(ctx, agent) {
  return ctx.tools.schemas(agent).map(schema => schema.name)
}

describe('reference inspection tool projection', () => {
  test('prepared references hide invalid MCP alternatives until a job is submitted', async () => {
    const ctx = await harness()
    const agent = await createAgent(ctx, 'projection')
    registerTextTool(ctx, 'mcp__openmontage__prepare_reference_clone', async () => JSON.stringify({
      status: 'prepared',
      project_id: 'clone-1',
    }))
    registerTextTool(ctx, 'mcp__openmontage__read_project_file', async () => '{"content":"analysis"}')
    registerTextTool(ctx, 'mcp__openmontage__submit_video_job', async () => JSON.stringify({
      status: 'submitted',
      jobId: 'job-1',
    }))
    registerTextTool(ctx, 'mcp__openmontage__list_video_artifacts', async () => '{"artifacts":[]}')
    registerTextTool(ctx, 'mcp__tools-platform__search', async () => 'unrelated')

    const prepared = await execute(ctx, agent, 'mcp__openmontage__prepare_reference_clone', { source: 'https://example.test/video' })

    expect(prepared.isError, JSON.stringify(prepared.content)).toBe(false)
    expect(schemaNames(ctx, agent)).toContain('mcp__openmontage__read_project_file')
    expect(schemaNames(ctx, agent)).toContain('mcp__openmontage__submit_video_job')
    expect(schemaNames(ctx, agent)).not.toContain('mcp__openmontage__prepare_reference_clone')
    expect(schemaNames(ctx, agent)).not.toContain('mcp__openmontage__list_video_artifacts')
    expect(schemaNames(ctx, agent)).not.toContain('mcp__tools-platform__search')

    await execute(ctx, agent, 'mcp__openmontage__submit_video_job', { workflow: 'animation' })

    expect(schemaNames(ctx, agent)).toContain('mcp__openmontage__prepare_reference_clone')
    expect(schemaNames(ctx, agent)).toContain('mcp__openmontage__list_video_artifacts')
    expect(schemaNames(ctx, agent)).toContain('mcp__tools-platform__search')
  })
})

describe('stalled outcome circuit breaker', () => {
  test('equivalent errors open one tool circuit even when arguments change', async () => {
    const ctx = await harness({ stalledOutcomeThreshold: 3 })
    const agent = await createAgent(ctx, 'failures')
    let calls = 0
    registerTextTool(ctx, 'mcp__openmontage__list_video_artifacts', async () => {
      calls += 1
      throw new Error('OpenMontage Job was not found')
    })

    let thresholdResult
    for (const jobId of ['check', 'check2', 'check3']) {
      thresholdResult = await execute(ctx, agent, 'mcp__openmontage__list_video_artifacts', { job_id: jobId })
    }
    const blocked = await execute(ctx, agent, 'mcp__openmontage__list_video_artifacts', { job_id: 'check4' })

    expect(calls).toBe(3)
    expect(thresholdResult.additionalContexts).toEqual([
      expect.objectContaining({
        source: expect.objectContaining({ kind: 'plugin', plugin: 'openmontage-guidance' }),
        content: [expect.objectContaining({ text: expect.stringContaining('did not advance the workflow') })],
      }),
    ])
    expect(blocked.isError).toBe(true)
    expect(blocked.content).toEqual([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('stalled-outcome circuit is open') }),
    ])
  })

  test('unchanged project listings open a circuit but status polling does not', async () => {
    const ctx = await harness({ stalledOutcomeThreshold: 3 })
    const agent = await createAgent(ctx, 'unchanged')
    let listCalls = 0
    let pollCalls = 0
    registerTextTool(ctx, 'mcp__openmontage__list_project_files', async () => {
      listCalls += 1
      return '{"files":[{"path":"analysis.json"}]}'
    })
    registerTextTool(ctx, 'mcp__openmontage__reference_clone_status', async () => {
      pollCalls += 1
      return '{"status":"processing"}'
    })

    for (let index = 0; index < 4; index += 1) {
      await execute(ctx, agent, 'mcp__openmontage__list_project_files', { project_id: 'clone-1' })
      await execute(ctx, agent, 'mcp__openmontage__reference_clone_status', { project_id: 'clone-1' })
    }

    expect(listCalls).toBe(3)
    expect(pollCalls).toBe(4)
  })

  test('circuits stay agent-local and a user message resets them', async () => {
    const ctx = await harness({ stalledOutcomeThreshold: 2 })
    const first = await createAgent(ctx, 'first')
    const second = await createAgent(ctx, 'second')
    let calls = 0
    registerTextTool(ctx, 'mcp__openmontage__list_video_artifacts', async () => {
      calls += 1
      throw new Error('OpenMontage Job was not found')
    })

    await execute(ctx, first, 'mcp__openmontage__list_video_artifacts', { job_id: 'one' })
    await execute(ctx, first, 'mcp__openmontage__list_video_artifacts', { job_id: 'two' })
    await execute(ctx, first, 'mcp__openmontage__list_video_artifacts', { job_id: 'blocked' })
    await execute(ctx, second, 'mcp__openmontage__list_video_artifacts', { job_id: 'other-agent' })
    expect(calls).toBe(3)

    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('reset')]))
    const idle = new Promise(resolve => {
      const dispose = ctx.on('agent/status', ({ agent, status }) => {
        if (agent === first && status === 'idle') {
          dispose()
          resolve()
        }
      })
    })
    first.followup(createUserMessage({
      content: [{ type: 'text', text: 'continue' }],
      source: { kind: 'user' },
    }))
    await idle
    await execute(ctx, first, 'mcp__openmontage__list_video_artifacts', { job_id: 'after-reset' })

    expect(calls).toBe(4)
  })

  test('rejects a threshold that cannot establish repetition', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    let failure
    try {
      await ctx.plugin(OpenMontage, { stalledOutcomeThreshold: 1 })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect(failure.message).toMatch(/integer >= 2/)
  })
})
