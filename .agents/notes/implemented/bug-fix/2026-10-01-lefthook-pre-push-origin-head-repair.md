# Agent Note: A dangling origin/HEAD no longer blocks Lefthook pre-push

Status: implemented

English | [中文](2026-10-01-lefthook-pre-push-origin-head-repair.zh.md)

## Problem

Every first push of a new branch failed with `lefthook: typecheck (skip) exit status 128` on clones of this fork created while the remote's default branch was still `master`. Lefthook's pre-push job file gate lists the changed files with `git diff --name-only HEAD @{push}`, and before a branch's first push no upstream exists, so lefthook falls back to the branch named by `refs/remotes/origin/HEAD`. That symref is resolved in-process, not through a `git symbolic-ref` subprocess: lefthook 2.1.9's binary carries the parser `ref: refs/remotes/origin/(?P<name>.*)$` and contains neither a `symbolic-ref` command string nor an `init.defaultBranch` lookup, and an A/B probe with a deliberately dangling symref while `init.defaultBranch=main` still diffed against `master`. When the fork's branch consolidation left only `dev` and `main` on the remote, the stored symref pointed at a branch that no longer existed, the fallback `git diff --name-only HEAD master --` failed with exit status 128, and lefthook treated the gate as a failed job and blocked the push.

## Decision

[`scripts/install-lefthook.mjs`](../../../../scripts/install-lefthook.mjs) now repairs a dangling `refs/remotes/origin/HEAD` after a successful installation, repointing it at the first of `refs/remotes/origin/main` or `refs/remotes/origin/master` that exists, and warns when neither does. The repair is offline and deterministic, and it never fails the installation: postinstall also runs on machines without network access, where `git remote set-head origin --auto` — the authoritative source for the remote's default branch — could hang on an unreachable host or an SSH passphrase prompt. Repositories with no `origin/HEAD` at all are left untouched: that state has no observed failure, and creating refs in repositories that never had one is outside the installer's contract. The step runs inside the installer lock and after the hook installation succeeded, so it can neither race sibling worktrees nor trigger the hook-path rollback.

## Alternatives considered

**Compensate in `lefthook.yml` with a job-level `files:` template or `skip_empty: false`.** Rejected: lefthook resolves push files before consulting a job's own declaration, so the config cannot replace the failing resolution, and a custom `files:` command that returns empty on failure would silently skip the typecheck gate instead of blocking the push.

**Wait for upstream lefthook to fall back to something besides the stored symref.** Rejected: the 2.1.9 binary has no other source to consult, and every clone of this fork stays broken until an upgrade lands, if one ever does.

## Consequences

Pre-rename clones heal at the next `pnpm install` and their first new-branch pushes pass the gate again. Fresh clones never needed the repair: git seeds `refs/remotes/origin/HEAD` from the remote's default branch, which is `main` here. Any unexpected failure of the repair step downgrades to a stderr warning prefixed `[install-lefthook]`, so dependency installation never breaks over a convenience heuristic, and an unrepairable repository prints the `git remote set-head origin --auto` command that fixes it by hand.

## Testing

`scripts/install-lefthook.spec.ts` covers repair to an existing `main` ref, fallthrough to `master` when `main` does not exist, a valid symref left untouched, and an unrepairable symref that keeps the installation green while warning. Against this clone directly: a symref deliberately repointed at `refs/remotes/origin/master` was repaired to `refs/remotes/origin/main` by `node scripts/install-lefthook.mjs` with exit status 0.
