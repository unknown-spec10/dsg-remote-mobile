// Pairing, device sessions, cookie signing and PIN rate limiting.
// All secrets are process-local random values; no external dependencies.
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'

const DEFAULT_PIN_TTL_MS = 5 * 60 * 1000
const DEFAULT_TOKEN_TTL_MS = 10 * 60 * 1000
const DEFAULT_COOKIE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const DEFAULT_MAX_DEVICES = 8
const DEFAULT_MAX_FAILURES = 5
const DEFAULT_FAILURE_WINDOW_MS = 5 * 60 * 1000

function hmac(secret, value) {
  return createHmac('sha256', secret).update(value).digest('base64url')
}

/** Constant-time string comparison that never throws on length mismatch. */
export function equals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function randomPin() {
  return String(randomInt(0, 10000)).padStart(4, '0')
}

function deviceName(userAgent) {
  const ua = typeof userAgent === 'string' ? userAgent : ''
  const platform = /iPhone/i.test(ua) ? 'iPhone'
    : /iPad/i.test(ua) ? 'iPad'
      : /Android/i.test(ua) ? 'Android'
        : /Macintosh/i.test(ua) ? 'Mac'
          : /Windows/i.test(ua) ? 'Windows'
            : /Linux/i.test(ua) ? 'Linux'
              : 'Phone'
  const browser = /CriOS|Chrome/i.test(ua) ? 'Chrome'
    : /FxiOS|Firefox/i.test(ua) ? 'Firefox'
      : /EdgiOS|Edg/i.test(ua) ? 'Edge'
        : /Safari/i.test(ua) ? 'Safari'
          : 'Browser'
  return `${platform} ${browser}`.slice(0, 48)
}

/**
 * @param {object} options
 * @param {string} options.secret  persistent HMAC secret (required for cookies to survive restart)
 * @param {object} [options.log]
 */
export function createAuth(options = {}) {
  const {
    log = console,
    pinTtlMs = DEFAULT_PIN_TTL_MS,
    tokenTtlMs = DEFAULT_TOKEN_TTL_MS,
    cookieTtlMs = DEFAULT_COOKIE_TTL_MS,
    maxDevices = DEFAULT_MAX_DEVICES,
    maxFailures = DEFAULT_MAX_FAILURES,
    failureWindowMs = DEFAULT_FAILURE_WINDOW_MS,
  } = options
  if (typeof options.secret !== 'string' || options.secret.length < 32) {
    throw new Error('dsh-remote-mobile: auth secret must be at least 32 characters')
  }
  const secret = options.secret

  /** @type {Map<string, {id:string,name:string,createdAt:number,lastSeenAt:number,userAgent:string,address:string,canApprove:boolean}>} */
  const devices = new Map()
  /** @type {Map<string, {count:number,windowStart:number,lockedUntil:number}>} */
  const failures = new Map()
  let pin = randomPin()
  let pinExpiresAt = Date.now() + pinTtlMs
  let token = randomBytes(24).toString('base64url')
  let tokenExpiresAt = Date.now() + tokenTtlMs

  function rotatePin() {
    pin = randomPin()
    pinExpiresAt = Date.now() + pinTtlMs
    return { pin, pinExpiresAt }
  }

  function rotateToken() {
    token = randomBytes(24).toString('base64url')
    tokenExpiresAt = Date.now() + tokenTtlMs
    return { token, tokenExpiresAt }
  }

  function rotateAll() {
    rotatePin()
    rotateToken()
  }

  function ensureFresh() {
    const now = Date.now()
    if (tokenExpiresAt <= now) rotateToken()
    if (pinExpiresAt <= now) rotatePin()
  }

  /**
   * Drop expired per-address limiter records so a failed-pairing spray cannot
   * grow the map forever. Behaviour is unchanged for live windows.
   */
  function pruneFailures(now) {
    if (failures.size < 64) return
    for (const [address, record] of failures) {
      if (record.lockedUntil <= now && now - record.windowStart > failureWindowMs) failures.delete(address)
    }
  }

  function addDevice(userAgent, address) {
    const id = randomBytes(12).toString('hex')
    const device = {
      id,
      name: deviceName(userAgent),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 200) : '',
      address: address || '',
      // Approval permission: every newly paired device may answer by default.
      canApprove: true,
    }
    devices.set(id, device)
    while (devices.size > maxDevices) {
      let oldest = null
      for (const item of devices.values()) {
        if (oldest === null || item.createdAt < oldest.createdAt) oldest = item
      }
      if (oldest === null) break
      devices.delete(oldest.id)
      log.info?.(`remote-mobile: dropped oldest paired device ${oldest.id.slice(0, 6)}… (limit ${maxDevices})`)
    }
    return device
  }

  function publicDevice(device) {
    return {
      id: device.id,
      name: device.name,
      createdAt: device.createdAt,
      lastSeenAt: device.lastSeenAt,
      address: device.address,
      // Missing on records persisted by older versions → allowed (backwards compatible).
      canApprove: device.canApprove !== false,
    }
  }

  function pairWithToken(candidateToken, userAgent, address) {
    ensureFresh()
    if (!equals(candidateToken, token) || Date.now() > tokenExpiresAt) {
      return { ok: false, error: 'invalid-token' }
    }
    const device = addDevice(userAgent, address)
    rotateAll()
    log.info?.(`remote-mobile: paired ${device.name}`)
    return { ok: true, device: publicDevice(device) }
  }

  function pairWithPin(candidatePin, userAgent, address) {
    ensureFresh()
    const now = Date.now()
    pruneFailures(now)
    const record = failures.get(address) || { count: 0, windowStart: now, lockedUntil: 0 }
    if (record.lockedUntil > now) {
      return { ok: false, error: 'rate-limited', retryAfterMs: record.lockedUntil - now }
    }
    if (now - record.windowStart > failureWindowMs) {
      record.count = 0
      record.windowStart = now
    }
    failures.set(address, record)
    if (!(typeof candidatePin === 'string' && /^\d{4}$/.test(candidatePin)) || !equals(candidatePin, pin)) {
      record.count += 1
      if (record.count >= maxFailures) {
        record.lockedUntil = now + failureWindowMs
        record.count = 0
        record.windowStart = now
        log.warn?.(`remote-mobile: PIN attempts from ${address} locked out for ${Math.round(failureWindowMs / 1000)}s`)
      }
      return { ok: false, error: 'invalid-pin' }
    }
    failures.delete(address)
    const device = addDevice(userAgent, address)
    rotateAll()
    log.info?.(`remote-mobile: paired ${device.name}`)
    return { ok: true, device: publicDevice(device) }
  }

  function deviceFromCookie(rawCookie) {
    if (typeof rawCookie !== 'string' || rawCookie.length === 0) return null
    const parts = rawCookie.split('.')
    if (parts.length !== 3) return null
    const [id, expiresAt, signature] = parts
    if (!/^[a-f0-9]{24}$/.test(id) || !/^\d{13}$/.test(expiresAt)) return null
    if (!equals(hmac(secret, `device|${id}|${expiresAt}`), signature)) return null
    if (Number(expiresAt) <= Date.now()) return null
    const device = devices.get(id)
    if (device === undefined) return null
    device.lastSeenAt = Date.now()
    return device
  }

  function cookieValue(deviceId) {
    const expiresAt = String(Date.now() + cookieTtlMs)
    return `${deviceId}.${expiresAt}.${hmac(secret, `device|${deviceId}|${expiresAt}`)}`
  }

  function cookieMaxAgeSeconds() {
    return Math.floor(cookieTtlMs / 1000)
  }

  function revoke(deviceId) {
    return devices.delete(deviceId)
  }

  /**
   * Flip one shared paired device's approval permission.
   * @param {string} deviceId paired-device id
   * @param {boolean} canApprove whether this device may answer approvals
   * @returns the public device, or null when the id is unknown
   */
  function setCanApprove(deviceId, canApprove) {
    const device = devices.get(deviceId)
    if (device === undefined) return null
    device.canApprove = canApprove === true
    return publicDevice(device)
  }

  function revokeAll() {
    const count = devices.size
    devices.clear()
    return count
  }

  function status() {
    ensureFresh()
    return {
      pin,
      pinExpiresAt,
      token,
      tokenExpiresAt,
      devices: [...devices.values()].map(publicDevice),
    }
  }

  function exportState() {
    return {
      secret,
      devices: [...devices.values()],
    }
  }

  function importState(state) {
    if (state === null || typeof state !== 'object') return
    if (Array.isArray(state.devices)) {
      for (const raw of state.devices) {
        if (raw === null || typeof raw !== 'object') continue
        if (typeof raw.id !== 'string' || !/^[a-f0-9]{24}$/.test(raw.id)) continue
        devices.set(raw.id, {
          id: raw.id,
          name: typeof raw.name === 'string' ? raw.name.slice(0, 48) : 'Paired device',
          createdAt: Number(raw.createdAt) || Date.now(),
          lastSeenAt: Number(raw.lastSeenAt) || Date.now(),
          userAgent: typeof raw.userAgent === 'string' ? raw.userAgent.slice(0, 200) : '',
          address: typeof raw.address === 'string' ? raw.address : '',
          // Older state files have no flag; absence means "may approve".
          canApprove: raw.canApprove !== false,
        })
        if (devices.size >= maxDevices) break
      }
    }
  }

  return {
    rotatePin,
    rotateToken,
    rotateAll,
    ensureFresh,
    pairWithToken,
    pairWithPin,
    deviceFromCookie,
    cookieValue,
    cookieMaxAgeSeconds,
    revoke,
    revokeAll,
    setCanApprove,
    status,
    exportState,
    importState,
    devices: () => [...devices.values()].map(publicDevice),
  }
}
