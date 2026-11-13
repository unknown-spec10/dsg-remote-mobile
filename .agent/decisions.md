# Decisions and hard-won lessons

Short rationale for choices that are easy to "clean up" incorrectly.

## Packaging and identity

- **Scoped npm package.** `dsh-remote-mobile` is taken on npm by an unrelated project; the plugin
  publishes as `@deep-podder/dsh-remote-mobile` with `publishConfig.access: public`. The unscoped
  name must never be used.
- **One package, two halves.** The Host plugin and the browser client live in one npm package
  (`exports` + `dsh.client`); the SPA is served by the plugin server, not by DSH. Do not split
  them or add a build step.
- **Client registration id == package name.** This is a DSH rc.3 client-modules requirement, not
  a style choice. Renaming the package requires updating `client.js`, `cordis.patch.yml`, the
  profile dependency/junction and the docs together. The 0.0.5 → 0.0.6 release exists because that
  invariant was missed once and broke Web boot.
- **No `private: true`,** because the package is published. `files` is a strict whitelist; `dev/`
  intentionally stays out.

## Host/transport

- **Standalone server, not a DSH route.** The phone needs a stable origin/port independent of the
  desktop Web GUI, plus its own cookie/rate-limit/pairing model. DSH routes are used only for the
  desktop panel bootstrap.
- **Defensive service access.** `ctx.get(...)` everywhere; deployments compose different bundles.
  Missing services degrade the feature, they never crash the Host.
- **Listener retry.** A desktop restart can overlap the previous process. Failing once used to
  leave the plugin active with no phone server until another restart; retrying with backoff is
  deliberate. `listening`/`listenError` in the panel status is the diagnostic.
- **State backup.** `.bak` exists because a plugin reload raced the state save and could drop all
  paired devices. Only an unreadable main file falls back to the backup; a valid file with zero
  devices is respected (revoke-all is a real user action).
- **No arbitrary HTTPS from the Host.** Push endpoints are allowlisted/provider-checked so a
  paired device cannot use the Host as a request proxy.

## Security policy

- **Approvals are first-answer-wins**, with the desktop dock mirroring the same list and a
  per-device `canApprove` gate. If the phone is attached it answers exclusively; with no phone the
  desktop answerer stays authoritative.
- **Commands are the Agent's registry minus policy.** `/export` (desktop download) and
  `/permission` (sandbox/approval preset) are hidden by name and by first-party definition id.
  A restricted device must never be able to disable the approval gate it cannot answer. Showing
  "all commands" was a product request; keeping these two hidden is the security boundary.
- **Reply pushes carry an excerpt.** The user explicitly asked for context in notifications; the
  body is a ≤150-char flattened excerpt, which is conversation content on the lock screen. That is
  documented as a privacy note rather than removed.
- **Secret scanning false positive.** The RFC 8291 Appendix A `auth_secret` is public test data;
  it is split into fragments so generic scanners stay quiet. Never rotate/replace it — the
  byte-exact test vector is the guard against non-interoperable encryption.

## Product/UI

- **Sessions are grouped by the Host's projects**, matching the desktop sidebar; unknown cwd =
  Ungrouped. The phone does not invent projects or reorder the registry.
- **Archived sessions are hidden by default**, matching the desktop default filter; an explicit
  **Show archived (N)** control is the escape hatch. The old always-visible collapsed footer group
  was removed after user feedback.
- **Commands palette mirrors the Host**, with argument input and a 10 s list timeout. Hidden
  commands are filtered in the bridge, not just the UI.
- **App lock is a client-side privacy gate** (WebAuthn needs HTTPS/localhost). It is documented as
  a deterrent; the cookie + desktop revoke are the real security controls.
- **Screenshots come from the mock**, never from a live Host (real session titles/paths would leak
  into a public repo). The mock therefore mirrors the v20 frames (workspaces, commands, push
  report) to keep the screenshots honest.
- **The phone cannot delete sessions, browse files or change policy.** Session management stops at
  rename/fork/pin/archive/open; that is intentional scope, not an unfinished feature.

## Operations

- **You are usually inside the Host you are modifying.** Prefer `plugin_manager` reloads to
  killing DSH; full restarts are the user's action. Client-module changes need a page reload.
- **The desktop app owns the `desktop` profile.** Its recovery action resets bundles and the user
  patch (with a `.bak-*`); always restore after a recovery.
- **Version bumps touch six files**; `release-check` is the contract. Published npm versions are
  immutable — fix forward with a patch release.
- **Screenshots, README and GitHub raw URLs** are part of the release; regenerate/web URLs must
  stay valid (repo `unknown-spec10/dsg-remote-mobile`, branch `main`).
