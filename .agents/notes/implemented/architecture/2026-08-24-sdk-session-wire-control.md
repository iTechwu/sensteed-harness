# Agent Note: SDK session wire control

Status: implemented

English | [中文](2026-08-24-sdk-session-wire-control.zh.md)

## Problem

The SDK runtime needs wire-level control over a session's live work: cancel the running Agent, resume from persistence, and change the durable approval policy. Each of these already existed behind an internal factory or event, and inventing parallel JSON-RPC semantics would fork the ownership of persistence, approval policy, and Agent lifecycle. The wire contract also needs a boundary for what a session creator may seed (an environment overlay) versus what must stay out of process configuration.

## Decision

The SDK runtime exposes cancellation, persistence-backed resume, and durable approval-policy changes as session-owned JSON-RPC requests. `session/cancel` aborts the live Agent and does not close the subprocess. `session/resume` delegates to the existing `AgentRegistry.resume` factory so persistence ownership and setup rollback remain in one implementation. `session/approval-policy` appends the existing `approval/policy` event instead of inventing a second policy store.

The first prompt may carry a per-session environment overlay, but it is immutable after session creation and only allows `DEEPSEEK_BASE_URL`. Credentials, interpreter search paths, dynamic-loader variables, and arbitrary process environment mutation stay outside the wire contract. A scoped DeepSeek plugin consumes the overlay when the runtime does not already own a global adapter; a global adapter plus an overlay is rejected rather than silently ignoring the requested endpoint.

## Alternatives considered

**Per-session close over the wire.** Rejected: cancellation is a work control operation, while `shutdown` remains process lifecycle teardown; exposing close per session would blur the two and complicate subprocess ownership.

**A second approval-policy store addressed by the wire.** Rejected: appending the existing `approval/policy` event keeps one durable policy history; a separate store would need its own reconciliation against answerer decisions.

## Consequences

Both TypeScript SDK layers and the protocol type map expose the same methods. Approval *policy* is wire-controlled; individual approval decisions remain an answerer capability and are not synthesized without a request identity and durable audit pair. Per-session close is intentionally absent: cancellation is a work control operation, while `shutdown` remains process lifecycle teardown.
