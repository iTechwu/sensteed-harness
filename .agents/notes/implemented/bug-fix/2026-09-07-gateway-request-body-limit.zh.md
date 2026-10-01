# Agent Note: DeepSeek 网关请求体上限诊断

Status: implemented

[English](2026-09-07-gateway-request-body-limit.md) | 中文

## Problem

公网 `/api/v1/chat/completions` 路由会在 Nginx 边缘层拒绝较大的序列化聊天请求并返回 HTTP 413，Models 服务尚未获得请求。适配器把所有 413 映射为 `INVALID_REQUEST`，因此会话只显示笼统失败，压缩组件也收不到上下文溢出信号。

## Decision

公网 Nginx `/api/` location 允许最大 25 MiB 请求体，与已有的 `/ai/` 和 `/mcp/` 路由一致。直接 DeepSeek 适配器把带有明确上下文容量措辞的 413 映射为 `CONTEXT_WINDOW_EXCEEDED`，其他 413 使用 `REQUEST_BODY_TOO_LARGE`。没有提供方错误消息的请求体过大错误使用固定诊断，绝不复制网关 HTML 原文。

## Alternatives considered

**把桌面端端点从 `/api/v1` 切换到 `/ai/v1`。** 不采用，因为 `/api/v1` 是桌面 profile 使用的文档化 Models 公网端点，切换路由会改变部署归属，不能修复缺失的边缘限制。

**把所有 413 都当作上下文溢出。** 不采用，因为边缘字节上限与模型 token 上下文容量是不同问题；混淆二者会针对基础设施限制触发压缩，并掩盖部署配置错误。

**只提高 Nginx 上限而不改变适配器诊断。** 不采用，因为任何未协调的网关或提供方 413 仍会被错误标为 `INVALID_REQUEST`，用户看到的原因依旧不准确。

## Consequences

`/api/` 上不超过 25 MiB 的请求可以到达 Models 网关；公网阈值要改变，部署系统必须拉取并启用这次提交的 Nginx 配置。新的错误码是终止性错误，不会自动重试，避免重复发送同一个过大的请求体。提供方明确报告的上下文错误仍沿用现有压缩恢复路径。

## Verification

通过无凭据公网请求确认原有边缘阈值恰为 1 MiB：1,048,556 字节请求可以到达认证层，而 1,048,580 字节请求返回 Nginx 413。适配器聚焦测试覆盖 400 与 413 的上下文措辞、请求体过大分类以及经过清理的网关诊断。
