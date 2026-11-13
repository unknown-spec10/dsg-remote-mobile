# Release and publishing

## Current release facts

- npm package: `@deep-podder/dsh-remote-mobile` (public, scoped; `publishConfig.access: public`)
- GitHub: <https://github.com/unknown-spec10/dsg-remote-mobile> (branch `main`)
- Current tree version: **0.0.6** (0.0.5 was published but contains a client-registration bug —
  do not install it)
- The unscoped name `dsh-remote-mobile` is taken on npm by an unrelated project; never try to
  publish unscoped.

## Version bump checklist

Update the same version in all six places (release-check enforces agreement):

1. `package.json` → `version`
2. `index.js` → `const VERSION`
3. `server.js` → `const VERSION`
4. `mobile/app.js` → `var FALLBACK_VERSION`
5. `mobile/mock-server.js` → `const VERSION` (dev mock, shown by `capture-screenshots`)
6. `PROTOCOL.md` → the `ready` example version

Then:

```powershell
node dev/release-check.mjs
node dev/spa-check.mjs
node dev/static-check.mjs
node dev/server-smoke.mjs
node dev/push-check.mjs
node dev/changes-bridge-check.mjs
node dev/client-check.mjs
node dev/desk-auth-check.mjs
node dev/toggle-check.mjs
npm pack --dry-run          # review tarball: 36 files, no dev/, screenshots included
```

If the SPA shell changed, bump `?v=<n>` in `index.html` and the SW `CACHE`/`PRECACHE` together
(`dev/spa-check.mjs` fails otherwise) and regenerate screenshots (`node dev/capture-screenshots.mjs`).

## npm publish

The `deep-podder` account requires 2FA. `private` must be absent and `publishConfig.access`
`public` (both already set).

```powershell
cd <checkout>
npm login --auth-type=web        # if the CLI session expired (npm whoami → 401)
npm publish                      # prompts for the 6-digit OTP; or use --otp=<code>
npm view @deep-podder/dsh-remote-mobile version   # verify
```

Errors seen in practice:

- `403 ... Two-factor authentication ... required` → rebuild the OTP and retry
  (`npm publish --otp=<code>`), or use a granular token with 2FA bypass via `NODE_AUTH_TOKEN`.
- `401 Unauthorized` on `whoami` → expired login; `npm login` again.
- `404 Not Found` on PUT usually also means auth/token trouble for the scope (not name
  availability). Check `npm whoami` first.
- Never commit `.npmrc` or a token; it is gitignored.

## Git / GitHub

```powershell
git add -A
git commit -m "<focused message>"
git tag vX.Y.Z
git push
git push origin vX.Y.Z           # or --follow-tags
```

The remote is already `origin` → `https://github.com/unknown-spec10/dsg-remote-mobile.git`.
`main` is the default branch; `v0.0.6` tag exists. GitHub repo name uses **dsg** (not dsh) —
package README/bugs/screenshots raw URLs point there.

README images reference
`https://raw.githubusercontent.com/unknown-spec10/dsg-remote-mobile/main/docs/screenshots/*.png`,
which works only while the repo is public and the branch is `main`.

## Repository hygiene

- `package.json` `files` is a strict whitelist; `dev/` is **not** shipped, `mobile/mock-server.js`
  and `mobile/README.md` are.
- `dev/release-check.mjs` scans every **published** text file for personal paths (`C:\Users\…`,
  `D:\Projects\…`, `/Users/…`) and rejects TODO/FIXME/eval/child_process in shipped sources.
- Keep `docs/verification.md` as internal evidence; it is shipped but explicitly internal-only.
- Secret scanning: GitHub/GitGuardian may flag the RFC 8291 `auth_secret` in
  `dev/push-check.mjs`; it is published test data, not a credential. It is split in two string
  fragments to avoid generic detectors; resolve old alerts as false positives.
- Optional repo metadata to set in GitHub: description and topics (`deepseek-harness`, `dsh`,
  `dsh-plugin`, `mobile`, `remote`).

## After publishing

- Bump nothing further; update the README badge automatically via npm.
- If an already-published version is broken, publish a new patch version — published versions are
  immutable. 0.0.5 → 0.0.6 exists for exactly that reason.
- Verify the npm page renders the README and screenshots, then create a GitHub release from the
  matching tag.
