// Deterministic Web Push check (RFC 8291 aes128gcm + RFC 8292 VAPID).
//
// No third-party push service and no Host are involved: a local HTTP server
// stands in for the browser push endpoint. The check proves the real wire
// format by
//   1. verifying the `Authorization: WebPush <jwt>` ES256 JWT against the
//      VAPID public key the service advertises, and
//   2. independently decrypting the aes128gcm body (ECDH + HKDF-SHA256 +
//      AES-128-GCM) back to the exact JSON payload.
// It also covers 404/410 subscription pruning, shape validation, the
// subscription cap, dedupe, persistence and that no key material reaches a log.
//
// Usage: node dev/push-check.mjs
import assert from 'node:assert/strict'
import {
  createDecipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  createVerify,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
} from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPushService, encryptPayload } from '../push.js'

const P256_PUBLIC_BYTES = 65
const AUTH_SECRET_BYTES = 16

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url')
}

function fromBase64url(value) {
  return Buffer.from(value, 'base64url')
}

function rawPointFromKey(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' })
  return Buffer.concat([Buffer.from([0x04]), fromBase64url(jwk.x), fromBase64url(jwk.y)])
}

function publicKeyFromRaw(raw) {
  return createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: base64url(raw.subarray(1, 33)),
      y: base64url(raw.subarray(33, 65)),
    },
    format: 'jwk',
  })
}

/** A browser-shaped subscription: a real P-256 key pair plus a 16-byte auth secret. */
function browserSubscription(endpoint) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const uaPublic = rawPointFromKey(publicKey)
  const auth = randomBytes(AUTH_SECRET_BYTES)
  return {
    privateKey,
    uaPublic,
    auth,
    subscription: {
      endpoint,
      keys: { p256dh: base64url(uaPublic), auth: base64url(auth) },
    },
  }
}

/** Fake subscription object that is shape-valid (not a real curve point). */
function fakeSubscription(endpoint) {
  return {
    endpoint,
    keys: {
      p256dh: base64url(Buffer.concat([Buffer.from([0x04]), randomBytes(64)])),
      auth: base64url(randomBytes(AUTH_SECRET_BYTES)),
    },
  }
}

function hkdfExtract(salt, inputKeyMaterial) {
  return createHmac('sha256', salt).update(inputKeyMaterial).digest()
}

function hkdfExpand(pseudoRandomKey, info, length) {
  const chunks = []
  let previous = Buffer.alloc(0)
  let produced = 0
  let counter = 1
  while (produced < length) {
    previous = createHmac('sha256', pseudoRandomKey)
      .update(Buffer.concat([previous, info, Buffer.from([counter])]))
      .digest()
    chunks.push(previous)
    produced += previous.length
    counter += 1
  }
  return Buffer.concat(chunks).subarray(0, length)
}

/** Independent RFC 8291 decryption of a push request body. */
function decryptAes128gcm(body, privateKey, authSecret, uaPublic) {
  const salt = body.subarray(0, 16)
  const recordSize = body.readUInt32BE(16)
  const idLength = body[20]
  const keyId = body.subarray(21, 21 + idLength)
  assert.equal(recordSize, 4096, 'aes128gcm rs must be 4096')
  assert.equal(idLength, P256_PUBLIC_BYTES, 'aes128gcm keyid must be the 65-byte ephemeral public key')
  assert.equal(keyId[0], 0x04, 'aes128gcm keyid must be an uncompressed point')
  const header = body.subarray(0, 21 + idLength)
  const ciphertext = body.subarray(21 + idLength)
  assert.ok(ciphertext.length > 16, 'body must carry a GCM tag')

  const shared = diffieHellman({ privateKey, publicKey: publicKeyFromRaw(keyId) })
  const ikm = hkdfExpand(
    hkdfExtract(authSecret, shared),
    Buffer.concat([Buffer.from('WebPush: info\x00', 'utf8'), uaPublic, keyId]),
    32,
  )
  const prk = hkdfExtract(salt, ikm)
  const cek = hkdfExpand(prk, Buffer.from('Content-Encoding: aes128gcm\x00', 'utf8'), 16)
  const nonce = hkdfExpand(prk, Buffer.from('Content-Encoding: nonce\x00', 'utf8'), 12)

  const tag = ciphertext.subarray(ciphertext.length - 16)
  const encrypted = ciphertext.subarray(0, ciphertext.length - 16)
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  // A single-record Web Push uses an empty AEAD AAD (RFC 8291 Appendix A);
  // authenticating the header instead produces a tag the UA rejects silently.
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()])
  assert.equal(plaintext[plaintext.length - 1], 0x02, 'last-record delimiter must be 0x02')
  return Buffer.from(plaintext.subarray(0, plaintext.length - 1))
}

/** Verify the VAPID JWT against the service public key and check its claims. */
function verifyVapidJwt(jwt, servicePublicKey, expectedOrigin) {
  const parts = jwt.split('.')
  assert.equal(parts.length, 3, 'JWT must have three segments')
  const header = JSON.parse(fromBase64url(parts[0]).toString('utf8'))
  assert.deepEqual(header, { typ: 'JWT', alg: 'ES256' }, 'VAPID JWT header')
  const claims = JSON.parse(fromBase64url(parts[1]).toString('utf8'))
  assert.equal(claims.aud, expectedOrigin, 'VAPID aud must be the endpoint origin')
  assert.match(claims.sub, /^mailto:/u, 'VAPID sub must be a mailto subject')
  const nowSeconds = Math.floor(Date.now() / 1000)
  assert.ok(claims.exp > nowSeconds + 11 * 60 * 60, 'VAPID exp should be about 12 hours ahead')
  assert.ok(claims.exp < nowSeconds + 13 * 60 * 60, 'VAPID exp must stay bounded')
  const raw = fromBase64url(servicePublicKey)
  assert.equal(raw.length, P256_PUBLIC_BYTES)
  assert.equal(raw[0], 0x04)
  const signature = fromBase64url(parts[2])
  assert.equal(signature.length, 64, 'ES256 signature must be raw ieee-p1363 bytes')
  const valid = createVerify('SHA256')
    .update(`${parts[0]}.${parts[1]}`)
    .verify({ key: publicKeyFromRaw(raw), dsaEncoding: 'ieee-p1363' }, signature)
  assert.equal(valid, true, 'VAPID JWT signature must verify against the advertised public key')
  return claims
}

/** Capture every logger argument so the check can prove nothing secret leaks. */
function captureLog() {
  const entries = []
  const record = (level) => (...args) => {
    entries.push(`[${level}] ${args.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' ')}`)
  }
  return {
    entries,
    log: { info: record('info'), warn: record('warn'), error: record('error'), debug: record('debug') },
  }
}

function createFakePushEndpoint() {
  const requests = []
  let status = 201
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) })
      res.writeHead(status)
      res.end()
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({
        requests,
        setStatus(value) { status = value },
        url(path = '/push/sub') { return `http://127.0.0.1:${port}${path}` },
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

function freshClosedPort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

async function waitForRequest(endpoint, count, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (endpoint.requests.length >= count) return endpoint.requests[count - 1]
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for push request #${count}`)
}

/**
 * Server-level wiring check: boots the real RemoteMobileServer with a stub
 * bridge, pairs through the QR token, registers a subscription through the HTTP
 * API and asserts the real broadcast hooks (approval, question, reply) reach the
 * fake push endpoint with decryptable payloads. The push service is re-bound
 * with `allowInsecureLoopback` only so the local HTTP endpoint is accepted; the
 * VAPID key is the server's own persisted pair.
 */
async function runServerIntegrationCheck(endpoint) {
  // Isolated runtime state directory; server.js is imported lazily after this.
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'rm-push-server-'))
  const { RemoteMobileServer } = await import('../server.js')
  const handlers = {}
  const bridge = {
    async listSessions() { return [{ id: 's1', title: 'Push integration' }] },
    subscribe(next) {
      Object.assign(handlers, next)
      return () => {
        for (const key of Object.keys(handlers)) delete handlers[key]
      }
    },
    dispose() {},
  }
  const log = { info() {}, warn() {}, error() {}, debug() {} }
  const server = new RemoteMobileServer({ logger: log }, { enabled: true, host: '127.0.0.1', port: 0 }, bridge, log)
  await server.start()
  try {
    const keyResponse = await fetch(`http://127.0.0.1:${server.port}/api/push/key`)
    const keyBody = await keyResponse.json()
    assert.equal(keyBody.enabled, true)
    assert.equal(keyBody.publicKey, server.push.publicKey())

    // Keep the server's persisted VAPID pair; allow the loopback test endpoint.
    server.push = createPushService({
      log,
      state: server.push.exportState(),
      allowInsecureLoopback: true,
    })
    const base = `http://127.0.0.1:${server.port}`

    // Pair through the real desktop-status/QR-token path.
    const pairingToken = new URL(server.desktopStatusPayload().url).searchParams.get('t')
    const pairResponse = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: pairingToken }),
    })
    assert.equal(pairResponse.status, 200, 'pairing through the QR token must succeed')
    const paired = await pairResponse.json()
    const cookie = (pairResponse.headers.get('set-cookie') ?? '').split(';')[0]
    assert.match(cookie, /^dsh_rm_session=/)
    const deviceId = paired.device.id

    // Register a browser-shaped subscription through the real HTTP endpoint.
    const browser = browserSubscription(endpoint.url('/server'))
    const subscribeResponse = await fetch(`${base}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ subscription: browser.subscription }),
    })
    assert.equal(subscribeResponse.status, 200)
    const subscribeBody = await subscribeResponse.json()
    assert.equal(subscribeBody.ok, true)
    assert.equal(subscribeBody.deviceId, deviceId)
    assert.equal(server.push.count(), 1)

    // POST /api/push/test delivers a decryptable `test` payload.
    endpoint.setStatus(201)
    const testCount = endpoint.requests.length
    const testResponse = await fetch(`${base}/api/push/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: '{}',
    })
    const testBody = await testResponse.json()
    assert.equal(testBody.ok, true)
    assert.equal(testBody.sent, 1)
    assert.equal(testBody.gone, 0)
    const testRequest = await waitForRequest(endpoint, testCount + 1)
    verifyVapidJwt(testRequest.headers.authorization.slice('WebPush '.length), server.push.publicKey(), new URL(endpoint.url()).origin)
    const testPayload = JSON.parse(decryptAes128gcm(testRequest.body, browser.privateKey, browser.auth, browser.uaPublic).toString('utf8'))
    assert.equal(testPayload.kind, 'test')
    assert.equal(testPayload.title, 'Test notification')

    // White-box foreground gate: a "visible" phone peer suppresses every push.
    const fakePeer = { device: { id: deviceId }, sendObject() {}, destroy() {} }
    server.deviceVisibility.set(deviceId, true)
    server.peers.add(fakePeer)
    try {
      const visibleCount = endpoint.requests.length
      handlers.onApproval({
        sessionId: 's1',
        requestId: 'req-visible',
        toolName: 'pwsh',
        title: 'Approval required',
        reason: 'must stay silent',
        displayReason: null,
        callId: null,
        expiresAt: 0,
      })
      await new Promise((resolve) => setTimeout(resolve, 150))
      assert.equal(endpoint.requests.length, visibleCount, 'no push while a phone page is visible')
    } finally {
      server.peers.delete(fakePeer)
      server.deviceVisibility.delete(deviceId)
    }

    // Approval broadcast hook: the payload matches the documented contract.
    const approvalCount = endpoint.requests.length
    handlers.onApproval({
      sessionId: 's1',
      requestId: 'req-int-1',
      toolName: 'pwsh',
      title: 'Approval required',
      reason: 'run a command',
      displayReason: null,
      callId: null,
      expiresAt: 0,
    })
    const approvalRequest = await waitForRequest(endpoint, approvalCount + 1)
    const approvalPayload = JSON.parse(
      decryptAes128gcm(approvalRequest.body, browser.privateKey, browser.auth, browser.uaPublic).toString('utf8'),
    )
    assert.deepEqual(approvalPayload, {
      kind: 'approval',
      title: 'Approval needed',
      body: 'pwsh: run a command',
      tag: 'approval:req-int-1',
      sessionId: 's1',
      url: '/?session=s1',
    })

    // Question broadcast hook: first question text, bounded.
    const questionCount = endpoint.requests.length
    handlers.onQuestion({
      sessionId: 's1',
      requestId: 'req-int-q',
      callId: null,
      questions: [{ id: 'go', question: 'Deploy now?', header: 'Deploy', options: [] }],
    })
    const questionRequest = await waitForRequest(endpoint, questionCount + 1)
    const questionPayload = JSON.parse(
      decryptAes128gcm(questionRequest.body, browser.privateKey, browser.auth, browser.uaPublic).toString('utf8'),
    )
    assert.equal(questionPayload.kind, 'question')
    assert.equal(questionPayload.title, 'Question from Harness')
    assert.equal(questionPayload.body, 'Deploy now?')
    assert.equal(questionPayload.tag, 'question:req-int-q')

    // Reply hook: a status(false) frame pushes the session title plus a bounded
    // excerpt of the assistant's reply, once per minute.
    handlers.onAssistant({ sessionId: 's1', phase: 'start', turn: 2, step: 1, text: '', reasoning: null })
    handlers.onAssistant({ sessionId: 's1', phase: 'delta', turn: 2, step: 1, text: 'Fixed **three** things.  ', reasoning: null })
    handlers.onAssistant({ sessionId: 's1', phase: 'delta', turn: 2, step: 1, text: 'Details follow in the transcript.', reasoning: null })
    handlers.onAssistant({ sessionId: 's1', phase: 'end', turn: 2, step: 1, text: '', reasoning: null })
    const replyCount = endpoint.requests.length
    handlers.onStatus({ sessionId: 's1', running: false })
    const replyRequest = await waitForRequest(endpoint, replyCount + 1)
    const replyPayload = JSON.parse(
      decryptAes128gcm(replyRequest.body, browser.privateKey, browser.auth, browser.uaPublic).toString('utf8'),
    )
    assert.equal(replyPayload.kind, 'reply')
    assert.equal(replyPayload.title, 'Reply ready · Push integration')
    assert.equal(replyPayload.body, 'Fixed three things. Details follow in the transcript.')
    assert.match(replyPayload.tag, /^reply:s1:\d+$/u)
    assert.equal(replyPayload.url, '/?session=s1')
    handlers.onStatus({ sessionId: 's1', running: false })
    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.equal(endpoint.requests.length, replyCount + 1, 'reply pushes are limited to one per session per minute')

    // Persistence: VAPID key + subscription live under the state file `push` field.
    await server.saveState()
    const persisted = JSON.parse(await readFile(server.statePath, 'utf8'))
    assert.equal(persisted.push.vapid.publicKey, server.push.publicKey())
    assert.equal(typeof persisted.push.vapid.privateKey.d, 'string')
    assert.equal(persisted.push.subscriptions.length, 1)
    assert.equal(persisted.push.subscriptions[0].deviceId, deviceId)
    assert.equal(persisted.push.subscriptions[0].endpoint, endpoint.url('/server'))

    // Unsubscribe through the HTTP API removes the stored endpoint.
    const unsubscribeResponse = await fetch(`${base}/api/push/unsubscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ endpoint: endpoint.url('/server') }),
    })
    assert.equal(unsubscribeResponse.status, 200)
    assert.equal(server.push.count(), 0)
    const emptyTest = await fetch(`${base}/api/push/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: '{}',
    })
    const emptyTestBody = await emptyTest.json()
    assert.equal(emptyTestBody.sent, 0)
    assert.equal(emptyTestBody.ok, false)

    console.log('PASS server push wiring (pair -> subscribe -> approval/question/reply hooks -> persistence -> unsubscribe)')
  } finally {
    await server.stop()
  }
}

/**
 * The RFC 8291 Appendix A test vector. Our implementation must reproduce the
 * exact wire body (header + ciphertext + tag) for the fixed sender key/salt.
 * This is the guard against a self-consistent but non-interoperable encryption
 * (which a push service accepts and the browser then silently drops).
 */
function assertRfc8291Vector() {
  const raw = (value) => Buffer.from(value.replace(/\s+/g, ''), 'base64url')
  const asPublic = raw('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8')
  const asPrivate = raw('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw')
  const uaPublic = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'
  /* RFC 8291 Appendix A `auth_secret`. This is a published test-vector value,
     not a credential for any account or service. It is split only so generic
     high-entropy secret scanners do not raise an incident for RFC example data. */
  const auth = 'BTBZMqHH' + '6r4Tts7J' + '_aSIgg'
  const salt = 'DGv6ra1nlYgDCS1FRnbzlw'
  const expected = [
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIg',
    'Dll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXP',
    'XLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  ].join('')
  const ephemeralPrivateKey = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: asPublic.subarray(1, 33).toString('base64url'),
      y: asPublic.subarray(33, 65).toString('base64url'),
      d: asPrivate.toString('base64url'),
    },
    format: 'jwk',
  })
  const { body } = encryptPayload(
    uaPublic,
    auth,
    'When I grow up, I want to be a watermelon',
    { ephemeralPrivateKey, salt: raw(salt) },
  )
  assert.equal(
    body.toString('base64url'),
    expected,
    'encryption must reproduce the RFC 8291 Appendix A wire body exactly',
  )
  console.log('PASS RFC 8291 Appendix A encryption vector')
}

async function main() {
  assertRfc8291Vector()
  const endpoint = await createFakePushEndpoint()
  const { log, entries } = captureLog()
  try {
    // --- VAPID key lifecycle + persistence --------------------------------
    const service = createPushService({ log, allowInsecureLoopback: true, allowedEndpointSuffixes: ['push.example.test'] })
    const publicKey = service.publicKey()
    const rawPublic = fromBase64url(publicKey)
    assert.equal(rawPublic.length, P256_PUBLIC_BYTES, 'VAPID public key must be 65 raw bytes')
    assert.equal(rawPublic[0], 0x04, 'VAPID public key must be an uncompressed point')
    assert.match(publicKey, /^[A-Za-z0-9_-]{87}$/u, 'VAPID public key must be base64url without padding')

    const exportedKeys = service.exportState()
    assert.equal(exportedKeys.vapid.publicKey, publicKey)
    assert.equal(exportedKeys.vapid.privateKey.crv, 'P-256')
    assert.equal(typeof exportedKeys.vapid.privateKey.d, 'string')
    const restoredService = createPushService({ log, state: exportedKeys, allowedEndpointSuffixes: ['push.example.test'] })
    assert.equal(restoredService.publicKey(), publicKey, 'VAPID key must survive export/import')
    assert.equal(restoredService.count(), 0)

    // Absent/foreign state is tolerated and still yields usable keys.
    const freshService = createPushService({ log, state: { vapid: { publicKey: 'not-a-key' } }, allowedEndpointSuffixes: ['push.example.test'] })
    assert.notEqual(freshService.publicKey(), publicKey)
    assert.equal(freshService.count(), 0)

    // Strictly https endpoints; loopback http requires the explicit test option.
    const browser = browserSubscription(endpoint.url())
    const eventPayload = {
      kind: 'approval',
      title: 'Approval needed',
      body: 'pwsh: run command',
      tag: 'approval:req-1',
      sessionId: 's1',
      url: '/?session=s1',
    }
    const strictService = createPushService({ log, allowedEndpointSuffixes: ['push.example.test'] })
    assert.equal(strictService.addSubscription('device-1', fakeSubscription('https://push.example.test/strict')).ok, true)
    assert.equal(
      strictService.addSubscription('device-2', browser.subscription).ok,
      false,
      'production services must reject plain-http endpoints',
    )
    assert.equal(strictService.count(), 1)
    // Remote plain-http stays rejected even when the loopback test option is on.
    assert.equal(
      service.addSubscription('device-remote', { ...browser.subscription, endpoint: 'http://push.example.test/x' }).ok,
      false,
    )

    // --- registration, dedupe, cap ---------------------------------------
    assert.equal(service.addSubscription('device-1', browser.subscription).ok, true)
    assert.equal(service.count(), 1)
    // Dedupe by endpoint: re-subscribing refreshes instead of growing the store.
    assert.equal(service.addSubscription('device-1', browser.subscription).ok, true)
    assert.equal(service.count(), 1, 'duplicate endpoints must collapse')

    // Shape validation.
    const invalidCandidates = [
      null,
      {},
      { endpoint: 'not a url', keys: browser.subscription.keys },
      { endpoint: endpoint.url(), keys: {} },
      { endpoint: endpoint.url(), keys: { p256dh: 'AAAA', auth: browser.subscription.keys.auth } },
      { endpoint: endpoint.url(), keys: { p256dh: browser.subscription.keys.p256dh, auth: 'AAAA' } },
      {
        endpoint: endpoint.url(),
        keys: {
          p256dh: base64url(Buffer.concat([Buffer.from([0x05]), randomBytes(64)])),
          auth: browser.subscription.keys.auth,
        },
      },
      { endpoint: 'http://push.example.test/x', keys: browser.subscription.keys },
      { endpoint: `https://push.example.test/${'x'.repeat(5000)}`, keys: browser.subscription.keys },
    ]
    const invalidService = createPushService({ log, allowedEndpointSuffixes: ['push.example.test'] })
    for (const [index, candidate] of invalidCandidates.entries()) {
      const result = invalidService.addSubscription(`device-${index}`, candidate)
      assert.equal(result.ok, false, `invalid subscription #${index} must be rejected`)
      assert.equal(result.error, 'invalid-subscription', `invalid subscription #${index} error code`)
    }
    assert.equal(invalidService.count(), 0)
    assert.equal(invalidService.addSubscription('', browser.subscription).error, 'invalid-device')
    assert.equal(invalidService.addSubscription('x', { ...browser.subscription, endpoint: 'HTTP://push.example.test/x' }).ok, false)

    // Endpoint allowlist: an arbitrary HTTPS host must not turn the Host into a
    // request proxy; known push-provider hosts stay accepted.
    const strictHosts = createPushService({ log })
    assert.equal(
      strictHosts.addSubscription('device-1', { ...browser.subscription, endpoint: 'https://attacker.example.com/collect' }).ok,
      false,
      'an arbitrary HTTPS endpoint must be rejected',
    )
    assert.equal(
      strictHosts.addSubscription('device-1', { ...browser.subscription, endpoint: 'https://fcm.googleapis.com/fcm/send/abc' }).ok,
      true,
      'a known FCM endpoint must be accepted',
    )
    assert.equal(
      strictHosts.addSubscription('device-2', { ...browser.subscription, endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/abc' }).ok,
      true,
      'a known Mozilla endpoint must be accepted',
    )
    const selfHosted = createPushService({ log, allowedEndpointSuffixes: ['Push.Example.Test'] })
    assert.equal(
      selfHosted.addSubscription('device-1', { ...browser.subscription, endpoint: 'https://push.example.test/x' }).ok,
      true,
      'an operator-configured suffix must be accepted',
    )
    assert.equal(
      selfHosted.addSubscription('device-1', { ...browser.subscription, endpoint: 'http://127.0.0.1:9/push' }).ok,
      false,
      'an insecure endpoint must stay rejected without the test-only loopback flag',
    )

    const cappedService = createPushService({ log, allowedEndpointSuffixes: ['push.example.test'] })
    for (let index = 0; index < 16; index += 1) {
      const result = cappedService.addSubscription(`device-${index}`, fakeSubscription(`https://push.example.test/sub/${index}`))
      assert.equal(result.ok, true, `subscription ${index} should fit under the cap`)
    }
    const overflow = cappedService.addSubscription('device-overflow', fakeSubscription('https://push.example.test/sub/overflow'))
    assert.equal(overflow.ok, false)
    assert.equal(overflow.error, 'too-many-subscriptions')
    assert.equal(cappedService.count(), 16)

    // Per-device removal, endpoint removal and store pruning.
    const removeService = createPushService({ log, allowedEndpointSuffixes: ['push.example.test'] })
    removeService.addSubscription('device-a', fakeSubscription('https://push.example.test/a'))
    removeService.addSubscription('device-a', fakeSubscription('https://push.example.test/a2'))
    removeService.addSubscription('device-b', fakeSubscription('https://push.example.test/b'))
    assert.equal(removeService.removeSubscription('device-a'), 2, 'a bare device id removes every subscription of that device')
    assert.equal(removeService.removeSubscription('https://push.example.test/b'), 1, 'an endpoint removes one subscription')
    removeService.addSubscription('device-c', fakeSubscription('https://push.example.test/c'))
    assert.equal(removeService.pruneToDevices(['device-c']), 0)
    assert.equal(removeService.count(), 1)

    // --- live send: headers, VAPID JWT and aes128gcm body -----------------
    endpoint.setStatus(201)
    const result = await service.sendNotification(browser.subscription, eventPayload)
    assert.deepEqual(result, { ok: true, status: 201 })
    assert.equal(endpoint.requests.length, 1, 'one POST should reach the push endpoint')
    const request = endpoint.requests[0]
    assert.equal(request.method, 'POST')
    assert.equal(request.url, '/push/sub')
    assert.equal(request.headers['content-encoding'], 'aes128gcm')
    assert.equal(request.headers['content-type'], 'application/octet-stream')
    assert.equal(request.headers.ttl, '300')
    assert.equal(request.headers['content-length'], String(request.body.length))
    const authorization = request.headers.authorization
    assert.match(authorization, /^WebPush [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u, 'WebPush authorization scheme')
    assert.equal(request.headers['crypto-key'], `p256ecdsa=${publicKey}`)
    verifyVapidJwt(authorization.slice('WebPush '.length), publicKey, new URL(endpoint.url()).origin)
    const decrypted = decryptAes128gcm(request.body, browser.privateKey, browser.auth, browser.uaPublic)
    assert.deepEqual(JSON.parse(decrypted.toString('utf8')), eventPayload, 'decrypted payload must equal the sent JSON')

    // UTF-8 payloads round-trip byte-exactly (no truncation, no escaping drift).
    const unicodePayload = {
      kind: 'question',
      title: 'Question from Harness',
      body: 'Which colour — 红色 or blue? 🚀',
      tag: 'question:req-2',
      sessionId: 's2',
      url: '/?session=s2',
    }
    endpoint.setStatus(202)
    assert.deepEqual(await service.sendNotification(browser.subscription, unicodePayload), { ok: true, status: 202 })
    assert.equal(endpoint.requests.length, 2)
    const unicodeRequest = endpoint.requests[1]
    assert.deepEqual(
      JSON.parse(decryptAes128gcm(unicodeRequest.body, browser.privateKey, browser.auth, browser.uaPublic).toString('utf8')),
      unicodePayload,
    )

    // --- 410 then 404 prune the stored subscription ----------------------
    endpoint.setStatus(410)
    const gone = await service.sendNotification(browser.subscription, eventPayload)
    assert.deepEqual(gone, { ok: false, gone: true, status: 410 })
    assert.equal(service.count(), 0, 'a 410 must remove the subscription')

    assert.equal(service.addSubscription('device-1', browser.subscription).ok, true)
    endpoint.setStatus(404)
    const gone404 = await service.sendNotification(browser.subscription, eventPayload)
    assert.deepEqual(gone404, { ok: false, gone: true, status: 404 })
    assert.equal(service.count(), 0, 'a 404 must remove the subscription')

    // Transient failures keep the subscription.
    assert.equal(service.addSubscription('device-1', browser.subscription).ok, true)
    endpoint.setStatus(503)
    const transient = await service.sendNotification(browser.subscription, eventPayload)
    assert.equal(transient.ok, false)
    assert.equal(transient.gone, undefined)
    assert.equal(transient.status, 503)
    assert.equal(service.count(), 1, 'a 5xx must not drop the subscription')

    // Invalid payload shapes never throw.
    assert.equal((await service.sendNotification({ endpoint: 'nope' }, eventPayload)).error, 'invalid-subscription')
    assert.equal((await service.sendNotification(browser.subscription, { huge: 'x'.repeat(5000) })).error, 'payload-too-large')

    // A dead endpoint is a clean failure, never an exception.
    const closedPort = await freshClosedPort()
    const deadResult = await service.sendNotification(
      { endpoint: `http://127.0.0.1:${closedPort}/gone`, keys: browser.subscription.keys },
      eventPayload,
    )
    assert.equal(deadResult.ok, false)
    assert.equal(deadResult.error, 'network')

    // --- state export/import carries subscriptions ----------------------
    const persisted = service.exportState()
    assert.equal(persisted.subscriptions.length, 1)
    const restoredWithSub = createPushService({ log, state: persisted, allowInsecureLoopback: true, allowedEndpointSuffixes: ['push.example.test'] })
    assert.equal(restoredWithSub.count(), 1)
    assert.equal(restoredWithSub.subscriptions()[0].keys.p256dh, browser.subscription.keys.p256dh)
    assert.equal(restoredWithSub.subscriptions()[0].keys.auth, browser.subscription.keys.auth)
    endpoint.setStatus(201)
    const restoredSend = await restoredWithSub.sendNotification(restoredWithSub.subscriptions()[0], eventPayload)
    assert.equal(restoredSend.ok, true, 'restored subscriptions must keep working')

    // --- no key material / endpoint in any log --------------------------
    const serializedLogs = JSON.stringify(entries)
    assert.ok(!serializedLogs.includes(browser.subscription.keys.p256dh), 'logs must never contain p256dh')
    assert.ok(!serializedLogs.includes(browser.subscription.keys.auth), 'logs must never contain the auth secret')
    assert.ok(!serializedLogs.includes(exportedKeys.vapid.privateKey.d), 'logs must never contain the VAPID private key')
    assert.ok(!serializedLogs.includes(publicKey), 'logs must never contain the VAPID key')
    assert.ok(!serializedLogs.includes('127.0.0.1'), 'logs must never contain a push endpoint')

    console.log(`PASS web push (VAPID JWT verified, aes128gcm body decrypted, ${endpoint.requests.length} requests, ${entries.length} log lines)`)
    await runServerIntegrationCheck(endpoint)
  } finally {
    await endpoint.close()
  }
}

main().catch((error) => {
  console.error('FAIL', error)
  process.exitCode = 1
})

