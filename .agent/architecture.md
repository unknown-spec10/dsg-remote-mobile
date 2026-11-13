# Architecture

## Planes

| Plane | Runs in | Responsibility |
|---|---|---|
| Host plugin | DSH Host process (Cordis loader row `dsh-remote-mobile`) | Pairing server, bridge to Host services, Web Push sender, DSH web routes + desktop panel bootstrap |
| Client module | DSH Web UI (browser) | Settings → Remote mobile access panel (QR/PIN/devices) and the desktop approval dock |
| Phone SPA | Phone browser, served by the plugin server | Chat/streaming, approvals, sessions, commands, settings, PWA |

The plugin server is independent of the DSH web server: the phone talks to
`http://<host>:3456` (or an HTTPS proxy/Tailscale Serve in front), the desktop panel talks to the
DSH web origin and loopback-only plugin routes.

## Host startup (`index.js`)

`apply(ctx, config)`:

1. returns immediately when `config.enabled === false`;
2. creates the bridge (`bridge.js`) with peer-presence probes (`hasApprovalPeers`, `hasQuestionPeers`)
   so waterfall interception only happens while a phone is attached;
3. creates `RemoteMobileServer` and starts it inside a Cordis effect (disposal stops it);
4. registers same-origin pairing routes on the DSH `webServer` (waits for the service; the row can
   apply before the HTTP carrier is active);
5. pushes `__DSH_REMOTE_MOBILE__` (enabled/version/port/desk key/bind host) into owner pages via
   `webserver/index-inject` so the client panel can bootstrap over loopback.

The server listens on `0.0.0.0:3456` by default, retries `EADDRINUSE` with backoff, and keeps
one `.bak` generation of its pairing state.

## Transport (`server.js`)

- HTTP: SPA shell/assets, pairing/cookie auth, uploads/preview, desktop loopback endpoints,
  push endpoints (`/api/push/*`, including `/api/push/report` diagnostics).
- WebSocket `/ws`: JSON frames, cookie required, origin checked against `Host`. Full frame catalog
  is in `PROTOCOL.md`; do not invent frames.
- Security headers, strict CSP (`script-src 'self'`), body/socket caps, per-address PIN rate limit.
- Push: fan-out limiter, foreground suppression (visibility frames), per-session reply throttle,
  per-device test limit.

## Bridge (`bridge.js`)

Optional-service access via `ctx.get`, so a deployment missing a service degrades rather than
crashes. Main surfaces:

- `sessionController`: list/search/create/resume/prompt/cancel, events/history pages, projections,
  model catalog/selection, rename/fork.
- `agents`: live agent lookup (`agents.get(sessionId)`), used for queue, commands, prompt fallbacks.
- `approval/request`, `user-questions/request`: watermark interceptors answered by the phone first
  (desktop dock mirrors the same pending list; first answer wins).
- `workspaceRegistry`: project workspaces, pinned/archived sets, `workspaceId` per session row.
- `commands`: preset + host registry union via `commands.list(agent)`;
  `PHONE_HIDDEN_COMMANDS` / `PHONE_HIDDEN_COMMAND_DEFINITION_IDS` keep `/export` and `/permission`
  off the phone.
- `workspaceChanges`/`contextPressure`/`tokenMeter`: activity diff and context meter (live only).
- Attachments: uploads/`attachments`/`fileUploads`, inline-image prompt retry fallback.

Bridge methods return wire-shaped values; the server wraps them in frames. Errors map to protocol
codes (`bad-request`, `not-found`, `unavailable`, `forbidden`, `not-live`, …).

## Session lifecycle (phone perspective)

1. Pair → cookie → WS `ready` (`sessions`, `workspaces`, `device`, `limits`).
2. Open a session: summary + history page + queue/context when live. Cold sessions are readable
   but not activatable.
3. Prompt: resumes the agent on demand; streamed `assistant.start/delta/end`, tool frames, queue
   frames, approvals/questions.
4. Commands: live-only; list from the live Agent's registry; execute validates the name against
   that same registry.
5. Turn end: push `reply` when no phone page is visible.

Durable command/approval events are in the Host session log; the phone reloads history after a
command/approval to show the canonical node.

## Phone SPA (`mobile/`)

Vanilla JS, no build, no dependencies. `app.js` owns transport/state/render; `index.html` is the
shell + inline SVG sprite; `styles.css` the design system; `sw.js` the PWA shell cache. Asset
URLs are versioned (`?v=<n>`) and the SW cache name must match (`dsh-remote-v<n>`). Sheets are
single-instance and rebuilt through `buildSheet()` (clears the body) — never call a sheet builder
directly after an async frame or a spinner can survive under loaded rows.

## State and secrets

`$DSH_HOME/remote-mobile-state.json` (mode 0600): cookie HMAC secret, paired devices, VAPID key
pair, push subscriptions. `.bak` keeps the previous good copy; `.enabled` is the desktop switch;
`.public-url` the advertised HTTPS origin; `.desk-key` the loopback panel gate. Nothing here is
committed. Deleting the file forgets devices + VAPID keys.
