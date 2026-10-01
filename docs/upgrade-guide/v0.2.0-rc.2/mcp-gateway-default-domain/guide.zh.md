---
kind: upgrade-guide
description: "MCP 网关默认主机从 ixicai.cn 迁移到 ai.hozonauto.com，覆盖 tools、media 与 openmontage 三个 MCP bundle。"
---

# MCP 网关默认主机迁移至 ai.hozonauto.com

[English](guide.md) | 中文

## 变更

v0.2.0-rc.2 及之前，随仓库发布的 MCP bundle 的网关 URL 以 `https://ixicai.cn/mcp` 为默认：`tools` 各域（`@dofe/dsh-tools-mcp` 的 `MCP_BASE_URL` 默认值）、media bundle（`@dofe/dsh-models-media-mcp`）以及 openmontage bundle（`@dofe/dsh-openmontage-mcp`，固定 URL）。

下个 release 将所有默认值指向 `https://ai.hozonauto.com`：`MCP_BASE_URL` 回退值变为 `https://ai.hozonauto.com/mcp`，两个固定 URL 变为 `https://ai.hozonauto.com/mcp/media` 与 `https://ai.hozonauto.com/mcp/montage`。依赖旧主机且未设置 `MCP_BASE_URL` 的部署升级后会开始调用新主机。

## 迁移

1. 若部署必须保留旧主机，请在启动 profile 的进程环境中设置 `MCP_BASE_URL=https://ixicai.cn/mcp`；`!!js` 回退表达式在加载时读取它。
2. 否则无需改动：用 profile 重启 `dsh`，确认 `tools-*`、`media` 与 `openmontage` 的 MCP 客户端连接正常（启动日志中客户端注册完成、无重连报错）。
