# dsh-openmontage-mcp

[English](README.md) | 中文

这是一个 DeepSeek Harness（DSH）**组合包**，用于在 `web` profile 中注册 OpenMontage MCP 服务作为额外的 MCP 客户端，并添加系统提示词，告诉模型何时使用该服务。

## 暴露内容

- OpenMontage MCP 工具以 DSH 服务限定命名空间 `mcp__openmontage__<tool>` 注册为原生工具，例如 `mcp__openmontage__submit_video_job`。
- 提示词段落（`openmontage:guidance`）指示模型对脚本化、多镜头、编辑或克隆重制任务依次调用 `mcp__openmontage__openmontage_capabilities` → `prepare_reference_clone` → `submit_video_job`。持续 5–10 秒的连续单镜头短片应改用 Media MCP。
- Agent 级工作流守卫会在检查已准备的参考项目时收窄 MCP 目录，并在再次执行远程调用前阻止重复的等价失败。

`prepare_reference_clone` 是一项同步的长时间操作，因为它可能下载源视频并运行 ffmpeg／转写分析。组合包为该调用提供最长 10 分钟。如果客户端报告超时，请保留返回的 `project_id`，并在重试前调用 `mcp__openmontage__reference_clone_status`；重试会复用已完成的项目。状态变为 `prepared` 后，调用 `list_project_files`。对于 JSON／Markdown 分析文件，使用 `read_project_file`，让远程客户端通过已认证的 MCP 通道接收文本；不要把仅 CI 可用的 `/exchange/openmontage/<project_id>` 路径传给本地 `Read` 工具。只有在需要共享挂载或交付媒体时，才使用 `sync_project_exports` 或 `export_project_file`。

参考项目处于 `prepared` 状态时，本地工具仍然可用，但 MCP 目录只保留 OpenMontage 能力查询、参考项目状态、项目文件列举与读取、项目导出和 Job 提交工具。此时不能再次调用 `prepare_reference_clone`，也不能在 Job 创建前调用 `list_video_artifacts`。成功执行 `submit_video_job` 或收到新的用户消息后，完整工具目录恢复。

## 循环防护

Host 插件默认在三个等价的无进展结果后为对应 Agent 打开熔断。它按规范化结果内容识别失败，因此改变无效的 `job_id` 无法绕过检测。成功但内容不变的 `list_project_files` 结果也属于无进展。达到阈值的结果继续保留在审计日志中，同时加入纠偏模型上下文；之后对该工具的调用会在远程工具体运行前被拒绝。

`reference_clone_status`、`get_video_job` 和 `list_video_job_events` 属于轮询豁免，因为状态暂时不变是正常情况。成功且发生变化的结果会重置该工具的计数。新用户消息会重置对应 Agent 的全部熔断，一个 Agent 的状态不会影响另一个 Agent。

部署需要不同限制时，可在 Host 插件行中把 `stalledOutcomeThreshold` 设置为不小于二的整数。无效值会在插件加载时失败。

调用 `submit_video_job` 后，按 `begin_client_stage` -> 零次或多次该阶段允许的 `invoke_openmontage_tool` 调用 -> `submit_client_stage` 驱动每个客户端负责的阶段。阶段工具列表为空时，不要虚构调用。`begin_client_stage` 返回 `jobId`、`stage`、`stageAttempt`、`leaseToken` 和 `stageContract`；把 lease 字段映射到顶层参数 `job_id`、`stage`、`stage_attempt` 和 `lease_token`。每次非 catalog 调用还必须提供稳定的非空 `idempotency_key`。Selector、preflight、ranking、generation、progress 和 composition 调用不是独立的 provider API。

外层 `operation: "generate"` 选择的是网关执行生命周期，不能代替逻辑工具自身的 operation。调用 `video_compose` 时，把选定的工具 operation 放在 `inputs` 内，例如外层 `operation: "generate"` 与 `inputs.operation: "render"` 同时存在；其他允许值以实时 input schema 为准。

把 `stageContract` 视为该次执行的权威约定：通过 `read_openmontage_file` 读取每个 `instructionFiles` 项，并把每个返回结果按 `submit_client_stage` schema 中定名的 instruction 记录入参映射为 `{"path": result.relative_path, "content_hash": result.content_hash}`。`declaredTools` 包含 pipeline manifest（流水线元数据清单）中的原始词汇；只把 `gatewayTools` 中的精确名称传给 `invoke_openmontage_tool`。使用 `produces` 作为提交的 `artifacts` 顶层键。例如传入 `{"research_brief": {<brief fields>}}`，不要把 brief 字段直接放在 `artifacts` 顶层。

## 凭据

| 凭据名称 | 含义 | 默认值 |
|---|---|---|
| `MODELS_API_KEY` | 由 DSH 凭据服务解析并发送给网关的唯一 Models API key | *（必填）* |

MCP 端点固定为 `https://ai.hozonauto.com/mcp/montage`；用户不能配置仅 CI 可用的 base URL。

MCP 客户端在连接前要求提供 `MODELS_API_KEY`，网关会在每个请求中验证该凭据。DSH 不配置 OpenMontage 服务 token 或 job attribution。

`failOnStartupError` 为 `false`：如果 OpenMontage 暂时不可用，web profile 仍可启动；服务恢复后，重连 supervisor 会注册工具。

## 安装

通过部署的插件挂载和 `DSH_PLUGIN_SPECS` 交付：

```sh
# in docker-helm.dofe.ai .env
DEEPSEEK_HARNESS_PLUGIN_SOURCE_DIR=../deepseek-harness/plugins
DSH_PLUGIN_SPECS=/opt/dsh-plugins/dsh-openmontage-mcp
```

也可以从 checkout 安装：

```sh
dsh plugin --profile web add ./dsh-openmontage-mcp
```
