# DSH Remote — mobile web client

Self-contained mobile SPA for the `dsh-remote-mobile` plugin. It is served **only** by
the plugin's standalone server (port 3456 by default) at `/`, `/app.js` and `/styles.css`.
Open it on a phone on the same local network, pair once, and control a DeepSeek Harness
session from the browser.

No framework, no npm dependencies, no CDN, no webfonts, no build step, no hashed
filenames. Everything shipped is plain HTML, CSS, browser JS, a manifest and PNG/SVG
icons.

| File | Purpose | Shipped |
| --- | --- | --- |
| `index.html` | App shell, inline SVG icon sprite, pairing + chat markup. References `/app.js?v=20` and `/styles.css?v=20`. | yes |
| `styles.css` | Design tokens and all component styles (light/dark, safe-area aware, reduced-motion aware). | yes |
| `app.js` | Transport, state, screens, safe markdown renderer, syntax highlighter, PWA/voice/notifications/share features. | yes |
| `manifest.webmanifest` | Installable PWA metadata, maskable icons and the Android Web Share Target. | yes |
| `sw.js` | Versioned (`v20`) shell service worker: navigation fallback, prefetched shell, stale-while-revalidate static assets; never caches `/api/*`, `/ws`, `/remote-mobile/*` or `/share-target`. | yes |
| `favicon.svg` | Small tab icon (same dark tile + signal mark as the app logo). | yes |
| `icons/icon-192.png`, `icons/icon-512.png` | `any`-purpose app icons. | yes |
| `icons/icon-maskable-512.png` | Maskable icon (glyph inside the 80% safe circle). | yes |
| `icons/apple-touch-icon.png` | 180 px iOS home-screen icon. | yes |
| `mock-server.js` | **Development only.** Zero-dependency Node mock of `/api/*`, `/ws`, the PWA/static routes and `/share-target`, including a hand-rolled RFC 6455 WebSocket server. Published only so a checkout can run it; the plugin never imports or serves it. | yes (dev helper) |
| `README.md` | This file (implementation notes; not served by the plugin). | yes |

> Packaging note: the host `package.json` `files` list names every shipped mobile asset
> (`index.html`, `app.js`, `styles.css`, `manifest.webmanifest`, `sw.js`, `favicon.svg`,
> `icons/*.png`, `mock-server.js` and this README); keep it in step when adding assets.

---

## Running the mock (development)

From the plugin root:

```powershell
cd mobile
node mock-server.js            # or: node mock-server.js 3457
```

The server prints:

```
Local:    http://localhost:3456/
Network:  http://<lan-ip>:3456/
PIN:      1234   (rotates after a successful PIN pair)
One-tap:  http://localhost:3456/?t=<random token>
```

Then either open the one-tap token URL (the SPA pairs, cleans `?t=` from the address bar),
or open `/` and enter the PIN. The PIN shown at startup is always valid; after a
successful PIN pairing the mock rotates it and logs the new one, matching the protocol's
rotation rule. Set `RM_KEEP_PIN=1` to disable rotation while developing.

Behaviour to exercise:

1. **Pair** with the PIN or token link. Rate limiting is wire-compatible (5 failures /
   5 min → `429 { error: "rate-limited", retryAfterMs }`); use
   `RM_RATE_WINDOW_MS=20000` to watch the countdown without waiting five minutes.
2. **Chat history** opens automatically; the seeded transcript exercises markdown,
   inline code, a fenced `js` block, a pipe table, lists, a blockquote, a link, a tool
   card, a settled `ask_user_question` card, a seeded image attachment (served by the mock
   preview route) and a failed tool.
3. **Attach a file** — tap the paperclip in the composer and choose **Take photo**,
   **Photo library** or **File** from the source sheet (camera uses
   `capture="environment"`; the library path is image-only). Each file uploads immediately
   with progress; images render as thumbnails in the chip and user bubble (tap for the
   lightbox), non-images stay as pills, and the reply acknowledges the names.
   `RM_MAX_UPLOAD_BYTES` (default 32 MB) and `RM_UPLOAD_DELAY_MS` make the
   upload/413/waiting states easy to exercise; `RM_BROKEN_PREVIEW_FIXTURE=1` adds a missing
   history image so the broken-preview pill can be exercised.
4. **Send a prompt** — e.g. `Deploy the mobile build to staging`. The mock streams tokens,
   emits a `tool.start`/`tool.end` pair, then asks a two-question `ask_user_question`
   batch (radio + multi-select + custom text). Answer it, then approve the approval card
   and the run finishes; reject it and the mock reports the denial. Skipping the question
   batch records a declined outcome.
5. **Ask a blocking question** — send `Ask me a blocking question`. The mock emits a
   `question.request` with no tool row, resends it once to exercise dedupe, then streams
   the closing reply after you answer.
6. **Cross-session fixture** — send `cross-session fixture test`. The mock emits a pending
   approval for the active session, a pending approval and a question for non-active
   sessions, then forces a `history` reload. The active approval renders inline; the other
   two appear in the notice bar with `Open`, which switches to the owning session and
   re-attaches the card there.
7. **Stop** while a run is streaming to see the stop button and `session.status`.
8. **Activity** tab shows step boundaries, the tool call (expandable input/output), the
   question and its answers, the approval and its resolution, filtered by All / Tools /
   Errors.
9. **Sessions / Model / Agent preset** sheets read the `sessions`, `models` and `presets`
   frames. The mock seeds two project workspaces plus one ungrouped session, so the sheet
   shows the same project grouping, **Show archived (N)** control and **Ungrouped** section
   the real Host drives. The ⋯ **Commands** sheet lists four demo Host commands (`compact`,
   `feedback`, `goal`, `plan`) with argument hints and opens the command-input sheet for the
   hinted ones. Creating a session inserts it and opens it. The overflow sheet also hosts the
   **Auto / Light / Dark** appearance control (stored in `localStorage`, applied before
   first paint on the next load). In the Model sheet, **V4.1 Flash** (default effort
   `Medium`) and **Claude Sonnet 4.5** (no default effort) open the reasoning-effort
   picker; picking an effort updates the chip, the ⋯ **Model** row trailing label and the
   mock session, while the plain models still select immediately.
10. Delete the `rm_session` cookie or use the menu's **Unpair this phone** to return to the
    pairing screen.
11. **PWA / offline shell** — on `localhost` (a secure context) the mock serves
    `/manifest.webmanifest`, `/sw.js` (with `Service-Worker-Allowed: /`) and the icons, so
    the installable/offline shell can be exercised. Add the app to a home screen and reload
    offline: the cached shell paints and the reconnect banner takes over until the server is
    back. The mock sends the same strict CSP as the Host so CSP regressions surface here.
12. **Share target** — open
    `http://localhost:3456/share-target?title=Title&text=Hello&url=https%3A%2F%2Fexample.com`
    (or call it from `navigator.share`-style tooling). The mock mirrors the Host's
    `302 /?share=<json>`; the SPA strips the parameter, opens the session and prefills the
    composer. `?share_text=` / `?share_url=` / `?share_title=` are accepted as aliases.
13. **Voice input** — needs a real browser API. Chrome on `localhost` may expose
    dictation; iOS Safari exposes `SpeechRecognition` only in some versions. The mic button
    is hidden automatically when the API is missing.
14. **Background notifications (Web Push)** — the mock serves `GET /api/push/key`
    (a real, freshly generated 65-byte P-256 VAPID key), the cookie-gated
    `POST /api/push/subscribe|unsubscribe|test|report` routes, and acks `client.visibility`
    over the socket. On `http://localhost:3456` (a secure context) the full lifecycle works
    in Chrome, including a real push-service subscription: **⋯ → Background notifications**
    (Off → Enabled), **Send test notification** (`{ok:true,sent:1,gone:0}`), then tap the
    switch again to unsubscribe. Mock delivery is intentionally local: it never reaches a
    real push service, so the test route reports success without a network send.

Mock environment variables:

| Variable | Effect |
|---|---|
| `PORT` / `HOST` | Listen port (default 3456) and bind address (default `0.0.0.0`). |
| `RM_PIN` | Fixed pairing PIN (default `1234`); it rotates after a successful pair unless `RM_KEEP_PIN=1`. |
| `RM_RATE_WINDOW_MS` / `RM_RATE_MAX` | PIN rate-limit window and failure count. |
| `RM_MAX_UPLOAD_BYTES` / `RM_UPLOAD_DELAY_MS` | Upload cap and artificial upload latency (413 / progress states). |
| `RM_BROKEN_PREVIEW_FIXTURE=1` | Adds a missing history image to exercise the broken-preview pill. |
| `RM_SEARCH_DISABLED=1` | Makes `sessions.search` answer `unavailable` like a Host without the index. |
| `RM_APPROVAL_READONLY=1` | Marks the demo device `canApprove:false`. |

`node dev/capture-screenshots.mjs` starts this mock on a private port, pairs a demo device and
regenerates `docs/screenshots/` from the current shell (used by the root README).
15. The mock also serves `/favicon.svg` and returns `204` for `/favicon.ico`, matching the
    production static table.

Environment variables: `PORT`, `HOST`, `RM_PIN`, `RM_RATE_WINDOW_MS`, `RM_RATE_MAX`,
`RM_KEEP_PIN`, `RM_MAX_UPLOAD_BYTES`, `RM_UPLOAD_DELAY_MS`,
`RM_BROKEN_PREVIEW_FIXTURE`. The mock is dev-only: it is not imported by the plugin, has no
auth beyond the demo cookie, keeps uploaded bytes in memory (never on disk) to serve
`/api/preview`, and must never be exposed beyond localhost/LAN development.

---

## Design notes

A calm, premium chat surface: warm off-white in light mode (`#F7F5F2`), near-black in
dark (`#161616`), system serif for assistant prose and headings, system sans for UI
chrome, and a single ink/paper accent for primary actions. No gradient bloom, no
glassmorphism, no webfonts, no icon sheet — only inline SVG.

### Theme

- Every colour, radius, duration and type family is a custom property in `styles.css`:
  `:root` is the light palette, `:root[data-theme="dark"]` the dark one, and
  `color-scheme` follows the effective theme.
- **No inline theme bootstrap** (the Host CSP is `script-src 'self'`, so inline scripts
  are blocked). `app.js` resolves the persisted preference
  (`localStorage["dsh-remote-theme"]`, values `auto` / `light` / `dark`) on init, writes
  `<html data-theme>` plus every `<meta name="theme-color">`, owns the Auto / Light / Dark
  segmented control in the overflow sheet, follows `prefers-color-scheme` while Auto is
  selected (live, without a reload), and keeps the choice across sessions. The first
  paint uses the light default until the deferred script runs.
- `prefers-reduced-motion: reduce` collapses transitions/animations and renders the
  streaming caret steady.

### Typography and shape

- Assistant replies are plain system serif (`"Iowan Old Style", "Palatino Linotype",
  Palatino, "Book Antiqua", Georgia, "Times New Roman", serif`) at 17.5 px / 1.55 with
  no bubble; headings, lists, blockquotes, links and inline code tune to the palette.
  UI labels use the system sans stack; code, durations and timestamps use
  `ui-monospace`.
- User messages are right-aligned warm-gray bubbles (20 px radius). Composer is a
  floating pill with a circular 44 px primary button: ink on paper in light, paper on
  ink in dark. Cards use 14–24 px radii, 1 px hairlines and only very soft shadows.
  Question cards use the same card language with serif question text, 46 px option rows
  and a single Skip/Submit pair; resolved cards settle into the elevated surface.
- Attachments use a 44 px paperclip button inside the composer, full-width progress
  chips above it (name, size, upload percentage/error, 44 px remove hit area) and
  image thumbnails (or file pills for non-images) inside the user bubble, with a
  full-screen lightbox on tap — paths are never shown.
- Spacing follows a 4 px rhythm with 18–22 px transcript gaps and generous empty
  states. Every primary control (icon buttons, tabs, send/stop, sheet rows, jump pill,
  approval buttons, PIN submit, per-message actions) reaches 44 px; secondary controls
  get invisible hit-area expansion.
- Below the composer pill sits one compact meta row laid out as a three-track grid:
  status note (left) · context-window meter (exactly centred on the viewport) ·
  Queue/Steer selector and model/effort chip (right). It is intentionally small
  (10–10.5 px labels) so the header can stay title + status only; the note truncates
  on the left, the chip ellipsizes on the right, and the row never scrolls
  horizontally on 320–412 px phones. The header is the matching symmetric row: a
  non-interactive spacer exactly one icon button wide balances the two-button right
  cluster, so the title block and its status line are truly centred (measured
  centre offset 0 px at 320/360/390/412 in both themes) while long titles ellipsize
  between the icon buttons.

### Accessibility and input

- Icon buttons have `aria-label`s, tabs use `role="tab"` + `aria-selected`, sheets are
  `role="dialog" aria-modal`, logs are live regions, focus is restored on sheet close,
  `:focus-visible` uses a 2 px ink ring, and links are external
  `rel="noopener noreferrer nofollow"`.
- Safe areas: `viewport-fit=cover` plus `env(safe-area-inset-*)` padding on the top bar,
  composer and bottom sheets. A `visualViewport` listener feeds `--app-h` so the iOS
  keyboard does not hide the composer.
- No hover dependence; all state is visible and actionable by tap. Haptics
  (`navigator.vibrate`, when available) fire on send, approve/reject and theme changes.
- Tool cards, activity entries and the markdown renderer are keyboard-accessible:
  expandable rows are buttons with `aria-expanded`, and every text/code copy control is
  a real button.

---

## Behaviour notes

### Pairing

- Boot probes `GET /api/state`. Paired → connect; unpaired → pairing screen.
- A `?t=<token>` link immediately `POST`s `/api/pair { token }`, then strips the query
  string with `history.replaceState`. Expired/consumed tokens fall back to the PIN form.
- PIN entry is a single transparent numeric input over four styled digit slots
  (16 px font avoids iOS focus zoom, `autocomplete="one-time-code"` supports SMS/Keychain
  autofill). Four digits auto-submit.
- Wrong PIN shakes and clears; `429` starts a visible `m:ss` countdown and disables entry.

### Connection

- `ws(s)://<host>/ws` with the pairing cookie. Close code `4401` returns to pairing with
  "device no longer paired".
- Reconnect uses exponential backoff `0.5s → 8s` (jittered, attempts capped), with
  `connected / reconnecting / offline` banner states driven by `navigator.onLine`.
- On every reconnect the SPA re-sends `sessions.list` and, for the active session,
  `history.load { limit: 50 }`, refreshing model/preset lists if they were already loaded.
- **Heartbeat and fast resume (v18).** After `ready`, on socket open and on every
  `visibilitychange`, the page sends `{type:"client.visibility", visible}` (only while the
  socket is `OPEN`) so the Host can suppress Web Push while a phone page is foregrounded.
  Any incoming frame refreshes `lastPong`, and a `ping` goes out every 5 s. While the app
  is visible a watchdog ticks every 5 s: if no frame has arrived for 15 s or the socket is
  not `OPEN`, it tears the socket down and reconnects immediately with the backoff reset.
  Returning to a foregrounded page is the important path: if the socket is missing or the
  last frame is older than 10 s, the SPA reconnects immediately (no backoff wait), and one
  quiet "Reconnected" toast is shown when the gap exceeded 2 s. A session-creation timeout
  whose socket is down also forces an immediate reconnect instead of leaving the banner
  stale. Nothing tries to keep a frozen page alive — this is intentionally "background
  disconnect + instant, correct recovery on resume".

### Transcript and streaming

- `assistant.delta` chunks accumulate in one live assistant item; DOM painting is
  coalesced into `requestAnimationFrame`, and only the live bubble is re-rendered — the
  list is never rebuilt per token. `assistant.end` finalises the bubble and removes the cursor.
- Sending is optimistic: a local user bubble is appended immediately and reconciled when
  `history`/`session.opened` arrives. Pending bubbles are deduped against durable `user`
  items by trimmed text; live assistant text survives transcript reloads.
- History tool items and live `tool.start`/`tool.end` are deduped by `callId`. Tool
  cards are **collapsed by default** (icon, tool name, status, duration, chevron); a tap
  expands a monospace args preview and scroll-capped output with a smooth height/opacity
  transition. Failures still auto-expand, and the expanded/collapsed state survives
  re-renders and the tool's own `tool.end` refresh.
- Assistant replies render as plain serif prose; a small **Copy** action copies the
  message text, and tapping the prose reveals the message timestamp. User bubbles reveal
  their timestamp on tap as well. Code blocks keep their language label and copy button.
- Scroll is pinned to the bottom unless the user scrolls up; a "Jump to latest" /
  "New messages" pill appears. Switching to Activity and back preserves the transcript.
- Empty states: no session, no messages, and a filtered-out activity feed each have
  purposeful copy (starter prompts only fill the composer, they never send).

### Activity

The tab shares the chat palette: compact All / Tools / Errors filter, a live indicator
(green while connected, muted while reconnecting), and a timeline of the active
session's step boundaries, tool calls, approvals and errors. Tool, approval and error
entries are collapsible with the same animated body used by chat tool cards; expanded
state is stored per entry id and survives live re-renders while the view is open.

### Approvals

`approval.request` renders an approval card with tool name, reason/displayReason, optional
callId and Approve/Reject. Answering is one-tap: both buttons disable while unanswered.
`approval.resolved` updates the card in place with the outcome
(`allowed-once` / `rejected` / `cancelled` / `unavailable`) and updates the Activity entry.
Approvals for a non-active session are remembered and surfaced when that session is
opened; a toast flags them immediately.

### Questions (`ask_user_question`)

- A question batch is a **first-class card**, never a collapsed tool chip. It renders a
  header (question `header` or tool title), a status chip (`Needs answer` / `Waiting` /
  `Answered` / `Skipped` / `Unavailable`), each question in serif with its detail text,
  radio rows for single-select, checkbox rows for `multiSelect`, an optional "Other"
  text input per question, and one Skip/Submit pair for the whole batch.
- `question.request` creates a card keyed by `requestId` (works even when no `tool.start`
  preceded it). A `tool.start` carrying `question` creates the same card keyed by
  `callId`; a later `question.request` with the same callId merges into it, so a batch
  is never duplicated. Duplicate/retried requests refresh the card without losing the
  draft.
- Draft selections and custom text are stored on the transcript item, so they survive
  re-renders (including a duplicate `question.request`). Submit is enabled once any
  question has a selection or custom text; unanswered questions are omitted from the
  answer batch. Skip sends an empty `answers` array (see the assumptions below).
- After `question.answer` the card locks into **Waiting for Harness…** until
  `question.resolved` or `tool.end` arrives. Then it becomes a read-only card showing the
  chosen labels and custom text (or `Skipped` / `No longer available`).
- Settled history rows (`kind: "tool"` with a `question` payload) render read-only; the
  answer batch is parsed from the JSON `output` when possible and otherwise falls back to
  **Answered**. The question is also recorded in the Activity feed.
- Pending questions for a non-active session are remembered in a client map and
  re-attached to the transcript when that session is opened.

### Cross-session interactions

- `sessionId` is authoritative: an approval/question whose `sessionId` differs from the
  active session is stored in the client maps but **never** appended to the transcript.
  Deduplication (tool.start + question.request twins) only merges items of the same
  session, and `appendMessage` has a defensive boundary that refuses a foreign approval or
  question. This prevents a card from the wrong session appearing inline.
- The notice bar is a direct child of the six-row `.app` grid on row 3 (between the tabs
  and the connection banner): full-width, safe-area margins, warning surface, first owner
  name and `(+N)` when more interactions are pending, with a 44 px **Open** action. It is
  re-rendered whenever approvals/questions arrive, resolve or a session opens, and removes
  itself when nothing foreign is pending.
- **Open** calls `openSession` for the owning session; `replaceTranscript` + the pending
  maps re-attach the card inline there, with normal answer actions (the stale
  `otherSession` flag is recomputed against the current active session, so a re-attached
  card never keeps the foreign-session meta/Open row). Approval actions are equal-width
  46 px buttons in both themes (the primary button carries a transparent 1 px border so
  it matches the ghost button's border box).
- The active session's own pending approval/question renders inline immediately and is
  re-attached after a `history` reload by the same maps.

### Attachments

- The paperclip button opens one hidden `<input type="file" multiple>` (no `accept`
  filter, so images and arbitrary files are both selectable; on mobile the OS picker
  offers Photos/Files). It is positioned inside the composer and is disabled while
  offline or without an active session.
- On selection each file is queued and uploaded **sequentially** to
  `POST /api/upload` (raw bytes) with `x-dsh-session`, `x-dsh-filename` and
  `x-dsh-media-type` headers and the device cookie. `XMLHttpRequest` supplies real
  per-file progress; Send is disabled while any upload is queued/running. Chips above the
  composer show name, size, progress, errors and a remove control (removing an in-flight
  file aborts its request). Files over the 32 MB client limit fail immediately with the
  size message; a server `413` is surfaced on the chip as well.
- After upload the chip shows `Uploaded` (image chips get a small thumbnail), and a
  successful response (validated for `name`/`path`/`relativePath`/`size`/`mediaType`) is
  kept as the attachment object. Failed uploads block sending until removed (or retried by
  selecting the file again).
- Image attachments render as rounded, `object-fit: cover` thumbnails inside the user
  bubble (two per row, single images capped around 220 px high); non-image files stay as
  file pills. Tapping a thumbnail opens a full-screen lightbox (dark backdrop, safe-area
  padding, filename caption) that closes on the image/backdrop, the 44 px close button or
  Escape. A thumbnail that cannot load is replaced by a `Preview unavailable` file pill.
- Optimistic images use `URL.createObjectURL(file)` for an immediate thumbnail; those
  composer URLs are revoked on remove, send and clear. After a history reload the same
  image is requested from
  `GET /api/preview?session=<sessionId>&path=<encodeURIComponent(path)>` using the current
  session; on error the bubble falls back to the file pill.
- Sending includes the successful upload objects as `attachments` on the `prompt` frame.
  The optimistic user bubble keeps the message text plus image thumbnails/file-name pills
  (never paths), and the chips clear only after the frame has been written to the socket.
  If the send fails, the optimistic bubble is removed (its object URLs revoked), the
  message is restored and the uploaded files stay attached. Attachment-only messages get
  an `is-attachment-only` bubble with reduced padding.
- History user rows now carry `attachments: [{path,name,mediaType}]` (the mock does) with
  the synthetic "Attached files…" block already stripped from `text`; the SPA uses those
  entries to rebuild thumbnails/pills after a reload. Attachments are session-scoped:
  switching sessions, unpairing or losing auth aborts uploads, clears the tray and revokes
  outstanding bubble object URLs.
- Media type falls back to an extension map when the picker reports none, and the
  filename header is sanitised to Latin-1/header-safe characters (the UI keeps the
  original name).

### Installable app and service worker (B7)

- `manifest.webmanifest` declares `name` / `short_name` "DSH Remote", `display`
  `standalone`, `orientation` `portrait`, `scope` and `start_url` `/`, the warm light
  `theme_color` / `background_color` (`#F7F5F2`), 192/512 `any` icons, a 512 maskable icon
  and a `share_target` (`action: "/share-target"`, `method: "GET"`, `title`/`text`/`url`
  params). `index.html` links the manifest, `/favicon.svg`, the 180 px
  `apple-touch-icon`, two media-scoped `theme-color` metas (light/dark) and
  `mobile-web-app-capable` next to the Apple meta tags.
- Icons are generated from the app's own logo language — a `#141210` ink tile with the
  cream signal mark — at 192, 512, 512 maskable (glyph inside the central 80% safe circle)
  and 180 apple-touch. They share the asset palette rather than a separate brand.
- `sw.js` is a zero-dependency classic worker with a versioned cache (`dsh-remote-v20`).
  Install precaches `/`, `/app.js?v=20`, `/styles.css?v=20`, the manifest, favicon and all
  icons, then `skipWaiting()`. Activate deletes older `dsh-remote-*` caches and calls
  `clients.claim()`. Fetch: navigation → network first, caching the shell and falling back
  to cached `/` (including `?share=` deep links) when offline; same-origin versioned/shell
  assets → cache-first plus stale-while-revalidate; everything else is left to the
  browser. It never intercepts or caches `/api/*`, `/ws`, `/remote-mobile/*`,
  `/share-target`, `sw.js`, non-GET requests, cross-origin requests or opaque responses.
- Registration runs only when `'serviceWorker' in navigator` and
  `window.isSecureContext` (HTTPS or localhost; plain-HTTP LAN URLs intentionally skip
  it), with `{ scope: '/', updateViaCache: 'none' }` and a silent failure path. The
  `controllerchange` listener reloads **once** when an update activates (guarded by
  `swReloading`), and does not reload on the first install's `clients.claim()`.
- Theme: the previous inline `<head>` bootstrap was removed because the Host CSP allows
  only `script-src 'self'`. `app.js` resolves the stored Auto/Light/Dark preference on
  init and updates every `theme-color` meta; the root keeps `data-theme="light"` until
  then.

### Voice input (B8)

- A 44 px mic button sits in the composer (`#btn-mic`, `i-mic` sprite symbol). It is
  feature-detected as `SpeechRecognition || webkitSpeechRecognition`; when neither exists
  the button stays `hidden` — no dead control and no console noise.
- Tapping starts continuous recognition with `interimResults = true` and
  `lang = navigator.language || 'en-US'`. Interim text is composed **after** whatever the
  composer already contained (existing draft preserved; a single space joins segments);
  final results append with a space. Tapping the mic again, sending, opening a sheet,
  switching to Activity, reconnecting, hiding the page or switching sessions stops it and
  commits the pending interim words into the composer first.
- Listening state: accent (ink pill) mic + pulse, `aria-pressed="true"`, placeholder
  "Listening…"; the pulse is disabled by `prefers-reduced-motion`.
- `not-allowed` / `service-not-allowed` / `no-speech` / `network` / `audio-capture` are
  mapped to short toasts and stop cleanly; `onend` restarts at most six times while the
  user still wants dictation, and `aborted` (our own stop) never toasts.

### Background notifications — Web Push (v18)

- **Why push.** Page-level `new Notification()` only fires while the SPA is alive and
  hidden; a backgrounded phone freezes the page, so approvals, questions and finished
  replies were silently missed. v18 moves delivery to the browser Push API: the Host sends
  an encrypted payload to the phone's push service, the service worker shows it even when
  the page is frozen, and tapping it re-opens the right session.
- **Requirements.** Push needs a secure context — HTTPS (Tailscale Serve or a trusted TLS
  proxy) or `http://localhost`/`127.0.0.1`. Plain HTTP over the LAN has no service worker
  and therefore no push; the menu row says **Needs HTTPS**. The user must grant
  notification permission on the installed app/tab. iOS requires a Home Screen install and
  iOS 16.4+; on Android Chrome, Web Push needs Google Play services present.
- **Menu row.** ⋯ → **Background notifications** now reports the real state: `Enabled`
  (subscribed), `Off`, `Needs HTTPS`, `Unsupported`, `Permission denied`, or
  `Subscription error` (with "tap to retry"). Enabling happens only on that tap: the SPA
  checks `isSecureContext`, `serviceWorker`, `PushManager` and `Notification`, requests
  permission, fetches `GET /api/push/key`, decodes the base64url VAPID key to bytes, calls
  `registration.pushManager.subscribe({userVisibleOnly:true, applicationServerKey})`,
  POSTs `subscription.toJSON()` to `/api/push/subscribe`, and toasts
  "Background notifications on". Disabling calls `subscription.unsubscribe()` and then
  `POST /api/push/unsubscribe` with the old endpoint before toasting
  "Background notifications off". A **Send test notification** row sits below it, enabled
  only while subscribed, and POSTs `/api/push/test`
  (toast "Test notification sent" / "No subscription on the Host — enable again.").
- **Re-sync, never auto-prompt.** After every `ready` (start and reconnect) and when the
  menu opens, the page reads `pushManager.getSubscription()`. When permission is already
  granted and a subscription exists it is re-POSTed idempotently, but the SPA never asks
  for permission on its own. A subscription that the Host pruned (404/410 on delivery) is
  recovered by the service worker's `pushsubscriptionchange` handler or the next manual
  enable. `subscribe()` is bounded by a 15 s timeout so a browser without a reachable push
  service cannot leave the row stuck on "Enabling…".
- **Fallback (no doubles).** If the page is hidden, permission is granted, and there is no
  live push subscription (unsupported/denied/not enabled), the old
  `new Notification()` path still fires for approvals, questions and reply-finished with
  the same per-tag/session dedupe. With a live subscription the service worker is the only
  notifier, so nothing double-alerts. The tab title still gets the `● ` attention prefix.

### Service-worker push handlers (v18)

- `push`: parses `event.data.json()` defensively (empty/malformed payloads still notify
  with a fallback title/body), then
  `registration.showNotification(title, { body, tag, icon:'/icons/icon-192.png',
  badge:'/icons/icon-192.png', data:{ url, sessionId, kind } })`. The Host's `tag`
  replaces a repeat notification for the same approval/question instead of stacking.
- `notificationclick`: closes the notification, focuses an existing same-origin app window
  and `postMessage({type:'open-session', sessionId})`; without one it
  `clients.openWindow(payload.url)` (`/?session=<id>`), so a cold tap opens the session
  after pairing/ready.
- `pushsubscriptionchange`: best effort — GET `/api/push/key`, re-subscribe with the
  decoded VAPID key, POST the new subscription; failure is retried on the next app start.
- The existing cache/install/activate/fetch behaviour is unchanged and still never touches
  `/api/*`, `/ws`, `/remote-mobile/*` or `/share-target`.

### Deep links and resume routing (v18)

- `/?session=<id>` is read on boot but consumed only after the `sessions` frame confirms
  the id exists; the SPA opens that session once and strips the parameter with
  `history.replaceState`. Unknown ids are left alone, and on an unpaired phone the link
  waits until pairing completes (never auto-opens across the pairing screen). A
  `{type:'open-session', sessionId}` message from the service worker takes the same path,
  with a short retry window if the sessions frame is still in flight.


### Camera and share target (B10 / B11)

- The paperclip now opens a source sheet with **Take photo** / **Photo library** / **File**.
  One hidden file input is reconfigured per choice: `accept="image/*" capture="environment"`
  for the camera, `accept="image/*" multiple` for the library, and no filter for generic
  files. The existing sequential `/api/upload` pipeline is unchanged; the 44 px attach
  button is fully inside the composer row (verified with bounding-box checks in earlier
  passes; the composer has `overflow: visible` and the button has explicit 44 px
  min-width/height).
- Web Share Target support: on boot the SPA reads `?share=<urlencoded JSON
  {title,text,url}>`, with `?share_text=` / `?share_url=` / `?share_title=` as defensive
  aliases. Title, text and URL are joined with newlines, a URL already present in the text
  is not duplicated, the parameter is stripped with `history.replaceState`, and the result
  becomes the composer draft (the view snaps to Chat). If no session is open yet the draft
  is retained until one is opened/created, then applied. The Host side is
  `GET /share-target` → `302 /?share=<json>` (already in `server.js`).

### Markdown, code and safety

- `renderMarkdown` builds DOM nodes; **no untrusted text ever reaches `innerHTML`**. Text is
  written with `textContent`, which is the escaping boundary. Supported subset: headings,
  bold/italic (including `***`), inline code, fenced code, ordered/unordered lists with one
  level of nesting, pipe tables with alignment markers, blockquotes, horizontal rules and
  links. Unknown constructs stay literal.
- Links are accepted only for `http:`, `https:`, `mailto:` and same-origin relative paths.
- Fenced code with `js/ts/json/sql/bash/python/rust/html/css` is highlighted with a
  priority-ordered sticky-regex tokenizer (comments, strings, keywords, numbers,
  functions/variables/tags/attributes) that writes token text through `textContent`.
  Unknown or missing languages render as plain code. Code blocks have a copy button with
  a `execCommand` fallback for non-secure-context LAN pages.
- Reason about token rendering as "server/model text is hostile": it is always data.

### State model

One active session at a time. `sessions` and `session.status` drive the drawer/running
indicator; `models`/`presets` are cached per connection; the Activity feed is per active
session and cleared on switch. Sheets are single-instance, re-renderable, animated and
drag-to-dismiss from the grabber.

---

### Session management (Batch C)

- The Sessions sheet mirrors the desktop's project grouping: one collapsible section per
  registered project workspace (in Host display order) with a title, truncated root path,
  folder glyph, member count and a persisted collapsed state
  (`localStorage["dsh-remote-projects.v1"]`, default expanded), then an **Ungrouped**
  section for sessions that belong to no workspace. Within a section, pinned sessions lead
  followed by the Host's newest-first order. When the Host reports no workspaces (older
  build, or a deployment without the workspace registry) the sheet falls back to flat
  **Pinned** / **Recent** sections.
- Archived sessions are **hidden by default**, exactly like the desktop's default filter. A
  centered **Show archived (N)** control above the list switches to showing them (grayed,
  with the **Archived** tag) inside their project; **Hide archived** switches back. Archived
  rows still open, but open read-only. The search filter forces project sections open while
  a query is present and hides sections with no match.
- Rows show the running/idle dot, title, updated time + preset, a small pin marker, an
  **Archived** tag and the active check.
- The search box keeps the old instant local title/preset filter. Typing ≥3 characters also
  schedules a debounced (350 ms) `sessions.search`; `sessions.found` renders a **Messages**
  section with title + snippet (result rows already in the session list are skipped). When
  this deployment answers `unavailable`, the SPA disables message search for the sheet
  lifetime, keeps the local filter and explains once (no retry spam, no broken UI).
- Session menu (⋯) row actions: **Rename** (sheet with pre-filled input, Save disabled while
  blank, note that the desktop may shorten titles), **Pin/Unpin**, **Archive/Unarchive**
  (second tap when a run is active sends `stopActivity: true`; the first tap only explains
  the stop), and **Fork session** (second tap confirms; the fork arrives as a new
  `session.opened`, and stale live state is dropped first). Rename updates the header/list
  from `session.updated` and tolerates the following `sessions` refresh.
- Archived session rendering: a slim banner above the composer ("Archived session —
  unarchive to continue") with an inline **Unarchive** action, send/mic/attach disabled,
  stop hidden, transcript readable, queue/steer hidden. The menu also offers Unarchive.
- Live-only queue/steer UI is derived from `agentAvailable`; rename/pin/archive/fork stay
  available for cold sessions. A `not-live` error becomes "This session is not live on the
  desktop yet."; `forbidden` explains the device's approval restriction.

### Reasoning-effort picker (v17)

- The Host `models` frame may carry `reasoning: { efforts: [{id,name,description}],
  defaultEffort }` on a catalog entry; it is absent for models without an effort control.
  `model.select` accepts `reasoningEffort` (an effort `id`; omitted/null = Host default),
  and the selected effort is echoed in `sessions` rows and `session.opened.session` as
  `model: { provider, model, reasoningEffort }`.
- The Model sheet shows a subtle trailing tag with the effort that applies (the current
  effort for the active model, otherwise the advertised default, or `Default` when there
  is none) plus a chevron. Tapping a reasoning-capable model opens a second sheet scoped
  to that session and model: **Provider default** is offered only when `defaultEffort` is
  absent, followed by every effort (name + optional description). The active effort is
  marked (`aria-current`, check) and the advertised default carries a `Default` tag.
  Choosing a row sends `model.select { sessionId, provider, model, reasoningEffort }`
  (null for Provider default), closes the sheet and toasts
  `Model set to V4.1 Flash · High` (or `· Default`). Models without `reasoning` keep the
  immediate `model.select` behaviour.
- The bottom-right composer chip and the ⋯ menu **Model** row show `Label` alone when the
  model has no effort control and `Label · EffortName` when one is active; both ellipsize
  inside their shrinkable containers on 320–412 px. The chip updates optimistically on tap
  and again from the server's `sessions` refresh / reopened session. The picker is scoped:
  a sheet opened for one session can never emit a selection for another.
- The mock catalog advertises `V4.1 Flash` (efforts low/medium/high, `defaultEffort:
  "medium"`), `Claude Sonnet 4.5` (efforts with `defaultEffort: null`, so Provider default
  is offered) and plain `DeepSeek Chat`, `DeepSeek Reasoner` and `Qwen 2.5 Coder 32B`
  entries, so both branches are exercisable in the dev mock.

### Queue and steering

- Queue state is stored only for the active session from `session.opened.queue`, `queue`
  and `queue.changed`; frames for another session are dropped (strict scoping). A compact
  strip above the composer shows "N queued" (green dot, collapse chevron) and expands to
  the items, each with a **Queued / Steering / Context** tag and two-line text preview.
- Tapping an item opens an action sheet: **Steer now** (only a queued item while the agent
  is running), **Edit message** (textarea sheet, Save → `queue.update action:"edit"`), and
  **Remove from queue** (tap-again confirm → `action:"remove"`). Optimistic local removal is
  reconciled by the server's `queue.changed`/`queue` frames.
- While a session is running and live, the composer meta row shows a **Queue / Steer**
  segmented control (queue is the default; forced back to queue whenever the run ends, the
  session is archived or the agent is unavailable). Sending includes `mode: "queue" |
  "steer"`. A rejected steer (`bad-request`) rolls back the optimistic bubble, restores the
  text, flips to Queue and toasts. The strip disappears when the queue is empty, and a
  cold/non-live session never shows queue UI.

### Image limits (Batch D)

- `ready.limits.image` and `{type:"limits",image}` are stored (`null` allowed, unknown
  fields ignored). The attachment sheet adds a hint when limits exist:
  "Photos go straight to the model · up to N photos · M MB each" (maxImages/maxBytes).
- Before upload, image picks are pre-checked: an image over `maxBytes` is skipped with
  "Image is larger than the N MB limit"; images beyond `maxImages` (counting images already
  attached/uploading) are skipped with "Only N photos per message". Non-image files and the
  existing upload pipeline are unchanged.

### Approval context and device permission

- `approval.request` may now carry `argsPreview` (≤600 chars), `argsKind`
  (`command|write|edit|other`) and `detail {kind,path?}`. The approval card renders an
  uppercase context tag (Command / File write / Edit / Details), the optional path, and a
  monospace preview collapsed to the first 6 lines; tapping the preview or the Show
  more/less control expands it. The block is omitted entirely when the fields are absent.
  Pending replay uses the same `approval.request` path, so restored approvals render
  identically; the Activity entry shows the same label + preview.
- `ready.device` / `/api/state` may include `canApprove` (default true). When it is false,
  approval cards stay expanded with full details but Approve/Reject are disabled and a
  read-only note appears ("This device can't answer approvals — answer on the desktop or
  another phone."); `approval.answer` is never sent, one-tap is blocked, and the Activity
  row adds a read-only note. `deviceCanApprove()` defaults true for older Hosts (a ready
  frame that omits the flag preserves the `/api/state` value).
- `error.code: "forbidden"` shows that same approval-permission guidance as a toast.

### Context meter (Batch C3; moved to the composer meta row in v16, centred in v17)

- `session.opened.context` and `{type:"context",sessionId,…}` both feed one compact meter
  on the **composer meta row** directly under the input — not in the header, which now
  carries only the session title and status line. It reads `527k / 1M` in tabular
  monospace next to a thin 56 px track (40 px at ≤380 px), with an `est.` pill when
  `basis === "estimated"`. It is hidden for `basis: "unknown"`, missing windows or null
  context, and frames for another session are dropped (strict scoping). Above 85% the
  label, bar and `est.` pill switch to the warning palette.
- The meta row is `display:grid; grid-template-columns:minmax(0,1fr) auto minmax(0,1fr)`
  with the meter as the auto centre track. Both side tracks resolve to the same width,
  so the meter's bounding-box centre is the viewport centre line within ±1 px (measured
  0.0 px offset at 320/360/390/412) even when the note is long or the right cluster is
  wide. The note is start-aligned with `min-width:0` and ellipsizes; the right cluster
  (`Queue/Steer` + model/effort chip) is end-aligned, `min-width:0`, and the chip
  ellipsizes, so neither can push the centre off. On the narrowest phones (≤380 px)
  the decorative track is dropped while Queue/Steer shares the row (the `11.2k / 1M`
  numbers stay) so the control fits inside its side track without moving the centre. The decorative `aria-hidden`
  track/label fragments are backed by a `role="group"` `aria-label`
  ("Context: … of … tokens used (…%, estimated)").
- The header is a symmetric flex row (`[drawer + spacer] · title · [compose, more]`):
  the spacer is exactly one 44 px icon button wide, so the title block and the centred
  status line sit on the viewport centre line without absolute positioning. The topbar
  is 52 px tall in both themes and long titles ellipsize between the icon clusters.
- Refresh is event-driven, never a poll: `context.get` after opening a session, after each
  `assistant.end`, when returning to the app, and for the active session on reconnect
  resync. Stale responses for other sessions are ignored. Above 85% the label, bar and
  `est.` pill switch to the warning palette (warm amber in both themes).

### Changed-files review (Batch C3)

- The Activity view now has a **Changes** panel above the event stream. On session open,
  after each `assistant.end`, on resume and on reconnect the SPA sends
  `changes.list {limit:10}`; only the active session's `changes` frame is rendered.
- Each event is a small card: `Turn N · X files · +a −d`, with per-file rows (monospace
  path, `+a/−d` or `binary`/`large`). An event with `available:false` shows
  **“diff unavailable (session not live)”**.
- Tapping a file sends `changes.diff {seq,index}` and opens a diff sheet that starts in a
  loading state. Text diffs render monospace lines with green/red tints for `+`/`-` and
  context lines in both themes, `coarse` explains a whole-file hunk, binary/oversized get
  explicit notes, and `error.code:"unavailable"` renders a “diff unavailable” state. The
  renderer caps output at 1200 lines (with a truncation note) so a huge diff cannot create
  thousands of nodes; the lines scroll inside the sheet.

### Commands palette (v20)

- The ⋯ menu has a **Commands** row (only with an active session). It sends
  `commands.list`; the sheet shows a spinner until the frame arrives and always rebuilds
  through `buildSheet()` (clearing the body), so the loading row cannot survive under the
  loaded list. A lost/refused reply times out after 10 s with “The Harness did not answer in
  time — try again.” `available:false` explains why without executing anything: `not-live` →
  “Commands need a live agent — send a message first…”, otherwise “Commands are not
  available for this session.”
- The list mirrors the Host command registry for the live Agent (preset-mounted commands
  included): typically `/compact`, `/goal`, `/plan`, `/feedback`, plus any future command.
  `/export` (desktop-only ZIP download) and `/permission` (sandbox/approval policy switch,
  including `danger-full-access`) are hidden by the bridge and refused if sent — a paired
  phone must not be able to widen its own sandbox, and a device marked `canApprove:false`
  must not be able to disable the approval gate. Rows show the command name, description and
  the argument hint on its own line (2-line clamped description; the input sheet carries the
  full hint).
- Tapping a command with an argument hint opens a **command-input** sheet headed by the
  command name: an input pre-focused with the hint as placeholder and a **Run command**
  action that sends `commands.execute { line: "/name <args>" }`. Commands without a hint keep
  the double-tap confirmation before sending the bare `/name`. `command.result` toasts
  `name — success/error` (with short trimmed text) and reloads `history.load` for the active
  session because the Host logs the command event; context and changes are refreshed too.
  `forbidden` / `not-live` / `bad-request` map to friendly toasts and clear the pending
  command.

### App lock (Batch E2, client-side privacy gate)

- The ⋯ menu has a **Privacy → App lock** switch. It is shown only when
  `'PublicKeyCredential' in window` **and** `window.isSecureContext`; otherwise the row is
  disabled and explains that it needs HTTPS (Tailscale) and a biometric-capable browser.
- Enabling runs on the tap gesture: `navigator.credentials.create` with a 32-byte challenge,
  `rp {name:"DSH Remote", id: location.hostname}`, a random 16-byte user id,
  ES256/RS256 params (−7/−257), `authenticatorAttachment:"platform"`,
  `userVerification:"required"`, `residentKey:"preferred"`, 60 s timeout and no attestation.
  On success the credential id (base64url), device id, enabledAt and unlockedAt are stored
  under `localStorage["dsh-remote-applock.v1"]` (one entry per device; a credential from a
  different device id is ignored). Toast “App lock on”.
- Lock behaviour: a cold start of the installed app is **always locked** until verified;
  after a successful assertion there is a 5-minute grace, but returning after the app was
  hidden for 30+ seconds locks again. The decision is a pure function
  (`appLockShouldLock`) and is driven by `visibilitychange`/resume. The lock panel is an
  opaque full-screen dialog; the app is `inert`, `aria-hidden` and `visibility:hidden`
  behind it, and Unlock runs `navigator.credentials.get` with the stored credential id,
  `transports:["internal"]`, `userVerification:"required"` and a 60 s timeout. Failure or
  cancel shows “Could not verify — try again.” and stays locked.
- Disabling the row also requires a successful assertion first; only then is the stored
  state removed and the overlay hidden (toast “App lock off”). Unreadable/corrupt lock state
  fails open (usable) and logs nothing; every WebAuthn call is try/caught. The panel always
  shows the recovery note: “Can't unlock? Revoke this device from the desktop pairing panel
  and pair again.” The pairing cookie is never touched.
- **Honest limitation:** this is a client-side deterrent/privacy gate for the installed app,
  not server enforcement. The pairing cookie/session remains authoritative, so a determined
  attacker with the device/browser profile can still use the API; the real recovery is the
  desktop pairing panel's revoke. WebAuthn requires a secure context (HTTPS via Tailscale
  Serve or localhost), which is exactly why the row is disabled on plain-HTTP LAN URLs.

## Protocol assumptions, deviations and TODOs

These are the places where the SPA had to make a choice because `PROTOCOL.md` is silent.
None change the wire format; all are client-side heuristics.

1. **`history.hasMore` has no cursor/offset.** The protocol only sends `limit`, so older
   pages cannot be requested deterministically. For now `hasMore` is ignored and only the
   most recent history is rendered. *TODO:* add `before`/`cursor` to `history.load` if
   pagination is wanted, then wire a "Load earlier messages" affordance.
2. **No acknowledgements for `prompt`, `model.select`, `preset.select` or `stop`.** The UI
   is optimistic: model/preset labels update on tap, optimistic user bubbles reconcile via
   history, and stop stays "Stopping…" until `session.status { running: false }`. Failures
   surface through `error` frames and toasts.
3. **`sessions.create` has no documented response.** The SPA waits for the resulting
   `sessions`/`session.opened` frames and times out after 12 s with a toast.
4. **Approvals are not part of `HistoryItem`.** Pending approvals are kept in a client map
   and re-attached to the transcript on `history` reload; resolved approvals live only in
   the current view/Activity feed until the transcript reloads.
5. **`assistant.delta.reasoning` is treated as an incremental chunk** (same as `text`).
   Reasoning renders in a collapsed `<details>` block; if the Harness ever sends full
   snapshots instead, this needs a flag.
6. **Auto-open heuristic:** on first connect the SPA opens `ready.activeSessionId`, then
   the last session stored in `localStorage`, then the first session in `sessions`.
   `session.status` is authoritative for the running indicator; `assistant.start` only
   shows the typing state and clears on first delta.
7. **Activity is per active session.** Switching sessions clears the feed; global
   cross-session event history is not reconstructed from frames.
8. **Service worker + offline shell.** `sw.js` (cache `dsh-remote-v20`) now precaches the
   shell and serves it offline, but only in a secure context: HTTPS or `localhost`. Plain
   `http://<lan-ip>:3456/` deliberately does not register a worker, so the "offline-ish"
   reconnect/banner/resync behaviour still applies there. Bump the cache name **and** the
   `?v=` references together when the shell changes; the page reloads at most once when an
   update activates.
9. **WS close `4401`** is the only auth-loss signal handled; other close codes follow the
   normal reconnect policy.
10. **Mock-only:** fixed `1234` PIN at boot, in-memory state, no token signing, and a
    single-connection-friendly global active session. The real Host owns auth, pairing and
    persistence; the mock exists only to drive this SPA end to end.
11. **Question frames are a protocol extension.** `question.request`, `question.resolved`,
    `question.answer` and the `question` payload on `tool.start`/history tool items are
    implemented exactly as specified to this SPA. The host-side bridge and `PROTOCOL.md`
    are owned by the Lead; nothing else in the wire format changed.
12. **Skip semantics.** `question.answer` has no explicit decline flag, so Skip sends
    `answers: []`. The Host is expected to treat that as `question.resolved` with
    `outcome: "declined"`. If the bridge prefers a different signal, this is the single
    place to align.
13. **Duplicate question frames.** `tool.start` may carry the batch and `question.request`
    may follow for the same call; the SPA dedupes by `requestId`/`callId`, merges the
    payloads and preserves the draft. A duplicate `question.request` only refreshes the
    card. Interactive questions live in a client map (like approvals) so they survive a
    `history` reload; settled history rows render read-only.
14. **Answer batch shape.** Answers are sent as `{ id, selected: [labels], custom? }`;
    unanswered questions are omitted and `custom` is omitted when empty. Resolved answers
    are matched to questions by `id` and custom text is shown as `Other: …`. History
    `output` JSON is parsed tolerantly (`{answers}` wrapper or a bare array) and falls
    back to **Answered** when it cannot be parsed.
15. **Uploads/attachments/previews are a protocol extension.** `POST /api/upload` (raw
    bytes, device cookie, `x-dsh-session` / `x-dsh-filename` / `x-dsh-media-type` headers),
    the `attachments` array on the `prompt` frame, history user attachments
    (`{path,name,mediaType}`) and `GET /api/preview?session=…&path=…` are being added by
    the Host. The SPA sends the upload response objects back verbatim and never renders
    paths; the Host appends them to the prompt text for the agent. Preview requests use
    the current session id and only for png/jpeg/webp/gif; any other type or an error
    falls back to a file pill.
16. **Filename header sanitisation.** HTTP header values are byte strings, so
    `x-dsh-filename` replaces control/non-Latin-1 characters with `_` (the original
    name stays in the UI/chips). If the Host prefers percent-encoded UTF-8 names, this is
    the one place to align.
17. **Size limit.** Files over 32 MB are rejected client-side before upload, and a server
    `413` is also surfaced on the chip. The Host is the authority; the client guard is a
    fast-fail courtesy.
18. **Attachment-only sends.** A message may have files and no text; the SPA sends
    `text: ""` plus `attachments`. The Host must accept that combination (the mock does).
    Unanswered failed uploads block sending until removed.
19. **Object-URL lifecycle.** Composer thumbnails use a blob URL that is revoked on
    remove/send/clear; the optimistic bubble gets its own blob URL (so the thumbnail
    survives the chip teardown) which is revoked when a history reload replaces that
    message, on session switch, reset or unpair. History thumbnails use `/api/preview`
    instead of blobs.
20. **History attachment metadata.** User history items carry
    `attachments: [{path,name,mediaType}]` with the synthetic "Attached files…" block
    already stripped from `text`. The mock emits this shape; older hosts that omit it
    simply render no previews/pills.
21. **Session scoping is client-side.** An approval/question is rendered inline only when
    its `sessionId` equals `S.activeSessionId`; otherwise it is kept in the pending maps
    and surfaced by the notice bar. A frame without `sessionId` is treated as belonging
    to the active session (there is nothing to scope it against). Duplicate question
    frames only merge within the same session, and `appendMessage` refuses a foreign
    approval/question as a defensive boundary. The notice bar itself is client-only.
22. **Web Share Target contract (B11).** `manifest.share_target` is
    `{ action: "/share-target", method: "GET", params: { title, text, url } }`. The Host
    route answers `302 /?share=<encodeURIComponent(JSON)>` (mirrored in `server.js` and the
    mock). The SPA additionally accepts `?share_text=`, `?share_url=` and `?share_title=`
    as defensive aliases; those aliases are a client convenience, not part of the manifest
    contract. The draft is prepared but never auto-sent.
23. **PWA static serving requirements (B7).** The Host must keep serving `/sw.js` from the
    site root with `Service-Worker-Allowed: /` and no HTTP caching, the manifest with
    `application/manifest+json`, the PNG/SVG icons, and the CSP `worker-src 'self'`
    (already true in the frozen `server.js`/CSP). The host-owned `package.json` `files`
    list must also include the new PWA assets (reported to the Lead; not edited here).
24. **Background notifications are Web Push (v18).** The service worker handles `push`,
    `notificationclick` and `pushsubscriptionchange`; the page owns the subscription
    lifecycle and reports `client.visibility`. The old page-level `Notification` path is
    kept only as a fallback when the page is hidden, permission is granted and no push
    subscription is live, so the two paths never double-alert. Permission is requested only
    on the menu row's user gesture; on boot the SPA re-POSTs an existing subscription but
    never prompts. Mock delivery is local by design (the test route answers without a real
    network push), and platforms without a push service surface the `Subscription error`
    state rather than pretending to work.
25. **Voice uses the browser's Web Speech service (B8).** Recognition is network-backed on
    most platforms, deliberately feature-detected, and continuous mode is approximated by
    restarting `onend` up to six times while the user is still listening. There is no
    offline fallback and no audio ever leaves the SPA's own APIs.
26. **Theme boot moved into app.js (B7/CSP).** The Host CSP allows only `script-src 'self'`,
    so the old inline `<head>` theme bootstrap was removed. `app.js` applies the persisted
    Auto/Light/Dark preference on init and updates all `theme-color` metas; the very first
    paint is the light default until the deferred script runs.

---

## Verification performed

### Project grouping, archived filter and command palette (v20, current)

Verified against the installed plugin on `127.0.0.1:3456`:

- `node --check mobile\app.js` and `node --check mobile\sw.js` → exit 0.
- `node dev\spa-check.mjs` → `PASS spa check (964 helpers, 64 cached ids, v20)`; page refs,
  `CACHE` and `PRECACHE` all agree on v20.
- `node dev\static-check.mjs` → `/app.js?v=20 200 text/javascript; charset=utf-8` (323,911
  bytes), `/styles.css?v=20 200 text/css` (85,744 bytes), manifest + 3 PWA icons +
  `/share-target` OK.
- `node dev\ui-check.mjs` (paired headless Chrome, 412×915): project-grouped Sessions sheet
  with title/root path/count, **Ungrouped** section, collapse/expand round-trip persisted in
  `dsh-remote-projects.v1`, zero archived rows in the default list, **Show archived (N)**
  reveals them and **Hide archived** hides them again, and the Commands sheet lists
  `compact/feedback/goal/plan` (no `/export` or `/permission`) with no surviving loading
  spinner; argument commands open the input sheet; zero console errors.
- Live protocol: `commands.list` returned the four benign Host commands with hints, without
  `/export` or `/permission`; `/compact` and `/goal` executed (`command.result name`
  preserved) and an unknown command was refused `forbidden` (`dev/commands-live.mjs`). Every
  `ready`/`sessions` frame carried `workspaces` and session rows carried `workspaceId`;
  `dev/session-features-live.mjs` still passes rename/search/pin/archive/cold guards.
- `node dev\layout-probe.mjs` at 320, 360 and 412 px: `scrollWidth === innerWidth`,
  `titleCenterOffset 0`, `meterCenterOffset 0`, `offenders []` (the grouped sheet did not
  disturb the centred header/footer or introduce overflow).

### Background Web Push + fast-resume resilience (v18)

Run from a checkout of this plugin:

- `node --check mobile\app.js` → exit 0; `node --check mobile\sw.js` → exit 0;
  `node --check mobile\mock-server.js` → exit 0.
- `node dev\static-check.mjs` → `/app.js?v=20 200 text/javascript; charset=utf-8 bytes
  312522`; `/styles.css?v=20 200 text/css; charset=utf-8 bytes 83860`;
  `PASS static asset + header check` (exit 0; CSP, PWA surface, `Service-Worker-Allowed`).
- `node dev\spa-check.mjs` → `PASS spa check (930 helpers, 64 cached ids, v18)`; page refs,
  `CACHE` and `PRECACHE` all agree on v18.
- `node dev\server-smoke.mjs` → `PASS bridge image attachment checks`, `PASS approval
  context checks`, `PASS transport smoke test` (frozen server untouched).
- **Service-worker VM harness** (stub `self`/`caches`/`clients`/`registration.showNotification`/
  `pushManager`, run with Node `vm`): **15/15 PASS**, actual lines:
  - handler presence; install precaches the v18 shell; activate deletes older caches;
    fetch never intercepts `/api/`, `/ws`, non-GET; versioned shell still cache-first.
  - `push` renders title/body/tag/data/icon/badge; empty payload and malformed JSON still
    notify with fallback copy; hostile types are sanitised.
  - `notificationclick` closes + focuses + `postMessage({type:'open-session',sessionId})`;
    falls back to `clients.openWindow('/?session=…')`; ignores cross-origin clients.
  - `pushsubscriptionchange` GETs `/api/push/key`, subscribes with the decoded key and POSTs
    `/api/push/subscribe`; disabled key is a best-effort no-op.
- **Static integration harness**: **15/15 PASS** — v18 coherence, push endpoint wiring,
  subscription lifecycle (`/api/push/*`, `applicationServerKey`, `userVisibleOnly`,
  `toJSON`, unsubscribe), menu states (`Enabled/Off/Needs HTTPS/Unsupported/Permission
  denied/Subscription error`), no-auto-prompt sync on `ready`/reconnect, page-notification
  fallback gating, `client.visibility` on ready/socket-open/visibilitychange, `lastPong` on
  every frame, watchdog constants (`5000/15000/10000/2000`) and conditions, session-timeout
  reconnect, `?session=` parse/consume/strip/open + SW `open-session` message, zero
  `console.*` in app.js/sw.js, no inline scripts or handlers, mock push routes and
  visibility ack.
- **Headless Chrome drive** (`Chrome/157.0.8103.38`, mock server paired through
  `POST /api/pair`): boot reached **Ready** with **`consoleMessages: []`** and
  **`exceptions: []`** after ~8 s; two `{"type":"client.visibility","visible":true}` frames
  were captured on the socket (socket-open + ready); `GET /api/push/key` returned
  `enabled:true` with a **65-byte** decoded key; the service worker was active with a
  `pushManager`. Driven lifecycle:
  - menu row **Off** ("Off — enable background alerts"), test row disabled;
  - `Browser.grantPermissions(notifications)` then tap → **Enabled**, real FCM
    subscription created, toast "Background notifications on";
  - **Send test notification** → toast "Test notification sent" (mock `{ok,sent:1}`);
  - tap again → subscription `null`, toast "Background notifications off", rows back to Off.
  - **Resume recovery**: emulated offline + closed the socket + simulated a hidden page for
    2.6 s, then online + visible → reconnected from `Ready` in **105 ms** with one
    "Reconnected" toast and `client.visibility` false→true frames (3 socket instances).
  - **Deep link**: `/?session=sess-api` opened "API refactor notes" and the URL became `/`.
- **Not verified here:** a real Host→push-service delivery (encrypted RFC 8291 payload on a
  locked phone) and iOS 16.4+ installed-app push; the mock never sends over the network and
  the Host was not restarted. The SW/notification rendering was driven through the VM
  harness and the real subscription lifecycle through Chrome; page-level fallback was
  covered statically (it requires a hidden page without a subscription).

### Header/footer alignment + reasoning-effort picker (v17)

Run from a checkout of this plugin:

- `node --check mobile\app.js` → exit 0; `node --check mobile\sw.js` → exit 0;
  `node --check mobile\mock-server.js` → exit 0.
- `node dev\static-check.mjs` → `/app.js?v=17 200 text/javascript; charset=utf-8 bytes
  293567`; `/styles.css?v=17 200 text/css; charset=utf-8 bytes 83860`;
  `PASS static asset + header check` (exit 0; v17 ref pair, CSP, PWA surface and
  `Service-Worker-Allowed` intact).
- `node dev\spa-check.mjs` → `PASS spa check (887 helpers, 64 cached ids, v17)` (exit 0;
  index.html + sw.js version refs, CACHE and PRECACHE all agree).
- `node dev\server-smoke.mjs` → `PASS bridge image attachment checks`, `PASS approval
  context checks`, `PASS transport smoke test` (exit 0; the frozen server is untouched).
- **CDP geometry of the checkout** (bundled `mobile/mock-server.js` + a throwaway probe in a
  temp dir outside the checkout; paired through `POST /api/pair`, `Emulation.setDeviceMetrics
  Override` + `Emulation.setEmulatedMedia`). At 320, 360, 390 and 412 CSS px in dark **and**
  light `prefers-color-scheme`:
  - `.titleblock` centre − `innerWidth/2` = **0.0 px** at all eight width/theme pairs;
    `.session-sub` (status line) centre offset also **0.0 px**; `.topbar` height **52 px**.
  - `.context-meter` centre − `innerWidth/2` = **0.0 px** at all eight pairs (headroom
    exists because the two `1fr` grid tracks resolve equal around the auto centre track).
  - `document.scrollWidth === innerWidth` (320/320, 360/360, 390/390, 412/412) and the
    model/effort chip is fully inside the viewport (`chip.right` 298/338/366/388 ≤ vw).
  - Stress states at every width: (a) long title + long note + long effort chip, and
    (b) running (Queue/Steer visible, chip hidden, decorative track dropped) — both keep
    `.titleblock` and `.context-meter` centre offsets at **0.0 px**, the note stays inside
    its own grid track and truncates (80–123 px across the cases) and
    `scrollWidth === innerWidth`. `document.querySelectorAll('body *')`
    reports no viewport overflow except one mock-fixture `<code>` element inside a
    horizontally scrollable `pre.md-codeblock` (clipped by its parent, so no document
    overflow; the same data-dependent element appears on the live v16 shell).
- `node dev\layout-probe.mjs` against the live plugin at WIDTH 320/360/390/412 →
  `scrollWidth === innerWidth` and `appWidth === innerWidth` for all four. The live v16
  transcript still yields one clipped `<code>` offender (over 221/181/155/133 px, all inside
  the horizontal-scroll `pre`); rerun against the then-deployed shell to confirm the same on
  v17.
- **Reasoning picker driven end to end** against the mock over CDP (click flows, not just
  static checks): menu → Model → `V4.1 Flash` → `High` produced toast
  `Model set to V4.1 Flash · High`, chip `V4.1 Flash · High`, and the model row tag
  `High`; reopening the sheet marked `High` active (`aria-current`) with `Default` on
  `Medium`. `Claude Sonnet 4.5` (no `defaultEffort`) rendered a **Provider default** row;
  choosing it toasted `Model set to Claude Sonnet 4.5 · Default` and the chip fell back to
  `Claude Sonnet 4.5`. A plain model (`Qwen 2.5 Coder 32B`) selected immediately, closed
  the sheet and toasted `Model set to Qwen 2.5 Coder 32B.` (no drill-in sheet).
- Screenshots were captured during development and are not shipped in the repository.
- **Not verified here:** physical iOS/Android/WebKit; the live server was not restarted or
  modified, so the official layout probe above still measures the deployed v16 shell. The
  `est.`/≥85% meter states and the light theme were exercised through DOM state and CDP
  media emulation rather than a real device setting; no browser console output, inline
  script or network endpoint was added.

### Frontend polish — context-meter move + bottom-row cleanup (v16)

Run from a checkout of this plugin:

- `node --check mobile\app.js` → exit 0; `node --check mobile\sw.js` → exit 0;
  `node --check mobile\mock-server.js` → exit 0.
- `node dev\static-check.mjs` → `/app.js?v=16 200 text/javascript; charset=utf-8 bytes
  286015`; `/styles.css?v=16 200 text/css; charset=utf-8 bytes 81605`;
  `PASS static asset + header check` (exit 0; the single v16 ref pair, CSP, PWA surface
  and `Service-Worker-Allowed` header are intact).
- `node dev\spa-check.mjs` → `PASS spa check (866 helpers, 64 cached ids, v16)` (exit 0;
  the new `context-est` cached id exists and index.html/sw.js version refs agree).
- `node dev\server-smoke.mjs` → `PASS bridge image attachment checks`, `PASS approval
  context checks`, `PASS transport smoke test` (exit 0; the frozen server is untouched).
- **Headless-Chrome layout verification of the checkout.** The checkout's `mobile/` folder
  was served by the bundled `mobile/mock-server.js` (paired through `POST /api/pair`,
  then driven over CDP with a throwaway script outside the checkout). At 320, 360, 390 and
  412 CSS px in dark **and** light `prefers-color-scheme`, every state reported
  `scrollWidth === innerWidth` (320/320, 360/360, 390/390, 412/412), `.app` width equal
  to the viewport and `offenders: []` — including running (note + meter + Queue/Steer),
  and the synthetic worst case with the note, meter, Queue/Steer **and** model chip all
  visible, plus the `est.` badge and >85% warning palette. The meta row measured 21 px
  tall idle, 38 px while running (one row) and the top bar 52 px in both themes.
  Screenshots were captured during development and are not shipped in the repository.
- `node dev\layout-probe.mjs` against the **live v15 plugin** at `WIDTH=320,360,390,412`
  → `scrollWidth === innerWidth`, `appWidth === innerWidth`, `offenders: []` for all
  four (pre-sync baseline: the live server still answers `?v=15`). Re-run it after the
  checkout is deployed to assert the same on v16.
- **Not verified here:** physical iOS/Android devices and WebKit. The estimated-basis
  badge/warning colours were exercised by forcing that DOM state (the mock always serves
  `basis:"usage"`), and light theme through CDP media emulation rather than a real OS
  `prefers-color-scheme` toggle. No browser console output, inline script or network
  endpoint was added.

### Batch C3/E2 — context, changes, commands, app lock (v10)

Run from a checkout of this plugin after syncing the live
plugin:

- `node --check mobile\app.js` → exit 0; `node --check mobile\sw.js` → exit 0;
  `node --check mobile\mock-server.js` → exit 0.
- `node dev\static-check.mjs` → `/app.js?v=10 200 text/javascript; charset=utf-8 bytes
  283660`; `/styles.css?v=10 200 text/css; charset=utf-8 bytes 80037`;
  `PASS static asset + header check` (exit 0; PWA surface + service-worker header intact).
- `node dev\server-smoke.mjs` → `PASS transport smoke test` (exit 0).
- Static integration + lock-state-machine harness → **PASS**, actual lines:
  - `S->C C3 frames: 5 handlers + mock emitters present`
  - `C->S C3 frames: 5 emitters + mock handlers; refresh hooks; strict scoping`
  - `UI: context meter, changes panel, diff view, lock overlay + disabled row styles present`
  - `Commands palette + diff sheet (1200-line cap, unavailable copy) present`
  - `lock state machine: cold-start locked -> assertion unlock -> 5-min grace -> inactivity
    relock -> disabled` (the extracted `appLockShouldLock` executed in Node for: cold start
    → true; verified within grace → false; +5 min + 1 ms → true; hidden 30 s → true; hidden
    29 999 ms → false; disabled → false)
  - `lock wiring: WebAuthn create/get params, platform+UV, disable-requires-assertion, cold
    start/resume, fail-open`
  - `v10 refs + SW v10, zero console.*, no inline scripts/handlers`
- Mock WebSocket protocol run (real masked RFC 6455 client) → **PASS**:
  `session.opened.context` = `{used:11214, window:1000000, basis:"usage"}`;
  `context.get` → `11214/1000000 usage`; `changes.list` → 2 items (first 2 files, second
  `available:false`); `changes.diff` text `src/app.ts` 6 lines with `+`/`-`, binary
  `assets/logo.png`, unknown coordinates → `error unavailable`; `commands.list` →
  `compact`; `commands.execute /compact` → `command.result compact success "Compacted 4
  history items (~909 tokens)."`; unknown command → `error forbidden`; following
  `history.load` includes the command event.
- **Headless browser limitation:** Chromium/Edge still cannot start in this sandbox (Mojo
  named-pipe restriction), so real WebAuthn (`credentials.create/get`), the lock overlay,
  permission prompts and synthetic-frame UI rendering were not driven in a browser. The
  lock state machine was executed directly from the source in Node; the mock protocol run
  covers every C3 frame shape; WebAuthn platform behaviour is documented as a device
  spot-check (requires a secure context + biometric authenticator).

### Batch C/D — session management, queue/steer, image limits, approval context (v9)

Run from a checkout of this plugin after syncing the v8
plugin and bumping to v9:

- `node --check mobile\app.js` — **passes** (also `node --check mobile\sw.js` and
  `node --check mobile\mock-server.js`).
- `node dev\static-check.mjs` — **PASS static asset + header check**; served
  `/app.js?v=9` (253,581 bytes) and `/styles.css?v=9` (74,671 bytes), `no-store`, correct
  content types, PWA surface intact.
- `node dev\server-smoke.mjs` — **PASS transport smoke test**; the frozen server contract
  was not modified.
- Static integration harness (Node): all 7 new S→C frame cases + handler functions present
  and referenced by the mock (`session.updated`, `sessions.found`, `session.pinned`,
  `session.archived`, `queue`, `queue.changed`, `limits`); all 11 C→S emitters present
  (`session.rename`, pin/unpin, archive/unarchive, fork, `sessions.search`, `queue.list`,
  `queue.update` edit/remove/steer, prompt mode); queue strip / archived banner / prompt
  mode / pin-archive-fork icons / v9 refs / 9 new style selectors present; limits +
  approval-context + `canApprove` + `forbidden` paths present; SW cache bumped to
  `dsh-remote-v9`; zero `console.*`, zero inline scripts/handlers. **PASS Batch C/D static
  integration check.**
- Mock WebSocket protocol run (real masked RFC 6455 client, port ephemeral), actual output:
  - `ready` → `canApprove=true`, image limits `{maxImages:4,maxBytes:5242880,...}`,
    `queue:[]`; sessions rows carry `pinned`, `archived`, `agentAvailable` (release pinned,
    design archived); `session.opened.queue` present.
  - `session.rename` → `session.updated "Release checklist v2"` + `sessions`; pin/unpin →
    `session.pinned true/false`; archive/unarchive → `session.archived true/false`;
    `session.fork` → new `(fork)` session; `sessions.search "release"` → 2 results with
    snippets; `queue.list` → 0 items.
  - Deploy turn: `question.request` 2 questions answered → `approval.request`
    `argsKind=command`, `argsPreview` 8 lines, `detail.path=scripts\deploy.ps1`.
  - Running session: queued prompt → `queue.changed` item placement `queued`; edit →
    updated text; remove → item gone; steer while idle → `error bad-request`; archive while
    running without `stopActivity` → `error bad-request`; with `stopActivity:true` →
    `session.archived`; `limits` → maxImages 4 / maxBytes 5242880.
  - **PASS mock Batch C/D protocol run.**
- Headless Chromium could not be used in this sandbox (the earlier documented
  named-pipe/Mojo restriction still blocks browser startup), so synthetic-frame browser
  checks for the new UI states were not re-run. The UI paths (approval args with/without
  preview, `canApprove=false` disabled buttons + note, queue strip expansion, archived
  read-only composer, sessions grouping) are covered by the static integration harness and
  the mock protocol run, and are documented as device spot-checks.

### Batch B — phone-native features (v8)

Run from a checkout of this plugin:

- `node --check mobile\app.js` — **passes** (also `node --check mobile\mock-server.js` and
  `node --check mobile\sw.js`).
- `node dev\static-check.mjs` — **PASS static asset + header check**; served
  `/app.js?v=8` (214,685 bytes) and `/styles.css?v=8` (67,225 bytes), `no-store` and
  correct content types.
- `node dev\server-smoke.mjs` — **PASS transport smoke test**; the frozen server contract
  was not modified.
- Custom `RemoteMobileServer` HTTP check on an ephemeral port (same stub bridge pattern as
  `dev/static-check.mjs`), actual output:
  - `GET /` → `200 text/html`, CSP `script-src 'self'`, manifest/apple-touch/favicon links,
    v8 refs, both light/dark `theme-color` metas, **no inline scripts**.
  - `/manifest.webmanifest` → `200 application/manifest+json; charset=utf-8`, 876 bytes;
    JSON parses, `display: standalone`, `share_target` action/method/params and a maskable
    icon.
  - `/sw.js` → `200 text/javascript`, 4,756 bytes, `Service-Worker-Allowed: /`,
    `cache-control: no-cache`.
  - `/icons/icon-192.png` (9,626 B), `/icons/icon-512.png` (27,264 B),
    `/icons/icon-maskable-512.png` (18,615 B), `/icons/apple-touch-icon.png` (6,394 B) →
    `200 image/png` with valid PNG signatures; `/favicon.svg` → `200 image/svg+xml`.
  - `/share-target?title=t&text=x&url=https%3A%2F%2Fexample.com` → `302`,
    `Location: /?share=%7B%22title%22%3A%22t%22%2C…%7D`, payload round-trips exactly.
  - **PASS PWA + share-target HTTP check.**
- Service-worker logic exercised in a Node `vm` harness with stubbed `caches`/`fetch`:
  install precached all 9 shell entries and called `skipWaiting`; activate deleted
  `dsh-remote-v7`, kept `dsh-remote-v8` and unrelated caches and called `clients.claim`;
  `/api/*`, `/ws`, `/remote-mobile/*`, `/share-target` and cross-origin requests bypass the
  worker; navigation is network-first, caches `/`, and falls back offline (including a
  `?share=` deep link); `/app.js?v=8` is cache-first with a background revalidation fetch;
  a fresh `?v=` asset is fetched and stored. **PASS service worker logic harness.**
- Static integration checks: all 19 new functions are defined; zero `console.*` calls in
  `app.js`; zero inline `<script>` tags in `index.html`; both v8 refs present; manifest
  icons/share target valid; zero external HTTP(S) asset URLs in the shipped files.
- **Headless-browser limitation in this sandbox:** Chrome/Edge headless can no longer start
  (`mojo platform_channel.cc: Access is denied` — the confined sandbox blocks the named
  pipes Chromium needs for IPC). Earlier batches' headless CDP passes are recorded below;
  for Batch B the browser-dependent states (SW install/offline, live voice, real
  notifications, share-sheet handling) were therefore reviewed in code and covered by the
  VM/HTTP harnesses, not re-driven in a browser. This is an environment limitation, not a
  failing assertion.

### Earlier batches (v7 and before)

- `node --check app.js` — passes.
- `node --check mock-server.js` — passes. The mock gained the `ask_user_question` demo flow,
  the `/api/upload` endpoint + prompt attachment echo, the settled-history fixtures for
  those extensions, and the cross-session fixture prompt; every other frame/endpoint still
  matches `PROTOCOL.md` (Batch B adds static/PWA routes and `/share-target` to the mock
  only).
- `index.html` references `/app.js` / `/styles.css` (versioned), the manifest, favicon and
  apple-touch icon; no CDN, no webfonts, no external icon sheet, no inline scripts.
- Mock HTTP smoke: `/health`, `/` and the static assets; wrong PIN → `401`; correct PIN →
  `200` + `Set-Cookie`; a one-tap `?t=` token pairs once and the query is then stripped.
- Full SPA end-to-end pass in headless Chromium (driven over CDP) at 390 × 844, DPR 2 with
  touch emulation, against `node mock-server.js`: **74 assertions, zero failures**, zero
  console errors and zero uncaught exceptions (only the deliberate `401` / `429` network
  responses from the negative tests).
  - Pairing: serif headline, refined PIN slots, wrong-PIN inline error, PIN pairing, token
    pairing after unpair, `429` rate-limit countdown with disabled entry.
  - Transcript: plain serif assistant prose (no bubble), right-aligned warm user bubble,
    headings / lists / blockquote / inline code / pipe table / fenced `js` block, language
    label + copy, per-assistant copy action, tap-to-reveal timestamps, no horizontal
    overflow.
  - Tool cards: collapsed by default; tap expands args + output with real height and opacity;
    tap collapses; live `pwsh` call appears collapsed; failures keep auto-expanding.
  - Theme: Auto / Light / Dark control in the overflow sheet, `data-theme`, `color-scheme`
    and `theme-color` all update; dark palette tokens apply; the choice persists across a
    reload; theme is applied by `app.js` on init (the inline bootstrap was removed for
    CSP); Auto follows `prefers-color-scheme` live; reduced-motion collapses transitions
    and the caret blink.
  - Sheets and Activity: sessions drawer, new-session preset sheet and model sheet open
    from their buttons and close cleanly; Activity renders entries, live indicator,
    expandable rows and compact All / Tools / Errors filter.
  - Streaming and approvals: streaming caret, optimistic user bubble, stop button, approval
    card with ≥44 px Approve/Reject, one-tap approve resolving in place.
  - 44 px primary targets throughout, and `scrollWidth <= innerWidth` at the 390 px viewport.
- Screenshots captured during that pass: light/dark pairing, chat top and bottom, expanded
  tool, sheets, Activity, streaming, approval and rate-limit states.
- Screenshot review confirmed the intended composition: 58 px top bar, centred Chat/Activity
  switch, 700 px max transcript column, 17.5 px serif prose, floating pill composer with a
  44 px circular send button, fixed 844 px shell, no clipping or overflow.
- **Question-card pass** (same headless Chromium harness, against the mock question flow):
  **38 assertions, zero failures**, zero console errors and zero uncaught exceptions.
  - Settled history `ask_user_question` row renders as a read-only question card (no inputs),
    answers parsed from the JSON `output` (`Staging`, `Unit tests`, `Other: Also run the
    linter`), and `ask_user_question` never appears as a tool chip.
  - `Deploy…` produces a two-question batch: stacked questions, 2 radio options, 3 checkbox
    options, 2 custom inputs, Skip/Submit pair, Submit disabled until answered, 46 px rows.
  - Selecting radio + checkboxes + custom text, Submit → **Waiting for Harness…** with
    disabled actions → resolved read-only card showing chosen labels and custom text; the
    Activity timeline records `Question answered`.
  - Skip on a later batch resolves as `declined` with every answer shown as **Skipped**.
  - A request-only `question.request` (no tool row) renders an answerable card, adds no tool
    entry, survives a duplicate request re-render with its draft intact, and resolves
    read-only.
  - Light and dark question cards both verified, no horizontal overflow.
- Question screenshots: light history/pending/draft/waiting/resolved, dark resolved/pending/
  skipped, request-only and resolved states, plus the Activity entry.
- **Attachment pass** (same headless Chromium harness, against the mock upload endpoint with
  a 1 MB server limit and a 700 ms delay to make progress observable): **41 assertions, zero
  failures**, zero console errors and zero uncaught exceptions (only the deliberate `413`
  network response from the error-path test).
  - 44 px paperclip in the composer, hidden multi-file input, no chips before selection; send
    enabled with text, disabled while files upload, restored when all uploads complete.
  - Two files upload sequentially with a per-file progress chip; names/sizes show; removing a
    chip works; chips render in both light and dark.
  - Send keeps the message text and shows image thumbnails + non-image file names in the
    optimistic bubble, clears the chips, the mock logs the upload and the assistant reply
    echoes the attachment name; no upload paths ever appear in the DOM.
  - Reload restores image thumbnails (via `/api/preview`) and non-image file pills from
    history metadata.
  - Server `413` surfaces as an error chip ("too large"), blocks send, and can be removed;
    a >32 MB file is rejected client-side without any request; a forced send failure removes
    the optimistic bubble, restores the text and keeps the uploaded file; an attachment-only
    send works and clears chips.
  - No horizontal overflow, zero console errors/exceptions.
- Attachment screenshots: uploading, chips light/dark, sent bubble, history reload, 413 error,
  client-limit guard and attachment-only send.
- **Inline-preview pass** (same headless Chromium harness, with the broken-preview fixture
  enabled): **31 assertions, zero failures**, zero console errors and zero uncaught
  exceptions (only the deliberate `404` from the seeded broken preview).
  - Seeded history image loads through `/api/preview?session=sess-release&path=…`; the
    non-image attachment stays a pill; the missing image falls back to a
    `Preview unavailable` pill.
  - Tap opens the full-screen lightbox with the full image and filename caption; the 44 px
    close button and Escape both dismiss it.
  - Paperclip bounding-box checks pass at 390 px and 320 px width and with a grown
    multi-line composer: 44×44 size, fully inside the composer box, icon inside the
    button, no clipping ancestor and the hit-test at its centre resolves to the button.
  - Optimistic bubble uses a `blob:` thumbnail (loaded), chip removal and send revoke the
    composer object URLs, non-image attachments stay pills, chips clear on send.
  - Dark-mode thumbnails and lightbox verified; history reload switches the uploaded
    image to `/api/preview` and leaves no `blob:` images; an attachment-only message shows
    just the preview with reduced bubble padding.
  - No horizontal overflow and no unexpected network entries.
- Inline-preview screenshots: seeded history (thumbnail + broken fallback + pill), history
  lightbox, 320 px composer, optimistic thumbnail, optimistic lightbox, dark previews,
  dark lightbox, history-reload preview and attachment-only preview.
- **Cross-session notice/scoping pass** (headless Chromium, mock fixture with an active
  approval plus a foreign approval and question): **38 assertions, zero failures**, zero
  console errors and zero uncaught exceptions.
  - Notice bar is grid row 3 between the tabs and the transcript, 6-row app grid,
    bounding boxes show no overlap with the transcript or composer, no horizontal
    overflow, text/action not clipped, 44 px Open; shows `(+1)` for the second foreign item.
  - Only the active-session approval is inline; the foreign approval/question never appear
    in the active transcript. The active approval survives a `history`/session reopen.
  - Approval card stays inside the transcript column with 16 px padding, equal-width
    46 px Reject/Approve buttons and wrapped reason at 390 light, 390 dark and 320 both
    themes.
  - Open switches to the foreign approval's session, the card is re-attached and
    answerable there; approving it advances the notice; Open again re-attaches the release
    approval, then the design question, which is answerable in its own session. The notice
    removes itself when no foreign interactions remain.
- Cross-session screenshots: notice light/dark, 320 dark/light, opened API approval,
  release approval resolved, design question and its resolved state.

## Not covered here

The real Host bridge, auth/signing and desktop pairing panel are owned by other halves of
the plugin (`index.js`, `server.js`, `auth.js`, `bridge.js`, `client.js`), and the
`question.*` frames, `POST /api/upload` + `prompt.attachments`, history user attachments,
`GET /api/preview` and `PROTOCOL.md` are being added on the host side by the Lead. This
client consumes the documented frames/endpoints (including those extensions) and assumes
those halves implement them faithfully.

Batch B additionally depends on host-owned packaging/serving: `package.json` `files` must
ship the manifest, service worker, favicon and icon PNGs (the frozen `server.js` static
table and CSP already serve/support them). The mock was extended with those static routes
and `/share-target`, but the mock is dev-only and not part of the package. Real-device
states that cannot be asserted without a physical/emulated browser — iOS Add-to-Home-Screen
notification permission, the Android share sheet, live microphone permission, and
offline-then-update service-worker activation — are implemented defensively and documented
above; Web Push was driven end-to-end in headless Chrome against the mock (real push-service
subscription, test push, unsubscribe), but a *real Host push delivery* (encrypted RFC 8291
payload arriving on a locked phone) and iOS 16.4+ installed-app behaviour still need a phone
spot-check.
