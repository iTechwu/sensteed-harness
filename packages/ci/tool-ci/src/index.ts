/**
 * Model-facing `ci_run` tool over the shell capability seam (`ctx.shell`).
 *
 * This package owns model-facing concerns only: the `ci_run` tool schema, its
 * prompt section, per-gate command validation, bounded output projection, and
 * the terminal presentation card. It never owns provider selection or network
 * access; every gate runs through `ctx.shell` so sandboxing, timeouts, and
 * cancellation stay the shell executor's responsibility.
 *
 * `ci_run` runs one or more CI quality-gate commands in sequence in a target
 * directory (for example `pnpm lint`, `pnpm typecheck`, `pnpm test`,
 * `pnpm build`) and returns one structured result value: an overall verdict
 * and a per-gate record capturing exit code, terminating signal, timeout and
 * abort facts, duration, and the bounded output tail. A failed gate stops the
 * sequence by default (`stopOnFailure: true`) so the model sees the first
 * failing gate rather than a cascade of unrelated failures.
 *
 * The canonical value is the programmatic API; the Native renderer folds it
 * into prose for the model. The gate timeout is deployment config
 * (`timeoutMs`), never a hardcoded tunable, and the model-facing schema exposes
 * no timeout argument.
 * @module @deepseek-ai/dsh-tool-ci
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { TerminalCallView, TerminalResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import type { ShellRunResult } from '@deepseek-ai/dsh-shell'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-ci'

/** Services required by the CI tool suite. */
export const inject = ['tools', 'shell', 'systemPrompt']

/** Default per-gate cooperative tool-call timeout budget (ms). */
export const DEFAULT_GATE_TIMEOUT_MS = 120_000

/** Default cap on characters of each gate's captured stdout/stderr kept in the canonical value. */
export const DEFAULT_GATE_MAX_OUTPUT_CHARS = 20_000

/** Whether `stopOnFailure` defaults to true when the model omits it. */
export const DEFAULT_STOP_ON_FAILURE = true

/** Plugin config: the gate timeout budget, the output cap, and the default stop-on-failure mode. */
export interface Config {
  /** Per-gate timeout budget (ms). Defaults to `DEFAULT_GATE_TIMEOUT_MS`. */
  timeoutMs?: number
  /** Cap on captured stdout/stderr characters per gate. Defaults to `DEFAULT_GATE_MAX_OUTPUT_CHARS`. */
  maxOutputChars?: number
  /** Default for `stopOnFailure` when the model omits it. Defaults to true. */
  stopOnFailure?: boolean
}

export const Config: z<Config> = z.object({
  timeoutMs: z.number().min(1).default(DEFAULT_GATE_TIMEOUT_MS),
  maxOutputChars: z.number().min(1).default(DEFAULT_GATE_MAX_OUTPUT_CHARS),
  stopOnFailure: z.boolean().default(DEFAULT_STOP_ON_FAILURE),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/** `ci_run` argument names carry the model-facing array positions after validation. */
export interface CiRunArgs {
  /** Directory the gates run in. */
  cwd: string
  /** CI gate commands to run in order, for example `["pnpm lint", "pnpm typecheck"]`. */
  gates: string[]
  /** Stop the sequence at the first failing gate. Defaults to `stopOnFailure` config. */
  stopOnFailure?: boolean
}

/** `ci_run` arguments after validation and default application. */
export interface ResolvedCiRunArgs {
  /** Directory the gates run in. */
  cwd: string
  /** CI gate commands to run in order. */
  gates: string[]
  /** Whether to stop at the first failing gate. */
  stopOnFailure: boolean
  /** Per-gate timeout budget (ms). */
  timeoutMs: number
}

/** Per-gate outcome recorded in the canonical value. */
export interface CiGateResult {
  /** The gate command as run. */
  command: string
  /** `passed`, `failed`, or `skipped` (not run because a prior gate failed). */
  status: 'passed' | 'failed' | 'skipped'
  /** Process exit code; null when the process died from a signal or failed to spawn. */
  exitCode: number | null
  /** Terminating signal (for example `SIGTERM`); null on normal exit. */
  signal: string | null
  /** True when the executor's own timeout cut the command short. */
  timedOut: boolean
  /** True when the caller's abort signal cut the command short. */
  aborted: boolean
  /** Wall-clock duration of the gate run (ms). */
  durationMs: number
  /** Bounded stdout tail. */
  stdout: string
  /** Bounded stderr tail. */
  stderr: string
  /** True when stdout was truncated to the configured cap. */
  stdoutTruncated: boolean
  /** True when stderr was truncated to the configured cap. */
  stderrTruncated: boolean
}

/** The canonical `ci_run` output value. */
export interface CiRunValue {
  /** The directory the gates ran in. */
  cwd: string
  /** `passed` when every gate passed, `failed` when any failed or was skipped, `aborted` when cancelled. */
  overall: 'passed' | 'failed' | 'aborted'
  /** Per-gate results in run order. */
  gates: CiGateResult[]
}

/**
 * Validate and default `ci_run` arguments. Throws a plain `Error` for
 * constraints the schema DSL cannot express.
 * @param args - the schema-validated arguments.
 * @param config - resolved plugin config supplying default timeout and stop-on-failure.
 * @returns the validated, defaulted arguments.
 */
export function parseCiArgs(args: CiRunArgs, config: ResolvedConfig): ResolvedCiRunArgs {
  const cwd = args.cwd.trim()
  if (cwd.length === 0) throw new Error('cwd must be a non-empty path')
  if (!Array.isArray(args.gates) || args.gates.length === 0) {
    throw new Error('gates must contain at least one command')
  }
  const gates = args.gates.map(gate => gate.trim())
  if (gates.some(gate => gate.length === 0)) throw new Error('each gate command must be a non-empty string')
  return {
    cwd,
    gates,
    stopOnFailure: args.stopOnFailure ?? config.stopOnFailure,
    timeoutMs: config.timeoutMs,
  }
}

/** Cap a string to `maxChars` characters, marking truncation for the caller. */
function capOutput(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  return { text: text.slice(0, maxChars), truncated: true }
}

/**
 * Project one finished `ci_run` gate into its canonical record, capping the
 * output tails to the configured budget.
 * @param command - the gate command as run.
 * @param run - the completed foreground run from the shell executor.
 * @param durationMs - the gate's wall-clock duration.
 * @param maxOutputChars - the configured per-stream character cap.
 * @param status - the gate status (`passed`/`failed`, or `skipped` for unrun gates).
 * @returns the canonical per-gate record.
 */
export function gateResultFromRun(
  command: string,
  run: ShellRunResult | undefined,
  durationMs: number,
  maxOutputChars: number,
  status: 'passed' | 'failed' | 'skipped',
): CiGateResult {
  if (status === 'skipped' || run === undefined) {
    return {
      command,
      status: 'skipped',
      exitCode: run?.exitCode ?? null,
      signal: run === undefined || run.signal === null ? null : run.signal,
      timedOut: run?.timedOut ?? false,
      aborted: run?.aborted ?? false,
      durationMs,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
    }
  }
  const stdout = capOutput(run.stdout.text, maxOutputChars)
  const stderr = capOutput(run.stderr.text, maxOutputChars)
  return {
    command,
    status,
    exitCode: run.exitCode,
    signal: run.signal === null ? null : run.signal,
    timedOut: run.timedOut,
    aborted: run.aborted,
    durationMs,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutTruncated: run.stdout.truncated || stdout.truncated,
    stderrTruncated: run.stderr.truncated || stderr.truncated,
  }
}

/**
 * Render the canonical `ci_run` value as the model-facing text block.
 * @param value - the validated canonical value.
 * @returns a markdown summary of the verdict and each gate.
 */
export function renderCiRunValue(value: CiRunValue): string {
  const lines: string[] = []
  lines.push('CI gate run in ' + value.cwd)
  lines.push('Overall: ' + value.overall)
  for (const gate of value.gates) {
    lines.push('')
    lines.push('## ' + gate.command)
    if (gate.status === 'skipped') {
      lines.push('- skipped (prior gate failed)')
    } else {
      const reason = gate.status === 'passed'
        ? 'exit 0'
        : gate.timedOut
          ? 'timed out after ' + String(gate.durationMs) + 'ms'
          : gate.aborted
            ? 'aborted'
            : gate.signal !== null
              ? 'killed by ' + gate.signal
              : 'exit ' + String(gate.exitCode ?? 'unknown')
      lines.push('- ' + gate.status + ': ' + reason + ', ' + String(gate.durationMs) + 'ms')
    }
    if (gate.stdout.length > 0) lines.push('[stdout]\n' + gate.stdout)
    if (gate.stderr.length > 0) lines.push('[stderr]\n' + gate.stderr)
    if (gate.stdoutTruncated || gate.stderrTruncated) lines.push('[output truncated]')
  }
  return lines.join('\n')
}

/** Pending-state presentation: a terminal card headed by the joined gate commands. */
export function presentCiCall(args: CiRunArgs): TerminalCallView {
  return {
    card: 'terminal',
    title: args.gates.join(' && '),
    description: 'Run CI quality gates',
    cwd: args.cwd,
  }
}

/**
 * Completed-state presentation: a terminal card carrying the combined output
 * from the replayable canonical meta. Falls back to the generic card (returns
 * `undefined`) when meta is absent or malformed, so replay never crashes.
 * @param args - the raw tool arguments.
 * @param result - the final model-facing tool result; `meta` carries the value.
 * @returns the terminal result view, or `undefined` for the generic fallback.
 */
export function presentCiResult(args: CiRunArgs, result: ToolResult): TerminalResultView | undefined {
  if (result.isError) return undefined
  const meta = result.meta
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const gates = (meta as { gates?: unknown }).gates
  if (!Array.isArray(gates)) return undefined
  const blocks = gates.map((gate) => {
    if (typeof gate !== 'object' || gate === null) return ''
    const g = gate as Record<string, unknown>
    const command = typeof g.command === 'string' ? g.command : ''
    const stdout = typeof g.stdout === 'string' ? g.stdout : ''
    const stderr = typeof g.stderr === 'string' ? g.stderr : ''
    const parts = ['$ ' + command]
    if (stdout.length > 0) parts.push(stdout)
    if (stderr.length > 0) parts.push(stderr)
    return parts.join('\n')
  }).join('\n\n')
  const last = gates[gates.length - 1] as Record<string, unknown> | undefined
  const exitCode = typeof last?.exitCode === 'number' ? last.exitCode : undefined
  const signal = typeof last?.signal === 'string' ? last.signal : undefined
  return {
    card: 'terminal',
    title: args.gates.join(' && '),
    output: blocks.length > 0 ? blocks : '(no output)',
    ...exitCode !== undefined ? { exitCode } : {},
    ...signal !== undefined ? { signal } : {},
  }
}

/** Register the `ci_run` tool and its system-prompt guidance. */
export function applyCiRunTool(ctx: Context, config: ResolvedConfig): void {
  const maxOutputChars = config.maxOutputChars
  ctx.systemPrompt.section({
    name: 'tool:ci_run',
    order: 112,
    text: 'Use the ci_run tool to run CI quality gates (lint, typecheck, test, build, and so on) in a repository and get a structured per-command verdict. The required gates array accepts one or more shell commands (for example ["pnpm lint", "pnpm typecheck"]); pass the absolute or relative working directory as cwd. A failed or timed-out gate stops the sequence by default so you see the first failure. Prefer it over running each command via bash when you need a single structured result.',
  })
  ctx.tools.register(defineTool({
    name: 'ci_run',
    description: 'Run one or more CI quality-gate commands in a directory (for example pnpm lint, pnpm typecheck, pnpm test, pnpm build) and return a structured per-command verdict. Reads do not mutate parent-agent state.',
    parameters: {
      cwd: { type: 'string', required: true, description: 'Directory the gates run in (absolute, or resolved against the session workspace).' },
      gates: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'One or more CI gate commands to run in order, for example ["pnpm lint", "pnpm typecheck"].',
      },
      stopOnFailure: { type: 'boolean', description: 'Stop at the first failing gate. Defaults to true.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cwd: { type: 'string', required: true },
          overall: { type: 'string', enum: ['passed', 'failed', 'aborted'], required: true },
          gates: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                command: { type: 'string', required: true },
                status: { type: 'string', enum: ['passed', 'failed', 'skipped'], required: true },
                exitCode: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
                signal: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
                timedOut: { type: 'boolean', required: true },
                aborted: { type: 'boolean', required: true },
                durationMs: { type: 'number', required: true },
                stdout: { type: 'string', required: true },
                stderr: { type: 'string', required: true },
                stdoutTruncated: { type: 'boolean', required: true },
                stderrTruncated: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderCiRunValue(value) }],
      presentationMeta: (_args, value) => value,
    },
    timeoutMs: config.timeoutMs,
    // CI gates may write to the workspace (build artifacts, generated files), so
    // concurrent calls on the same tree are unsafe.
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const resolved = parseCiArgs(args, config)
      const gates: CiGateResult[] = []
      let aborted = false
      for (let index = 0; index < resolved.gates.length; index += 1) {
        const command = resolved.gates[index] as string
        if (exec.signal.aborted) {
          aborted = true
          break
        }
        const start = Date.now()
        let run: ShellRunResult | undefined
        let spawnError: string | undefined
        try {
          run = await (await ctx.shell.execute(ctx.shell.resolve({
            command,
            workdir: resolved.cwd,
            timeoutMs: resolved.timeoutMs,
            signal: exec.signal,
          }))).result()
        } catch (error) {
          spawnError = error instanceof Error ? error.message : String(error)
        }
        const durationMs = Date.now() - start
        if (spawnError !== undefined) {
          gates.push({
            command,
            status: 'failed',
            exitCode: null,
            signal: null,
            timedOut: false,
            aborted: false,
            durationMs,
            stdout: '',
            stderr: 'failed to start: ' + spawnError,
            stdoutTruncated: false,
            stderrTruncated: false,
          })
        } else if (run !== undefined) {
          const passed = run.exitCode === 0 && run.signal === null && !run.timedOut && !run.aborted
          gates.push(gateResultFromRun(command, run, durationMs, maxOutputChars, passed ? 'passed' : 'failed'))
          if (run.aborted) {
            aborted = true
            break
          }
          if (!passed && resolved.stopOnFailure) {
            for (const remaining of resolved.gates.slice(index + 1)) {
              gates.push(gateResultFromRun(remaining, undefined, 0, maxOutputChars, 'skipped'))
            }
            break
          }
        }
      }
      if (exec.signal.aborted && gates.length < resolved.gates.length) aborted = true
      const overall = aborted ? 'aborted' as const : gates.some(gate => gate.status !== 'passed') ? 'failed' as const : 'passed' as const
      return { cwd: resolved.cwd, overall, gates }
    },
    presentCall: presentCiCall,
    presentResult: presentCiResult,
  }))
}

/**
 * Register the `ci_run` tool. The disposer is fiber-scoped (the effect-based
 * registry cleans up on dispose), so no manual teardown is needed.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  applyCiRunTool(ctx, resolved)
}
