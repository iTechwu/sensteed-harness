---
kind: upgrade-guide
description: "@dofe/dsh-geo-mcp 与 @dofe/dsh-geoflow-mcp 两个 bundle 已删除；geoflow 和 georank 的 MCP 工具不再由本仓库提供。"
---

# Geo MCP bundle 已删除

[English](guide.md) | 中文

## 变更

v0.2.0-rc.2 及之前，仓库在 `plugins/` 下提供两个插件 bundle：`@dofe/dsh-geo-mcp`（geoflow 与 georank 客户端）和 `@dofe/dsh-geoflow-mcp`（独立的 geoflow 客户端）。profile 在 `dsh.profile.bundles` 中列出任一 bundle 即可使用 `mcp__geoflow__*` 与 `mcp__georank__*` 工具。

下个 release 删除这两个 bundle。仍引用它们的 profile 会在启动时 bundle 查找失败，且所有 agent 会话中不再出现 `mcp__geoflow__*` / `mcp__georank__*` 工具。

## 迁移

1. 打开引用了这两个 bundle 的 profile —— `$DSH_HOME/profiles/<name>/package.json` —— 并从 `dsh.profile.bundles` 中删除 `@dofe/dsh-geo-mcp` 和 `@dofe/dsh-geoflow-mcp` 条目。
2. 若仍需要 geoflow 或 georank 工具，请在 profile 的 `cordis.patch.yml` 中手工注册等价的 Streamable-HTTP MCP 客户端条目；上一 revision 的 `plugins/dsh-geo-mcp/cordis.patch.yml` 可作为结构参考。
3. 确认：用该 profile 重启 `dsh`，检查启动日志不再出现 bundle 解析错误，且 `mcp__geoflow__*` 工具要么来自手写条目、要么按预期消失。
