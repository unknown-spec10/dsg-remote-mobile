# dsh-remote-mobile — wire protocol

This file is the contract between the three halves of the plugin:

| Half | Files | Responsibility |
|---|---|---|
| Host Cordis plugin + HTTP/WS server | `index.js`, `server.js`, `auth.js`, `push.js`, `qr.js` | pairing, static SPA, WebSocket hub, desktop routes, Web Push |
| Host bridge to the DSH runtime | `bridge.js` | sessions, prompts, streaming, approvals, questions, uploads |
| Mobile SPA (phone browser) | `mobile/index.html`, `mobile/app.js`, `mobile/styles.css` | the phone UI |
| Desktop pairing UI + dock (DSH web client) | `client.js` | the Settings panel and the synced approval dock |

No external npm dependencies anywhere. Plain ESM on the Host, plain browser JS in the SPA.

## Ports and origins

- Standalone server: `http://<bind-host>:<port>` — default `0.0.0.0:3456` (`0` picks a free port).
- The DSH Web UI keeps its own origin (for example `http://127.0.0.1:56770`) and is where
  `client.js` runs; it never loads the phone SPA.
- The mobile SPA is served **only** by the standalone server.

## Auth model

1. On enable, the Host creates an ephemeral **pairing token** (random bytes, base64url) and a
   4-digit **PIN** (`crypto.randomInt(0, 10000)`). PIN lives 5 minutes, token 10 minutes.
2. QR URL: `<public-url>/?t=<token>` — `public-url` is the selected interface (Tailscale
   Serve, tailnet IP, Wi-Fi), so the QR honours the chip selected in the desktop panel.
3. A valid `?t=` link makes the SPA `POST /api/pair` with `{ "token": "<token>" }`. The server
   consumes the token and replies `200 { "paired": true, "device": {...}, "version": "..." }`
   with `Set-Cookie: dsh_rm_session=<signed>; Path=/; HttpOnly; SameSite=Lax;
   Max-Age=<30 days>`, adding `Secure` when the request arrived over TLS.
4. Manual entry (`<public-url>/`) shows a PIN screen and calls `POST /api/pair` with
   `{ "pin": "1234" }`. Wrong PIN → `401 { "error": "invalid-pin" }`; more than 5 failures
   per address in 5 minutes → `429 { "error": "rate-limited", "retryAfterMs": n }`.
5. Cookie-protected routes are `POST /api/rotate-pin`, `POST /api/unpair`, `POST /api/upload`,
   `GET /api/preview`, the WebSocket upgrade and the `/api/push/subscribe`,
   `/api/push/unsubscribe`, `/api/push/test`, `/api/push/report` routes. `GET /api/health`,
   `GET /api/state`, `GET /api/push/key` and `POST /api/pair` are unauthenticated by design, as
   is the desktop-panel `/api/desktop/*` family (loopback/desk key instead of a phone cookie,
   see below). An unauthenticated upgrade is refused with `401` before any frame; a revoked
   device's socket is closed immediately.
6. `POST /api/unpair` and the desktop **revoke** both rotate every token and PIN, so a stale
   QR link or a cleared browser cannot silently re-pair.

### HTTP endpoints (standalone server)

| Method | Path | Auth | Request / response |
|---|---|---|---|
| GET | `/` | no | SPA `index.html` (CSP, `no-store`) |
| GET | `/app.js`, `/styles.css` | no | static assets, versioned by the page (`?v=<n>`), `no-store` |
| GET | `/api/health` | no | `{ ok: true, version }` |
| GET | `/api/state` | no | `{ paired, device: { id, name, createdAt, canApprove } \| null, version, pinTtlMs }` |
| POST | `/api/pair` | no | `{ token? }` or `{ pin? }` → `200 { paired, device, version }`, `401`, `429` |
| POST | `/api/rotate-pin` | cookie | `{}` → `{ pin, pinExpiresAt }` |
| POST | `/api/unpair` | cookie | `{}` → `{ ok: true }`, revokes this device and clears the cookie |
| POST | `/api/upload` | cookie | raw bytes, up to 32 MiB; headers `x-dsh-session` (required), `x-dsh-filename`, `x-dsh-media-type` → `{ ok, name, path, relativePath, size, mediaType }` (`path` is the absolute Host path, used by the phone only as an opaque attachment reference) |
| GET | `/api/preview?session=<id>&path=<path>` | cookie | the stored image bytes (`content-type`, `nosniff`, `private, max-age=300`); 404 when missing or not a previewable image |
| GET | `/api/push/key` | no | `{ enabled: true, publicKey }` — VAPID `applicationServerKey` (base64url raw P-256 point); `{ enabled: false, publicKey: null }` before the server starts |
| POST | `/api/push/subscribe` | cookie | `{ subscription: { endpoint, keys: { p256dh, auth } } }` → `{ ok: true, deviceId }`; `400 invalid-subscription` (bad shape, insecure scheme, or a host that is not a known push provider — see below), `429 too-many-subscriptions` (per device and global caps) |
| POST | `/api/push/unsubscribe` | cookie | `{ endpoint }` → `{ ok: true }` (removes only this device's endpoint) |
| POST | `/api/push/test` | cookie | `{}` → `{ ok, sent, gone, failed }` (status/counts only — never the push service's response body); `429 { error: "rate-limited", retryAfterMs }` above 6 sends/minute per device; no-op without subscriptions |
| POST | `/api/push/report` | cookie | bounded diagnostics from the service worker / SPA: `{ kind, detail, scope, permission? }` → `{ ok: true }`; each field is collapsed to one bounded line before it is appended to the Host debug log (no endpoints, keys or notification content) |

Request bodies are bounded: JSON bodies 64 KiB, `/api/pair` 8 KiB, uploads 32 MiB. The
desktop `/api/desktop/*` family additionally answers `OPTIONS` with `204` and CORS headers
for a loopback page (and the private-network preflight header).

### Desktop endpoints (loopback / desk key)

`client.js` runs on the DSH web origin, so it uses the same-origin routes the Host registers
on `ctx.webServer`:

| Method | Path |
|---|---|
| GET | `/remote-mobile/pairing` |
| POST | `/remote-mobile/pairing/rotate` |
| POST | `/remote-mobile/pairing/revoke` |
| POST | `/remote-mobile/pairing/enable` |
| POST | `/remote-mobile/pairing/disable` |
| GET | `/remote-mobile/pairing/pending` |
| POST | `/remote-mobile/pairing/answer` |
| POST | `/remote-mobile/pairing/device` |

`POST /remote-mobile/pairing/device` (same-origin) and `POST /api/desktop/device`
(body `{ deviceId, canApprove }` → `{ ok: true, device }`, 404 `missing-device` for an
unknown id) flip one paired device's approval permission. Both obey the same
loopback/desk-key policy as the other desktop routes.

The standalone server exposes the same data on `/api/desktop/status`, `/rotate`, `/revoke`,
`/enable`, `/disable`, `/pending`, `/answer`, `/device`. Those accept a loopback TCP peer
(the panel's keyed bootstrap path passes `?key=<desk-key>`); a remote origin gets 403 even
from this machine's browser. The desk key is written once per process to
`$DSH_HOME/remote-mobile-state.json.desk-key` (0600) and grants nothing over the network.
Each device row in `/api/desktop/status` carries `canApprove`.

### Static app surface (installable PWA + share target)

| Method | Path | Notes |
|---|---|---|
| GET | `/manifest.webmanifest` | `application/manifest+json`; standalone app, icons, share target |
| GET | `/sw.js` | root-scope service worker, `Service-Worker-Allowed: /`, `no-cache` |
| GET | `/icons/icon-192.png`, `/icons/icon-512.png`, `/icons/icon-maskable-512.png`, `/icons/apple-touch-icon.png` | PNG icons |
| GET | `/favicon.svg` | SVG favicon |
| GET | `/share-target?title=&text=&url=` | Web Share Target: `302` to `/?share=<urlencoded JSON {title,text,url}>` |

The service worker caches the shell (`/`, the versioned `/app.js` and `/styles.css`) so the
installed app opens offline, and never caches `/api/*`, `/ws`, `/remote-mobile/*` or the share
target. Installation requires a secure context (HTTPS, e.g. Tailscale Serve); on plain HTTP
the SPA works but no service worker is registered. The share redirect is handled entirely
client-side: the SPA reads `?share=`, pre-fills the composer, strips the query and never
auto-sends.

### Web Push (real background notifications)

Approvals, questions and finished replies are delivered through the browser Push API, so a
notification arrives while the phone page is frozen, the app is backgrounded or the screen is
off. The Host implements RFC 8291 (`aes128gcm` payload encryption) and RFC 8292 (VAPID) itself
with `node:crypto` and the global `fetch` (`push.js`, no npm dependency); the only third party
is the browser's own push service endpoint.

**Requirements.** Push needs a secure context: HTTPS (Tailscale Serve or a trusted TLS proxy)
or `http://localhost`/`127.0.0.1`. Plain HTTP over the LAN has no service worker and therefore
no push. The user must have granted notification permission to the installed app/tab.

**VAPID key.** `GET /api/push/key` is unauthenticated (the public key is public by design) and
returns:

```jsonc
{ "enabled": true, "publicKey": "<base64url, raw uncompressed P-256 point (65 bytes)>" }
```

`publicKey` is **base64url without padding**. Decode it to bytes before
`pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })` (browsers also accept
the base64url string; passing the decoded bytes is unambiguous). `enabled: false` with a `null`
key means the server is still starting.

**Subscribing.** After pairing, `POST /api/push/subscribe` with the cookie and
`{ "subscription": { "endpoint": "https://...", "keys": { "p256dh": "...", "auth": "..." } } }`
(any `PushSubscription.toJSON()`-shaped object; `keys.p256dh` must decode to 65 bytes and
`keys.auth` to 16). Success is `{ "ok": true, "deviceId": "<the cookie's device id>" }`. The
server keeps at most **4** subscriptions per device and **16** total; re-subscribing the same
endpoint refreshes it instead of growing the store; a full store answers
`429 { "error": "too-many-subscriptions" }` and a malformed shape
`400 { "error": "invalid-subscription" }`. Endpoints must be `https:` URLs whose host is a
known browser push service (FCM, Mozilla autopush, Windows WNS, Apple push) or a suffix the
operator configured with `PA_REMOTE_MOBILE_PUSH_HOSTS`; an arbitrary host is refused so the
Host cannot be used as an HTTPS request proxy (only the deterministic dev harness accepts
loopback `http:` endpoints).

**Unsubscribing.** `POST /api/push/unsubscribe` with `{ "endpoint": "..." }` →
`{ "ok": true }`. Only the calling device's own endpoint can be removed; an unknown endpoint is
an idempotent no-op. Unpairing, desktop revoke and device eviction also delete that device's
subscriptions.

**Test.** `POST /api/push/test` (cookie, empty body) sends one `kind: "test"` notification to
the calling device's subscriptions and answers `{ "ok": <at least one accepted>, "sent": n,
"gone": n, "failed": n }` (counts only; the push service's response body never reaches the
phone). Above 6 sends/minute for one device it answers
`429 { "error": "rate-limited", "retryAfterMs": n }`. With no subscriptions it is a no-op
(`{ "ok": false, "sent": 0, "gone": 0 }`) and touches no network. Unlike the automatic
notifications, this explicit action is not foreground-gated.

**Diagnostics.** The service worker and SPA may `POST /api/push/report` with a bounded
`{ kind, detail, scope, permission? }` body (`sw-activated`, `push-shown`, `push-error`,
`notification-click`, `push-enabled`). Each field is collapsed to one bounded log line before
it is appended to the Host debug log; it never includes endpoints/keys/notification content,
and exists so a delivery failure can be distinguished from an OS-level notification block.

**Encryption detail.** `aes128gcm` is RFC 8291 with the **empty AEAD AAD** used by
single-record pushes; authenticating the header instead produces a tag that the push service
accepts and the browser silently drops. `dev/push-check.mjs` pins the RFC 8291 Appendix A
wire body byte-for-byte next to the VAPID signature and decrypt round-trip.

**Push message payload.** The service worker's `push` event delivers JSON (`event.data.json()`):

```jsonc
{
  "kind": "approval" | "question" | "reply" | "test",
  "title": "Approval needed" | "Question from Harness" | "Reply ready" | "Test notification",
  "body": "short bounded text",
  "tag": "approval:<requestId>" | "question:<requestId>" | "reply:<sessionId>:<minute>" | "test:<deviceId>:<ts>",
  "sessionId": "..." | null,
  "url": "/?session=<sessionId>" | "/"
}
```

- `kind: "approval"` — `body` is `<toolName>: <bounded reason>` (or just the tool name); open
  `url` to answer with the pending approval card.
- `kind: "question"` — `body` is the first question's text, bounded to 160 characters.
- `kind: "reply"` — title is `Reply ready · <session title>` (title alone when unknown) and
  `body` is a bounded plain-text excerpt (≤150 chars) of the assistant's actual reply with
  fenced code dropped and markdown flattened; at most one per session per 60 s.
- `kind: "test"` — from `POST /api/push/test`.

Use the payload `tag` as `showNotification({ tag })` so a repeat for the same request replaces
the old notification instead of stacking. The payload never contains tool output, tool
arguments or secrets; the body is the bounded text described above (control characters are
stripped and secret-looking `key=value` pairs are redacted). A finished-reply notification is
conversation content on the lock screen by design — see SECURITY.md.

**Service worker expectations.**

- `push`: `const data = event.data ? event.data.json() : {}`; `event.waitUntil(self.registration
  .showNotification(data.title, { body: data.body, tag: data.tag, icon: '/icons/icon-192.png',
  badge: '/icons/icon-192.png', data: { url: data.url, sessionId: data.sessionId } }))`.
- `notificationclick`: `event.notification.close()`; focus a matching client or
  `clients.openWindow(event.notification.data.url)` (same-origin URL from the payload).
- `pushsubscriptionchange`: re-run `GET /api/push/key` → `pushManager.subscribe(...)` →
  `POST /api/push/subscribe` (same-origin, so the cookie rides along). If that fails, retry on
  the next app start.

**Gating, limits and expiry.** The SPA reports whether its page is visible with the
`client.visibility` frame below (on `visibilitychange` and once after `ready`). While **any**
connected phone page reports `visible: true` the server sends no push; when none is visible it
fans out to every stored subscription, capped at ~30 notifications/minute process-wide and
deduplicated by `tag` for 5 minutes. The desktop **Remote access** switch being off also
suppresses delivery (the subscriptions are kept and delivery resumes when it is switched back
on). Push services that answer `404`/`410` are pruned automatically. Browser/push-service
subscriptions can expire at any time, so the SPA should re-subscribe on start when
`Notification.permission === "granted"`.

## WebSocket

`ws://<host>:<port>/ws` (or `wss://` behind Tailscale Serve) — cookie required. JSON text
frames, one object per frame. Unknown types are ignored with an `error` frame. Every frame
carries `type`; data frames additionally carry `sessionId`.

### Client → Server

```jsonc
{ "type": "sessions.list" }
{ "type": "sessions.open",    "sessionId": "..." }
{ "type": "sessions.create",  "preset": "standard", "cwd": "/path/to/dir" }  // both optional
{ "type": "sessions.search",  "query": "literal message text" }   // cold-safe, max 20 sessions
{ "type": "session.rename",   "sessionId": "...", "title": "New title" }
{ "type": "session.fork",     "sessionId": "...", "atSeq": 123 }   // atSeq optional
{ "type": "session.pin",      "sessionId": "..." }
{ "type": "session.unpin",    "sessionId": "..." }
{ "type": "session.archive",  "sessionId": "...", "stopActivity": false } // stopActivity optional
{ "type": "session.unarchive","sessionId": "..." }
{ "type": "queue.list",       "sessionId": "..." }                // live sessions only
{ "type": "queue.update",     "sessionId": "...", "itemId": "...",
  "action": "edit" | "remove" | "steer", "text": "edited text" }  // text only for edit
{ "type": "history.load",     "sessionId": "...", "limit": 50 }   // limit 1..200, default 50
{ "type": "prompt",           "sessionId": "...", "text": "...", "requestId": "uuid",
  "mode": "queue" | "steer",                                       // default "queue"
  "attachments": [{ "path": "...", "name": "photo.jpg", "mediaType": "image/jpeg", "size": 1234 }] }
{ "type": "stop",             "sessionId": "..." }
{ "type": "approval.answer",  "requestId": "...", "decision": "allow" | "reject" }
{ "type": "question.answer",  "sessionId": "...", "requestId": "...", "callId": "...",
  "answers": [{ "id": "color", "selected": ["Blue"], "custom": null }] }
{ "type": "model.list" }
{ "type": "model.select",     "sessionId": "...", "provider": "...", "model": "...", "reasoningEffort": null }
{ "type": "preset.list" }
{ "type": "preset.select",    "sessionId": "...", "preset": "standard" }
{ "type": "limits" }                                           // image limits (additive)
{ "type": "context.get",      "sessionId": "..." }              // context-window meter
{ "type": "changes.list",     "sessionId": "...", "limit": 10 } // changed-file events (live only)
{ "type": "changes.diff",     "sessionId": "...", "seq": 0, "index": 0 }
{ "type": "commands.list",    "sessionId": "..." }              // every Host command (export/permission hidden)
{ "type": "commands.execute", "sessionId": "...", "line": "goal ship it" }  // "/" optional; args kept
{ "type": "client.visibility", "visible": true }                 // page foreground state (Web Push gating)
{ "type": "ping", "t": 0 }
```

`commands.execute.line` may be sent with or without the leading slash (`"/goal ship it"` or
`"goal ship it"`); the command name is validated against the live Agent's current command
registry, and the full trimmed line (arguments preserved) reaches that registry. Two commands
are hidden from the phone: `/export` (its Host command only records a lifecycle, and the desktop
browser then downloads the ZIP from a Host-only route the phone server cannot proxy) and
`/permission` (it switches the session's sandbox/approval preset, including
`danger-full-access`; sandbox policy must not be changed from a device that may itself be
restricted from answering approvals). Hiding is by name and by first-party definition id, so a
renamed alias cannot re-expose the policy switch.

Model selection: `model.list` returns the flattened Host catalog. Models that expose a
reasoning control carry `reasoning.efforts[]` (`id`, `name`, optional `description`) and an
optional `defaultEffort`; models without it have no `reasoning` field. `model.select` takes
the same `reasoningEffort` the catalog advertised (raw effort id). Omit it to fall back to
`defaultEffort`, and when the model has neither, the effective behaviour is the provider
default. The selected effort is echoed back in the `model` object of `sessions` rows and
`session.opened.session`, and `model.list.current.reasoningEffort` is the deployment default's
effort.

`prompt` accepts text, attachments, or both. Attachments are first POSTed to `/api/upload`
and the returned descriptors are forwarded here. The bridge now delivers uploads whose
`mediaType` starts with `image/` as **real inline image content parts**
(`{ type: "image", mediaType, data: <base64> }`) built from the stored bytes, so the model
sees the photo without a tool call. Every attachment still keeps a path reference in the
prompt text: non-images in the existing
`Attached files from the user's phone (read them with your file tools; images can be opened
with read_image):` block, inline images in an
`Attached images from the user's phone (shown inline in this message; already visible to you
— no tool call needed):` block. If the Host rejects the image parts for any reason (validation,
size, unsupported type), the bridge retries the same prompt once as text-only path
references, so a phone send never fails because of its images. Non-image files are never
inlined.

`prompt.mode`: `"queue"` (default) targets the session's next turn. `"steer"` injects into the
nearest step of a **running** turn; when the agent is idle (or after its turn ended) the Host
rejects it and the server answers with an `error` frame (`code: "bad-request"`). Steering does
not replace queued prompts and is best-effort by design.

`session.rename` is cold-safe: the Host resumes the session to append `session/title`,
normalizes the text (control sequences/whitespace) and truncates it to its configured UTF-8
byte budget (80 bytes in the shipped desktop composition). A title with no visible characters
is refused with an `error` frame (`code: "bad-request"`), not persisted.

`session.fork` is cold-safe. `atSeq` is an inclusive event boundary; omitted, the Host forks
the latest completed turn. The fork is a **new independent session** (not a subagent child)
and appears in the next `sessions` refresh. Sources that still need a desktop-side migration
answer with `code: "bad-request"` and a message asking to open the session on the desktop.

`sessions.search` searches literal message **content** (not titles), cold-safe. The Host caps
results at 20 sessions and 240 code points per snippet; there is no pagination in v1 (a
`hasMore` flag says the cap was hit). An empty query is `code: "bad-request"`.

Pin/archive are registry-global flags:
- `session.pin` prepends the session to the pinned set; pinning an archived session fails
  (`code: "bad-request"`, unarchive first).
- `session.archive` requires an inactive session unless `stopActivity: true` is sent, which
  stops a running turn/job first. Archiving drops the pin. Archived sessions stay visible in
  `sessions` (with `archived: true`) but cannot run a model step until unarchived.
- These calls acknowledge with `session.pinned` / `session.archived` and are followed by a
  `sessions` refresh.

Project workspaces: every `ready` and `sessions` frame carries `workspaces`, the registered
project workspaces in Host display order as `{ id, title, path, sessionIds }`. Every session
row (list/open/create) also carries `workspaceId`: the owning workspace id, or `null` when the
session belongs to no registered workspace (for example one created with a plain `cwd`). The
`sessionIds` membership mirrors the desktop sidebar grouping, so the SPA groups rows by
`workspaceId` and shows ungrouped sessions separately. Names, ids and project root paths only —
never session content.

`context.get` returns the context-window meter for one session. It is cold-safe (read from
the Host's `contextPressure` / `tokenUsage` projections): `usedTokens` prefers
`projectedTokens` (the size the next request would send) and falls back to
`pressureTokens`; `basis` is `"usage"` when a provider usage sample exists, `"estimated"`
when only the projection's estimate exists, and `"unknown"` for a session that never ran a
turn. `contextWindow` is the model's window when the Host recorded it. The same object is
included in `session.opened` as `context`.

Changed files: `changes.list` scans recent session events for `workspace/changes` and returns
one item per event (`seq`, `turn`, counts and files). File summaries are kept in Host memory
for live sessions only; an event whose summary is gone (cold session, another process, Host
restart) comes back as `{ available: false }` instead of an error. `changes.diff` takes the
event `seq` and the **original index in that summary's `files` array** and answers with either
text hunks (`kind: "text"`, unified-style lines without `@@` headers, `coarse` when the Host's
diff timeout forced a whole-file hunk), or `kind: "binary"` / `"oversized"` refusals. Paths are
relativised to the session directory or reduced to a short tail — the phone never receives
`cwd`, drive letters or home paths. Diff data is live-process only: unknown coordinates answer
`code: "unavailable"`.

Commands: `commands.list` requires a live Agent, so a cold session answers
`available: false` (the phone never activates a session just to list commands). For a live
Agent the bridge returns every descriptor from the Agent's Host command registry — including
commands mounted by the Agent preset (goal/plan/compact/feedback, …) — sorted by name, minus
the desktop-only `/export` and the policy-changing `/permission`. The phone therefore shows the
same benign command surface the desktop palette offers. `commands.execute` resolves the name
against that same live registry (never a static list), runs the full trimmed line on that Agent
(arguments preserved) and reports `command.result`; the Host logs durable `command/run` +
`command/done` events, so the phone should reload history afterwards to show the command node.
A cold session answers `code: "not-live"`, an unknown or hidden command `code: "forbidden"`.

### Server → Client

```jsonc
{ "type": "ready", "version": "0.0.6", "server": { "name", "port" },
  "device": { "id", "name", "canApprove": true }, "sessions": [], "workspaces": [],
  "activeSessionId": null, "queue": [],
  "limits": { "image": { "maxBytes", "maxDimension", "maxImages",
                          "maxMessageBytes", "mediaTypes": ["image/png", "..."] } } | null }

{ "type": "limits", "image": { "maxBytes", "maxDimension", "maxImages",
                               "maxMessageBytes", "mediaTypes": ["image/png", "..."] } | null }

{ "type": "sessions", "sessions": [
    { "id", "title", "running": false, "updatedAt": 0,
      "preset": "standard|null", "model": { "provider", "model", "reasoningEffort": "..." | null } | null,
      "agentAvailable": true, "pinned": false, "archived": false, "workspaceId": "ws-id|null" }
  ], "workspaces": [{ "id": "ws-id", "title": "Project", "path": "/projects/x",
                      "sessionIds": ["..."] }], "activeSessionId": "..." | null }

{ "type": "session.opened",
  "session": { "id", "title", "running", "preset", "model",
               "agentAvailable", "pinned", "archived", "workspaceId" },
  "history": [HistoryItem],
  "queue": [{ "id", "placement": "queued|steering|context", "rpcId": "..."?, "text": "..." }],
  "context": { "usedTokens": 0, "pressureTokens": 0, "projectedTokens": 0,
               "contextWindow": 0, "basis": "usage|estimated|unknown",
               "tokenUsage": { "inputTokens", "outputTokens", "totalTokens",
                               "reasoningTokens" } | null } | null }

{ "type": "session.updated", "sessionId": "...", "title": "New title",
  "session": { same shape as a `sessions` row } | null }

{ "type": "sessions.found", "query": "...", "hasMore": false,
  "results": [{ "id", "title", "snippet", "updatedAt", "running", "pinned", "archived",
                "agentAvailable", "workspaceId" }] }

{ "type": "session.pinned", "sessionId": "...", "pinned": true, "archived": false }
{ "type": "session.archived", "sessionId": "...", "archived": true, "pinned": false }

{ "type": "queue", "sessionId": "...",
  "items": [{ "id", "placement": "queued|steering|context", "rpcId": "..."?, "text": "..." }],
  "pendingInput": ["approval"|"question"|"other"], "running": true, "active": true }
{ "type": "queue.changed", "sessionId": "...",
  "items": [{ "id", "placement", "rpcId": "...", "text": "..." }] }

{ "type": "history", "sessionId": "...", "items": [HistoryItem], "hasMore": false }

{ "type": "context", "sessionId": "...",
  "usedTokens": 0, "pressureTokens": 0, "projectedTokens": 0, "contextWindow": 0,
  "basis": "usage|estimated|unknown",
  "tokenUsage": { "inputTokens", "outputTokens", "totalTokens", "reasoningTokens" } | null }

{ "type": "changes", "sessionId": "...",
  "items": [{ "seq": 0, "available": true, "turn": 1, "total": 2, "added": 10, "deleted": 3,
              "files": [{ "index": 0, "path": "src/app.ts", "display": "src/app.ts",
                          "added": 8, "deleted": 1, "binary": false, "oversized": false }] }
          ] }   // unavailable items: { "seq": 0, "available": false, "files": [] }
{ "type": "changes.diff", "sessionId": "...", "seq": 0, "index": 0,
  "kind": "text" | "binary" | "oversized", "path": "src/app.ts", "coarse": false,
  "hunks": [{ "oldStart": 1, "oldLines": 2, "newStart": 1, "newLines": 3,
              "lines": [" context", "-removed", "+added"] }] }

{ "type": "commands", "sessionId": "...", "available": true,
  "items": [{ "name": "goal", "description": "...", "hint": "[<objective>|clear]",
              "attachments": true },
            { "name": "plan", "description": "...", "hint": "[off|message]", "attachments": true },
            { "name": "compact", "description": "...", "hint": null, "attachments": false }],
  "reason": null }        // available:false with reason "not-live" | "unavailable";
                          // /export and /permission are hidden from the phone
{ "type": "command.result", "sessionId": "...", "commandId": "..." | null,
  "name": "goal", "kind": "success" | "error", "text": "..." | null,
  "sourceEventSeq": 0 | null }

{ "type": "assistant.start", "sessionId": "...", "turn": 1, "step": 1 }
{ "type": "assistant.delta", "sessionId": "...", "text": "...", "reasoning": null }
{ "type": "assistant.end",   "sessionId": "...", "turn": 1, "step": 1 }

{ "type": "tool.start", "sessionId": "...", "callId": "...", "name": "pwsh",
  "title": "Run command", "argsPreview": "...", "detail": { "command": "..." } | null,
  "question": null }                        // question payload when this call asks the user
{ "type": "tool.end", "sessionId": "...", "callId": "...", "ok": true,
  "output": "...", "durationMs": 120, "detail": null }

{ "type": "approval.request", "sessionId": "...", "requestId": "...", "toolName": "pwsh",
  "title": "Approval required", "reason": "...", "displayReason": "..." | null,
  "callId": null, "expiresAt": 0,
  // Additive card context, present only when the bridge already correlated the
  // tool call (callId); absent otherwise. Never contains secret-looking values.
  "argsPreview": "bounded, scrubbed preview (≤600 chars)",
  "argsKind": "command" | "write" | "edit" | "other",
  "detail": { "kind": "command" | "write" | "edit" | "other", "path": "..."? } }
{ "type": "approval.resolved", "sessionId": "...", "requestId": "...",
  "outcome": "allowed-once" | "rejected" | "cancelled" | "unavailable",
  "by": "phone" | "desktop" | null }

{ "type": "question.request", "sessionId": "...", "requestId": "...", "callId": "..." | null,
  "questions": [
    { "id": "color", "question": "Which colour?", "header": "Colour",
      "detail": null, "multiSelect": false,
      "options": [{ "label": "Red", "description": "Warm" }, { "label": "Blue" }] }
  ] }
{ "type": "question.resolved", "sessionId": "...", "requestId": "..." | null, "callId": "..." | null,
  "answers": [{ "id": "color", "selected": ["Blue"], "custom": null }] | null,
  "outcome": "answered" | "declined" | "unavailable",
  "by": "phone" | "desktop" | null }

{ "type": "session.status", "sessionId": "...", "running": true }
{ "type": "models",
  "catalog": [{ "provider", "model", "label",
                // Only when the model exposes a reasoning control:
                "reasoning": { "efforts": [{ "id", "name", "description": "..." | null }],
                               "defaultEffort": "..." | null } }],
  "current": { "provider", "model", "reasoningEffort": null } | null }
{ "type": "presets", "presets": [{ "id", "title", "description" }], "current": "standard" | null }

{ "type": "visibility", "visible": true }   // ack for client.visibility; not required for Web Push
{ "type": "error", "code": "bad-request|not-found|internal|not-live|unavailable|forbidden", "message": "..." }
{ "type": "pong", "t": 0 }
```

### Welcome replay

After `ready`, the server immediately replays every open interaction as its original frame —
each pending `approval.request`, then each pending `question.request`. A phone that reconnects
therefore sees the same cards again without asking the Host to re-emit them; answering from
either device settles the request once.

### HistoryItem

The SPA renders a flat, already-ordered stream. `kind` is one of `user`, `assistant`,
`tool`, `error`, `system`. Assistant message text is markdown and the SPA sanitises it.

```jsonc
{ "id": "seq:12", "kind": "user", "text": "...", "ts": 0 }
{ "id": "seq:13", "kind": "assistant", "text": "markdown...", "ts": 0 }
{ "id": "tool:call-1", "kind": "tool", "callId": "call-1", "name": "read",
  "title": "Read file", "argsPreview": "src/index.ts", "ok": true,
  "output": "…", "diff": null, "durationMs": 42, "ts": 0 }
{ "id": "seq:14", "kind": "error", "text": "...", "ts": 0 }
```

A `user` history item that was sent with phone uploads carries an `attachments` array in
addition to its clean text, so the SPA can render thumbnails through `/api/preview`:

```jsonc
{ "id": "seq:11", "kind": "user", "text": "what is this?", "ts": 0,
  "attachments": [{ "path": "...", "name": "photo.jpg", "mediaType": "image/jpeg" }] }
```

## Behaviour rules

- **Live vs cold sessions.** Every session row and `session.opened.session` carries
  `agentAvailable`: true only while the Host has an attached Agent. `queue.list`,
  `queue.update` and `prompt.mode: "steer"` are live-only; a cold session answers
  `code: "not-live"` (queue/steer) or the Host's busy/steer error, and the SPA must hide or
  disable those controls when `agentAvailable` is false. `sessions.list`, `sessions.open`,
  `history.load`, `sessions.search`, `session.rename` and `session.fork` are cold-safe.
- **Queue is the live inbox, not history.** `queue` items (`queued`/`steering`/`context`)
  live in the running agent's inbox; they become `user` history items only when the loop
  claims them at the next turn/step. `queue.update` supports `edit` (text only, non-empty),
  `remove`, and `steer` (only for a `queued` item of a running turn). There is **no
  reordering**. After any queue mutation the server pushes `queue.changed` (coalesced to at
  most one frame per session per ~120 ms) and `queue.update` also acks with a `queue` frame
  to the requesting device.
- **Pending queue replay.** `session.opened` includes the current queue (empty for a cold
  session), so a reconnect that re-opens its active session restores the queue; `ready`
  carries `queue: []` because no session is active on a fresh socket.
- **Inline images are best-effort.** The bridge inlines at most 4 images per prompt and at
  most the smaller of 5 MiB and the deployment's `maxImageBytes`/`maxMessageImageBytes`
  (plus `maxImagesPerMessage`); a stored upload larger than that, of an unsupported type, or
  otherwise unreadable is kept as a path reference instead of being inlined. The effective
  caps are advertised in `ready.limits.image` and on demand via `{ "type": "limits" }`
  (`null` when the Host cannot discover the attachment store). If the Host rejects the
  inline parts, the bridge retries once with a text-only prompt and logs a warning (counts
  only, no content). History rows are unchanged: user items still carry
  `attachments: [{ path, name, mediaType }]`, now parsed from both attachment blocks.
- **Search may be disabled.** `sessions.search` answers `code: "unavailable"` with a clear
  message when this deployment turns off the session-query index; the SPA should hide or
  disable search in that case rather than retrying.
- **Session metadata.** `agentAvailable`, `pinned`, `archived` and `workspaceId` are
  annotated by the Host from the live Agent registry and the workspace registry; missing
  workspace services degrade to `false`/`null`. Archived sessions remain in `sessions` (so the
  SPA can group them) but cannot run until unarchived.
- **Projects come from the workspace registry.** `ready`/`sessions` carry the registered
  `workspaces` in display order and each session row names its owning `workspaceId`; the SPA
  can reproduce the desktop's project grouping without extra round-trips. Workspaces are
  listed even when empty, and a session in no workspace is `workspaceId: null`.
- **The phone command palette mirrors the Host registry.** `commands.list` returns every
  command the live Agent's registry offers (host-plane and preset-mounted), sorted by name,
  minus `/export` (Host-only download route) and `/permission` (sandbox/approval policy switch).
  `commands.execute` validates against the same live registry and preserves arguments.
- **Approval cards carry bounded call context.** When a tool call was seen before the ask,
  `approval.request` adds `argsPreview` (≤600 chars), `argsKind`
  (`command`/`write`/`edit`/`other`) and `detail` (`{kind, path?}`, path only). Values whose
  argument key looks like a password/secret/token/key/credential are never cached or shown;
  the bridge keeps at most 200 call contexts and evicts oldest first. A card without a seen
  `callId` (or before the bridge observed the call) simply omits all three fields.
- **Per-device approval permission.** Every paired device has `canApprove` (default `true`,
  persisted, absent means `true`). A device with `canApprove:false` gets
  `{ "type": "error", "code": "forbidden", "message": "this device is not allowed to answer
  approvals" }` for `approval.answer`; the frame never reaches the bridge. Questions are not
  gated in this pass. The same device cannot widen its own sandbox: `/permission` is refused
  for every phone, so a restricted device cannot disable the approval gate it may not answer.
  The desktop panel flips the flag through
  `POST /api/desktop/device` or the same-origin `POST /remote-mobile/pairing/device`.
- **One answerer, first answer wins.** While a phone client is connected the bridge answers
  `approval/request` from the phone only (the desktop dock polls the same list, so either
  device can answer); the first answer clears both surfaces. With no phone connected the
  request goes straight to the shipped desktop answerer.
- **Questions follow the same exclusive routing, with a reconnect grace.** While a phone is
  connected it is the answerer. If **no** phone is connected when the question is asked, the
  bridge keeps the request pending for up to 45 seconds (`questionHandoffMs`) so a
  (re)connecting phone can still receive it; if no phone connects in that window it hands the
  request to the desktop chain and reports `outcome: "unavailable"` to the phone. A phone that
  disconnects after receiving a question does not start a new handoff timer.
- **Resolution frames name the answering surface.** `approval.resolved` and
  `question.resolved` carry `by: 'phone' | 'desktop' | null`; the SPA uses it to say
  "Approved on desktop" when the other device settled a card it was still showing. A
  question handed off to the desktop reports `outcome: "unavailable"`, which the SPA shows
  as "Moved to the desktop to answer."
- **Cards are session-scoped.** The SPA renders an approval or question card only inside the
  session it belongs to. Pending interactions for another session appear in the notice bar
  (`Approval needed in <title> (+N)`) with **Open**, which switches session and re-attaches
  the card. The server never needs to know which session the phone is viewing.
- **Session list refreshes are pushed.** A new approval, a status change, a create, a
  rename, a fork, or a pin/archive mutation makes the server re-list sessions and broadcast
  `sessions` (together with the current `workspaces`); clients must tolerate a `sessions`
  frame at any time (the SPA uses it for the notice bar, sidebar badges, project grouping and
  pin/archive grouping).
- **Web Push is per device and foreground-aware.** `client.visibility` (default unknown =
  not visible) gates every push: no push while a phone page reports itself visible, otherwise
  all stored subscriptions receive the JSON payload from the Web Push section. Pushes are
  best-effort and detached from the WebSocket path; a full store, a duplicate `tag`, the
  process-wide ~30/min cap, a visible page or an empty store all skip silently. Dead
  subscriptions (404/410) are pruned; the VAPID key pair and subscriptions live in the same
  state file as pairing under `push`, and revoking/unpairing a device deletes its
  subscriptions.
- Token and PIN are one-shot/rotating as described above; `revoke` drops one device
  immediately and closes its socket, and rotates all pairing material.
- The server keeps at most 8 paired devices; state lives in `$DSH_HOME/remote-mobile-state.json`
  (0600) so phones survive a Host restart. The same file's `push` field holds the VAPID key
  pair and the subscription store (absent in files written by older versions; the server then
  generates a fresh key pair).
- WS reconnect is the SPA's job: exponential backoff 0.5 s → 8 s, then `sessions.list` plus
  `history.load` for the active session; pending interactions are replayed by the server.
- Streaming deltas are throttled server-side to about 30 fps; the SPA may coalesce.
- Uploads are size-capped (32 MiB) and only previewable image types are served back by
  `/api/preview`; everything else is a normal attachment path in the transcript.
- Transport limits: WebSocket messages are capped at 1 MiB (oversize closes with `1009`),
  JSON request bodies at 64 KiB and `/api/pair` bodies at 8 KiB. Upload filenames are
  sanitised and previews are resolved and confined to the session's
  `var/remote-mobile-uploads` directory.
- PINs, tokens, cookies, the desk key and the VAPID private key are never written to any log.
  The optional request trails record method, path, origin, Host header, peer address, user
  agent and allowed/denied only; the debug trail additionally records pairing method/device
  name and `approval.request` / `approval.answer` ids and decisions. Push delivery logs only
  aggregate/wire outcomes — never the endpoint, subscription keys or payload body.

- **Client-only features.** The install prompt, service-worker registration, notification
  permission/subscription, voice input, camera capture, Android share target and the WebAuthn
  app-lock gate are local to the SPA; they degrade silently when the browser or secure context
  does not support them and never change the wire protocol (delivery itself is server-side Web
  Push, above). The app lock is a privacy gate over the same authenticated session, not a
  server rule.
