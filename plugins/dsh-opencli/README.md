# @dofe/dsh-opencli

English | [中文](README.zh.md)

Registers an `opencli` model tool in the dsh web profile so the harness can
drive a real Google Chrome browser and 100+ site adapters through the OpenCLI CLI.

## Usage

```bash
opencli browser navigate --url https://example.com
opencli twitter search --query opencli
opencli chatgpt read
```

Prerequisites:

- `google-chrome` installed on the harness host,
- `opencli` (npm `@jackwener/opencli`) on the host `PATH`,
- Node >= 20 (already in the node base image).

## Deploy

This bundle is loaded by the dsh web profile through a plugin spec. See
`packages/bundle/web` / the deployment's `DSH_PLUGIN_SPECS` and the CI image
build that bakes in Chrome + OpenCLI.
