---
description: "通过系统浏览器完成飞书 SSO 登录，领取网关分配给账户的 API key，并保存在既有的本地凭据存储中。本地取消可阻止迟到的回调与兑换把用户登入。"
kind: "package-reference"
---

# @deepseek-ai/dsh-deepseek-account-platform

[English](README.md) | 中文

## 概述

本提供方针对 Sensteed 网关实现账户服务定义：登录在系统浏览器中打开 SSO 授权页（飞书身份），把返回的 code 兑换为 SSO access token，经桌面 key 桥接领取账户的网关 API key，并把该 key 存入本地凭据存储的指定引用。模型请求随后以 `x-api-key` 认证；不读取、不存储任何原生 DeepSeek 凭据。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>

## 使用本包

配置指明部署位置：`ssoApiOrigin`（提供 `/oauth/authorize` 与 `/oauth/token` 的 SSO API 基址）、`gatewayApiOrigin`（提供 `/auth/desktop/provision-key` 与推理的网关 API 基址）、`credentialRefName`（签发 key 写入并读取的引用名）。三者齐备才能登录；缺少它们的组合以未登录状态启动，`resolveToken` 回答 `undefined`。`allowLoopbackHttp` 为开发 Mock 放行 loopback HTTP；`requestTimeoutMs` 与 `attemptTimeoutMs` 分别限定单请求与整个尝试。

登录以注册的桌面客户端运行 PKCE：Host webServer 在调用方提供的 loopback origin 上于 `/callback` 接收回调，state 比对使用常量时间比较，code 经 `POST {ssoApiOrigin}/oauth/token` 以 JSON 请求体兑换。access token 随后经 `POST {gatewayApiOrigin}/auth/desktop/provision-key`（附 `x-company-code: sensteed`）领取 key；领取是幂等的，每次成功都返回全文 key。key 先写入指定引用，随后提交元数据记录（`version: 2`：用户身份、签发时间、端点、引用名）；若解析到的有效值与写入的 key 不一致——进程环境遮蔽会在未来每次读取时胜出——本次尝试以 `storage` 失败，而不是存入一个永远读不到的凭据。

`resolveToken` 只回答 `gatewayApiOrigin` 之下的目的地，返回引用现值。经 `rejectToken` 上报的被拒请求密钥会清除引用与元数据记录并发出 `deepseek-account/session-expired`，引导 UI 回到登录；因此网关侧轮换 key 后需要重新登录。`getProfile` 直接投影存储的身份（SSO subject、显示名、头像），不发网络请求；钱包、红包与嵌入式平台页操作在网关上不存在，返回 `null`/`false`。登出在本地移除引用与记录；网关侧没有可供吊销的客户端会话。初始化时，版本或部署端点与组合不一致的存量记录会在消费者读取账户状态前删除。

<a id="model-experience"></a>
## 模型体验

无：账户凭据只影响 HTTP 认证，从不进入模型提示、Session 日志或工具结果。

#### KV Cache 影响

无模型请求前缀变化。

## 已知限制

<a id="known-limitations-and-deferred-work"></a>

- 浏览器登录需要 Host webServer。仅支持本地访问与经 HTTP localhost、127.0.0.1 或 [::1]（带显式端口）的 SSH 本地转发；不支持非 loopback 反向代理。SSO 授权页控制自身品牌呈现，请求的深色主题不会透传。
- 签发失败映射为三种登录错误码：access token 被拒为 `expired`；授权拒绝（非 sensteed company code、缺失飞书身份、非成员租户）为 `protocol`；限流与服务器错误为 `network`；响应体仅 Host 可见。
- 网关侧轮换 key 后，存量 key 失效且无通知；下一次模型请求以凭据错误失败，直到用户重新登录（幂等重领）。
- 进程环境遮蔽引用值属于配置错误：登录在写入后校验有效值，以 `storage` 失败，而不是存入永远读不到的凭据。
