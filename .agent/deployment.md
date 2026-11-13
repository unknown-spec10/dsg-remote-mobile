# Deployment (DSH profile)

## Identity

| Thing | Value |
|---|---|
| npm package | `@deep-podder/dsh-remote-mobile` |
| bundle row id | `dsh-remote-mobile` (in `cordis.patch.yml`) |
| bundle row name | `@deep-podder/dsh-remote-mobile` (must equal the package name) |
| default listen | `0.0.0.0:3456` (config `host`/`port`) |
| DSH profile (this machine) | `$DSH_HOME/profiles/desktop` (normally `~/.dsh/profiles/desktop`) |

## Profile wiring

A profile is a directory with a `package.json`:

```json
{
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "@deep-podder/dsh-remote-mobile"
  ] } },
  "dependencies": { "@deep-podder/dsh-remote-mobile": "link:<checkout>" }
}
```

plus the loader's `cordis.patch.yml` and `node_modules`. `resolveBundleDir` resolves a bundle
from the DSH installation first, then the profile; `node_modules/@deep-podder/dsh-remote-mobile`
can be a junction to this checkout for local development. A stale junction under the **old**
unscoped name (`node_modules/dsh-remote-mobile`) must be removed — keeping both aliases is how a
package rename ends up loaded twice.

Important: the desktop app manages the `desktop` profile. Its crash recovery writes
`profile/cordis.patch.yml` to `cordis.patch.yml.bak-<epoch>` and resets
`dsh.profile.bundles` to the shipped web template. If a user "disables plugins" to recover, the
patch/bundles are reset — restore from the `.bak-*` file and re-add the bundles.

## Installing

- **From npm (after publish):** `plugin_manager action=install_bundle target=@deep-podder/dsh-remote-mobile`
  (or the plugin manager UI). This runs `pnpm` against the profile and records the bundle.
- **From a checkout:** `plugin_manager action=install_bundle target=<absolute path to this folder>`.
- **Manual profile edit:** set the dependency to `link:<checkout>` (or a version range), add the
  scoped name to `dsh.profile.bundles`, ensure `cordis.patch.yml` row name matches the package
  name, and provide `node_modules/@deep-podder/dsh-remote-mobile`. Fix `pnpm-lock.yaml` if it still
  names the old package.

## Reloading without losing the session

If the agent runs **inside** the Host being changed, do not kill DSH. Toggle the plugin row:

```text
plugin_manager action=set_plugin enabled=false target=include:dsh-remote-mobile
plugin_manager action=set_plugin enabled=true  target=include:dsh-remote-mobile
```

This re-imports `index.js`/`server.js` from disk and restarts the listener. Caveat: the client
module graph (`client.js`) is composed at page boot; after changing `client.js` the desktop page
needs a reload. A full Harness restart (user action) is the only way to reload the client module
graph and the profile bundle list itself.

Listener lifecycle: on `EADDRINUSE` the server retries with backoff (1/2/4/8/15/30 s), so a
restart overlap with the previous process resolves itself. Pairing state keeps one `.bak`
generation; a corrupt/raced main file falls back to it.

## Ports and exposure

- Direct LAN: `http://<lan-ip>:3456` — Windows firewall may block inbound TCP 3456 (the network
  profile matters); add a rule only if the user wants LAN access.
- Tailscale recommended: either the tailnet IP, or HTTPS through Serve:

```powershell
tailscale serve --bg --https=8443 http://127.0.0.1:3456
```

  Write the public URL to `$DSH_HOME/remote-mobile-state.json.public-url` (or set
  `PA_REMOTE_MOBILE_PUBLIC_URL`) and restart/reload the plugin; the panel/QR then advertises the
  HTTPS origin and Web Push + PWA + app lock become available.
- Never port-forward 3456 to the public internet.

## State files (`$DSH_HOME`)

| File | Meaning |
|---|---|
| `remote-mobile-state.json` | cookie secret, devices, VAPID keys, push subscriptions (0600) |
| `remote-mobile-state.json.bak` | previous good copy (startup fallback) |
| `remote-mobile-state.json.enabled` | `0`/`1` desktop on/off switch |
| `remote-mobile-state.json.public-url` | advertised HTTPS origin |
| `remote-mobile-state.json.desk-key` | loopback gate for desktop endpoints |
| `remote-mobile-state.json.debug.log` / `.access.log` | bounded diagnostics |

Deleting the main state file forgets devices/VAPID keys (phones must re-pair; push
re-subscriptions). It never touches DSH sessions.

## Verification after a deploy

```powershell
(Invoke-WebRequest http://127.0.0.1:3456/api/health).Content        # {"ok":true,"version":"..."}
# panel status through the Host (loopback + desk key):
#   GET http://127.0.0.1:<host-port>/remote-mobile/pairing?key=<desk-key>
#   expect enabled=true, listening=true, version=<package version>, devices>0
node dev/ui-check.mjs                                               # live SPA end-to-end
```

For Tailscale: `GET https://<node>.<tailnet>.ts.net:8443/api/health` should return the same JSON;
if the phone shows “page isn’t available” while Tailscale is healthy, check the listener and the
plugin panel `listening` field first.
