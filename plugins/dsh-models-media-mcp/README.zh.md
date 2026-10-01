# dsh-models-media-mcp

[English](README.md) | 中文

DeepSeek Harness bundle：把 Models 媒体生成 MCP（`https://ai.hozonauto.com/mcp/media`）注册为
Streamable HTTP MCP server，server name 固定为 `media`，工具以 `mcp__media__*` 暴露。

## 工具

- `mcp__media__create_image_task` — 单张文生图（服务端固定 `seedream-5.0`）。
- `mcp__media__create_video_task` — 5–10 秒单镜头短视频（服务端固定 `seedance-2.0-fast`、
  无音频；`firstFrameUrl` 提供时为首帧图生视频）。
- `mcp__media__get_generation_task` — 按 `taskId` 轮询，成功返回托管 HTTPS 产物 URL 与元数据。
- `mcp__media__cancel_generation_task` — 取消任务；终态任务幂等返回。

复杂视频（脚本/分镜/多镜头/源视频复刻/剪辑/字幕/配音/成片编排）必须走 OpenMontage
（`dsh-openmontage-mcp`），本插件的 system prompt 只做选路提示；服务端对保留意图字段
返回 `POLICY_REQUIRES_OPENMONTAGE`。

## 约束

- 地址固定为公共网关路径，不接受自定义服务地址；`MODELS_API_KEY` 通过 DSH
  credential provider 解析，配置与日志不保存密钥值。
- `create` 工具的 `idempotencyKey` 必填；同一用户意图的重试必须复用原键。
- create 只创建任务，不等待生成；轮询由 Agent 显式调用 `get_generation_task`
  （图片 ≥3s、视频 ≥5s 间隔，连续无变化退避 10s）。

## 安装

与其它 DSH bundle 一致，用 `file:` 形式安装进 profile package tree（见
`python/sdk/README.md`），或在 profile 的 `cordis.patch.yml` 中引用本包。
