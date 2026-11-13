# Troubleshooting

Each entry is a failure actually seen in this project, its cause and the fix. Check here before
debugging from scratch.

## DSH won't start / “web boot: 1 entry did not activate”

Symptom in the desktop crash log
(`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-web-boot.log`):

```text
web boot: 1 entry did not activate
@deep-podder/dsh-remote-mobile: import failed
client-modules: duplicate factory registration for "dsh-remote-mobile"
```

Cause: `client.js` registered a short module id that no longer matched the manifest row id (the
package name) after the package was renamed to `@deep-podder/dsh-remote-mobile`. DSH rc.3 keys
factories by package name, so the bundle was loaded twice and aborted Web boot.

Fix: `client.js` must call
`window.__ModuleLoader__.load({ id: '@deep-podder/dsh-remote-mobile', … })`.
`dev/release-check.mjs` fails if it differs from `package.json`'s name. After changing
`client.js`, the desktop page needs a reload (client graph is composed at page boot).

Reproducing without touching the running Host: copy the profile `package.json` +
`cordis.patch.yml` into a temporary `$DSH_HOME/profiles/<name>`, add a scoped `node_modules`
junction to the checkout, boot with
`<runtime>\cli\bin\dsh.cmd --profile <name>` and load the printed token URL in headless Chrome;
assert zero console errors.

## Desktop recovery reset the profile

If the desktop app offers “disable plugins” after a failed boot, it calls `sanitizeProfile`:
renames `cordis.patch.yml` to `cordis.patch.yml.bak-<epoch>` and resets
`dsh.profile.bundles` to the shipped web template. Fix: restore the `.bak-*` patch, re-add the
bundles (base, web-app, agent-team if used, `@deep-podder/dsh-remote-mobile`), then verify.

## Phone: “page isn’t available” / site can’t be reached

1. Is the listener up? `Get-NetTCPConnection -LocalPort 3456 -State Listen` and
   `http://127.0.0.1:3456/api/health`.
2. If Tailscale Serve is healthy (`tailscale serve status`) but 3456 is dead, the phone proxy
   points at nothing. Common causes:
   - the Host loaded the plugin but `listen()` hit `EADDRINUSE` during a restart overlap (now
     retried with backoff, but an old process can still delay it);
   - the plugin row is disabled or not in the profile bundles;
   - the server threw before binding (check the Host's console/log).
3. Check the panel status through the Host:
   `GET http://127.0.0.1:<host-port>/remote-mobile/pairing?key=<desk-key>` →
   `enabled`, `listening`, `listenError`, `version`.
4. Reload without restarting DSH:
   `plugin_manager set_plugin enabled=false/true target=include:dsh-remote-mobile`.
   Then re-check `/api/health` and the phone.
5. Tailscale-specific: phone node offline/battery, `tailscale status`, tailnet DNS/MagicDNS.
   Plain LAN instead needs a Windows firewall inbound rule for TCP 3456.
6. After a shell/SW change the phone may serve an old cached shell; reload once or close/reopen
   the installed app.

## Paired phones or push disappeared after a reload

The server persists state to `$DSH_HOME/remote-mobile-state.json`; a reload can race the old and
new instance. The code now keeps a `.bak` and falls back to it only when the main file is
unreadable; a valid state with zero devices is treated as authoritative (intentional
revoke-all). If a pair is lost, re-pair with a fresh PIN/QR; sessions are untouched. Push
subscriptions must be re-enabled by opening the app and toggling Background notifications.

## Commands sheet stuck on “Loading commands…”

A builder called directly after an async frame appends to the sheet body and leaves the spinner.
Every async handler must rebuild with `buildSheet()` (clears the body). `openCommands()` has a
10 s timeout for a lost reply. Check `dev/ui-check.mjs`.

## Archived sessions visible / no project grouping

- Archived rows must be hidden by default; only **Show archived (N)** reveals them. The old
  collapsed footer toggle is gone; check the CSS/JS for `archived-toggle` leftovers.
- Grouping needs the Host to send `workspaces` + session `workspaceId` (v20 frames). Sessions
  created in an unregistered directory are **Ungrouped**, by design (same as desktop). If
  `workspaces` is empty, the SPA falls back to Pinned/Recent.

## Command palette shows only `/compact`

Old builds used a static allowlist. Current bridge must union `commands.list()` from the preset
service (`agentPresets.serviceFor(agent, 'commands')`) and the host `commands` service, then hide
`export`/`permission`. If a live check shows one item, inspect the bridge union and the Host log
(commands are preset-mounted in the shipped DSH composition).

## npm publish failures

See `release.md`: 403 → 2FA/OTP; 401 → `npm login`; 404 on PUT → auth/scope, not availability.
The unscoped package name is owned by another project; only the scoped name is valid.

## Dev/live-check environment

- Chrome must be installed; override `CHROME_PATH`. `CDP_PORT` may need changing if a probe died
  leaving a debug port.
- A leftover temp `dsh` test instance can hold 3080/3456; stop only the temp instance
  (`--profile <name>`), never the real Host. The test profiles live under `$env:TEMP\dsh-test-home*`.
- Live checks create and archive throwaway sessions; they revoke their own device. If a check is
  interrupted, its session may remain — archive it from the desktop or phone.
- Headless Chrome cannot start inside a confined subagent sandbox; run live probes from the Lead
  session or the user's shell.

## Startup retry / port overlap

`server.startListening()` retries `EADDRINUSE` with 1/2/4/8/15/30 s backoff. If a restart seems
stuck, wait ~30 s and re-check `/api/health` before assuming failure. `listenError` in the pairing
status shows the last bind error.
