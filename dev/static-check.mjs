// Static asset + header check for the phone SPA served by server.js.
//
// Fails (exit 1) instead of only printing: the SPA is served by this plugin, so a
// broken reference, a missing security header, a cacheable asset or a broken PWA
// install surface is a defect.
import assert from 'node:assert/strict'
import { RemoteMobileServer } from '../server.js'

const log = { info() {}, warn() {}, error() {} }
const bridge = {
  async listSessions() { return [] },
  subscribe() { return () => {} },
  dispose() {},
}
const server = new RemoteMobileServer({ logger: log }, { host: '127.0.0.1', port: 0 }, bridge, log)
await server.start()
const base = `http://127.0.0.1:${server.port}`

async function fetchOk(path, expectedType) {
  const response = await fetch(base + path)
  const body = await response.text()
  assert.equal(response.status, 200, `${path} status`)
  if (expectedType) assert.match(response.headers.get('content-type') ?? '', expectedType, `${path} content type`)
  return { response, body }
}

try {
  const pageResponse = await fetch(`${base}/`)
  const page = await pageResponse.text()
  assert.equal(pageResponse.status, 200, 'index status')
  assert.match(pageResponse.headers.get('content-type') ?? '', /text\/html/, 'index content type')
  const csp = pageResponse.headers.get('content-security-policy') ?? ''
  assert.match(csp, /script-src 'self'/, 'index is missing the CSP header')
  assert.match(csp, /worker-src 'self'/, 'CSP must allow the service worker')
  assert.match(csp, /img-src 'self' data: blob:/, 'CSP must allow blob: previews')
  assert.ok(page.length > 1000, 'index unexpectedly small')

  // The SPA busts its own cache with a version query, so match the reference and
  // then fetch exactly what the page asks for.
  const jsMatch = page.match(/src="(\/app\.js[^"]*)"/)
  const cssMatch = page.match(/href="(\/styles\.css[^"]*)"/)
  assert.ok(jsMatch, 'index.html does not reference /app.js')
  assert.ok(cssMatch, 'index.html does not reference /styles.css')
  assert.match(jsMatch[1], /\?v=\d+/, 'app.js reference is not cache-versioned')
  assert.match(cssMatch[1], /\?v=\d+/, 'styles.css reference is not cache-versioned')
  // Installability: manifest, touch icon and theme colour must be linked.
  assert.match(page, /rel="manifest" href="\/manifest\.webmanifest"/, 'index.html does not link the web app manifest')
  assert.match(page, /rel="apple-touch-icon"/, 'index.html does not link an apple touch icon')
  assert.match(page, /name="theme-color"/, 'index.html does not declare a theme colour')
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(page), 'index.html must not contain inline scripts (CSP)')

  for (const [path, contentType, cache] of [
    [jsMatch[1], /javascript/, /no-store/],
    [cssMatch[1], /text\/css/, /no-store/],
  ]) {
    const { response, body } = await fetchOk(path, contentType)
    assert.match(response.headers.get('cache-control') ?? '', cache, `${path} must not be cached`)
    assert.ok(body.length > 1000, `${path} unexpectedly small`)
    console.log(path, response.status, response.headers.get('content-type'), 'bytes', body.length)
  }

  const js = (await fetchOk(jsMatch[1])).body
  assert.ok(js.includes('/api/state'), 'app.js missing /api/state')
  assert.ok(js.includes('/api/pair'), 'app.js missing /api/pair')
  assert.ok(js.includes('/sw.js'), 'app.js does not register the service worker')

  // Installable PWA surface.
  const manifest = (await fetchOk('/manifest.webmanifest', /application\/manifest\+json/)).body
  const parsedManifest = JSON.parse(manifest)
  assert.equal(parsedManifest.name, 'DSH Remote')
  assert.equal(parsedManifest.display, 'standalone')
  assert.equal(parsedManifest.start_url, '/')
  assert.ok(Array.isArray(parsedManifest.icons) && parsedManifest.icons.length >= 3, 'manifest needs at least 3 icons')
  assert.ok(parsedManifest.icons.some((icon) => icon.purpose === 'maskable'), 'manifest needs a maskable icon')
  assert.equal(parsedManifest.share_target?.action, '/share-target')
  console.log('/manifest.webmanifest OK, icons', parsedManifest.icons.length)

  const sw = await fetchOk('/sw.js', /javascript/)
  assert.equal(sw.response.headers.get('service-worker-allowed'), '/', 'sw.js must be served with Service-Worker-Allowed: /')
  assert.ok(sw.body.includes('dsh-remote-v'), 'sw.js does not version its cache')

  for (const icon of ['/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/icons/apple-touch-icon.png']) {
    const response = await fetch(base + icon)
    assert.equal(response.status, 200, `${icon} status`)
    assert.match(response.headers.get('content-type') ?? '', /image\/png/, `${icon} content type`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    assert.ok(bytes.length > 100, `${icon} is empty`)
    assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], `${icon} is not a PNG`)
  }
  console.log('PWA icons OK')

  const favicon = await fetchOk('/favicon.svg', /image\/svg\+xml/)
  assert.ok(favicon.body.includes('<svg'), 'favicon.svg is not an SVG')

  // Share target bounces into the app with a JSON payload.
  const share = await fetch(`${base}/share-target?title=t&text=x&url=${encodeURIComponent('https://example.com')}`, {
    redirect: 'manual',
  })
  assert.equal(share.status, 302, 'share-target must redirect')
  const location = share.headers.get('location') ?? ''
  assert.match(location, /^\/\?share=/, 'share-target redirect must carry the share payload')
  const payload = JSON.parse(decodeURIComponent(location.slice('/?share='.length)))
  assert.deepEqual(payload, { title: 't', text: 'x', url: 'https://example.com' })
  console.log('/share-target OK')

  console.log('PASS static asset + header check')
} finally {
  await server.stop()
}
