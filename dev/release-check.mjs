// Public-release packaging check.
//
// Deterministic: no Host, no network, no pairing. Fails (exit 1) when the npm
// package would be incomplete (a runtime asset not matched by `files`), when a
// `files` entry matches nothing (a stale pattern), when the public docs regress
// (missing LICENSE/SECURITY, internal absolute paths, the removed
// `/api/client-error` endpoint creeping back), or when the bridge/server grows a
// dynamic-code or shell-execution primitive.
//
// Usage: node dev/release-check.mjs
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative, sep } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** Every file under the plugin root, relative and slash-separated. */
function listFiles(directory = root) {
  const out = []
  for (const name of readdirSync(directory)) {
    if (name === 'node_modules' || name === '.git') continue
    const absolute = join(directory, name)
    const info = statSync(absolute)
    if (info.isDirectory()) out.push(...listFiles(absolute))
    else out.push(relative(root, absolute).split(sep).join('/'))
  }
  return out
}

const files = listFiles()

/** npm `files` globs are simple here: `*`, `**`, `?`. */
function globToRegExp(pattern) {
  let out = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        out += '.*'
        index += 1
        if (pattern[index + 1] === '/') index += 1
      } else {
        out += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      out += '[^/]'
      continue
    }
    out += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`${out}$`)
}

// --- package.json metadata -------------------------------------------------

assert.equal(typeof pkg.name, 'string')
assert.match(
  pkg.name,
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/,
  'package name must be an npm-safe id (scoped names include @scope/)',
)
assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'version must be semver')
assert.equal(pkg.type, 'module', 'the plugin is plain ESM')
assert.equal(pkg.license, 'MIT', 'LICENSE file and package.json must agree on MIT')
assert.ok(typeof pkg.description === 'string' && pkg.description.length >= 20, 'package description is missing')
assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0, 'package.json `files` is missing')
assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml', 'dsh.bundle.patch must point at the bundle patch')
assert.equal(pkg.dsh?.client?.platform, 'web', 'the client half is a web module')

// Public npm release metadata: no `private`, scoped packages publish publicly,
// and the repository/homepage/bugs links must point somewhere real.
assert.notEqual(pkg.private, true, 'package.json must not be private for an npm release')
assert.equal(pkg.publishConfig?.access, 'public', 'publishConfig.access must be "public" for a scoped package')
assert.match(pkg.repository?.url ?? '', /^git\+https:\/\/github\.com\/[^/]+\/[^/]+\.git$/, 'repository.url must be a GitHub git URL')
assert.match(pkg.homepage ?? '', /^https:\/\/github\.com\//, 'homepage must be a GitHub URL')
assert.match(pkg.bugs?.url ?? '', /^https:\/\/github\.com\/.+\/issues$/, 'bugs.url must be a GitHub issues URL')

// `exports` targets must exist (wildcards are checked against the locale files).
for (const [key, target] of Object.entries(pkg.exports ?? {})) {
  if (typeof target !== 'string' || target.includes('*')) continue
  assert.ok(files.includes(target.replace(/^\.\//, '')), `exports["${key}"] points at a missing file: ${target}`)
}

// The bundle patch itself must insert the Host row with the documented defaults.
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
assert.match(patch, /id:\s*dsh-remote-mobile/, 'cordis.patch.yml must insert the plugin row')
assert.ok(patch.includes(`name: '${pkg.name}'`), 'cordis.patch.yml row name must match the npm package name')
assert.match(patch, /port:\s*3456/, 'cordis.patch.yml must keep the documented default port')

// --- files completeness ----------------------------------------------------

// Everything the plugin needs at runtime or in its public docs.
const required = [
  'index.js', 'client.js', 'bridge.js', 'server.js', 'auth.js', 'push.js', 'qr.js',
  'cordis.patch.yml', 'icon.svg',
  'locale/en.json',
  'vendor/qrcode.js', 'vendor/LICENSE',
  'mobile/index.html', 'mobile/app.js', 'mobile/styles.css',
  'mobile/manifest.webmanifest', 'mobile/sw.js', 'mobile/favicon.svg',
  'mobile/icons/icon-192.png', 'mobile/icons/icon-512.png',
  'mobile/icons/icon-maskable-512.png', 'mobile/icons/apple-touch-icon.png',
  'mobile/mock-server.js', 'mobile/README.md',
  'README.md', 'PROTOCOL.md', 'SECURITY.md', 'LICENSE',
  'docs/api-notes.md', 'docs/api-notes-v2.md',
  // Screenshots referenced by README.md; they must travel with the npm package.
  'docs/screenshots/pairing-light.png',
  'docs/screenshots/sessions-light.png',
  'docs/screenshots/chat-light.png',
  'docs/screenshots/commands-dark.png',
]
const patterns = pkg.files.map(globToRegExp)
const matches = (file) => patterns.some((pattern) => pattern.test(file))
const present = new Set(files)
for (const file of required) {
  assert.ok(present.has(file), `required file is absent: ${file}`)
  // README/LICENSE/package.json are always published by npm even when not listed.
  if (['README.md', 'LICENSE'].includes(file)) continue
  assert.ok(matches(file), `package.json "files" does not publish required asset: ${file}`)
}

// Every pattern must match at least one real file, otherwise the package ships a
// stale entry and we lose track of what is actually included.
for (const pattern of pkg.files) {
  const regex = globToRegExp(pattern)
  assert.ok(files.some((file) => regex.test(file)), `package.json "files" has a dead entry: ${pattern}`)
}

// Runtime assets must never be excluded by accident: these directories are
// managed by other sub-agents, so assert their documented contents are covered.
for (const file of files.filter((name) => name.startsWith('mobile/'))) {
  assert.ok(matches(file), `mobile asset is not published (add it to files): ${file}`)
}

// --- public docs -----------------------------------------------------------

const read = (name) => readFileSync(join(root, name), 'utf8')
const mit = read('LICENSE')
assert.match(mit, /MIT License/, 'LICENSE must be the MIT license text')
assert.match(mit, /Copyright \(c\) 2026 dsh-remote-mobile contributors/, 'LICENSE copyright line is missing')

const security = read('SECURITY.md')
for (const heading of ['Threat model', 'Revoking and rotating', 'Reporting a vulnerability']) {
  assert.ok(security.includes(heading), `SECURITY.md is missing the "${heading}" section`)
}
assert.match(security, /client-side/i, 'SECURITY.md must state that the app lock is client-side')

const gitignore = read('.gitignore')
for (const entry of ['node_modules/', '*.log', 'remote-mobile-state.json', 'var/', 'dist/']) {
  assert.ok(gitignore.includes(entry), `.gitignore should ignore ${entry}`)
}

// Public docs must not leak the build machine's paths.
const publicDocs = ['README.md', 'PROTOCOL.md', 'SECURITY.md', ...files.filter((name) => /^docs\/.*\.md$/.test(name))]
for (const name of publicDocs) {
  const text = read(name)
  assert.ok(!/[A-Za-z]:[\\/]+Users[\\/]/.test(text), `${name} leaks an absolute user path`)
  assert.ok(!text.includes('D:\\Projects'), `${name} leaks a local project path`)
}

// The removed endpoint must not be documented or implemented again. The string
// is built at runtime so this check file does not match itself.
const forbiddenEndpoint = ['/api/', 'client', 'error'].join('-')
for (const name of files.filter((file) => /\.(?:js|mjs|md|json|ya?ml)$/.test(file))) {
  const text = read(name)
  assert.ok(!text.includes(forbiddenEndpoint), `${name} references the removed ${forbiddenEndpoint} endpoint`)
}

// Deterministic checks named in the README must exist.
const readme = read('README.md')
for (const match of readme.matchAll(/node (dev\/[\w.-]+\.mjs)/g)) {
  assert.ok(files.includes(match[1]), `README names a missing check: ${match[1]}`)
}

// --- backend hygiene -------------------------------------------------------

// The Host half must not shell out or build code from strings; the bridge only
// talks to Cordis services.
for (const name of ['index.js', 'server.js', 'bridge.js', 'auth.js', 'push.js', 'qr.js', 'client.js']) {
  const source = read(name)
  assert.ok(!/(?:^|[^.\w$])eval\s*\(/.test(source), `${name} must not use eval()`)
  assert.ok(!/new\s+Function\s*\(/.test(source), `${name} must not build functions from strings`)
  assert.ok(!/node:child_process|require\(['"]child_process/.test(source), `${name} must not spawn processes`)
}

// No personal contact placeholders / TODOs in the shipped source tree.
for (const name of ['index.js', 'server.js', 'bridge.js', 'auth.js', 'push.js', 'qr.js', 'client.js']) {
  const source = read(name)
  assert.ok(!/\bFIXME\b|\bXXX\b/.test(source), `${name} still contains a FIXME/XXX marker`)
}

// --- version + release invariants -----------------------------------------

// One version everywhere: package metadata, the two Host version constants,
// the SPA fallback (the Host's `ready` frame supplies the live value) and the
// PROTOCOL example.
const versionSources = {
  'package.json': pkg.version,
  'index.js': /const VERSION = '([^']+)'/.exec(read('index.js'))?.[1],
  'server.js': /const VERSION = '([^']+)'/.exec(read('server.js'))?.[1],
  'mobile/app.js': /var FALLBACK_VERSION = '([^']+)'/.exec(read('mobile/app.js'))?.[1],
  'PROTOCOL.md': /"type": "ready", "version": "([^"]+)"/.exec(read('PROTOCOL.md'))?.[1],
}
for (const [name, value] of Object.entries(versionSources)) {
  assert.equal(value, pkg.version, `${name} must carry the package version ${pkg.version}`)
}

// Commands that would bypass the phone's approval boundary must stay hidden.
const bridge = read('bridge.js')
assert.match(
  bridge,
  /PHONE_HIDDEN_COMMANDS = new Set\(\[[^\]]*'export'[^\]]*'permission'[^\]]*\]\)/,
  'the bridge must hide both /export and the policy-changing /permission from the phone',
)
assert.match(
  bridge,
  /PHONE_HIDDEN_COMMAND_DEFINITION_IDS = new Set\(\[[^\]]*dsh-permission-presets/,
  'policy-changing commands must also be hidden by first-party definition id',
)

// Every PUBLISHED text file must be free of the build machine's personal paths.
// This covers the mock server, mobile docs and anything else shipped, not just
// the root docs checked above.
const publishedText = files.filter((name) => matches(name) && /\.(?:js|mjs|md|json|ya?ml|html|css|webmanifest)$/.test(name))
for (const name of publishedText) {
  const text = read(name)
  assert.ok(!/[A-Za-z]:[\\/]+Users[\\/]/.test(text), `${name} leaks an absolute user path`)
  assert.ok(!/D:[\\/]Projects[\\/]/i.test(text), `${name} leaks a local project path`)
  assert.ok(!/\/Users\/[^/\s]+\//.test(text), `${name} leaks a local home path`)
}

console.log(`PASS release packaging check (${pkg.files.length} files entries, ${required.length} required assets, ${publishedText.length} published text files scanned)`)
