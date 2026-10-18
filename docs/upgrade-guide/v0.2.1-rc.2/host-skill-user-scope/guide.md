---
kind: upgrade-guide
description: Host-sealed filesystem skill roots now support a distinct user-local provider and reserved skill-name prefix.
---
# Host-sealed user skill roots

English | [中文](guide.zh.md)

## Change

Applications using `installFilesystemSkillRootPolicy()` can supply `userRoots` alongside enterprise roots. Only a Host-mounted filesystem provider named `user-local` reads them. Its skill names receive the `user-local-` prefix and its source is `user-local`; enterprise sealed roots cannot publish names with that prefix. Agent-scoped providers, environment roots, and custom directories cannot override either source.

Applications that do not install a root policy retain their existing behavior.

## Migration

1. Pass explicit absolute personal directories as `userRoots` when installing the Host root policy.
2. Mount a second filesystem provider with `providerName: user-local`, `includeDefaultRoots: false`, and `watch: false`.
3. Invoke a personal skill named `example` as `user-local-example`. Verify that the registry lists provider and source `user-local`; keep enterprise skill names outside the reserved prefix.
