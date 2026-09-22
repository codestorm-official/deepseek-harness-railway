# DeepSeek Harness on Railway

An independent, minimal Railway deployment wrapper for the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web UI.

This repository is not maintained or endorsed by DeepSeek AI. It pins the official npm package `@deepseek-ai/dsh@0.1.7-alpha.1`, currently a developer preview that may introduce compatibility-breaking changes.

## What this wrapper adds

- A public gateway on Railway's dynamic `PORT` while the official Harness server remains on `127.0.0.1:3080`.
- A user-chosen username/password login with a `Secure`, `HttpOnly`, `SameSite=Strict` session cookie.
- A readiness endpoint at `/healthz` that becomes healthy only after Harness is available.
- Persistent Harness state at `/data/.dsh` and persistent workspaces at `/data/workspace`.
- A version-guarded compatibility patch that enables the authenticated Settings → Models workflow from Railway's HTTPS origin.
- Redaction of the upstream one-time launch token from process output.

## Required Railway configuration

Use one service, one replica, and one volume mounted at `/data`.

| Setting | Value |
| --- | --- |
| Builder | Dockerfile |
| Public domain | Required |
| Health check | `/healthz` |
| Health timeout | 300 seconds |
| Restart policy | On failure, up to 10 retries |
| Volume | `/data` |

### Required variables

| Variable | Description |
| --- | --- |
| `HARNESS_ACCESS_USERNAME` | User-chosen gateway username. Use 3-64 characters: letters, numbers, `.`, `_`, or `-`. |
| `HARNESS_ACCESS_PASSWORD` | User-chosen gateway password. Minimum 12 characters; 16 or more is recommended. Store as a secret. |
| `DSH_HOME` | Set to `/data/.dsh`. |
| `WORKSPACE_DIR` | Set to `/data/workspace`. |
| `DSH_TELEMETRY_DISABLED` | Set to `true` for the template privacy default. |

Railway provides `PORT` and `RAILWAY_PUBLIC_DOMAIN` automatically when the service has a generated public domain.

Model-provider credentials are optional at deployment. Open **Settings → Models** after signing in to configure DeepSeek, OpenAI, Anthropic, Kimi/Moonshot, OpenRouter, another installed provider, or a custom compatible API. Keys are write-only in the browser and persist in `$DSH_HOME/.credentials.yaml` on the mounted volume.

## Compatibility patch

DeepSeek Harness 0.1.7-alpha.1 deliberately selects memory-only settings for non-loopback browser pages even though its authenticated Connection API serves the settings namespace. `patch-upstream.mjs` changes that one compiled client decision to Host persistence for this gateway-authenticated deployment.

The patch fails closed unless both of these are true:

1. `@deepseek-ai/dsh-client-ui-settings` is exactly `0.1.7-alpha.1`.
2. The audited upstream persistence guard occurs exactly once.

Every Harness upgrade requires a fresh source, security, browser, provider, and persistence audit. Never change the pinned package version without updating and retesting the guard.

## Security

DeepSeek Harness is experimental agent software that can run commands, change files, access networks, install plugins, and spend model-provider credits. Its sandbox and approval prompts are not complete isolation.

- Use a private, single-operator deployment and a unique strong gateway password.
- Use dedicated provider keys with appropriate spend limits.
- Treat every plugin as executable code; review and pin it before installation.
- Back up `/data` and keep the service at one replica.
- Review agent commands and outputs before using important or sensitive workspaces.
- Do not expose regulated, confidential, or production credentials unless you have assessed the risk.

See the official [SAFETY.md](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-alpha.1/SAFETY.md) and [provider guide](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-alpha.1/docs/user/guide/providers.md).

## Licensing

The deployment wrapper in this repository is MIT licensed. DeepSeek Harness is separately MIT licensed by its upstream authors and includes additional third-party notices. Review the pinned upstream [license](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-alpha.1/LICENSE) and [third-party notices](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-alpha.1/THIRD_PARTY_NOTICES.md).
