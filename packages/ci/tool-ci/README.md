---
description: "The model-facing CI quality-gate tool: run named CI gate commands through the shell seam and return one structured verdict."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-ci

English | [中文](README.zh.md)

## Summary

The model-facing `ci_run` quality-gate tool over the [shell capability seam](../../shell/shell/README.md) (`ctx.shell`). It runs one or more gate commands in sequence in a target directory and returns one structured verdict: an overall result plus a per-gate record with exit code, signal, timeout/abort facts, duration, and a bounded output tail. A failed gate stops the sequence by default. Every gate runs through `ctx.shell`, so sandboxing, timeouts, and cancellation stay the shell executor responsibility; the package owns only model-facing concerns.

## Table of Contents

- [Tool](#tool)
- [Config](#config)
- [Stable registration](#stable-registration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Tool

| Tool | Args | Behavior |
|---|---|---|
| `ci_run` | `cwd` (string, required); `gates` (string[], required); `stopOnFailure` (boolean, optional) | Runs the gate commands in order in `cwd`, captures a bounded output tail per gate, and returns a structured `{ cwd, overall, gates[] }` value. `overall` is `passed`, `failed`, or `aborted`. |

The `gates` array accepts shell command strings (for example `pnpm lint`) rather than raw script names, so the model controls the exact invocation while the tool supplies the structured verdicts and the stopping policy.

## Config

| Key | Default | Meaning |
|---|---|---|
| `timeoutMs` | `120000` | Per-gate cooperative timeout budget (ms), attached as `ToolDefinition.timeoutMs`. |
| `maxOutputChars` | `20000` | Cap on characters of each gate captured stdout/stderr kept in the canonical value. |
| `stopOnFailure` | `true` | Default for `stopOnFailure` when the model omits it. |

```yaml
- id: tool-ci
  name: @deepseek-ai/dsh-tool-ci
```

## Stable registration

Tool registration follows enablement, not backend availability: a gate that fails to run is reported as a failed gate in the structured value rather than thrown as an infrastructure error, so the model schema stays stable across provider and executor changes. No invariant companion is published because `ci_run` owns no state: each call resolves its gates through the shell capability seam, and the structured value is the call's only projection.

## Model Experience

### CI quality-gate verdicts

#### What the model sees

One `ci_run` call returns a single structured verdict: the overall result plus one record per gate with status, reason, duration, and a bounded output tail. The prompt section tells the model to prefer it for multi-gate CI checks.

#### Token effect

Each gate contributes its bounded output tail to the canonical value; `maxOutputChars` caps what enters model context. Skipped gates after a failure contribute nothing.

#### KV Cache effect

The tool adds no persistent session state; the result value enters the transcript like any tool result and follows the session's normal cache rules.

## Known Limitations and Deferred Work

- `ctx.shell` must be mounted (the bash/pwsh executors supply it); a composition without it cannot load the tool.
- The tool does not manage long-running background gate batches; each `ci_run` call is a bounded foreground sequence.
- `maxOutputChars` caps the canonical value, not the executor own capture; a full stream is still recoverable through the underlying `CollectedOutput` spill path when truncation occurs.

### Dev Note

Deferred: background gate batches and a configurable output spill view stay off the roadmap until a deployment asks for them; the shell executor owns any deeper capture policy.
