---
description: "模型可用的 CI 质量门禁工具：经 shell 能力缝运行指定的门禁命令，返回单一结构化结论。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-ci

[English](README.md) | 中文

## 概述

模型可用的 `ci_run` 质量门禁工具，构建在 [shell 能力缝](../../shell/shell/README.zh.md)（`ctx.shell`）之上。它在目标目录按顺序运行一个或多个门禁命令，返回单一结构化结论：总体判定 + 每个门禁的记录（退出码、信号、超时/中止事实、耗时、有界输出尾部）。默认在首个失败门禁处停止。每个门禁都经 `ctx.shell` 执行，沙箱、超时与取消由 shell 执行器负责；本包只负责模型可见的职责。

## 目录

- [工具](#tool)
- [配置](#config)
- [稳定注册](#stable-registration)
- [模型体验](#model-experience)
- [已知限制](#known-limitations-and-deferred-work)

<a id="tool"></a>

## 工具

| 工具 | 参数 | 行为 |
|---|---|---|
| `ci_run` | `cwd`（string，必填）；`gates`（string[]，必填）；`stopOnFailure`（boolean，可选） | 在 `cwd` 中按顺序运行门禁命令，每个门禁捕获有界输出尾部，并返回结构化的 `{ cwd, overall, gates[] }` 值。`overall` 为 `passed`、`failed` 或 `aborted`。 |

`gates` 接受 shell 命令字符串（例如 `pnpm lint`），而不是裸脚本名，从而由模型控制具体调用方式，而工具负责结构化判定与停止策略。

<a id="config"></a>

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `timeoutMs` | `120000` | 每个门禁的协作超时预算（ms），附为 `ToolDefinition.timeoutMs`。 |
| `maxOutputChars` | `20000` | 每个门禁保留在规范值中的 stdout/stderr 字符上限。 |
| `stopOnFailure` | `true` | 当模型未指定时的 `stopOnFailure` 默认值。 |

```yaml
- id: tool-ci
  name: @deepseek-ai/dsh-tool-ci
```

<a id="stable-registration"></a>

## 稳定注册

工具注册遵循启用即注册，而非依赖后端可用性：无法运行的门禁被报告为结构化值中的 failed 门禁，而不是抛出一个基础设施错误，从而在不同 provider/executor 变化下保持模型 schema 稳定。本包不发布 invariant 伴随插件：`ci_run` 不持有任何状态，每次调用都通过 shell 能力缝解析门禁，结构化值就是该次调用的唯一投影。

<a id="model-experience"></a>

## 模型体验

### CI 门禁结论

#### 模型看到什么

一次 `ci_run` 调用返回单一结构化结论：总体判定 + 每个门禁的记录（状态、原因、耗时、有界输出尾部）。prompt 段落提示模型在做多门禁 CI 检查时优先使用它。

#### Token 影响

每个门禁只把有界输出尾部带入规范值；`maxOutputChars` 限制进入模型上下文的内容。失败后被跳过的门禁不产生任何内容。

#### KV Cache 影响

本工具不引入持久会话状态；结果值与普通工具结果一样进入转录，遵循会话的常规缓存规则。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制

- 必须挂载 `ctx.shell`（bash/pwsh 执行器提供它）；没有它的组合无法加载本工具。
- 本工具不管理长时间运行的后台门禁批次；每次 `ci_run` 调用都是带界的前台序列。
- `maxOutputChars` 裁剪的是规范值，而非执行器自身的捕获；当发生截断时，完整流仍可通过底层 `CollectedOutput` spill 路径恢复。

### 开发备注

延期事项：后台门禁批处理与可配置的输出裁剪视图，在真实部署提出需求前不进入路线；更深层的捕获策略由 shell 执行器负责。
