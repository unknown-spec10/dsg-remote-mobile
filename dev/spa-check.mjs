// Static sanity check for the zero-dependency phone SPA.
//
// This catches the class of regression that a browser would otherwise be the
// only place to notice: a helper that is called but never defined (ReferenceError
// during boot), and a version bump that updates index.html but not the service
// worker (or vice versa), which leaves installed phones on a mixed shell.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const mobileDir = fileURLToPath(new URL('../mobile/', import.meta.url))
const appSource = readFileSync(new URL('app.js', new URL('../mobile/', import.meta.url)), 'utf8')
const html = readFileSync(`${mobileDir}index.html`, 'utf8')
const sw = readFileSync(`${mobileDir}sw.js`, 'utf8')

/** Strip comments and string literals so identifier scanning sees real code only. */
function stripNonCode(source) {
  let out = ''
  let i = 0
  const n = source.length
  while (i < n) {
    const ch = source[i]
    const next = source[i + 1]
    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i += 1
      while (i < n) {
        if (source[i] === '\\') {
          i += 2
          continue
        }
        if (source[i] === quote) {
          i += 1
          break
        }
        i += 1
      }
      out += '""'
      continue
    }
    out += ch
    i += 1
  }
  return out
}

const code = stripNonCode(appSource)

// Declarations are scanned in the original source: a naive string/regex stripper
// can swallow code after a regex literal containing quotes, which would make a
// real helper look undefined. Calls are scanned in the stripped code.
const declared = new Set()
for (const match of appSource.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) declared.add(match[1])
for (const match of appSource.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=/g)) declared.add(match[1])
for (const match of appSource.matchAll(/(?<![.\w$])([\w$]+)\s*=\s*function/g)) declared.add(match[1])
// Parameters are callable identifiers too (e.g. `resolve` inside a Promise executor).
for (const match of appSource.matchAll(/\bfunction\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/g)) {
  for (const part of match[1].split(',')) {
    const name = part.trim().replace(/^\.\.\./, '').split(/[=\s]/)[0]
    if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name)
  }
}
for (const match of appSource.matchAll(/\(([^()]*)\)\s*=>/g)) {
  for (const part of match[1].split(',')) {
    const name = part.trim().replace(/^\.\.\./, '').split(/[=\s]/)[0]
    if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name)
  }
}
for (const match of appSource.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*=>/g)) declared.add(match[1])

const builtins = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'new', 'else', 'do',
  'try', 'delete', 'void', 'in', 'instanceof', 'of', 'await', 'async', 'yield', 'case', 'throw',
  'with', 'class', 'super', 'this', 'window', 'document', 'navigator', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'fetch', 'JSON', 'Math', 'Object', 'Array', 'String', 'Number',
  'Boolean', 'Promise', 'Error', 'TypeError', 'RangeError', 'Date', 'RegExp', 'Map', 'Set',
  'WeakMap', 'WeakSet', 'URL', 'URLSearchParams', 'atob', 'btoa', 'requestAnimationFrame',
  'cancelAnimationFrame', 'encodeURIComponent', 'decodeURIComponent', 'parseInt', 'parseFloat',
  'isFinite', 'isNaN', 'Response', 'Request', 'Blob', 'File', 'FileReader', 'XMLHttpRequest',
  'WebSocket', 'getComputedStyle', 'matchMedia', 'localStorage', 'sessionStorage', 'Intl',
  'TextEncoder', 'TextDecoder', 'structuredClone', 'queueMicrotask', 'customElements',
  'speechSynthesis', 'Notification', 'PublicKeyCredential', 'crypto', 'performance',
  'ResizeObserver', 'IntersectionObserver', 'MutationObserver', 'AbortController', 'Headers',
  'FormData', 'Image', 'Audio', 'history', 'location', 'screen', 'devicePixelRatio', 'confirm',
  'alert', 'prompt', 'Symbol', 'Reflect', 'Proxy', 'Function', 'Uint8Array', 'Uint32Array',
  'ArrayBuffer', 'DataView', 'MessageChannel', 'addEventListener', 'removeEventListener',
  'getSelection', 'scrollTo', 'isSecureContext',
])

const missing = new Set()
for (const match of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
  const name = match[1]
  if (builtins.has(name) || declared.has(name)) continue
  missing.add(name)
}
assert.deepEqual(
  [...missing].sort(),
  [],
  'app.js calls identifiers that are never defined (a boot-time ReferenceError)'
)

// Version refs in the page and the service-worker precache must agree.
const jsVersion = /src="\/app\.js\?v=(\d+)"/.exec(html)?.[1]
const cssVersion = /href="\/styles\.css\?v=(\d+)"/.exec(html)?.[1]
assert.ok(jsVersion, 'index.html does not reference /app.js?v=<n>')
assert.equal(cssVersion, jsVersion, 'app.js and styles.css cache versions differ')
const cacheVersion = /var CACHE = 'dsh-remote-v(\d+)'/.exec(sw)?.[1]
assert.equal(cacheVersion, jsVersion, 'service worker cache version differs from the page asset version')
assert.ok(sw.includes(`/app.js?v=${jsVersion}`), 'service worker precache does not name the versioned app.js')
assert.ok(sw.includes(`/styles.css?v=${jsVersion}`), 'service worker precache does not name the versioned styles.css')

// Every DOM id the SPA caches must exist in the served HTML. Only the literal
// id list inside cacheRefs() is considered (other refs are derived from it).
const cachedIds = new Set()
const refsBlock = /function cacheRefs\(\) \{([\s\S]*?)\n  \}/.exec(appSource)?.[1] ?? ''
const idsBlock = /var ids = \[([\s\S]*?)\]/.exec(refsBlock)?.[1] ?? ''
for (const match of idsBlock.matchAll(/'([a-z0-9-]+)'/g)) cachedIds.add(match[1])
const missingIds = [...cachedIds].filter((id) => !html.includes(`id="${id}"`))
assert.deepEqual(missingIds, [], 'SPA caches DOM ids that index.html does not contain')

console.log(
  `PASS spa check (${declared.size} helpers, ${cachedIds.size} cached ids, v${jsVersion})`
)

