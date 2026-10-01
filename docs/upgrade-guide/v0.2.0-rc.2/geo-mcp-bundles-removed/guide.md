---
kind: upgrade-guide
description: "The @dofe/dsh-geo-mcp and @dofe/dsh-geoflow-mcp bundles are removed; geoflow and georank MCP tools no longer load from this repository."
---

# Geo MCP bundles are removed

English | [中文](guide.zh.md)

## Change

Through v0.2.0-rc.2, the repository shipped two plugin bundles under `plugins/`: `@dofe/dsh-geo-mcp` (geoflow and georank clients) and `@dofe/dsh-geoflow-mcp` (the standalone geoflow client). A profile that listed either bundle in `dsh.profile.bundles` exposed the `mcp__geoflow__*` and `mcp__georank__*` tools.

The next release deletes both bundles. A profile that still references them fails the bundle lookup at startup, and the `mcp__geoflow__*` / `mcp__georank__*` tools disappear from every agent session.

## Migration

1. Open the profile that references either bundle — `$DSH_HOME/profiles/<name>/package.json` — and delete the `@dofe/dsh-geo-mcp` and `@dofe/dsh-geoflow-mcp` entries from `dsh.profile.bundles`.
2. If you still need the geoflow or georank tools, register an equivalent Streamable-HTTP MCP client entry by hand in the profile's `cordis.patch.yml`; the deleted `plugins/dsh-geo-mcp/cordis.patch.yml` at the previous revision is the reference for its shape.
3. Confirm: restart `dsh` with the profile and check that startup logs no bundle-resolution error and that `mcp__geoflow__*` tools either appear from your hand-written entry or are gone as intended.
