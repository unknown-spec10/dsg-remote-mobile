# dsh-remote-mobile — agent guide

**Read this file first.** It is the onboarding contract for any agent (or human) working in this
repository. `.agent/` holds the deep-dive notes; this file is the short, always-loaded map.

- Repository: `dsh-remote-mobile` (npm `@deep-podder/dsh-remote-mobile`, scope owned by `deep-podder`)
- GitHub: <https://github.com/unknown-spec10/dsg-remote-mobile> (branch `main`)
- Current release in the tree: **0.0.6**
- Runtime target: **DeepSeek Harness 0.2.2-rc.3**, Desktop/Web profile on Windows
- No build step, no npm dependencies. Plain ESM Host plugin + plain browser JS SPA.

## What this plugin is

A DSH plugin that turns a phone into a remote control for a live desktop Harness session. It
runs a standalone pairing/HTTP/WS server inside the Host process, serves an installable mobile
web app, and bridges the phone to the same session, streaming, approval, question and command
pipeline the desktop UI uses.

```
phone browser ──HTTP(S)/WS──► <host>:3456 ──bridge──► DSH Host services
     ▲                        (pairing, cookie, rate limit)
     └── QR / 4-digit PIN from the desktop pairing panel ──┘
```

Two halves live in one package:

| Half | Files | Loaded by |
|---|---|---|
| Host | `index.js`, `server.js`, `bridge.js`, `auth.js`, `push.js`, `qr.js` | DSH Host (Cordis loader row) |
| Client | `client.js` | DSH Web UI client module system (settings section + approval dock) |
| SPA | `mobile/*` | The plugin's own server at `/` |

## Non-negotiable invariants

1. **Client module id == package name.** `client.js` calls
   `window.__ModuleLoader__.load({ id: '@deep-podder/dsh-remote-mobile', … })`. If the id does
   not equal `package.json`'s `name`, DSH rc.3 loads the bundle twice, throws
   `client-modules: duplicate factory registration`, and the whole Web UI fails to boot.
   `dev/release-check.mjs` enforces this.
2. **The bundle patch name == package name.** `cordis.patch.yml` inserts
   `name: '@deep-podder/dsh-remote-mobile'`; the scoped rename must be kept in sync with
   `package.json`. Renaming the package requires updating the profile dependency/junction too
   (see `.agent/deployment.md`).
3. **Version is one number in six places:** `package.json`, `index.js`, `server.js`,
   `mobile/app.js` (`FALLBACK_VERSION`), `mobile/mock-server.js`, and the PROTOCOL example.
   `release-check` fails on drift. Never hand-edit only one.
4. **Secrets never enter the repo or a log.** Pairing token/PIN, cookie HMAC secret, desk key,
   VAPID private key and push subscription endpoints live in
   `$DSH_HOME/remote-mobile-state.json` (mode 0600, plus `.bak`). Logs contain ids/status only.
   The repo is public; `dev/push-check.mjs` contains an RFC 8291 test vector (public example
   data, flagged by scanners as a false positive — do not "rotate" it).
5. **The phone gets no policy-changing command.** `/permission` (sandbox/approval preset,
   including `danger-full-access`) and `/export` are hidden from `commands.list` and refused by
   `bridge.executeCommand`. This must survive any future command-surface work.
6. **A paired phone never becomes a general HTTPS proxy.** Push subscription endpoints are
   validated against known push providers (or `PA_REMOTE_MOBILE_PUSH_HOSTS`), and
   `/api/push/test` returns counts only.
7. **You are probably running inside the Host you are changing.** Restarting Harness kills the
   session. Use `plugin_manager action=set_plugin` to reload `include:dsh-remote-mobile`; do not
   kill DSH processes. Full desktop restarts are the user's action.

## Where things live

| Path | Purpose |
|---|---|
| `index.js` | Host entry: creates bridge + `RemoteMobileServer`, registers DSH web routes and the page bootstrap global |
| `server.js` | HTTP/WS transport, pairing, cookies, rate limits, push endpoints, listener lifecycle |
| `bridge.js` | All Host-service interaction (`sessionController`, `agents`, `workspaceRegistry`, `commands`, approvals, questions, attachments) |
| `auth.js` | Device registry, HMAC cookie signing, PIN/token TTLs and rate limiting |
| `push.js` | RFC 8291 `aes128gcm` + RFC 8292 VAPID Web Push, subscription validation, state import/export |
| `client.js` | Desktop Settings section (QR/PIN/devices) + approval dock |
| `mobile/` | Zero-dependency SPA (`index.html`, `app.js`, `styles.css`, `sw.js`, manifest, icons) + dev mock |
| `dev/` | Deterministic checks + live checks + screenshot generator. Not shipped in npm |
| `docs/` | PROTOCOL/SECURITY companions, research notes, verification log |
| `.agent/` | This guide's deep dives |
| `cordis.patch.yml` | Bundle patch inserted into the profile |
| `package.json` | npm metadata (`files` is a strict whitelist), `publishConfig.access: public` |

## Quick commands

All commands run from the repository root. Node >= 22.

```powershell
# syntax + deterministic checks (no Host needed)
node --check server.js; node --check bridge.js; node --check auth.js; node --check push.js
node --check index.js; node --check client.js; node --check qr.js
node dev/release-check.mjs       # packaging, versions, client id, permission-hidden, path leaks
node dev/server-smoke.mjs        # transport/pairing/approvals/push surface against a fake bridge
node dev/push-check.mjs          # RFC 8291 vector + VAPID + encryption + endpoint allowlist
node dev/changes-bridge-check.mjs# context/changes/command registry semantics
node dev/spa-check.mjs           # SPA helpers, DOM ids, asset/service-worker version agreement
node dev/static-check.mjs        # served assets, CSP/security headers, PWA surface
node dev/client-check.mjs        # executes client.js against a fake module loader + React shim
node dev/desk-auth-check.mjs     # desktop pairing endpoint loopback/desk-key policy
node dev/toggle-check.mjs        # on/off switch closes and reopens the listener
```

Live checks pair a temporary device against the **installed, running** plugin (they mutate a
development Host; they create and archive throwaway sessions and revoke their own device):

```powershell
node dev/ui-check.mjs            # headless Chrome against the live SPA (grouping/commands/archived)
node dev/commands-live.mjs       # live command palette, argument passthrough, forbidden cases
node dev/session-features-live.mjs
node dev/model-effort-live.mjs
node dev/image-live.mjs
node dev/changes-live.mjs
node dev/capture-screenshots.mjs # regenerates docs/screenshots from the bundled mock
```

## Working agreement for agents

- Read this file and the relevant `.agent/*.md` before editing. Read `PROTOCOL.md` before
  touching wire frames.
- Keep the SPA zero-dependency (no npm installs, no CDN, no build step) and the Host plugin
  dependency-free (`node:` built-ins only).
- Keep everything in one package: no new per-domain workers, no second server, no framework.
- After any change: run the deterministic suite above; for wire/UI changes also run the live
  check (or ask the user to). Summary of checks: `.agent/development.md`.
- Update docs when behaviour changes: `PROTOCOL.md` for wire, `SECURITY.md` for trust, this file
  / `.agent/` for workflow, `README.md` for user-facing behaviour.
- Commit on `main` with a focused message. The GitHub remote is already configured; tags are
  `vX.Y.Z`. npm publishing needs the `deep-podder` account (2FA) — see `.agent/release.md`.
- Subagent sandboxes in this setup can be restricted to the workspace root; if writes to this
  checkout are denied, stage files elsewhere and let the Lead copy/commit them.

## Deep dives

- `.agent/architecture.md` — process/components, services, wire frames, lifecycle
- `.agent/development.md` — setup, check matrix, mock server, test conventions
- `.agent/deployment.md` — DSH profile/loader, scoped package install, reload/restart, state
- `.agent/phone-ui.md` — SPA structure, sheets, versioning, screenshots
- `.agent/security.md` — trust boundary, approvals, commands, push, secrets
- `.agent/release.md` — versioning, npm, GitHub, screenshots
- `.agent/troubleshooting.md` — known failures and the exact fix
- `.agent/decisions.md` — why things are the way they are (including hard-won lessons)
