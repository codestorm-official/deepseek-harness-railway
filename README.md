# RAKIT DeepSeek Harness on Railway

An independent deployment wrapper for the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web UI. RAKIT is not affiliated with or endorsed by DeepSeek AI. Upstream branding, copyright and licenses remain with their authors.

One Railway service, one replica, one persistent volume at `/data`. No database, Redis, or external proxy is required. The gateway listens on `0.0.0.0:$PORT`; Harness explicitly listens on `127.0.0.1:3080`.

The pinned `@deepseek-ai/dsh@0.1.7-alpha.1` remains unchanged. This is a production-conscious wrapper around experimental software, not a claim that Harness is production-ready. Read the official [safety notice](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-alpha.1/SAFETY.md).

## Railway setup

Deploy this fork as **one service**, using its **Dockerfile**. Leave Build Command and Start Command empty: Docker installs locked dependencies, applies the guarded compatibility patch, and starts through `tini` and `entrypoint.sh`.

| Setting | Value |
| --- | --- |
| Service name | `rakit-deepseek-harness` (suggested) |
| Builder | Dockerfile |
| Replicas / regions | One replica in one region |
| Volume mount | `/data`, attached to this service |
| Networking | One public HTTPS domain, targeting gateway `PORT` |
| Health check / timeout | `/healthz` / 300 seconds |
| Restart policy | On failure, up to 10 retries |
| Shutdown grace / draining | At least 15 seconds |
| Serverless / sleeping | Disabled for background work and sessions |

Do not expose the internal port through a TCP proxy or separate domain. A custom domain must be the single canonical `RAILWAY_PUBLIC_DOMAIN`; other domains are rejected. Health checks accept Railway's separate health-check Host header and expose only readiness status.

`railway.patch.yml` is a **Harness invocation overlay**, not Railway infrastructure configuration. It keeps newly initialized browser workspaces under `/data/workspace`. Dashboard settings above are explicit; no extra Railway infrastructure file is required for Dockerfile detection and automatic startup. [Railway configuration reference](https://docs.railway.com/config-as-code/reference).

## Environment variables

| Variable | Final value / requirement |
| --- | --- |
| `HARNESS_ACCESS_USERNAME` | Choose 3–64 characters from letters, digits, `.`, `_`, `-`. |
| `HARNESS_ACCESS_PASSWORD` | Unique random secret of **16+ characters**, maximum 256. Existing short passwords still start with a warning for compatibility; rotate them. |
| `RAILWAY_PUBLIC_DOMAIN` | Railway-generated hostname, without scheme, path or trailing slash. Explicitly set the canonical hostname when using a custom domain. |
| `PORT` | Railway-provided dynamic port; must differ from the internal port. |
| `DSH_HOME` | `/data/.dsh` (image default). |
| `WORKSPACE_DIR` | `/data/workspace` (image default). |
| `DSH_TELEMETRY_DISABLED` | `true` (image default). |
| `DSH_INTERNAL_PORT` | Optional; defaults to `3080`. |
| `NODE_ENV` | `production` (image default). |

No session signing secret or launch token needs configuration. Set credentials through Railway's secret-variable UI; keep them out of source, build arguments, URLs and logs.

Model-provider credentials are optional at deployment. After login, configure **Settings → Models**. The official [provider guide](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-alpha.1/docs/user/guide/providers.md) describes write-only keys in `$DSH_HOME/.credentials.yaml`. Profile settings remain under `$DSH_HOME/profiles/`. Choose `/data/workspace` when adding a workspace manually; arbitrary directories outside `/data` are ephemeral.

## Gateway protections

- All routes and WebSocket upgrades require authentication except login and readiness. HTTP Basic API clients are supported; authenticated API calls are proxied directly without redirecting mutations.
- Login uses a signed, expiring CSRF cookie/form challenge and exact Origin validation. State-changing cookie requests and WebSockets require the canonical Origin. Host and Fetch Metadata are checked before proxying; upstream trust checks stay enabled.
- Each login creates a random, server-held session with a 12-hour absolute lifetime. HTTPS cookies use `__Host-`, `Secure`, `HttpOnly`, and `SameSite=Strict`. Sessions end on gateway restart. `POST /__gateway/logout` with the canonical Origin revokes the session and disconnects its WebSockets. Logout does not undo submitted work.
- Shared account throttling permits 30 form submissions or failed Basic attempts per 15 minutes. Existing sessions keep working. Forwarding/IP headers cannot bypass it. Limits reset on restart; an attack can temporarily block legitimate new logins.
- Harness's launch token is exchanged for its signed cookie over loopback. Both stay server-side; neither appears in browser redirects or cookies. Public `token` query parameters are rejected.
- Browser Authorization, cookies and forwarding headers are stripped upstream. The only forwarded auth cookie is obtained internally from Harness. The wrapper never logs request bodies or credentials. Known environment secrets and launch tokens are redacted from both Harness output streams.
- Login bodies/timeouts are bounded. Proxy errors omit request URLs and credentials. Native Node HTTP streams uploads, downloads, SSE and WebSockets without an additional proxy dependency.

Loopback domains use HTTP cookies for local development only. Public deployments require Railway HTTPS. This is a private **single-operator** service, not a tenant-isolated platform.

## Persistence and permissions

`entrypoint.sh` rejects storage paths escaping `/data`, including symlink escapes. It initializes required directories, fixes only their ownership when needed, sets private directory permissions, and starts the app as UID/GID `10001`. It does not recursively change ownership each boot. A private umask protects new state files; the existing credential store gets mode `0600`.

Application files in `/app` stay root-owned. `tini` reaps orphan processes. Shutdown stops accepting traffic, closes upgraded sockets, signals Harness, waits for its exit, and enforces a 10-second deadline. Unexpected Harness exits fail the service even if Harness exits with code zero.

For legacy volumes with nested files owned by a different UID, back up and inspect ownership before a **one-time operator repair** of affected paths to UID/GID `10001:10001`. The wrapper deliberately does not rewrite all workspace ownership on deployment.

Back up `/data`; it contains plaintext provider credentials protected by filesystem permissions, not wrapper encryption. Railway retention, backup and project access controls require operator configuration. Volume redeployment can involve downtime; keep one replica.

## Compatibility patch

The pinned client chooses memory-only settings for non-loopback pages. `patch-upstream.mjs` changes only that client selection to Host persistence so the authenticated operator can save model configuration. It does **not** change server authentication, authorization, Host/Origin fences, sandboxing or approval policies.

The build fails unless `dsh`, `dsh-client-connection`, and `dsh-client-ui-settings` all match reviewed version `0.1.7-alpha.1` and the exact original guard occurs once. Reapplying to patched content also fails. Every upgrade needs a new source review and real browser/persistence tests. No automatic upgrade is performed.

## Verification

On Node 24:

```sh
npm ci
npm test
npm run patch:upstream
npm run test:upstream
npm audit --omit=dev
docker build -t rakit-deepseek-harness:local .
```

`npm test` checks login, invalid credentials, API protection, CSRF, Host/Origin validation, session expiry/restart/logout, throttling, header sanitization, token containment, readiness, WebSocket rejection/tunneling and patch drift using generated credentials and a loopback fixture.

`test:upstream` separately starts the **real pinned Harness**, saves a generated credential and setting through its authenticated API, registers a workspace, restarts against the same directory, and checks persistence, write-only credentials, old-session rejection and log redaction. It needs Node 24 and a complete patched installation. It makes no model-provider requests. CI runs these checks and builds Docker; CI has not run as part of this local change.

See [SECURITY_AUDIT.md](SECURITY_AUDIT.md) for local results and limitations. A filesystem restart test does not prove Railway volume attachment or redeployment behavior.

## Live Railway acceptance

1. Confirm one service/replica, attached `/data`, HTTPS routing and `/healthz`. Inspect listeners: only gateway binds `0.0.0.0`; Harness binds `127.0.0.1`.
2. Check login, unauthenticated API/WS rejection, authenticated chat/terminal WS and downloads. Confirm browser URLs, cookies, headers and Railway logs contain no launch token.
3. Save a dedicated provider key, change a setting, create a workspace/file under `/data/workspace`. Restart, then redeploy. Log in again; confirm the key remains configured without being displayed, settings/history survive, and the file is intact.
4. Restart during active WebSocket/background work. Confirm clean shutdown, readiness transitions, reconnect after login, and no orphan processes or corrupt state.
5. Check fresh/existing volume ownership and credential permissions, unchanged nested ownership on subsequent boots, and backup/restore.

## Remaining risk and licensing

Harness is an unaudited developer preview capable of executing commands/plugins, accessing files/networks and spending credits. Dedicated keys, spend limits, reviewed plugins, command approvals and backups remain necessary. Agents run with the wrapper's UID; container filesystem/process boundaries do not isolate malicious authenticated agents. Known-secret redaction cannot guarantee arbitrary plugins or agent output will never disclose a new secret. Restrict Railway project/log access.

The Node 24 base-image tag receives updates, so images are not digest-reproducible. Rebuild and scan the Linux image before public use. npm audit does not cover OS packages, unknown vulnerabilities, native addons or runtime plugins. Dependency lifecycle scripts remain enabled because the locked upstream graph contains native/required install hooks; review lockfile changes.

The wrapper's existing [MIT license](LICENSE) and copyright notice are preserved. Upstream package notices remain in the image. Review the pinned upstream [LICENSE](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-alpha.1/LICENSE) and [THIRD_PARTY_NOTICES.md](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-alpha.1/THIRD_PARTY_NOTICES.md).
