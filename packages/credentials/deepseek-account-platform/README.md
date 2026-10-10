---
description: "Sign in through the Feishu SSO in the system browser, provision the gateway API key assigned to the account, and keep it in the existing local credential store. Local cancellation prevents late callbacks and exchanges from signing the user in."
kind: "package-reference"
---

# @deepseek-ai/dsh-deepseek-account-platform

English | [中文](README.zh.md)

## Summary

The provider implements the account Service Definition against the Sensteed gateway: sign-in opens the SSO authorization page (Feishu identity) in the system browser, exchanges the returned code for an SSO access token, provisions the account's gateway API key through the desktop key bridge, and stores that key in the local credential store under the configured reference. Model requests then authenticate with `x-api-key`; no native DeepSeek credential is read or stored.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Configuration names the deployment: `ssoApiOrigin` (SSO API base serving `/oauth/authorize` and `/oauth/token`), `gatewayApiOrigin` (gateway API base serving `/auth/desktop/provision-key` and inference), and `credentialRefName` (the references entry the provisioned key is written to and read from). All three are required for sign-in; a composition without them boots signed out and answers `resolveToken` with `undefined`. `allowLoopbackHttp` opts loopback HTTP in for the development mock, and `requestTimeoutMs` plus `attemptTimeoutMs` bound each request and the whole attempt.

Sign-in runs PKCE with the registered desktop client: the Host webServer accepts the redirect at `/callback` on the loopback origin the caller supplies, the state comparison is timing-safe, and the code exchanges through `POST {ssoApiOrigin}/oauth/token` with a JSON body. The access token then provisions the key through `POST {gatewayApiOrigin}/auth/desktop/provision-key` with `x-company-code: sensteed`; provisioning is idempotent and returns the full key on every success. The key is written to the configured reference first, then the metadata record (`version: 2`: user identity, provisioning time, endpoints, reference name) commits; if the effective resolved value differs from the written key — a process-environment shadow would win every future read — the attempt fails as `storage` instead of storing a dead credential.

`resolveToken` answers only destinations under `gatewayApiOrigin` and returns the current reference value. A rejected request token reported through `rejectToken` clears the reference and the metadata record and emits `deepseek-account/session-expired`, guiding the UI back to sign-in; key rotation therefore requires signing in again. `getProfile` projects the stored identity (SSO subject, display name, avatar) without a network request; wallet, bonus, and embedded-platform-page operations do not exist on the gateway and return `null`/`false`. Sign-out removes the reference and the record locally; the gateway keeps no client-side session to revoke. At initialization a stored record whose version or deployment endpoints do not match the composition is deleted before consumers read account state.

## Model Experience

None, as account credentials affect HTTP authentication and never enter model prompts, Session logs, or tool results.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Browser sign-in requires the Host webServer. Only local access and SSH local forwarding through HTTP localhost, 127.0.0.1, or [::1] with an explicit port are supported; non-loopback reverse proxies are unsupported. The SSO authorize page controls its own branding; a requested dark theme is not forwarded.
- Provisioning failures map to three sign-in codes: `expired` for a rejected access token, `protocol` for authorization rejections (non-Sensteed company code, missing Feishu identity, non-member tenant), and `network` for rate limiting and server errors; the response body stays Host-only.
- A gateway-side key rotation invalidates the stored key without notification; the next model request fails with a credential error until the user signs in again, which re-provisions idempotently.
- A references value shadowed by the process environment is a misconfiguration: sign-in verifies the effective value after writing and fails as `storage` rather than storing a credential that can never be read.

<a id="dev-note"></a>
### Dev Note

The PKCE machinery (verifier/challenge generation, the timing-safe state comparison, and the loopback callback lifecycle) is carried over from the previous platform sign-in; the SSO token exchange and key provisioning replaced only the platform exchange steps. The key lives in the credentials references section while the record under `deepseek-account-platform/default` holds deployment-bound metadata only, so the secret never sits in two stores.
