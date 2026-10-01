---
name: browser-control
description: Drive a real browser to accomplish agent tasks - navigate, click, type, select, extract text/values, and capture screenshots. Use when a task requires interacting with a live web page, a logged-in flow, SSO, or extracting rendered DOM data that an API does not expose. Frames browser work as selector-first, state-before-act, and verify-after-write.
---

# Browser Control

Drive a live browser through the available browser tooling (a browser-capable CLI such as OpenCLI, Playwright, or a browser MCP) to accomplish tasks. Inspect before you act, prefer structured selectors over guessing, and verify every write.

## When to use

- A page renders data only in the DOM and has no equivalent API.
- The flow requires login, SSO, or a browser-managed session.
- You must demonstrate a UI interaction (click, fill, submit) and capture the result.

Prefer the site adapter command when one exists; use raw browser driving only for gaps, debugging, or one-off flows.

## Setup and lifecycle

1. Run the browser doctor/health check first; it reports whether the browser, extension, and debug port are ready.
2. Use a stable session name across a multi-step flow; close or release the session when finished.
3. Bind an existing user tab only when a logged-in or manually positioned page is required; otherwise prefer an owned session.
4. Never print credentials; use the app normal configuration path and a benign prompt.

## Core rules

1. **Inspect before acting.** Snapshot state (or find) first. Never hard-code a selector or an index from memory; indices are per-snapshot.
2. **Selector-first target contract.** Every interaction takes one target: a numeric ref from state/find (preferred, survives mild DOM drift) or a CSS selector with an explicit nth match.
3. **State - action - state after a navigation.** A route change, submit, or SPA transition invalidates prior refs; take a fresh snapshot before the next write.
4. **Verify writes that matter.** After typing, read the field value; after a select, read the value. React controlled inputs and masked fields silently eat characters.
5. **Read match confidence.** A reidentified element means the original ref was gone and a unique replacement was found - double-check you hit the right node.
6. **Prefer the network/API over screen-scraping.** If the page feeds a JSON API, the API is more reliable than the rendered DOM.
7. **Use the screenshot API for captures.** Save image bytes directly; the encoder detects image content independently of the filename extension.

## Cleanup

Release the session when done. Never leave a logged-in browser session or captured credentials behind. Report what the run did and any state exceptions together with the exact sources that produced them.
