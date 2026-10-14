# RAKIT wrapper review — 2026-10-14

Scope: all repository source/configuration, lockfile, license and ignore files. Existing PNG assets were inventoried and left unchanged. This is a wrapper review, not a full upstream security audit.

## Reviewed official sources

- Pinned [README](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-alpha.1/README.md), [SAFETY](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-alpha.1/SAFETY.md), Web/provider guides and CLI reference.
- Pinned [browser auth](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-alpha.1/packages/client/connection/src/browser-auth.ts), Connection admission, HTTP bridge, [Host/Origin fence](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-alpha.1/packages/client/connection/src/api-request-trust.ts), Webserver, settings/credentials/workspace controllers, API gateway and Web app startup.
- Pinned [client persistence choice](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-alpha.1/packages/client/ui-settings/src/client/index.ts). The retained patch changes a client decision; server admission stays enabled.
- [Railway configuration reference](https://docs.railway.com/config-as-code/reference). Dockerfile detection and automatic image startup need no additional infrastructure file; required settings are documented.

## Verified findings and changes

| Files | Security / reliability improvement |
| --- | --- |
| `gateway.mjs` | Replaced deterministic, unexpiring session credential with random server-held 12-hour sessions, logout/restart invalidation and WS expiry/disconnect. |
| `gateway.mjs` | Added signed login-CSRF challenge, canonical Host/Origin and Fetch Metadata checks; removed fabricated WS Origin. |
| `gateway.mjs` | Added shared-account throttling covering login forms and failed Basic attempts without trusting proxy/IP headers. |
| `gateway.mjs` | Stripped caller credentials/cookies/forwarding headers, removed public username prefill, and made Basic API mutations execute directly. |
| `gateway.mjs` | Removed browser launch-token redirects and cookie substring tests. Token/cookie exchange stays internal. Both output streams redact token URLs and known secrets. |
| `gateway.mjs` | Explicit loopback upstream bind; readiness needs authenticated HTTP 200. Probe caching/coalescing bounds health traffic. Child/listener failures stop service; bounded shutdown waits for child. |
| `entrypoint.sh` | Removed recursive boot chown. Added targeted ownership, private modes/umask, writable checks and storage-path containment. |
| `Dockerfile` | Root-owned app files, `tini` reaping, explicit SIGTERM; retained Node 24 and automatic startup. |
| `package.json`, lockfile | Removed gateway `http-proxy` and unused transitives. Native HTTP handles sanitized streams; unchanged pinned Harness is the only direct dependency. |
| `patch-upstream.mjs` | Preserved exact guard fail-closed behavior; added launcher/server version checks. Surrounding notices remain intact. |
| `railway.patch.yml` | Reviewed and retained official workspace-controller overlay under `/data`. |
| tests / CI | Added gateway/patch regressions, separate real-upstream persistence test, Node 24 CI and Docker build check. |
| ignore/attributes/docs | Excluded secrets/test data from image context, enforced shell LF endings, documented RAKIT deployment/security settings; existing LICENSE unchanged. |

## Local results

- **Passed:** nine gateway tests plus one compatibility-patch test (10 total), run directly in-process on host Node `21.5.0`. These verify the wrapper against fixtures, not the full Harness runtime.
- **Passed:** JavaScript syntax checks, `sh -n entrypoint.sh`, and `git diff --check`.
- **Passed:** offline `npm ci --dry-run --ignore-scripts --no-audit --no-fund` validates the package/lock install plan. It is not a dependency installation.
- **npm report:** `npm audit --omit=dev --json --registry=https://registry.npmjs.org` returned zero known vulnerabilities for the production lockfile. This is limited to the advisory data returned by that command.
- **Incomplete:** full `npm ci`; repeated connection resets left an incomplete local `node_modules`. Native install hooks and the actual patched npm distribution were not executed successfully.
- **Incomplete:** subprocess `npm test` was blocked by sandbox `spawn EPERM`; escalation was declined. Equivalent test files ran directly in-process successfully.
- **Incomplete:** real Harness persistence test stops at its Node 24 precondition on this Node 21 host. It needs installed dependencies and the patch. CI execution is pending.
- **Incomplete:** Docker build. Docker reports no running daemon; the build also hit sandbox build-state permission denial and build escalation was declined. No image scan/container validation is claimed.

## Remaining acceptance

Before publication, run Node 24 CI, build/scan the Linux image, and complete the README's live Railway checklist: volume restart/redeploy persistence of keys/settings/workspaces/history, fresh/existing volume permissions, HTTPS cookies, authenticated WS, loopback binding, provider UI compatibility, shutdown and backups.

Sessions and throttling intentionally reset with the single gateway process. Account-wide throttling can temporarily deny new logins under attack. The service has one operator identity and does not isolate tenants or malicious agents. OS/native/plugin vulnerabilities and arbitrary agent output are outside npm audit and known-secret redaction guarantees. Nothing has been published or changed upstream.
