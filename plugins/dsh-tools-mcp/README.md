# dsh-tools-mcp

English | [中文](README.zh.md)

A DeepSeek Harness (DSH) **bundle** that registers `tools.dofe.ai`'s nine business-domain
Streamable HTTP MCP endpoints as additional MCP clients in the `web` profile, and adds a
system-prompt section telling the model when to use them.

## What it exposes

`tools.dofe.ai` (FastAPI) mounts a shared `/mcp` gateway; each business domain is a separate
stateless streamable-http endpoint. This bundle adds one `@deepseek-ai/dsh-mcp-client`
instance per domain, so the tools surface as native tools under the server-qualified
namespace `mcp__tools-<domain>__<tool>` (e.g. `mcp__tools-platform__business_capabilities_list`):

| Domain | Endpoint |
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

A prompt section (`tools:guidance`) tells the model when to reach for these tools and how to
honour the confirm/`idempotencyKey` contract on side-effecting writes.

## Configuration (read at load time)

| Env var | Meaning | Default |
| --- | --- | --- |
| `MCP_BASE_URL` | Unified MCP gateway base URL; each domain appends `/tools/<domain>` | `https://ai.hozonauto.com/mcp` |
| `MODELS_API_KEY` | Single Models API key sent to the gateway | *(required)* |

The harness runs with host networking (DSH refuses `0.0.0.0`; Nginx proxies via the host
loopback). `tools.dofe.ai` is published on the CI host loopback at `TOOLS_API_PORT` (default
`13103`), and its `MCP_ALLOWED_HOSTS` already admits `127.0.0.1:*`, so the harness connects
The gateway is the only public access boundary. Point `MCP_BASE_URL` at a loopback gateway only for an explicitly isolated CI smoke test.

`failOnStartupError` is `false`: if `tools.dofe.ai` is briefly unreachable the web profile
still boots and the reconnect supervisor registers the tools once the server is back.

## Install

Shipped through the deployment's plugin mount and `DSH_PLUGIN_SPECS`:

```sh
# in docker-helm.dofe.ai .env
DEEPSEEK_HARNESS_PLUGIN_SOURCE_DIR=../deepseek-harness/plugins
DSH_PLUGIN_SPECS=/opt/dsh-plugins/dsh-tools-mcp
```

Or, from a checkout:

```sh
dsh plugin --profile web add ./dsh-tools-mcp
```
