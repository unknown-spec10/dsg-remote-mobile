// Real Web Push for the phone companion: VAPID (RFC 8292) + aes128gcm (RFC 8291).
//
// Zero dependencies: only `node:crypto` and the global `fetch` (Node >= 22). The
// Host server creates one service, persists its state inside the pairing state
// file (`push` field, mode 0600) and hands it to the bridge broadcast paths so a
// backgrounded phone's service worker is notified while the page is frozen.
//
// Security notes:
// - The VAPID private key lives only in memory and in the 0600 state file. It is
//   never logged, never returned by an HTTP endpoint and never sent to a phone.
// - `sendNotification` never throws, and never logs the endpoint or the payload:
//   only the HTTP status / `gone` flag is observable to callers.
// - Subscriptions are `https:` endpoints. Loopback `http:` endpoints are accepted
//   only when `allowInsecureLoopback` is set, which exists for the deterministic
//   `dev/push-check.mjs` harness; the Host server never enables it.
import {
  createCipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  createSign,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
} from 'node:crypto'

const VAPID_SUBJECT = 'mailto:dsh-remote-mobile@example.com'
const VAPID_JWT_LIFETIME_SECONDS = 12 * 60 * 60
const PUSH_TTL_SECONDS = 300

const P256_PUBLIC_BYTES = 65
const AUTH_SECRET_BYTES = 16
const AES_GCM_NONCE_BYTES = 12
const RECORD_SIZE = 4096
const MAX_SUBSCRIPTIONS = 16
const MAX_ENDPOINT_CHARS = 4096
const MAX_PAYLOAD_BYTES = 3800
const SEND_TIMEOUT_MS = 10_000

// RFC 8291 § 3.3/3.4 and RFC 8188 § 2.2 info strings (the trailing NUL is part
// of the protocol, not a string terminator).
const HKDF_AUTH_INFO = Buffer.from('WebPush: info\x00', 'utf8')
const HKDF_CEK_INFO = Buffer.from('Content-Encoding: aes128gcm\x00', 'utf8')
const HKDF_NONCE_INFO = Buffer.from('Content-Encoding: nonce\x00', 'utf8')

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url')
}

/**
 * Decode an unpadded base64url string of exactly `expectedBytes` octets.
 * @returns {Buffer|null} null for anything that is not a well-formed value.
 */
function decodeBase64url(value, expectedBytes) {
  if (typeof value !== 'string' || value.length === 0) return null
  const compact = value.replace(/=+$/u, '')
  if (compact.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(compact)) return null
  const buffer = Buffer.from(compact, 'base64url')
  if (expectedBytes !== undefined && buffer.length !== expectedBytes) return null
  return buffer
}

/** Raw uncompressed P-256 point (0x04 || X || Y) for a KeyObject. */
function rawPublicFromKey(keyObject) {
  const jwk = keyObject.export({ format: 'jwk' })
  if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') throw new Error('not a P-256 public key')
  return Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])
}

/** KeyObject for a raw uncompressed P-256 point. */
function publicKeyFromRaw(raw) {
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: base64url(raw.subarray(1, 33)),
    y: base64url(raw.subarray(33, 65)),
  }
  return createPublicKey({ key: jwk, format: 'jwk' })
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

/**
 * Encrypt one payload per RFC 8291 (aes128gcm content coding, RFC 8188).
 * Exported for the deterministic dev check; the service uses it internally.
 * @param {string|Buffer} uaPublic subscription `keys.p256dh` (base64url or raw bytes)
 * @param {string|Buffer} authSecret subscription `keys.auth` (base64url or raw bytes)
 * @param {Buffer|string} plaintext serialized JSON payload
 * @returns {{ body: Buffer, salt: Buffer, asPublic: Buffer }}
 */
export function encryptPayload(uaPublic, authSecret, plaintext, options = {}) {
  const uaRaw = typeof uaPublic === 'string'
    ? decodeBase64url(uaPublic, P256_PUBLIC_BYTES)
    : Buffer.from(uaPublic ?? [])
  const auth = typeof authSecret === 'string'
    ? decodeBase64url(authSecret, AUTH_SECRET_BYTES)
    : Buffer.from(authSecret ?? [])
  if (uaRaw === null || uaRaw.length !== P256_PUBLIC_BYTES || uaRaw[0] !== 0x04) {
    throw new Error('invalid p256dh')
  }
  if (auth === null || auth.length !== AUTH_SECRET_BYTES) throw new Error('invalid auth secret')
  const payload = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8')

  // Optional deterministic inputs exist only for the RFC 8291 test vector in
  // the dev check; production calls pass no options and get fresh randomness.
  const givenEphemeral = options !== null && typeof options === 'object' ? options.ephemeralPrivateKey : undefined
  const ephemeralPrivate = givenEphemeral !== undefined && givenEphemeral !== null
    ? (typeof givenEphemeral === 'object' && givenEphemeral.type === 'private'
      ? givenEphemeral
      : createPrivateKey(givenEphemeral))
    : generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
  const asPublic = rawPublicFromKey(createPublicKey(ephemeralPrivate))
  const shared = diffieHellman({ privateKey: ephemeralPrivate, publicKey: publicKeyFromRaw(uaRaw) })

  // RFC 8291 § 3.3: IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info\0" || ua_public || as_public)
  const inputKeyMaterial = hkdfExpand(
    hkdfExtract(auth, shared),
    Buffer.concat([HKDF_AUTH_INFO, uaRaw, asPublic]),
    32,
  )

  // RFC 8291 § 3.4: per-message salt, then CEK and nonce from the same PRK.
  const salt = options !== null && typeof options === 'object' && Buffer.isBuffer(options.salt)
    ? Buffer.from(options.salt)
    : randomBytes(16)
  const prk = hkdfExtract(salt, inputKeyMaterial)
  const cek = hkdfExpand(prk, HKDF_CEK_INFO, 16)
  const nonce = hkdfExpand(prk, HKDF_NONCE_INFO, AES_GCM_NONCE_BYTES)

  // RFC 8188 header: salt(16) || rs(4, big-endian) || idlen(1) || keyid(as_public).
  const header = Buffer.alloc(16 + 4 + 1 + P256_PUBLIC_BYTES)
  salt.copy(header, 0)
  header.writeUInt32BE(RECORD_SIZE, 16)
  header.writeUInt8(P256_PUBLIC_BYTES, 20)
  asPublic.copy(header, 21)

  // One record: the JSON payload followed by the 0x02 last-record delimiter.
  // The RFC 8291 example confirms a single-record push uses an EMPTY AEAD AAD;
  // adding the header as AAD yields a wrong authentication tag and the browser
  // silently drops the message after accepting it from the push service.
  const plaintextRecord = Buffer.concat([payload, Buffer.from([0x02])])
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  const ciphertext = Buffer.concat([cipher.update(plaintextRecord), cipher.final(), cipher.getAuthTag()])

  return { body: Buffer.concat([header, ciphertext]), salt, asPublic }
}

/**
 * Build a VAPID JWT (RFC 8292 § 2) for one push endpoint.
 * Exported for the deterministic dev check.
 * @param {{endpoint: string, privateKeyJwk: object, subject?: string,
 *   lifetimeSeconds?: number, now?: number}} options
 * @returns {string} compact JWS (`<header>.<claims>.<signature>`)
 */
export function buildVapidJwt(options = {}) {
  const {
    endpoint,
    privateKeyJwk,
    subject = VAPID_SUBJECT,
    lifetimeSeconds = VAPID_JWT_LIFETIME_SECONDS,
    now = Date.now(),
  } = options
  if (typeof endpoint !== 'string') throw new Error('endpoint required')
  const audience = new URL(endpoint).origin
  const header = base64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))
  const claims = base64url(JSON.stringify({
    aud: audience,
    exp: Math.floor(now / 1000) + Math.max(1, Math.floor(Number(lifetimeSeconds) || VAPID_JWT_LIFETIME_SECONDS)),
    sub: subject,
  }))
  const signingInput = `${header}.${claims}`
  const signature = createSign('SHA256')
    .update(signingInput)
    .sign({ key: createPrivateKey({ key: privateKeyJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' })
  if (signature.length !== 64) throw new Error('unexpected ECDSA signature length')
  return `${signingInput}.${base64url(signature)}`
}

function isLoopbackHost(hostname) {
  return hostname === '127.0.0.1'
    || hostname === 'localhost'
    || hostname === '::1'
    || hostname === '[::1]'
}

/**
 * Push services this Host is willing to POST to. Browser PushSubscriptions come
 * from a small set of provider families; accepting an arbitrary `https:` URL
 * would turn the Host into a request proxy for whoever holds a pairing cookie
 * (and let it read a bounded slice of the upstream response). Suffix matching
 * keeps provider edge/regional hosts working. A self-hosted push relay can opt
 * in through `allowedEndpointSuffixes` (the server maps
 * `PA_REMOTE_MOBILE_PUSH_HOSTS` to it).
 */
const PUSH_ENDPOINT_SUFFIXES = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'notify.windows.com',
  'push.apple.com',
]

function isPushServiceHost(hostname, extraSuffixes) {
  const host = String(hostname ?? '').toLowerCase()
  if (host.length === 0) return false
  for (const suffix of [...PUSH_ENDPOINT_SUFFIXES, ...extraSuffixes]) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return true
  }
  return false
}

/** Normalize an operator-supplied suffix list (`fcm.googleapis.com,push.example`). */
function normalizeSuffixList(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const suffix = entry.trim().toLowerCase().replace(/^\.+/u, '')
    if (suffix.length === 0 || suffix.length > 253) continue
    if (!/^[a-z0-9.-]+$/u.test(suffix)) continue
    if (!out.includes(suffix)) out.push(suffix)
  }
  return out
}

/**
 * Validate + canonicalize one browser PushSubscription shape.
 * @returns {{endpoint: string, keys: {p256dh: string, auth: string}}|null}
 */
function normalizeSubscription(raw, allowInsecureLoopback, allowedEndpointSuffixes = []) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (typeof raw.endpoint !== 'string' || raw.endpoint.length === 0 || raw.endpoint.length > MAX_ENDPOINT_CHARS) {
    return null
  }
  let url
  try {
    url = new URL(raw.endpoint)
  } catch {
    return null
  }
  const secure = url.protocol === 'https:'
  const loopbackDev = allowInsecureLoopback && url.protocol === 'http:' && isLoopbackHost(url.hostname)
  if (!secure && !loopbackDev) return null
  if (!loopbackDev && !isPushServiceHost(url.hostname, allowedEndpointSuffixes)) return null
  if (url.username.length > 0 || url.password.length > 0) return null
  if (url.hash.length > 0) return null
  if (raw.keys === null || typeof raw.keys !== 'object' || Array.isArray(raw.keys)) return null
  const p256dh = decodeBase64url(raw.keys.p256dh, P256_PUBLIC_BYTES)
  const auth = decodeBase64url(raw.keys.auth, AUTH_SECRET_BYTES)
  if (p256dh === null || p256dh[0] !== 0x04 || auth === null) return null
  return {
    endpoint: url.toString(),
    keys: { p256dh: base64url(p256dh), auth: base64url(auth) },
  }
}

function generateVapid() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return {
    publicKey: base64url(rawPublicFromKey(publicKey)),
    privateKeyJwk: privateKey.export({ format: 'jwk' }),
    privateKeyObject: privateKey,
  }
}

/** Restore a VAPID pair from persisted state, or null when it is unusable. */
function restoreVapid(state) {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return null
  if (typeof state.publicKey !== 'string') return null
  const raw = decodeBase64url(state.publicKey, P256_PUBLIC_BYTES)
  if (raw === null || raw[0] !== 0x04) return null
  const privateKeyJwk = state.privateKey
  if (privateKeyJwk === null || typeof privateKeyJwk !== 'object' || Array.isArray(privateKeyJwk)) return null
  if (privateKeyJwk.kty !== 'EC' || privateKeyJwk.crv !== 'P-256') return null
  if (typeof privateKeyJwk.x !== 'string' || typeof privateKeyJwk.y !== 'string' || typeof privateKeyJwk.d !== 'string') {
    return null
  }
  let privateKeyObject
  try {
    privateKeyObject = createPrivateKey({ key: privateKeyJwk, format: 'jwk' })
  } catch {
    return null
  }
  let derived
  try {
    derived = rawPublicFromKey(createPublicKey(privateKeyObject))
  } catch {
    return null
  }
  if (!derived.equals(raw)) return null
  return { publicKey: base64url(derived), privateKeyJwk, privateKeyObject }
}

function copySubscription(item) {
  return {
    deviceId: item.deviceId,
    endpoint: item.endpoint,
    keys: { p256dh: item.keys.p256dh, auth: item.keys.auth },
    createdAt: item.createdAt,
  }
}

/**
 * Create the Web Push service used by the Host server.
 *
 * @param {object} [options]
 * @param {object} [options.log] logger with optional `debug`/`warn`; keys and
 *   endpoints are never logged
 * @param {object|null} [options.state] previously exported state (`vapid` +
 *   `subscriptions`, the `push` field of the pairing state file)
 * @param {boolean} [options.allowInsecureLoopback] test-only: accept loopback
 *   `http:` endpoints (the Host server never sets this)
 * @param {number} [options.maxSubscriptions] override the 16-subscription cap
 * @param {string[]} [options.allowedEndpointSuffixes] extra push-service host
 *   suffixes (self-hosted relays); known provider hosts are always allowed
 * @param {string} [options.subject] VAPID `sub` contact (defaults to the
 *   placeholder mailto; operators should set a real one)
 */
export function createPushService(options = {}) {
  const log = options.log ?? console
  const allowInsecureLoopback = options.allowInsecureLoopback === true
  const maxSubscriptions = Number.isInteger(options.maxSubscriptions) && options.maxSubscriptions > 0
    ? options.maxSubscriptions
    : MAX_SUBSCRIPTIONS
  const allowedEndpointSuffixes = normalizeSuffixList(options.allowedEndpointSuffixes)
  const vapidSubject = typeof options.subject === 'string' && options.subject.trim().length > 0
    ? options.subject.trim().slice(0, 200)
    : VAPID_SUBJECT

  let vapid = restoreVapid(options.state?.vapid ?? null)
  /** @type {Array<{deviceId: string, endpoint: string, keys: {p256dh: string, auth: string}, createdAt: number}>} */
  let subscriptions = []

  function importSubscriptions(list) {
    subscriptions = []
    if (!Array.isArray(list)) return
    for (const item of list) {
      if (subscriptions.length >= maxSubscriptions) break
      if (item === null || typeof item !== 'object') continue
      if (typeof item.deviceId !== 'string' || item.deviceId.length === 0 || item.deviceId.length > 64) continue
      const normalized = normalizeSubscription(item, allowInsecureLoopback, allowedEndpointSuffixes)
      if (normalized === null) continue
      if (subscriptions.some((existing) => existing.endpoint === normalized.endpoint)) continue
      subscriptions.push({
        deviceId: item.deviceId,
        endpoint: normalized.endpoint,
        keys: normalized.keys,
        createdAt: Number(item.createdAt) || Date.now(),
      })
    }
  }

  if (vapid === null) vapid = generateVapid()
  importSubscriptions(options.state?.subscriptions)

  function removeEndpoint(endpoint) {
    const before = subscriptions.length
    subscriptions = subscriptions.filter((item) => item.endpoint !== endpoint)
    return before - subscriptions.length
  }

  function removeDevice(deviceId) {
    if (typeof deviceId !== 'string' || deviceId.length === 0) return 0
    const before = subscriptions.length
    subscriptions = subscriptions.filter((item) => item.deviceId !== deviceId)
    return before - subscriptions.length
  }

  /** Register (or refresh) one browser PushSubscription for a paired device. */
  function addSubscription(deviceId, subscription) {
    if (typeof deviceId !== 'string' || deviceId.length === 0 || deviceId.length > 64) {
      return { ok: false, error: 'invalid-device' }
    }
    const normalized = normalizeSubscription(subscription, allowInsecureLoopback, allowedEndpointSuffixes)
    if (normalized === null) return { ok: false, error: 'invalid-subscription' }
    const existing = subscriptions.find((item) => item.endpoint === normalized.endpoint)
    if (existing !== undefined) {
      existing.deviceId = deviceId
      existing.keys = normalized.keys
      existing.createdAt = Date.now()
      return { ok: true, subscription: copySubscription(existing) }
    }
    if (subscriptions.length >= maxSubscriptions) return { ok: false, error: 'too-many-subscriptions' }
    const record = {
      deviceId,
      endpoint: normalized.endpoint,
      keys: normalized.keys,
      createdAt: Date.now(),
    }
    subscriptions.push(record)
    return { ok: true, subscription: copySubscription(record) }
  }

  /**
   * Remove a subscription by endpoint (string or `{ endpoint }`) or, for a bare
   * device id, every subscription of that device. Returns how many were removed.
   */
  function removeSubscription(value) {
    if (typeof value === 'string' && /^https?:\/\//u.test(value)) return removeEndpoint(value)
    if (value !== null && typeof value === 'object' && typeof value.endpoint === 'string') {
      return removeEndpoint(value.endpoint)
    }
    if (typeof value === 'string') return removeDevice(value)
    return 0
  }

  /** Stored subscriptions (optionally for one device), keys included for sending. */
  function listSubscriptions(deviceId) {
    const source = typeof deviceId === 'string'
      ? subscriptions.filter((item) => item.deviceId === deviceId)
      : subscriptions
    return source.map(copySubscription)
  }

  /** Drop subscriptions whose paired device no longer exists. */
  function pruneToDevices(deviceIds) {
    const known = deviceIds instanceof Set ? deviceIds : new Set(Array.isArray(deviceIds) ? deviceIds : [])
    const before = subscriptions.length
    subscriptions = subscriptions.filter((item) => known.has(item.deviceId))
    return before - subscriptions.length
  }

  /**
   * Encrypt + POST one notification. Never throws and never logs the endpoint or
   * the payload.
   * @returns {Promise<{ok: boolean, status: number, gone?: boolean, error?: string}>}
   */
  async function sendNotification(subscription, payloadObject) {
    const normalized = normalizeSubscription(subscription, allowInsecureLoopback, allowedEndpointSuffixes)
    if (normalized === null) return { ok: false, status: 0, error: 'invalid-subscription' }
    let plaintext
    try {
      plaintext = Buffer.from(JSON.stringify(payloadObject ?? {}), 'utf8')
    } catch {
      return { ok: false, status: 0, error: 'invalid-payload' }
    }
    if (plaintext.length === 0 || plaintext.length > MAX_PAYLOAD_BYTES) {
      return { ok: false, status: 0, error: 'payload-too-large' }
    }
    try {
      const { body } = encryptPayload(normalized.keys.p256dh, normalized.keys.auth, plaintext)
      const authorization = buildVapidJwt({ endpoint: normalized.endpoint, privateKeyJwk: vapid.privateKeyJwk, subject: vapidSubject })
      const response = await fetch(normalized.endpoint, {
        method: 'POST',
        headers: {
          TTL: String(PUSH_TTL_SECONDS),
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          Authorization: `WebPush ${authorization}`,
          // Not required for aes128gcm but harmless and expected by some old
          // gateways (RFC 8292 § 2.1 legacy VAPID header form).
          // RFC 8292 legacy VAPID header form: FCM requires the application
          // server key under `p256ecdsa` (not the subscription's `p256dh`).
          'Crypto-Key': `p256ecdsa=${vapid.publicKey}`,
        },
        body,
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      })
      const status = response.status
      // The (tiny) error body names the push-service failure, e.g.
      // UnauthorizedRegistration; it is bounded and never logged.
      const detail = await response.text().catch(() => '')
      if (status === 201 || status === 202) return { ok: true, status }
      if (status === 404 || status === 410) {
        removeEndpoint(normalized.endpoint)
        return { ok: false, gone: true, status }
      }
      return { ok: false, status, detail: detail.slice(0, 300) }
    } catch (error) {
      log.debug?.(`remote-mobile: push send failed (${error?.name ?? 'Error'})`)
      return { ok: false, status: 0, error: 'network' }
    }
  }

  function exportState() {
    return {
      vapid: { publicKey: vapid.publicKey, privateKey: vapid.privateKeyJwk },
      subscriptions: subscriptions.map(copySubscription),
    }
  }

  function importState(state) {
    if (state === null || typeof state !== 'object' || Array.isArray(state)) return
    const restored = restoreVapid(state.vapid ?? null)
    if (restored !== null) vapid = restored
    importSubscriptions(state.subscriptions)
    if (vapid === null) vapid = generateVapid()
  }

  return {
    /** base64url raw uncompressed P-256 point for `applicationServerKey`. */
    publicKey: () => vapid.publicKey,
    addSubscription,
    removeSubscription,
    removeDevice,
    subscriptions: listSubscriptions,
    count: () => subscriptions.length,
    hasSubscriptions: () => subscriptions.length > 0,
    pruneToDevices,
    sendNotification,
    /** JWT for one endpoint (exposed for diagnostics; sendNotification uses it). */
    buildVapidJwt: (endpoint, now = Date.now()) => buildVapidJwt({
      endpoint,
      privateKeyJwk: vapid.privateKeyJwk,
      now,
    }),
    exportState,
    importState,
  }
}


