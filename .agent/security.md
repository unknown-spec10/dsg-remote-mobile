# Security model and invariants

The full user-facing model is `SECURITY.md`; this file is the maintainer checklist.

## Trust boundary

**Trusted:** a paired device and its user (pairing is the security boundary). A paired phone can
read/open sessions, prompt, run benign Host commands, answer approvals (unless restricted),
upload files and manage its own pairing.

**Untrusted:** every other network peer, every web page, and all session/model content (prompt
injection must never become a permission). No internet exposure is supported.

## Authentication

- Pairing: one-time token (192-bit, 10 min, in the QR) or 4-digit PIN (5 min); per-address PIN
  limiter (5 failures / 5 min); pairing rotates both.
- Cookie `dsh_rm_session`: HMAC-SHA256 over `deviceId|expiry`, 30 days, HttpOnly, SameSite=Lax,
  Secure over TLS; constant-time compare; device must still exist. Secret lives in the state file.
- Desktop endpoints (`/api/desktop/*`, same-origin `/remote-mobile/pairing/*`) answer only a
  loopback peer/Host or the per-process desk key; remote origins get 403.
- WS upgrade requires the cookie; when present, `Origin` must match `Host`.

## Approvals and questions

- While a phone is attached it is the exclusive answerer; the desktop dock mirrors the same list.
  First answer wins (`approval.resolved` tells which side).
- Per-device `canApprove` (default true) is enforced before the bridge sees the answer.
- Approval payloads show a bounded, secret-scrubbed preview. Values whose arg key looks like
  password/secret/token/key/credential are never cached/shown. Context map capped (~200).
- A question unanswered by a phone eventually hands back to the desktop (documented grace).

## Commands — only benign ones

- `commands.list` mirrors the live Agent registry (preset + host union), **minus**:
  - `export` — desktop-only ZIP download (browser-auth route),
  - `permission` — switches sandbox/approval preset (`danger-full-access` would disable the
    approval gate);
  and minus any descriptor whose first-party definition id is `@deepseek-ai/dsh-permission-presets`
  (alias/rename protection). `executeCommand` validates against the same union, so a hidden name
  is `forbidden` even if sent directly.
- When adding command-surface features, never widen this set without a threat-model update.

## Push

- Endpoints must be `https:` on a known provider (FCM/Mozilla/WNS/Apple) or an operator suffix
  configured via `PA_REMOTE_MOBILE_PUSH_HOSTS`; arbitrary hosts are rejected on subscribe and on
  state import (no Host-as-proxy).
- Max 4 subscriptions per device / 16 total; test action max 6/min per device and returns counts
  only (not the push service response body).
- VAPID private key lives only in the state file; `sub` is configurable via
  `PA_REMOTE_MOBILE_VAPID_SUBJECT` (defaults to a placeholder mailto).
- Payloads: approval/question/reply/test kinds, bounded text, reply excerpt ≤150 chars (flattened,
  fences dropped, secrets scrubbed) — lock-screen-visible conversation content by design.
- Automatic pushes are capped (~30/min), deduped by tag, and suppressed when a phone page is
  visible. 404/410 prunes the subscription.

## Uploads / previews

- `/api/upload` cookie-auth, 32 MiB cap, confined to the session workspace
  `var/remote-mobile-uploads/`, filename sanitised + timestamped.
- `/api/preview` and inline images re-resolve with `realpath` and refuse anything outside that
  directory; image extension + byte cap only.

## Logging

- Never log PIN/token/cookie/HMAC secret/desk key/VAPID private key/push endpoint content.
- `debug.log`/`access.log` contain method/path/origin/host/peer/UA, decisions, pairing device name,
  approval ids/tool names and bounded push diagnostics. `/api/push/report` fields are collapsed to
  one bounded line (no log forging).
- Secret-screen/scanning: the repo's RFC 8291 test-vector `auth_secret` is public example data and
  is intentionally split to avoid generic-scanner false positives; do not treat it as a leak.

## Known limits (documented, do not "fix" silently)

- Plain HTTP LAN traffic is readable; use Tailscale/TLS.
- App lock (WebAuthn) is a client-side privacy gate; cookie/revoke is the real control.
- `/api/health` and `/api/state` are unauthenticated (version/paired state only).
- Desktop `Origin: null`/`file://` loopback access is accepted by design for the Electron panel.
- The phone cannot delete sessions, browse files, or change sandbox policy.

## Reporting

Security issues: private advisory at
<https://github.com/unknown-spec10/dsg-remote-mobile/security/advisories/new>; do not post real
transcripts or pairing data.
