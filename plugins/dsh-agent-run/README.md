# dsh-agent-run

English | [中文](README.zh.md)

A DeepSeek Harness (DSH) **bundle** that ships a headless agent-exec executable —
`dsh-agent-run` — which OpenMontage spawns as its pipeline-stage executor,
**replacing `codex exec`**. It uses DeepSeek Harness's own LLM + `bash` tool to
execute exactly one OpenMontage pipeline stage and write that stage's checkpoint,
so the OpenMontage worker sees the stage finished. No Codex, no Claude, no web UI.

## What it does

OpenMontage's `AgentCommandPipelineExecutor.execute()` runs the agent argv from
`OPENMONTAGE_AGENT_EXECUTOR_JSON`, feeds the stage prompt on stdin, and injects
the LLM gateway route on the process env. `dsh-agent-run`:

1. Reads stdin — the **first line** is the `StageAssignment.to_wire()` file path
   (`OPENMONTAGE_ASSIGNMENT_PATH="<path>"`), the rest is the stage prompt.
2. Parses the assignment → `projectDir`, `projectsDir`, `projectId`, `stage`,
   `pipeline`, `stageAttempt`.
3. Boots the agent spine (this bundle's `cordis.yml`) headlessly via
   `@deepseek-ai/dsh-app-boot`, pointing the DeepSeek adapter at the OpenMontage
   gateway **purely from the env** (`OPENAI_BASE_URL`/`OPENAI_API_KEY`/
   `DOFE_MODEL_BASE_URL`/`DOFE_MODEL_API_KEY`) — no hardcoded model.
4. Drives **one** agent turn with the stage prompt; the agent does the stage work
   through the `bash` tool by running OpenMontage's granular Python tools from the
   repo root.
5. Writes the checkpoint through OpenMontage's own `lib.checkpoint.write_checkpoint`
   (the same Python entry point OpenMontage uses), with the correct
   `project_id` / `pipeline_type` / `stage` identity and a terminal status
   (`completed` | `awaiting_human` | `failed`).

The agent is also instructed to drop `{projectDir}/.openmontage/agent-run/result.json`
(`{"status": ..., "artifacts": {...}}`); the bin then re-writes the checkpoint from
it as the authoritative stage outcome. If the agent leaves neither a `result.json`
nor a terminal checkpoint, the bin writes a `failed` checkpoint so the worker
always sees an outcome.

## The exact `OPENMONTAGE_AGENT_EXECUTOR_JSON` argv

Set `OPENMONTAGE_AGENT_EXECUTOR_JSON` to a JSON array whose element is this bin.
The `{project_dir}` placeholder (if your command uses it) is substituted by the
executor with the project dir, but the bin does not need it — it reads the project
dir from the assignment file instead.

```jsonc
// Deployed form (bin on PATH):
["dsh-agent-run"]
// Or with a timeout:
["dsh-agent-run"]   // timeout is OPENMONTAGE_AGENT_TIMEOUT_SECONDS, not argv

// Checkout form (absolute node + file):
["node", "/Users/techwu/Documents/codes/dofe.ai/deepseek-harness/plugins/dsh-agent-run/bin/agent-run.js"]

// You may instead alias it as the `dsh agent run` spelling via a shell wrapper:
//   dsh-agent-run  =  dsh plugin bin agent-run   (or a `dsh` wrapper that exec's this bin)
```

The bin is a single ESM file, so `["node", "<abs>/bin/agent-run.js"]` is the most
portable, deployment-independent form. In a container that installs the bundle's
bin into the image PATH, `["dsh-agent-run"]` works.

## How the bin is invoked

- **argv:** the `OPENMONTAGE_AGENT_EXECUTOR_JSON` array (this bin).
- **stdin:** `_stage_prompt` — first line `OPENMONTAGE_ASSIGNMENT_PATH="<path>"`,
  remainder = agent prompt.
- **env:** `OPENAI_API_KEY`, `OPENAI_BASE_URL` (e.g. `<gateway>/v1`),
  `DOFE_MODEL_BASE_URL`, `DOFE_MODEL_API_KEY` set by the worker.
- **cwd:** the OpenMontage checkout (`AgentCommandPipelineExecutor` spawns with
  `cwd=ROOT`), so `python -c 'from lib.checkpoint import ...'` resolves.

## Mechanism: run one agent task + write the checkpoint

The bin (`bin/agent-run.js`) does, in order:

```
read stdin → parse OPENMONTAGE_ASSIGNMENT_PATH line → JSON.parse(assignment)
normalizeGatewayEnv()                 # OPENAI_*/DOFE_MODEL_* -> DEEPSEEK_*
resolvePython(cwd)                    # OPENMONTAGE_PYTHON || .venv || python3
ensureCheckpointImportable(cwd, py)   # from lib.checkpoint import write_checkpoint
write in_progress checkpoint          # liveness heartbeat (best effort)
ctx = await boot(NAME, cordis.yml)    # headless spine
agent = ctx.agentLoop.create(SessionId(...), { provider:'deepseek-official', model })
agent.followup(createUserMessage({ text: prompt }))
await agent.whenIdle()                # canonical wait (dsh-agent-loop tests use this)
  # agent is free to run bash: python -c "from tools tool_registry ... .execute({...})"
# agent/error + turn/end reason are captured and logged to stderr (the loop
# swallows turn failures -> idle, so without this the real error stays hidden)
# resolve status/artifacts from result.json || terminal checkpoint
write_checkpoint(projectsDir, projectId, stage, status, artifacts, pipeline_type=...)
dispose ctx
exit 0 (completed/awaiting_human) | exit 2 (failed)
```

The checkpoint is written through OpenMontage's own Python:

```python
from lib.checkpoint import write_checkpoint
write_checkpoint(Path(projectsDir), projectId, stage, status,
                 artifacts, pipeline_type=pipeline, ...)
```

(the bin passes the key/identity via a JSON payload on the subprocess's stdin, so
the format matches exactly — schema-validated, gates enforced, history archived).

## The cordis.yml it boots

`cordis.yml` composes the agent spine headlessly:

| Row | Plugin | Purpose |
|---|---|---|
| `llm-deepseek` | `@deepseek-ai/dsh-llm-deepseek` | OpenAI-compatible adapter; `baseURL`/`apiKeyEnv` read from `DEEPSEEK_*` (normalized from the gateway env) |
| `subprocess` | `@deepseek-ai/dsh-subprocess-local` | child-process groups for the bash executor |
| `bash` | `@deepseek-ai/dsh-bash-local` | the concrete bash executor (`cwd = process.cwd()` = OpenMontage ROOT) |
| `agent-spine` | `@deepseek-ai/dsh-agent-spine-demo` | Timer, LLM runtime, session store, system prompt, tool runtime, agent registry, skills, bash tool, agent loop |

No `settings` or `credentials` plugin is mounted: if `dsh-credentials-local` were
present, the DeepSeek adapter's `resolveApiKey` would consult the store and never
fall back to the process env
(`packages/llm/llm-deepseek/src/index.ts:411-432`). The gateway key arrives on the
env, so we deliberately let env resolution win.

## The agent prompt section

The persona (system prompt) tells the agent how to parse the assignment, read
`AGENT_GUIDE.md` / `skills/meta/checkpoint-protocol.md` / the pipeline manifest,
stay inside `projectDir`, run OpenMontage tools via `python -c "...registry... .execute({...})"`,
and write the result manifest + terminal status. Human-gated stages must be written
`awaiting_human` (gates are enforced by `write_checkpoint` — writing `completed`
without approval raises `GATE VIOLATION`).

## Install / build

This is a **standalone bin bundle**, not an agent-preset patch: it contributes no
system-prompt section or tools to a hosting profile (its `index.js` `apply` is a
no-op). The bin imports harness packages
(`@deepseek-ai/dsh-app-boot`, `@deepseek-ai/dsh-agent-spine-demo`,
`@deepseek-ai/dsh-bash-local`, `@deepseek-ai/dsh-subprocess-local`,
`@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-llm-deepseek`)
and resolves them from the **harness root `node_modules`** at runtime — the same
way the deployment loads the plain-JS plugins. `plugins/*` is **not** a `pnpm`
workspace member (`pnpm-workspace.yaml` lists `vendor`, `packages/*/*`, `apps/*`,
`examples`, etc.), so do **not** run `pnpm install` inside
`plugins/dsh-agent-run`. Just ensure the harness monorepo is installed so those
packages are linked:

```sh
cd deepseek-harness
pnpm install                       # links @deepseek-ai/* into the root node_modules
# (no build of this plugin needed — it ships prebuilt .js + cordis.yml)
```

In a deployed harness image those packages are already present; point the
executor's argv at the plugin's `bin/agent-run.js`.

## Environment variables

| Env | Meaning | Default |
|---|---|---|
| `OPENAI_API_KEY` / `DOFE_MODEL_API_KEY` | gateway API key (set by the worker / `OPENMONTAGE_AGENT_EXECUTOR_JSON`) | required |
| `OPENAI_BASE_URL` / `DOFE_MODEL_BASE_URL` | gateway base (normalized to `<gateway>/v1`) | required |
| `OPENMONTAGE_AGENT_MODEL_ID` | model id the agent uses | `deepseek-v4-flash` |
| `OPENMONTAGE_AGENT_TIMEOUT_SECONDS` | agent-turn wait cap | `7200` |
| `OPENMONTAGE_AGENT_BASH_TIMEOUT_MS` | per-bash-command timeout | `60000` |
| `OPENMONTAGE_PYTHON` | interpreter that has OpenMontage installed | `.venv` then `python3` |
| `DSH_AGENT_RUN_MAX_TOKENS` / `DSH_AGENT_RUN_THINKING` / `DSH_AGENT_RUN_REASONING_EFFORT` | LLM request caps | `16000` / `disabled` / `low` |

## Files

- `package.json` — bundle manifest + `bin: { "dsh-agent-run": "bin/agent-run.js" }`
- `bin/agent-run.js` — the executable
- `cordis.yml` — the headless spine composition the bin boots
- `index.js` — no-op bundle entry (the plugin is a standalone bin, not a profile patch)
