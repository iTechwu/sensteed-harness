# Agent Note: 悬空的 origin/HEAD 不再阻断 Lefthook pre-push

Status: implemented

[English](2026-10-01-lefthook-pre-push-origin-head-repair.md) | 中文

## 问题

在远端默认分支还是 `master` 期间克隆本 fork 的仓库里,新分支的每一次首推都会以 `lefthook: typecheck (skip) exit status 128` 失败。Lefthook 的 pre-push 作业文件门用 `git diff --name-only HEAD @{push}` 列出变更文件;分支首推前没有上游,该命令不可解析,于是 lefthook 回退到 `refs/remotes/origin/HEAD` 指向的分支。这个符号引用是进程内解析的,不经过 `git symbolic-ref` 子进程:lefthook 2.1.9 二进制携带解析器 `ref: refs/remotes/origin/(?P<name>.*)$`,既无 `symbolic-ref` 命令字符串,也无 `init.defaultBranch` 查询;在故意悬空符号引用且 `init.defaultBranch=main` 的 A/B 探测中,回退仍对 `master` 做了 diff。当 fork 的分支收敛使远端只剩 `dev` 与 `main` 后,仓库里保存的符号引用指向了已不存在的分支,回退命令 `git diff --name-only HEAD master --` 以退出码 128 失败,lefthook 把该门视为失败的作业并阻断推送。

## 决策

[`scripts/install-lefthook.mjs`](../../../../scripts/install-lefthook.mjs) 现在在安装成功后修复悬空的 `refs/remotes/origin/HEAD`:把它重新指向 `refs/remotes/origin/main` 或 `refs/remotes/origin/master` 中第一个存在的引用,两者都不存在时仅告警。修复离线且确定;它绝不会导致安装失败——postinstall 也会在无网络的机器上运行,而 `git remote set-head origin --auto` 虽是远端默认分支的权威来源,却可能在主机不可达或等待 SSH 口令提示时挂起。完全没有 `origin/HEAD` 的仓库不做处理:该状态没有观察到失败,给从未有过该引用的仓库创建引用也不在安装器的契约之内。该步骤在安装器锁内、且在钩子安装成功之后执行,因此既不会与兄弟 worktree 竞争,也不会触发钩子路径回滚。

## 备选方案

**在 `lefthook.yml` 中用作业级 `files:` 模板或 `skip_empty: false` 补偿。** 否决:lefthook 在读取作业自身的声明之前就完成了 push 文件的解析,配置无法替换失败的解析过程;而自定义 `files:` 命令在失败时返回空,会让 typecheck 门被静默跳过而不是阻断推送。

**等待上游 lefthook 回退到存储符号引用以外的来源。** 否决:2.1.9 二进制没有其他可查来源,在本仓库的克隆上,升级落地(如果有的话)之前每个克隆都保持损坏。

## 后果

改名前的克隆在下一次 `pnpm install` 时自愈,其新分支首推重新通过文件门。全新克隆从不需要修复:git 会从远端默认分支(此处为 `main`)播种 `refs/remotes/origin/HEAD`。修复步骤的任何意外失败都降级为带 `[install-lefthook]` 前缀的 stderr 告警,因此依赖安装永远不会因这个便利性启发式而中断;无法修复的仓库会打印 `git remote set-head origin --auto`,可手动执行修复。

## 测试

`scripts/install-lefthook.spec.ts` 覆盖:修复到已存在的 `main` 引用、`main` 不存在时回退到 `master`、有效符号引用保持不动、无法修复时安装保持绿色并告警。在本克隆上直接验证:把符号引用故意改指 `refs/remotes/origin/master` 后执行 `node scripts/install-lefthook.mjs`,以退出码 0 修复为 `refs/remotes/origin/main`。
