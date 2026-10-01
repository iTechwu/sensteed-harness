---
kind: upgrade-guide
description: "The default MCP gateway host moves from ixicai.cn to ai.hozonauto.com for the tools, media, and openmontage MCP bundles."
---

# MCP gateway default host moves to ai.hozonauto.com

English | [中文](guide.zh.md)

## Change

Through v0.2.0-rc.2, the shipped MCP bundles resolved their gateway URL against `https://ixicai.cn/mcp`: the `tools` domains (`MCP_BASE_URL` default in `@dofe/dsh-tools-mcp`), the media bundle (`@dofe/dsh-models-media-mcp`), and the openmontage bundle (`@dofe/dsh-openmontage-mcp`, fixed URL).

The next release points every default at `https://ai.hozonauto.com`: the `MCP_BASE_URL` fallback becomes `https://ai.hozonauto.com/mcp`, and the two fixed URLs become `https://ai.hozonauto.com/mcp/media` and `https://ai.hozonauto.com/mcp/montage`. Deployments that relied on the old host and do not set `MCP_BASE_URL` start calling the new host after upgrading.

## Migration

1. If your deployment must keep the old host, set `MCP_BASE_URL=https://ixicai.cn/mcp` in the environment of the process that boots the profile; the `!!js` fallbacks read it at load time.
2. Otherwise nothing to change: restart `dsh` with the profile and confirm the MCP clients for `tools-*`, `media`, and `openmontage` connect (startup logs show the clients registered without reconnect errors).
