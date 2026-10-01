# @dofe/dsh-opencli

[English](README.md) | 中文

在 dsh web profile 中注册 `opencli` 模型工具，让 harness 可以通过 OpenCLI CLI 驱动真实的 Google Chrome 浏览器和 100+ 站点适配器。

## 用法

```bash
opencli browser navigate --url https://example.com
opencli twitter search --query opencli
opencli chatgpt read
```

前置条件：

- harness 宿主机上已安装 `google-chrome`，
- 宿主机 `PATH` 上有 `opencli`（npm `@jackwener/opencli`），
- Node >= 20（node 基础镜像已内置）。

## 部署

本 bundle 由 dsh web profile 通过 plugin spec 加载。参见 `packages/bundle/web` / 部署的
`DSH_PLUGIN_SPECS`，以及烘焙 Chrome + OpenCLI 的 CI 镜像构建。
