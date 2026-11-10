# Security model

`dsh-remote-mobile` lets a phone browser drive a DeepSeek Harness Host over the local
network. That is a deliberately powerful capability: a paired phone can read a session's
transcript, send prompts and answer tool approvals. This document states the trust
boundary, what is and is not protected, and how to revoke access.

## Threat model

**Trusted:** the paired device and the person using it. Pairing is the security boundary.
Once a device pairs it is treated as the same user as the desktop Host: it can read the
session list/history it opens, send prompts, run the Host commands registered for the live
Agent (the same palette the desktop offers, minus the desktop-only `/export` download),
answer approvals (unless the desktop restricts that device) and upload files into the session
directory.

**Untrusted:** every other network peer, and any web page the phone or desktop browser
visits. The server never accepts commands from an unpaired peer; remote origins cannot read
the desktop pairing data.

The design targets a single user on a trusted LAN or a private tailnet, not an
internet-exposed multi-tenant service. Do not port-forward the mobile port from the public
internet.

## Authentication and secrets

- **Pairing.** Two ephemeral secrets exist per Host process: a one-time pairing **token**
  (192-bit, 10 minutes, embedded in the QR URL) and a 4-digit **PIN** (5 minutes). A valid
  token or PIN creates a device record and rotates both secrets. Pairing is the only way in.
- **Session cookie.** Pairing returns `dsh_rm_session`, an HMAC-SHA256 signed value of
  `deviceId|expiry|signature` (30 days). It is `HttpOnly`, `SameSite=Lax`, `Path=/`, and
  `Secure` when the request arrived over TLS. The cookie-signing secret is generated once and
  persisted in `$DSH_HOME/remote-mobile-state.json` (created with mode 0600; Windows relies on
  the per-user profile ACL instead of POSIX modes) so devices survive a restart.
- **Constant-time comparisons** are used for the pairing token, the PIN and the cookie
  signature. PIN attempts are rate-limited per client address (5 failures in 5 minutes →
  `429` with `retryAfterMs`); token attempts are not rate-limited because the token is a
  192-bit random value.
- **Desktop pairing data.** The panel endpoint (`/api/desktop/*`,
  `/remote-mobile/pairing/*`) exposes the PIN, pairing token, QR SVG and device list. It
  answers only a loopback TCP peer, or a request carrying the per-process desk key written to
  `$DSH_HOME/remote-mobile-state.json.desk-key` (0600). Remote origins get `403` even when
  the request originates on the same machine.
- **No secret logging.** PINs, tokens, cookies and the desk key are never written to a log.
  The optional request trail (`*.debug.log`, `*.access.log`, both mode 0600) records request
  metadata (method, path, origin, Host header, peer address, user agent, allowed/denied
  outcomes), pairing device names, approval/push event identifiers and the bounded
  `POST /api/push/report` diagnostics line. Client-supplied diagnostic fields are collapsed to
  a single bounded line; no transcript text, prompt, tool argument, cookie or key is logged.

## Approvals

Approvals are the highest-value interaction: approving a sandbox escalation can run a host
command. The rules are:

- While a phone is connected, the phone is the **exclusive answerer** for Host approval
  requests; with no phone connected the request goes to the shipped desktop answerer. This
  prevents a stale duplicate card on one surface after the other answered.
- The desktop approval dock polls the same pending list, so the desktop can still answer a
  request the phone received. **First answer wins**; the other surface is cleared by the
  `approval.resolved` frame (`by: "phone" | "desktop"`).
- Each paired device has a `canApprove` flag (default `true`, persisted). A restricted device
  receives `{"type":"error","code":"forbidden"}` and the answer never reaches the bridge.
  Restrict a device when it is used by someone who should read the conversation and chat but
  not grant approvals. The restriction is not a read-only mode: a restricted phone can still
  send prompts and run benign Host commands. It cannot widen its own sandbox either — the
  policy-changing `/permission` command and the desktop-only `/export` are hidden from the
  phone command palette and refused by the bridge, so a restricted device can never turn off
  the approval gate it is not allowed to answer.
- Approval cards show a bounded, secret-scrubbed preview of the tool call when the bridge saw
  it. Values whose argument key looks like a password/secret/token/key/credential are never
  cached or displayed.
- Only `allowed-once`, `rejected`, `cancelled` and `unavailable` exist; there is no
  always-allow grant. The Host's `ask | never` policy decides whether a request is raised at
  all.

## App lock is client-side

The optional biometric app lock (WebAuthn platform passkey) is a **client-side privacy gate**
over an already authenticated session. It is not server enforcement and cannot be: the
authoritative credential is the pairing cookie. An attacker holding the unlocked phone and
developer tools can bypass the JS gate. Its purpose is to keep a shoulder-surfer or a briefly
unattended phone out of the app. It requires a secure context (HTTPS or localhost); over
plain HTTP the switch is unavailable. The recovery path is to revoke the device on the
desktop.

## Network exposure

- The default bind is `0.0.0.0:3456` so LAN and tailnet devices can reach it. Plain HTTP
  means the cookie and transcript are readable by anyone who can observe that traffic. Use
  it only on a network you trust.
- **Recommended: Tailscale.** Either use the `100.x` tailnet address (traffic is encrypted by
  WireGuard) or terminate HTTPS in front of the port with Tailscale Serve. HTTPS is also
  required for the service worker, installation and the app-lock switch.
- If you terminate TLS yourself, forward `X-Forwarded-Proto: https` so the cookie is marked
  `Secure`, and bind the Node server to loopback where possible. The server trusts that
  header; a direct client can only make its own cookie stricter, not weaker.
- WebSocket upgrades require the cookie. When an `Origin` header is present it must match the
  request `Host`, which blocks cross-site WebSocket hijacking.

## What an attacker on the LAN can still do

- Reach `/api/health` and `/api/state` (unauthenticated by design; they expose version and
  paired/not-paired state, never a secret). Without a valid cookie `/api/state` returns
  `device: null`; with one it returns that device's own summary (name and approval flag).
- Attempt PIN guessing: 10,000 combinations against a 5-minute window, with per-address
  lockout. A distributed attacker with many source addresses on the same LAN could still try;
  this is why the port should not be exposed to an untrusted network. Token pairing is not
  brute-forceable.
- Copy or replay the session cookie if it can read it (HTTP, or a TLS-terminating proxy it
  controls). Revocation is the only mitigation, so keep the listen port private.
- A sandboxed `Origin: null` page running in a browser on the Host machine can read the
  loopback desktop pairing endpoint (this is what lets the Electron `file://` client panel
  work). It cannot reach the cookie-protected phone API without a paired cookie. Treat
  untrusted local web content on the Host machine as a risk.

## Uploads and previews

- `POST /api/upload` is cookie-authenticated and capped at 32 MiB per request; JSON request
  bodies are capped at 64 KiB.
- Uploads are written under `<session workspace>/var/remote-mobile-uploads/` with the file
  name sanitised to `[\w.\- ]` and a timestamp prefix, so a name cannot traverse the
  filesystem.
- `GET /api/preview` and inline-image delivery re-resolve the requested path and refuse
  anything outside that directory, with an image extension and within the preview byte cap.
  They never serve an arbitrary host file.
- Tool output, error text and changed-file paths sent to the phone are truncated and
  path-redacted; tool arguments are shown to the paired device by design (the approval card
  is useless without them) unless the bridge is created with `redactPaths: true`.

## Web Push

Background notifications use standard Web Push: the Host holds a VAPID (P-256) key pair, the
phone's service worker registers a browser push subscription, and the Host encrypts each
payload to that subscription (RFC 8291 `aes128gcm`). Consequences:

- **Per-device and revocable.** A subscription is bound to the paired device that registered
  it. Unpairing, the desktop per-device *Revoke*, *Revoke all devices* and eviction by the
  paired-device cap delete that device's subscriptions. The VAPID key pair is independent of
  device revocation and lives until the state file is deleted.
- **The VAPID private key is a secret.** It lives only in memory and in
  `$DSH_HOME/remote-mobile-state.json` (`push.vapid`, the same 0600 file as the cookie secret)
  so notifications survive a Host restart. It is never logged and never returned by a route;
  only the public key (`GET /api/push/key`) is exposed, which is exactly what the browser needs
  for `applicationServerKey`.
- **Subscription endpoints and keys are stored locally.** The browser push endpoint URL and
  the `p256dh`/`auth` subscription keys are persisted in the same 0600 file. They are delivery
  capabilities for that browser, not read access to the session; revoking the device removes
  them, and a device can only unsubscribe its own endpoint.
- **Payloads are bounded and scrubbed.** A push carries a kind, a title, ≤160 characters of
  body, a tag, the session id and an app URL — never tool output, tool arguments or secrets.
  Control characters are stripped, secret-looking `key=value` pairs are redacted and
  approval/question text is truncated like an approval card. A finished-reply notification
  additionally carries a flattened excerpt (≤150 characters) of the assistant's reply, which is
  conversation content rendered by the lock screen — treat lock-screen previews of this app like
  any messaging app's, and turn the notification category off on the phone if that is not
  acceptable. A notification carries no buttons that could answer an approval.
- **Delivery is best-effort and foreground-aware.** Payload TTL is 300 s; delivery is capped at
  ~30/minute process-wide, deduplicated by tag for 5 minutes and skipped entirely while any
  phone page reports itself visible or the desktop **Remote access** switch is off (the
  subscriptions are kept in the latter case). The explicit **Send test notification** action is
  exempt from the foreground gate by design but has its own per-device rate limit (6/minute) and
  never returns the push service's response body. A failure (offline phone, expired
  subscription, push service error, 404/410) never affects the WebSocket path or the transcript;
  404/410 prunes the subscription.
- **Only known push services are contacted.** Subscription endpoints must be `https:` and use a
  known browser push provider (FCM, Mozilla autopush, Windows WNS, Apple push), or a suffix the
  operator configured with `PA_REMOTE_MOBILE_PUSH_HOSTS`. Anything else is refused when the
  phone registers it and when a saved subscription is restored, so a paired device cannot turn
  the Host into a request proxy to an arbitrary host.
- **The push endpoint is the browser vendor's service** (FCM on Android, Apple push for
  installed iOS web apps). A notification travels from the Host to that service and then to the
  device; the payload is encrypted to the subscription by design, while delivery metadata
  (endpoint, timing) is visible to the push service as with any web push.

## Revoking and rotating

- **Revoke one device:** desktop panel → *Remote mobile access* → device row → *Revoke*, or
  `POST /api/desktop/revoke` with `{ "deviceId": "..." }`. Its socket is closed immediately,
  its push subscriptions are deleted and every outstanding pairing token/PIN is rotated.
- **Revoke everything:** *Revoke all devices* (or `{ "all": true }`). All sockets close, all
  push subscriptions are deleted and all pairing material rotates, so a saved `?t=` QR link
  cannot re-pair.
- **Unpair from the phone:** `POST /api/unpair` revokes the calling device (and its push
  subscriptions), rotates the pairing material and clears the cookie.
- **Delete `$DSH_HOME/remote-mobile-state.json`** while the plugin is stopped to forget every
  device and the VAPID key pair; a new signing secret and VAPID pair are generated on the next
  start, so every old cookie is dead and old push subscriptions must re-subscribe.
- **Turn access off** with the desktop switch: the listener and all phone sockets close;
  the on/off choice and paired devices persist.

## Releasing / sharing a build

Before publishing a bundle, confirm `node dev/release-check.mjs` passes: it asserts the
package `files` list covers every runtime asset, `LICENSE`/`SECURITY.md` exist, every published
file is free of the build machine's personal paths, the version is consistent across the
package, Host constants, SPA fallback and PROTOCOL example, the phone cannot reach the
policy-changing `/permission` command, and the removed `/api/client-error` endpoint is not
referenced anywhere. Run the deterministic checks in `README.md`; live-pairing checks
(`dev/*-live.mjs`) touch a real Host.

## Reporting a vulnerability

Use the repository's private vulnerability reporting form
(https://github.com/unknown-spec10/dsg-remote-mobile/security/advisories/new) rather than a
public issue. Include the plugin version, the Harness version, and a minimal reproduction. Do
not attach real session transcripts or pairing data.
