# Internal verification log

**Status: maintainer notes, not part of the public contract.** This file preserves the
manual verification evidence gathered while building v1 on the installed
**DeepSeek Harness 0.2.2-rc.1 Desktop profile**. Re-run the deterministic checks in
[README.md](../README.md) before a release and refresh this log; live probes are manual and
mutate the Host, so they are not CI checks.

## Host activation and pairing

- Host activation: plugin row `include:dsh-remote-mobile` active; `GET :3456/api/health` OK.
- Pairing: token pairing sets an `HttpOnly` cookie; replaying the token is rejected; wrong
  PINs trip the per-IP limiter (429); unauthenticated WebSocket upgrades are refused.
- Desktop data: panel status endpoint returns PIN, QR SVG and ranked LAN addresses.
- Live session data over the phone protocol: 6 sessions listed with titles/presets, history
  pages, 31-model catalog, preset roster, new-session creation and a real streaming prompt
  round-trip (`assistant.start → deltas → assistant.end`).
- Client half: module factory executes and registers `settings.section` `remote-mobile` and
  the `shell.overlay` desktop approval dock.
- Approval round-trip over the phone protocol: request reached the phone, the same request
  appeared in the desktop pending list, approving from the phone resolved it, the pending
  list emptied (dock closes) and the turn completed. Re-confirmed on the real phone against
  the installed plugin (the answer is recorded as `approval.answer … accepted=true` in
  `remote-mobile-state.json.debug.log`).
- Mobile SPA rendering, verified headless at 390 and 320 px in light and dark themes: the
  cross-session notice bar occupies its own grid row (no overlap, no overflow, +N count, 44 px
  Open target); only the owning session renders a pending card; Open switches session and
  re-attaches approvals and questions; approval and question button rows are exactly even
  (same 46 px height and border box); attachment thumbnails open a lightbox, and the attach
  control is never clipped (38/38 assertions, plus all earlier suites green with zero console
  errors).
- Installable PWA surface served by the live plugin: manifest parses with the expected
  name/display/start_url, three icons (including a maskable one), `/sw.js` is returned with
  `Service-Worker-Allowed: /`, every icon is a valid PNG, and `/share-target` redirects into
  the app with the JSON payload.
- Session management over the live phone protocol: a session created with an explicit
  working directory, renamed (empty title rejected as `bad-request`), pinned/unpinned,
  archived/unarchived (the `session.archived` frame and the `sessions` set carry the flag; the
  phone hides archived rows by default behind **Show archived (N)**), and a cold session
  correctly rejects queue operations with `not-live`.
- Inline image prompt over the live protocol: a 16x16 red PNG uploaded from the phone was
  answered "Red OK" with no `read_image` tool call, proving the model received the image as
  an inline content part. The Host advertised limits (`maxImages: 4`, `maxBytes: 5 MiB`,
  png/jpeg/webp/gif).
- Approval cards over the live protocol: a real sandbox-escalation approval carried
  `argsKind: command`, `detail.kind: command` and the exact command in `argsPreview`; the
  escalation was rejected from the phone. The same run proved per-device permission: with
  `canApprove:false` the phone's `approval.answer` was refused with `forbidden`, the desktop
  toggle restored it, and the desktop device list reported the flag.
- Batch C UI (sessions grouping, rename/pin/archive/fork, queue strip, Queue/Steer, approval
  context, read-only device) verified with a protocol-level mock run (all frames and
  rejections) plus static integration checks; batch B PWA/voice/notification paths are
  covered by the static/PWA checks and the HTTP surfaces listed above.
- Static assets are versioned `?v=20` and served `no-store`, with the service worker cache
  bumped in step so an installed phone cannot pin an older bundle.
- Command palette over the live protocol (v20): `commands.list` for a live `standard` Agent
  returned `compact, feedback, goal, plan` with argument hints (`/goal`/`/plan` hints);
  `/compact` compacted 4 history items (~909 tokens), `/goal` reported "No goal is currently
  set", an unknown command was refused `forbidden`, and `commands.execute` preserved
  arguments. `/export` and the policy-changing `/permission` are hidden from the phone (the
  latter also by first-party definition id, so a renamed alias cannot re-expose it). The sheet
  no longer sticks on "Loading commands…" because the SPA rebuilds the sheet body through
  `buildSheet()` when the frame arrives; a 10-second timeout covers a lost reply.
- Project grouping over the live protocol (v20): every `ready`/`sessions` frame carries the
  registered workspaces (one project with 5 accounted sessions in the test Host) and session
  rows carry `workspaceId` (`null` for sessions created in temp directories). The SPA renders
  one collapsible section per project plus **Ungrouped**, keeps archived sessions out of the
  default list (explicit **Show archived (N)** control), persists collapsed projects, and
  forces sections open while searching. `dev/ui-check.mjs` asserts all of this against
  headless Chrome with zero console errors.
- Web Push hardening (v20): a subscription endpoint must be HTTPS on a known browser push
  provider (FCM/Mozilla/WNS/Apple) or an operator-configured suffix
  (`PA_REMOTE_MOBILE_PUSH_HOSTS`), so a paired device cannot use the Host as an HTTPS request
  proxy; arbitrary endpoints are also dropped when a saved state file is restored. A device
  may keep at most 4 subscriptions, `POST /api/push/test` returns counts only (never the push
  service's response body) and is limited to 6 sends/minute per device, and
  `POST /api/push/report` fields are collapsed to one bounded log line. `dev/push-check.mjs`
  asserts the allowlist and the RFC 8291/VAPID wire proof.
- Batch C3 over the live protocol (pre-v20 history): `context.get` reported
  `usedTokens 11214` against a `contextWindow` of 1,000,000 with `basis: "usage"` after a real
  turn; changed-file frames and diff hunks are covered by the deterministic bridge harness
  (`dev/changes-bridge-check.mjs`) and the transport smoke test; the live model only produced
  a file-writing turn intermittently, so the end-to-end live probe is best-effort.
- App lock: the state machine (cold start locked → assertion unlocks → 5-minute grace →
  30-second hidden relock → disable requires assertion) is executed headlessly, and the
  WebAuthn request parameters (`platform`, `userVerification: required`, ES256/RS256) are
  asserted by the static harness; real biometric prompts remain a device spot-check.
- Not verified automatically: the rendered desktop panel/dock appearance, real service
  worker install/offline behaviour, actual microphone input, live in-app notifications and
  Android share-sheet delivery (no browser control in the build session); the HTTP and wire
  surfaces behind them are verified, and the device spot-checks are listed in
  [mobile/README.md](../mobile/README.md).
