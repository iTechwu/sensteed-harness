# dsh-agent-run

[English](README.md) | 中文

一个 DeepSeek Harness (DSH) **bundle**，交付无头 agent-exec 可执行文件
`dsh-agent-run`——OpenMontage 以它作为管线阶段执行器拉起，**取代 `codex exec`**。
它使用 DeepSeek Harness 自己的 LLM + `bash` 工具精确执行一个 OpenMontage 管线阶段，
并写入该阶段的 checkpoint，让 OpenMontage worker 看到阶段完成。没有 Codex、没有
Claude、没有 Web UI。

## 它做什么

OpenMontage 的 `AgentCommandPipelineExecutor.execute()` 运行来自
`OPENMONTAGE_AGENT_EXECUTOR_JSON` 的 agent argv，把阶段 prompt 喂给 stdin，并把
LLM 网关路由注入进程环境。`dsh-agent-run`：

1. 读取 stdin——**第一行**是 `StageAssignment.to_wire()` 文件路径
   （`OPENMONTAGE_ASSIGNMENT_PATH="<path>"`），其余是阶段 prompt。
2. 解析 assignment → `projectDir`、`projectsDir`、`projectId`、`stage`、
   `pipeline`、`stageAttempt`。
3. 经 `@deepseek-ai/dsh-app-boot` 无头启动 agent 骨架（本 bundle 的
   `cordis.yml`），**纯粹从环境变量**把 DeepSeek adapter 指向 OpenMontage 网关
   （`OPENAI_BASE_URL`/`OPENAI_API_KEY`/`DOFE_MODEL_BASE_URL`/`DOFE_MODEL_API_KEY`）
   ——没有硬编码模型。
4. 用阶段 prompt 驱动**一次** agent 轮次；agent 通过 `bash` 工具在仓库根目录运行
   OpenMontage 的细粒度 Python 工具来完成阶段工作。
5. 经 OpenMontage 自己的 `lib.checkpoint.write_checkpoint`（OpenMontage 使用的同一
   Python 入口）写入 checkpoint，带正确的 `project_id` / `pipeline_type` / `stage`
   身份与终态（`completed` | `awaiting_human` | `failed`）。

同时会指示 agent 落盘 `{projectDir}/.openmontage/agent-run/result.json`
（`{"status": ..., "artifacts": {...}}`）；bin 再以它为权威阶段结果重写 checkpoint。
如果 agent 既没留 `result.json` 也没留终态 checkpoint，bin 写入 `failed` checkpoint，
保证 worker 总能看到结果。

## 精确的 `OPENMONTAGE_AGENT_EXECUTOR_JSON` argv

把 `OPENMONTAGE_AGENT_EXECUTOR_JSON` 设为一个 JSON 数组，其元素就是本 bin。
`{project_dir}` 占位符（如果你的命令用到）由执行器替换为项目目录，但本 bin 不需要
它——它从 assignment 文件读项目目录。

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

bin 是单文件 ESM，所以 `["node", "<abs>/bin/agent-run.js"]` 是最可移植、与部署无关的
形态。在把 bundle 的 bin 安装进镜像 PATH 的容器里，`["dsh-agent-run"]` 即可。

## bin 如何被调用

- **argv：** `OPENMONTAGE_AGENT_EXECUTOR_JSON` 数组（本 bin）。
- **stdin：** `_stage_prompt`——第一行 `OPENMONTAGE_ASSIGNMENT_PATH="<path>"`，
  其余为 agent prompt。
- **env：** worker 设置的 `OPENAI_API_KEY`、`OPENAI_BASE_URL`（如 `<gateway>/v1`）、
  `DOFE_MODEL_BASE_URL`、`DOFE_MODEL_API_KEY`。
- **cwd：** OpenMontage checkout（`AgentCommandPipelineExecutor` 以 `cwd=ROOT`
  拉起），因此 `python -c 'from lib.checkpoint import ...'` 可解析。

## 机制：运行一次 agent 任务并写入 checkpoint

bin（`bin/agent-run.js`）按顺序执行：

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

checkpoint 经 OpenMontage 自己的 Python 写入：

```python
from lib.checkpoint import write_checkpoint
write_checkpoint(Path(projectsDir), projectId, stage, status,
                 artifacts, pipeline_type=pipeline, ...)
```

（bin 经子进程 stdin 上的 JSON payload 传键/身份，格式完全一致——schema 校验、
门禁强制、历史归档。）

## 它启动的 cordis.yml

`cordis.yml` 无头组合 agent 骨架：

| Row | Plugin | 用途 |
|---|---|---|
| `llm-deepseek` | `@deepseek-ai/dsh-llm-deepseek` | OpenAI 兼容 adapter；`baseURL`/`apiKeyEnv` 读 `DEEPSEEK_*`（由网关环境归一化） |
| `subprocess` | `@deepseek-ai/dsh-subprocess-local` | bash 执行器的子进程组 |
| `bash` | `@deepseek-ai/dsh-bash-local` | 具体 bash 执行器（`cwd = process.cwd()` = OpenMontage ROOT） |
| `agent-spine` | `@deepseek-ai/dsh-agent-spine-demo` | Timer、LLM 运行时、会话存储、system prompt、工具运行时、agent registry、skills、bash 工具、agent loop |

不挂载 `settings` 或 `credentials` 插件：若存在 `dsh-credentials-local`，DeepSeek
adapter 的 `resolveApiKey` 会查存储而永不回退进程环境
（`packages/llm/llm-deepseek/src/index.ts:411-432`）。网关密钥经环境到达，
因此我们有意让环境解析胜出。

## agent prompt 小节

persona（system prompt）指示 agent 如何解析 assignment、读取 `AGENT_GUIDE.md` /
`skills/meta/checkpoint-protocol.md` / 管线 manifest、留在 `projectDir` 内、经
`python -c "...registry... .execute({...})"` 运行 OpenMontage 工具，并写出结果
manifest 与终态。人工门禁阶段必须写 `awaiting_human`（门禁由 `write_checkpoint`
强制——未经审批写 `completed` 会抛 `GATE VIOLATION`）。

## 安装 / 构建

这是**独立 bin bundle**，不是 agent-preset patch：它不向宿主 profile 贡献
system-prompt 小节或工具（其 `index.js` 的 `apply` 是空操作）。bin 导入 harness 包
（`@deepseek-ai/dsh-app-boot`、`@deepseek-ai/dsh-agent-spine-demo`、
`@deepseek-ai/dsh-bash-local`、`@deepseek-ai/dsh-subprocess-local`、
`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-llm-deepseek`）
并在运行时从 **harness 根 `node_modules`** 解析——与部署加载纯 JS 插件的方式相同。
`plugins/*` **不是** `pnpm` workspace 成员（`pnpm-workspace.yaml` 列出 `vendor`、
`packages/*/*`、`apps/*`、`examples` 等），所以**不要**在 `plugins/dsh-agent-run`
里跑 `pnpm install`。只需确保 harness monorepo 已安装、这些包已链接：

```sh
cd deepseek-harness
pnpm install                       # links @deepseek-ai/* into the root node_modules
# (no build of this plugin needed — it ships prebuilt .js + cordis.yml)
```

在已部署的 harness 镜像中这些包已存在；把执行器 argv 指向插件的
`bin/agent-run.js` 即可。

## 环境变量

| Env | 含义 | 默认 |
|---|---|---|
| `OPENAI_API_KEY` / `DOFE_MODEL_API_KEY` | 网关 API key（由 worker / `OPENMONTAGE_AGENT_EXECUTOR_JSON` 设置） | 必填 |
| `OPENAI_BASE_URL` / `DOFE_MODEL_BASE_URL` | 网关基址（归一化为 `<gateway>/v1`） | 必填 |
| `OPENMONTAGE_AGENT_MODEL_ID` | agent 使用的模型 id | `deepseek-v4-flash` |
| `OPENMONTAGE_AGENT_TIMEOUT_SECONDS` | agent 轮次等待上限 | `7200` |
| `OPENMONTAGE_AGENT_BASH_TIMEOUT_MS` | 单条 bash 命令超时 | `60000` |
| `OPENMONTAGE_PYTHON` | 装有 OpenMontage 的解释器 | 先 `.venv` 再 `python3` |
| `DSH_AGENT_RUN_MAX_TOKENS` / `DSH_AGENT_RUN_THINKING` / `DSH_AGENT_RUN_REASONING_EFFORT` | LLM 请求上限 | `16000` / `disabled` / `low` |

## 文件

- `package.json` — bundle 清单 + `bin: { "dsh-agent-run": "bin/agent-run.js" }`
- `bin/agent-run.js` — 可执行文件
- `cordis.yml` — bin 启动的无头骨架组合
- `index.js` — 空操作 bundle 入口（本插件是独立 bin，不是 profile patch）
