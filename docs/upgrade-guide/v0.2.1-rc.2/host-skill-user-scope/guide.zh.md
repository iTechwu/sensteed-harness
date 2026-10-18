---
kind: upgrade-guide
description: Host 封闭的文件系统技能根现支持独立 user-local 提供方及保留名称前缀。
---
# Host 封闭的用户技能根

[English](guide.md) | 中文

## 变更

使用 `installFilesystemSkillRootPolicy()` 的应用可在企业根之外提供 `userRoots`。只有 Host 挂载的 `user-local` 文件系统提供方可以读取这些根。其技能名添加 `user-local-` 前缀，来源为 `user-local`；企业封闭根不能发布此前缀的技能。Agent 作用域提供方、环境变量根和自定义目录均不能覆盖这两类来源。

未安装根策略的应用保留原有行为。

## 迁移

1. 安装 Host 根策略时，通过 `userRoots` 传入明确的个人绝对路径。
2. 挂载第二个文件系统提供方，设置 `providerName: user-local`、`includeDefaultRoots: false` 和 `watch: false`。
3. 原名为 `example` 的个人技能改以 `user-local-example` 调用。确认注册表中的提供方及来源均为 `user-local`；企业技能名不得使用该保留前缀。
