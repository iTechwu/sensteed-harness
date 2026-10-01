# dsh-tools-mcp

[English](README.md) | 中文

一个 DeepSeek Harness (DSH) **bundle**：把 `tools.dofe.ai` 的九个业务域 Streamable HTTP MCP
端点注册为 `web` profile 中的额外 MCP 客户端，并新增一段 system-prompt，告诉模型何时使用它们。

## 暴露内容

`tools.dofe.ai`（FastAPI）挂载共享的 `/mcp` 网关；每个业务域是一个独立的无状态
streamable-http 端点。本 bundle 为每个域增加一个 `@deepseek-ai/dsh-mcp-client` 实例，
使工具以带 server 限定的命名空间 `mcp__tools-<domain>__<tool>` 原生暴露
（例如 `mcp__tools-platform__business_capabilities_list`）：

| 域 | 端点 |
| --- | --- |
| platform | `/mcp/platform` |
| supply-chain | `/mcp/supply-chain` |
| talent-discovery | `/mcp/talent-discovery` |
| lead-discovery | `/mcp/lead-discovery` |
| lead-monitor | `/mcp/lead-monitor` |
| hotspot-discovery | `/mcp/hotspot-discovery` |
| custom-car-monitoring | `/mcp/custom-car-monitoring` |
| viral-video | `/mcp/viral-video` |
| browser-intelligence | `/mcp/browser-intelligence` |

一段 prompt 小节（`tools:guidance`）告诉模型何时使用这些工具，以及如何在带副作用的写入上
遵守 confirm/`idempotencyKey` 契约。

## 配置（加载时读取）

| 环境变量 | 含义 | 默认值 |
| --- | --- | --- |
| `MCP_BASE_URL` | 统一 MCP 网关基址；每个域追加 `/tools/<domain>` | `https://ai.hozonauto.com/mcp` |
| `MODELS_API_KEY` | 发往网关的单一 Models API key | *（必填）* |

harness 以 host 网络运行（DSH 拒绝 `0.0.0.0`；Nginx 经宿主回环代理）。`tools.dofe.ai`
发布在 CI 宿主回环的 `TOOLS_API_PORT`（默认 `13103`），其 `MCP_ALLOWED_HOSTS` 已放行
`127.0.0.1:*`，因此 harness 可以连接。网关是唯一公开访问边界；仅显式隔离的 CI 冒烟测试
才把 `MCP_BASE_URL` 指向回环网关。

`failOnStartupError` 为 `false`：`tools.dofe.ai` 短暂不可达时 web profile 仍可启动，
重连监督器会在服务恢复后注册工具。

## 安装

经部署的 plugin 挂载与 `DSH_PLUGIN_SPECS` 交付：

```sh
# in docker-helm.dofe.ai .env
DEEPSEEK_HARNESS_PLUGIN_SOURCE_DIR=../deepseek-harness/plugins
DSH_PLUGIN_SPECS=/opt/dsh-plugins/dsh-tools-mcp
```

或从 checkout 安装：

```sh
dsh plugin --profile web add ./dsh-tools-mcp
```
