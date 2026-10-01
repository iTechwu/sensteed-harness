# dsh-openmontage-mcp

English | [中文](README.zh.md)

A DeepSeek Harness (DSH) **bundle** that registers the OpenMontage MCP server as
an additional MCP client in the `web` profile, and adds a system-prompt section
telling the model when to use it.

## What it exposes

- OpenMontage's MCP tools appear as native tools with the DSH server-qualified
  namespace `mcp__openmontage__<tool>` (e.g. `mcp__openmontage__submit_video_job`).
- A prompt section (`openmontage:guidance`) instructs the model to call
  `mcp__openmontage__openmontage_capabilities` → `prepare_reference_clone` →
  `submit_video_job` for scripted, multi-shot, edited, or clone-recreate tasks.
  A 5–10 second continuous single-shot clip belongs to the Media MCP instead.
- An Agent-local workflow guard narrows the MCP catalog while a prepared
  reference is being inspected and stops repeated equivalent failures before
  another remote call runs.

`prepare_reference_clone` is a synchronous, long-running operation because it
may download a source video and run ffmpeg/transcription analysis. The bundle
allows up to 10 minutes for this call. If a client reports a timeout, keep the
returned `project_id` and call `mcp__openmontage__reference_clone_status` before
retrying; completed projects are reused on retry. Once the status is
`prepared`, call `list_project_files`. For JSON/Markdown analysis files, use
`read_project_file` so a remote client receives the text over the authenticated
MCP channel; do not pass the CI-only `/exchange/openmontage/<project_id>` path
to a local `Read` tool. Use `sync_project_exports` or `export_project_file` only
when a shared mount or media delivery is needed.

While a reference project is `prepared`, local tools remain available but the
MCP catalog contains only OpenMontage capabilities, reference status, project
listing and reading, project export, and job submission tools. In particular,
another `prepare_reference_clone` and pre-Job `list_video_artifacts` call are
not available. A successful `submit_video_job` or a new user message restores
the complete catalog.

## Loop protection

The Host plugin opens an Agent-local circuit after three equivalent stalled
outcomes by default. It recognizes failures by their normalized result content,
so changing an invalid `job_id` does not evade detection. It also treats an
unchanged successful `list_project_files` result as stalled. The threshold
result remains in the audit log and adds corrective model context; later calls
to that tool are denied before the remote body runs.

`reference_clone_status`, `get_video_job`, and `list_video_job_events` are
exempt because unchanged status results are legitimate polling. A successful
changed outcome resets that tool's count. A new user message resets every
circuit for its Agent, and one Agent never changes another Agent's state.

Set `stalledOutcomeThreshold` on the Host plugin row to an integer greater than
or equal to two when a deployment needs a different limit. Invalid values fail
when the plugin loads.

After `submit_video_job`, drive each client-owned stage with
`begin_client_stage` -> zero or more stage-allowed `invoke_openmontage_tool`
calls -> `submit_client_stage`. Do not invent an invocation when the stage's
tool list is empty. `begin_client_stage` returns `jobId`, `stage`,
`stageAttempt`, `leaseToken`, and `stageContract`; map the lease fields to the
top-level `job_id`, `stage`, `stage_attempt`, and `lease_token` arguments. Every
non-catalog invocation also requires a non-empty stable `idempotency_key`.
Selector, preflight, ranking, generation, progress, and composition calls are
not standalone provider APIs.
The outer `operation: "generate"` selects the Gateway lifecycle and does not
replace a logical tool's own operation. For `video_compose`, pass the selected
tool operation inside `inputs`, such as outer `operation: "generate"` together
with `inputs.operation: "render"`; use the live input schema for other allowed
values.
Treat `stageContract` as authoritative for that attempt: read every
`instructionFiles` entry through `read_openmontage_file`, and map each returned
result into the instruction-record argument named by `submit_client_stage`'s
schema as
`{"path": result.relative_path, "content_hash": result.content_hash}`.
`declaredTools` contains raw pipeline-manifest vocabulary; pass only exact names
from `gatewayTools` to `invoke_openmontage_tool`. Key submitted `artifacts` by
`produces`. For example,
`{"research_brief": {<brief fields>}}`, rather than receiving the brief fields
directly at the `artifacts` level.

## Credential

| Credential name | Meaning | Default |
|---|---|---|
| `MODELS_API_KEY` | Single Models API key resolved by the DSH credential service and sent to the gateway | *(required)* |

The MCP endpoint is fixed at `https://ai.hozonauto.com/mcp/montage`; users do not
configure a CI-only base URL.

The MCP client requires `MODELS_API_KEY` before connecting, and the gateway validates it on every request. DSH configures no OpenMontage service token or job attribution.

`failOnStartupError` is `false`: if OpenMontage is briefly unreachable the web
profile still boots and the reconnect supervisor registers the tools once the
server is back.

## Install

Shipped through the deployment's plugin mount and `DSH_PLUGIN_SPECS`:

```sh
# in docker-helm.dofe.ai .env
DEEPSEEK_HARNESS_PLUGIN_SOURCE_DIR=../deepseek-harness/plugins
DSH_PLUGIN_SPECS=/opt/dsh-plugins/dsh-openmontage-mcp
```

Or, from a checkout:

```sh
dsh plugin --profile web add ./dsh-openmontage-mcp
```
