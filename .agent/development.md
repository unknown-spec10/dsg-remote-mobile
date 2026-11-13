# Development

## Prerequisites

- Node **>= 22** (the Host runtime is 24.x). No `npm install` is needed for the plugin or the SPA.
- On Windows, `node --check`/dev checks work in a normal shell. The live checks need the plugin
  installed in a running DSH profile; `ui-check`, `layout-probe` and `capture-screenshots` also
  need Chrome (`CHROME_PATH` overrides the default Windows path; `CDP_PORT` picks the debugging
  port).
- `dev/*` scripts use only Node built-ins (`fetch`, `node:http`, CDP over WebSocket).

## Deterministic check matrix

Run from the repository root. These must stay green before any commit.

| Command | Covers |
|---|---|
| `node --check server.js` (and `bridge.js`, `auth.js`, `push.js`, `index.js`, `client.js`, `qr.js`, `mobile/app.js`, `mobile/sw.js`, `mobile/mock-server.js`) | syntax/ESM validity |
| `node dev/release-check.mjs` | npm `files` completeness, required assets (README screenshots), semver + version consistency (6 places), client registration id == package name, `/permission`+`/export` hidden, no personal paths/TODOs/FIXME/eval/child_process in shipped files, publish metadata |
| `node dev/server-smoke.mjs` | HTTP/WS transport against a fake bridge: pairing, cookies, limits, frames, approvals/questions, push surface, uploads |
| `node dev/push-check.mjs` | RFC 8291 Appendix A byte-exact vector, VAPID JWT verify, aes128gcm decrypt, endpoint allowlist, pruning, caps, log hygiene, server wiring |
| `node dev/changes-bridge-check.mjs` | context meter, changed files/diffs, command registry union + hidden set, workspace mapping |
| `node dev/spa-check.mjs` | undefined SPA helpers, cached DOM ids, `?v=` refs vs SW `CACHE`/`PRECACHE` |
| `node dev/static-check.mjs` | served shell/assets, content types, `no-store`, CSP/security headers, PWA surface, share target |
| `node dev/client-check.mjs` | executes the client bundle against a fake module loader + React shim, asserts slot registrations |
| `node dev/desk-auth-check.mjs` | desktop pairing endpoint loopback/desk-key policy and same-origin route |
| `node dev/toggle-check.mjs` | the on/off switch closes and reopens the listener |

## Live checks

They pair a temporary device against the **installed and running** plugin, create/archive
throwaway sessions and revoke their own device. They mutate a development Host; never point them
at a Host you do not control.

| Command | Covers |
|---|---|
| `node dev/ui-check.mjs` | headless Chrome on the live SPA: project grouping, archived filter, collapse state, Commands sheet, no console errors |
| `node dev/layout-probe.mjs` | 320/360/390/412 px overflow + centred header/meter (env `WIDTH`, `OUT`) |
| `node dev/commands-live.mjs` | live palette, argument passthrough, `/export`+`/permission` refused, cleanup archive |
| `node dev/session-features-live.mjs` | rename/search/pin/archive guards |
| `node dev/model-effort-live.mjs` | reasoning catalog/selection round-trip (no model tokens) |
| `node dev/image-live.mjs`, `dev/changes-live.mjs`, `dev/approval-context-live.mjs`, `dev/live-check.mjs` | feature-specific live probes |
| `node dev/capture-screenshots.mjs` | regenerates `docs/screenshots/` from the mock (no Host, no personal data) |

## Mock server (`mobile/mock-server.js`)

Development-only, no dependencies, never imported by the plugin. It mirrors the v20 protocol
(`workspaces`/`workspaceId`, command palette, queue, approvals, questions, uploads, push routes)
so the SPA can be driven without DSH.

```powershell
cd mobile
node mock-server.js            # default http://localhost:3456, PIN 1234
node mock-server.js 3457       # alternate port
```

Env: `PORT`/`HOST`, `RM_PIN`, `RM_KEEP_PIN=1`, `RM_RATE_WINDOW_MS`/`RM_RATE_MAX`,
`RM_MAX_UPLOAD_BYTES`/`RM_UPLOAD_DELAY_MS`, `RM_BROKEN_PREVIEW_FIXTURE=1`,
`RM_SEARCH_DISABLED=1`, `RM_APPROVAL_READONLY=1`. The mock prints its PIN; it rotates after a
successful pair unless `RM_KEEP_PIN=1`.

`dev/capture-screenshots.mjs` starts this mock on a private port, pairs over HTTP, drives the SPA
in headless Chrome and overwrites the four README images. Regenerate after a UI change so the
README does not show a stale shell.

## Conventions

- **No dependencies, no build.** Host: `node:` built-ins only. SPA: plain browser JS, no bundler,
  no CDN, no inline scripts (strict CSP). Inline styles are allowed.
- **No new server or framework.** Extend `server.js`/`bridge.js` and the existing SPA.
- **Wire changes update `PROTOCOL.md`.** Client registration id, bundle patch name and version
  stay in sync (release-check enforces most of it).
- **Errors degrade, never crash the Host.** Optional services are looked up defensively; listener
  failures retry; bridge operations return protocol errors.
- **Do not log content/secrets.** Session ids, decisions/status only. Push endpoints, keys,
  PIN/token/cookie never appear in logs.
- **Testing with a fake bridge** (see `dev/server-smoke.mjs`, `dev/changes-bridge-check.mjs`) is the
  preferred way to pin frame/command semantics without a Host.
- **Committing:** `git add -A`, focused message on `main`, tag `vX.Y.Z` when releasing. The GitHub
  remote and npm scope are already configured (see `release.md`).
