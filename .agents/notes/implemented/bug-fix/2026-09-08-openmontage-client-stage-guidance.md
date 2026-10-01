# Agent Note: OpenMontage client workflow guidance and loop control

Status: implemented

English | [中文](2026-09-08-openmontage-client-stage-guidance.zh.md)

## Problem

The OpenMontage plugin explained how to submit and monitor a video Job but omitted the client-stage lifecycle required to execute selector and composition tools. A model could call `invoke_openmontage_tool` with only the logical tool operation and inputs, so the server received no Job or stage lease context and returned a generic MCP execution failure. A model could also confuse the Gateway lifecycle `operation="generate"` with `video_compose`'s required operation and omit `inputs.operation="render"`; the executor then failed before rendering and the Gateway returned only a generic failure. A separate reference-clone run exposed hundreds of native tools without the complete guidance in the Desktop composition. After project preparation, the model repeatedly stated that it needed `read_project_file` but emitted project-list or pre-Job artifact calls instead. Exact argument-based reminders did not stop calls whose invalid `job_id` changed.

## Decision

The plugin prompt states the complete `submit_video_job` -> `begin_client_stage` -> zero or more stage-allowed `invoke_openmontage_tool` calls -> `submit_client_stage` sequence, including the no-invocation case for stages with an empty tool list. It maps the begin response's `jobId`, `stage`, `stageAttempt`, and `leaseToken` fields to the later tools' `job_id`, `stage`, `stage_attempt`, and `lease_token` arguments, and requires a stable non-empty `idempotency_key`. The prompt distinguishes the outer Gateway lifecycle operation from the logical tool operation and requires `video_compose` calls to carry the selected operation inside `inputs`. The begin response's `stageContract` is authoritative for the attempt: the model reads every `instructionFiles` entry, maps each result to a `{path, content_hash}` entry in the instruction record that `submit_client_stage`'s schema names, passes only exact `gatewayTools` names to the invocation tool, treats `declaredTools` as manifest vocabulary, and keys submitted artifacts by `produces`.

The same Host plugin owns Agent-local workflow control. A successful reference preparation, or a reference status result equal to `prepared`, restricts that Agent's global MCP view to reference inspection, export, and job submission tools while preserving local tools. A successful job submission or a new user message lifts the restriction. The plugin also keys stalled outcomes by Agent, tool, and normalized result content. Three equivalent failures, or three unchanged successful project listings, open a circuit that denies later attempts before remote execution. Reference and Job status tools are exempt from this circuit because unchanged polling can be legitimate. The MCP bundle fixes its URL at the public gateway and resolves `MODELS_API_KEY` through the DSH credential service rather than reading process environment directly.

## Alternatives considered

**Rely only on OpenMontage tool descriptions.** Rejected because the host prompt determines tool sequencing before individual calls, and the missing lifecycle guidance had already produced context-free selector calls.

**Allow selector calls without a Job.** Rejected because Job attribution, stage authorization, lease fencing, idempotency, artifacts, and cost auditability depend on the existing client-stage lifecycle.

**Rewrite provider-emitted tool names from reasoning text.** Rejected because reasoning prose is not a typed intent channel, and changing a streamed provider call would make the persisted audit trail differ from the provider output. Tool projection prevents invalid alternatives without inventing model intent.

**Make the general repeat reminder blocking.** Rejected because unchanged calls and status polling can be valid in other domains. The blocking policy stays in the OpenMontage plugin, uses result content rather than arguments, and explicitly exempts polling tools.

## Consequences

Models receive both an explicit lifecycle and a server-derived per-stage execution contract before choosing OpenMontage tools, while the server remains authoritative for lease validation. Reference inspection presents fewer MCP alternatives, and repeated equivalent failures stop consuming remote calls even when arguments vary. The prompt and Agent-local policy add state and tests to the plugin, but other tools, Agents, and deployments that do not mount the plugin retain their behavior.

## Verification

The root Vitest gate runs the plugin test and checks the ordered lifecycle, camel-case response to snake-case argument mapping, nested `video_compose` operation, exact instruction-record entry construction, the distinction between manifest `declaredTools` and callable `gatewayTools`, the prohibited context-free argument set, and the absence of internal deployment addresses. The same test uses the real tool registry and Agent scope to check prepared-stage projection, job-submission restoration, changed-argument failure detection, unchanged project listings, polling exemptions, per-Agent isolation, user-message reset, pre-dispatch denial, and corrective model context. The keyless recorded-session owner follows the current Session v2 writer instead of claiming historical migration coverage.
