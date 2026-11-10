// Standalone pairing + WebSocket gateway for the mobile companion.
// This file owns transport, security and framing; the DSH bridge owns runtime
// operations, so the server never touches Harness internals directly.
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { appendFile, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAuth, equals } from './auth.js'
import { createPushService } from './push.js'
import { qrSvg } from './qr.js'

const VERSION = '0.0.5'
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_MESSAGE_BYTES = 1024 * 1024
const MAX_BODY_BYTES = 64 * 1024
const COOKIE_NAME = 'dsh_rm_session'
// Web Push fan-out limits: process-wide rate, per-tag replay window and the
// "reply ready" quiet period per session.
const PUSH_MAX_PER_MINUTE = 30
const PUSH_RATE_WINDOW_MS = 60 * 1000
// The explicit test-notification action bypasses the automatic limiter, so it
// gets its own small per-device window; a device may also keep at most four
// push subscriptions (one browser usually registers one).
const PUSH_TEST_WINDOW_MS = 60 * 1000
const PUSH_TEST_MAX_PER_DEVICE = 6
const MAX_SUBSCRIPTIONS_PER_DEVICE = 4
const PUSH_TAG_TTL_MS = 5 * 60 * 1000
const PUSH_TAG_LIMIT = 200
const PUSH_REPLY_INTERVAL_MS = 60 * 1000
const PUSH_BODY_CHARS = 160
const STATIC_FILES = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
  // Installable web app. The service worker must be served from the site root so
  // its scope covers the whole app.
  ['/manifest.webmanifest', { file: 'manifest.webmanifest', type: 'application/manifest+json; charset=utf-8' }],
  ['/sw.js', { file: 'sw.js', type: 'text/javascript; charset=utf-8' }],
  ['/icons/icon-192.png', { file: 'icons/icon-192.png', type: 'image/png' }],
  ['/icons/icon-512.png', { file: 'icons/icon-512.png', type: 'image/png' }],
  ['/icons/icon-maskable-512.png', { file: 'icons/icon-maskable-512.png', type: 'image/png' }],
  ['/icons/apple-touch-icon.png', { file: 'icons/apple-touch-icon.png', type: 'image/png' }],
  ['/favicon.svg', { file: 'favicon.svg', type: 'image/svg+xml' }],
])

function normalizeIp(value) {
  if (typeof value !== 'string') return 'unknown'
  return value.startsWith('::ffff:') ? value.slice(7) : value
}

function parseCookies(header) {
  const out = new Map()
  if (typeof header !== 'string') return out
  for (const part of header.split(';')) {
    const at = part.indexOf('=')
    if (at === -1) continue
    const key = part.slice(0, at).trim()
    const value = part.slice(at + 1).trim()
    if (key.length > 0) out.set(key, value)
  }
  return out
}

function jsonResponse(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  })
  res.end(text)
}

/**
 * Collapse one client-supplied value into a bounded single-line log field.
 * Diagnostics must never inject new lines (log forging) or unbounded text into
 * the debug log.
 */
function logField(value, max) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, max)
}

/** Operator-configured additional push-service host suffixes. */
function pushEndpointSuffixes() {
  const raw = process.env.PA_REMOTE_MOBILE_PUSH_HOSTS
  if (typeof raw !== 'string' || raw.trim().length === 0) return []
  return raw.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
}

/** Read a request body with a hard byte cap; rejects with `body-too-large`. */
function readBodyBuffer(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body-too-large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readBody(req, limit = MAX_BODY_BYTES) {
  return (await readBodyBuffer(req, limit)).toString('utf8')
}

async function readJsonBody(req, limit) {
  const text = await readBody(req, limit)
  if (text.length === 0) return {}
  const parsed = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('body-not-object')
  }
  return parsed
}

/** Minimal RFC 6455 server-side connection: text JSON frames only. */
class WebSocketPeer {
  constructor(socket, request, device, log) {
    this.socket = socket
    this.request = request
    this.device = device
    this.log = log
    this.buffer = Buffer.alloc(0)
    this.fragments = []
    this.open = true
    this.finished = false
    this.lastActivity = Date.now()
    this.listeners = { message: [], close: [] }
    socket.on('data', (chunk) => this.onData(chunk))
    socket.on('error', () => this.destroy())
    // HTTP server sockets allow half-open TCP; without this a browser that
    // disappears without a WebSocket close frame (tab killed, network lost)
    // would stay in `peers` until the heartbeat times out.
    socket.on('end', () => this.destroy())
    socket.on('close', () => this.finish())
    this.handshake()
  }

  handshake() {
    const key = this.request.headers['sec-websocket-key']
    if (typeof key !== 'string') {
      this.destroy()
      return
    }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
    this.socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
  }

  on(event, callback) {
    this.listeners[event].push(callback)
  }

  onData(chunk) {
    this.lastActivity = Date.now()
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 2) {
      const first = this.buffer[0]
      const second = this.buffer[1]
      const fin = (first & 0x80) !== 0
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.buffer.length < 4) return
        length = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.buffer.length < 10) return
        const big = this.buffer.readBigUInt64BE(2)
        if (big > BigInt(MAX_MESSAGE_BYTES)) {
          this.close(1009, 'message too large')
          return
        }
        length = Number(big)
        offset = 10
      }
      if (length > MAX_MESSAGE_BYTES) {
        this.close(1009, 'message too large')
        return
      }
      if (!masked) {
        this.close(1002, 'client frames must be masked')
        return
      }
      if (this.buffer.length < offset + 4 + length) return
      const mask = this.buffer.subarray(offset, offset + 4)
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + length))
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4]
      this.buffer = this.buffer.subarray(offset + 4 + length)
      this.handleFrame(opcode, fin, payload)
    }
  }

  handleFrame(opcode, fin, payload) {
    if (opcode === 0x8) {
      this.close(1000, 'bye')
      return
    }
    if (opcode === 0x9) {
      this.sendFrame(0x0a, payload)
      return
    }
    if (opcode === 0x0a) return
    if (opcode === 0x0 || opcode === 0x1) {
      this.fragments.push(payload)
      const total = this.fragments.reduce((sum, item) => sum + item.length, 0)
      if (total > MAX_MESSAGE_BYTES) {
        this.close(1009, 'message too large')
        return
      }
      if (!fin) return
      const text = Buffer.concat(this.fragments).toString('utf8')
      this.fragments = []
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        this.sendObject({ type: 'error', code: 'bad-request', message: 'invalid JSON frame' })
        return
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.sendObject({ type: 'error', code: 'bad-request', message: 'frame must be an object' })
        return
      }
      for (const listener of this.listeners.message) {
        try {
          listener(parsed)
        } catch (error) {
          this.log.warn?.(`remote-mobile: frame handler failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return
    }
    this.close(1003, 'unsupported opcode')
  }

  sendFrame(opcode, payload) {
    if (!this.open || this.socket.destroyed) return
    const length = payload.length
    let header
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length])
    } else if (length < 65536) {
      header = Buffer.alloc(4)
      header[0] = 0x80 | opcode
      header[1] = 126
      header.writeUInt16BE(length, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x80 | opcode
      header[1] = 127
      header.writeBigUInt64BE(BigInt(length), 2)
    }
    try {
      this.socket.write(Buffer.concat([header, payload]))
    } catch {
      this.destroy()
    }
  }

  sendObject(value) {
    if (!this.open) return
    if (this.socket.writableLength > 4 * 1024 * 1024) {
      this.close(1011, 'client too slow')
      return
    }
    this.sendFrame(0x01, Buffer.from(JSON.stringify(value), 'utf8'))
  }

  ping() {
    this.sendFrame(0x09, Buffer.alloc(0))
  }

  close(code = 1000, reason = '') {
    if (!this.open) return
    try {
      const status = Buffer.alloc(2)
      status.writeUInt16BE(code, 0)
      const text = Buffer.from(reason, 'utf8')
      this.sendFrame(0x08, Buffer.concat([status, text]))
    } catch {
      // the socket may already be gone; the destroy below is the fallback
    }
    this.open = false
    try {
      this.socket.end()
    } catch {
      this.socket.destroy()
    }
  }

  destroy() {
    this.open = false
    try {
      this.socket.destroy()
    } catch {
      // already gone
    }
  }

  finish() {
    // Runs once, on the socket's own close event. `close()`/`destroy()` mark
    // `open` false first, so this must not gate on it: the server's `close`
    // listeners are what remove the peer from `peers`.
    if (this.finished) return
    this.finished = true
    this.open = false
    for (const listener of this.listeners.close) {
      try {
        listener()
      } catch {
        // ignore listener failures
      }
    }
  }
}

/**
 * Rank local IPv4 addresses for the pairing URL. Real Wi-Fi/Ethernet interfaces
 * beat virtual switches (Hyper-V, WSL, Docker) and Windows ICS/hotspot adapters,
 * and Tailscale ranks just below a physical LAN interface so a phone on the
 * tailnet can still be reached.
 *
 * @param {string} bindHost configured bind address
 * @returns {Array<{ address: string, name: string }>}
 */
function localAddressEntries(bindHost) {
  if (typeof bindHost === 'string' && bindHost !== '0.0.0.0' && bindHost !== '::' && bindHost !== '::0') {
    return [{ address: bindHost, name: 'configured bind address' }]
  }
  const entries = []
  const interfaces = networkInterfaces()
  for (const [name, group] of Object.entries(interfaces)) {
    if (!group) continue
    for (const entry of group) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      if (entry.address.startsWith('169.254.')) continue
      let score = 0
      if (/tailscale/i.test(name)) score += 120
      else if (/^wi-?fi$|^wlan|^wireless|^ethernet$/i.test(name)) score += 100
      else if (/ethernet/i.test(name) && !/vethernet|virtual/i.test(name)) score += 80
      else if (/vethernet|hyper-v|virtual|vmware|virtualbox|docker|wsl/i.test(name)) score -= 60
      else if (/local area connection/i.test(name)) score -= 30
      if (/^192\.168\./.test(entry.address)) score += 10
      else if (/^10\./.test(entry.address)) score += 8
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(entry.address)) score += 6
      entries.push({ address: entry.address, name, score })
    }
  }
  if (entries.length === 0) return [{ address: '127.0.0.1', name: 'loopback' }]
  entries.sort((left, right) => right.score - left.score)
  return entries.map((entry) => ({ address: entry.address, name: entry.name }))
}

function localAddresses(bindHost) {
  return localAddressEntries(bindHost).map((entry) => entry.address)
}

/**
 * Where pairing state lives. The CLI sets DSH_HOME, but a desktop-launched
 * Host often does not, so fall back to the conventional `~/.dsh` directory
 * (the same home that owns `.credentials.yaml`). No directory means memory-only.
 */
function resolveStatePath() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return join(fromEnv, 'remote-mobile-state.json')
  try {
    const fallback = join(homedir(), '.dsh')
    if (existsSync(fallback)) return join(fallback, 'remote-mobile-state.json')
  } catch {
    // fall through to memory-only
  }
  return null
}

/**
 * Optional advertised URL in front of the mobile server (for example a
 * Tailscale Serve HTTPS endpoint). Configured with
 * `PA_REMOTE_MOBILE_PUBLIC_URL` or a `<state>.public-url` file.
 */
function resolvePublicUrl(statePath) {
  const fromEnv = process.env.PA_REMOTE_MOBILE_PUBLIC_URL
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim().replace(/\/+$/, '')
  if (statePath !== null) {
    try {
      const text = readFileSync(`${statePath}.public-url`, 'utf8').trim()
      if (text.length > 0) return text.replace(/\/+$/, '')
    } catch {
      // no public URL configured
    }
  }
  return null
}

/**
 * Whether the phone server should start with the Host. The desktop panel's
 * on/off switch persists here; absent means enabled.
 */
function resolveEnabled(statePath) {
  if (statePath === null) return true
  try {
    return readFileSync(`${statePath}.enabled`, 'utf8').trim() !== '0'
  } catch {
    return true
  }
}

/**
 * The plugin's mobile server. `start()` is idempotent; `stop()` releases every
 * socket, timer and listener.
 */
export class RemoteMobileServer {
  /**
   * @param {object} ctx Cordis host context (accepted for parity with the other
   *   halves; the server logs through the injected `log` only)
   * @param {object} config plugin config
   * @param {object} bridge DSH bridge from bridge.js
   * @param {object} log logger with info/warn/error
   */
  constructor(ctx, config, bridge, log) {
    this.config = config ?? {}
    this.bridge = bridge
    this.log = log ?? console
    this.port = Number.isInteger(this.config.port) ? this.config.port : 3456
    this.bindHost = typeof this.config.host === 'string' ? this.config.host : '0.0.0.0'
    this.started = false
    this.server = null
    this.auth = null
    this.publicUrl = null
    this.enabled = true
    this.listening = false
    this.deskKey = randomBytes(24).toString('hex')
    this.peers = new Set()
    this.pendingApprovals = new Map()
    this.pendingQuestions = new Map()
    // Which surface answered a pending interaction, keyed by request id, so the
    // resolved frame can tell the phone "the desktop answered this one".
    this.answerOrigins = new Map()
    this.assistantBuffers = new Map()
    // Pending queue-change coalescing, so an inbox splice and the following turn
    // boundary cannot fan out duplicate `queue.changed` frames.
    this.queueTimers = new Map()
    this.queuedQueues = new Map()
    this.staticCache = new Map()
    this.heartbeat = null
    this.flushTimer = null
    this.saveTimer = null
    this.savePending = false
    this.statePath = null
    this.unsubscribeBridge = null
    this.sessionRefreshTimer = null
    // Web Push service (VAPID key + subscriptions), created in start().
    this.push = null
    // deviceId -> whether that device currently has a foreground/visible phone
    // page. Absent means "unknown", which is treated as not visible.
    this.deviceVisibility = new Map()
    this.pushTags = new Map()
    this.pushWindowStart = 0
    this.pushWindowCount = 0
    // Per-device windows for the explicit "send test notification" action; the
    // test path bypasses the automatic dispatch limiter, so it needs its own cap.
    this.pushTestWindows = new Map()
    this.replyPushAt = new Map()
    // Per-session assistant text, so a "reply ready" push can carry a short
    // excerpt instead of only the session title. Bounded to a few recent turns.
    this.replyBuffer = new Map()
    this.replyText = new Map()
  }

  baseUrl() {
    const address = localAddresses(this.bindHost)[0]
    return `http://${address}:${this.port}`
  }

  async start() {
    if (this.started) return
    this.started = true
    this.statePath = resolveStatePath()
    this.publicUrl = resolvePublicUrl(this.statePath)
    this.enabled = resolveEnabled(this.statePath)
    let persisted = null
    if (this.statePath !== null) {
      try {
        persisted = JSON.parse(await readFile(this.statePath, 'utf8'))
      } catch {
        persisted = null
      }
    }
    const secret = persisted !== null && typeof persisted.secret === 'string' && persisted.secret.length >= 32
      ? persisted.secret
      : randomBytes(32).toString('base64url')
    this.auth = createAuth({ secret, log: this.log })
    if (persisted !== null) this.auth.importState(persisted)
    // Real Web Push: VAPID keys are generated once and restored from the same
    // state file (the `push` field, absent in state files written by older
    // versions). Subscriptions belong to paired devices and survive restarts.
    this.push = createPushService({
      log: this.log,
      state: persisted !== null && typeof persisted === 'object' ? persisted.push ?? null : null,
      allowedEndpointSuffixes: pushEndpointSuffixes(),
      subject: typeof process.env.PA_REMOTE_MOBILE_VAPID_SUBJECT === 'string'
        ? process.env.PA_REMOTE_MOBILE_VAPID_SUBJECT
        : undefined,
    })
    // Persist a freshly generated VAPID key immediately: without this a Host
    // restart before the first state save would rotate the key and silently
    // invalidate every existing browser push subscription.
    if (this.push !== null) this.scheduleSave()
    // A per-process key gates the desktop panel's status endpoint. Persisting it
    // under the owner-only state directory lets local tooling (and the user's own
    // scripts) reach pairing status; it never grants network access on its own.
    if (this.statePath !== null) {
      try {
        await writeFile(`${this.statePath}.desk-key`, this.deskKey, { mode: 0o600 })
      } catch (error) {
        this.log.warn?.(`remote-mobile: cannot persist desktop panel key: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    for (const [route, spec] of STATIC_FILES) {
      try {
        const file = fileURLToPath(new URL(`./mobile/${spec.file}`, import.meta.url))
        const body = await readFile(file)
        this.staticCache.set(route, { body, type: spec.type })
      } catch (error) {
        this.log.warn?.(`remote-mobile: cannot read mobile/${spec.file}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    this.wireBridge()
    if (this.enabled) {
      try {
        await this.listen()
      } catch (error) {
        this.log.error?.(`remote-mobile: server failed to start: ${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      this.log.info?.('remote-mobile: disabled by the desktop switch')
    }
  }

  async listen() {
    if (this.listening) return
    const server = createServer((req, res) => {
      this.handleHttp(req, res).catch((error) => {
        this.log.warn?.(`remote-mobile: request failed: ${error instanceof Error ? error.message : String(error)}`)
        if (!res.headersSent) jsonResponse(res, 500, { error: 'internal' })
        else res.destroy()
      })
    })
    // The raw upgraded socket is ours after this point: keep an error listener on
    // it from the first byte so a reset during the 401/handshake write cannot
    // surface as an unhandled 'error' event.
    server.on('upgrade', (req, socket, head) => {
      socket.on('error', () => {
        try {
          socket.destroy()
        } catch {
          // already gone
        }
      })
      try {
        this.handleUpgrade(req, socket, head)
      } catch {
        try {
          socket.destroy()
        } catch {
          // already gone
        }
      }
    })
    server.on('clientError', (_error, socket) => {
      socket.on('error', () => {
        try {
          socket.destroy()
        } catch {
          // already gone
        }
      })
      try {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      } catch {
        socket.destroy()
      }
    })
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(this.port, this.bindHost)
      })
    } catch (error) {
      try {
        server.close()
      } catch {
        // already closed
      }
      throw error
    }
    this.server = server
    this.listening = true
    const address = server.address()
    if (address !== null && typeof address === 'object') this.port = address.port
    this.startHeartbeat()
    this.log.info?.(`remote-mobile: listening on ${this.bindHost}:${this.port} (${this.baseUrl()})`)
  }

  async closeListener() {
    // Timers are cleared before the early return: `stop()` must release them even
    // when the listener was never opened (disabled at boot, failed listen).
    for (const timer of [this.heartbeat, this.flushTimer, this.saveTimer]) {
      if (timer !== null) clearInterval(timer)
    }
    this.heartbeat = null
    this.flushTimer = null
    this.saveTimer = null
    if (this.sessionRefreshTimer !== null) clearTimeout(this.sessionRefreshTimer)
    this.sessionRefreshTimer = null
    // No sockets survive a closed listener, so nothing is visibly foregrounded.
    this.deviceVisibility.clear()
    if (!this.listening) return
    this.listening = false
    this.assistantBuffers.clear()
    for (const peer of [...this.peers]) peer.destroy()
    this.peers.clear()
    if (this.server !== null) {
      const server = this.server
      this.server = null
      await new Promise((resolve) => {
        try {
          server.close(() => resolve())
        } catch {
          resolve()
        }
        server.closeAllConnections?.()
      })
    }
  }

  async persistEnabled() {
    if (this.statePath === null) return
    try {
      await writeFile(`${this.statePath}.enabled`, this.enabled ? '1' : '0', { mode: 0o600 })
    } catch (error) {
      this.log.warn?.(`remote-mobile: cannot persist the enabled switch: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Turn the phone server on or off from the desktop panel. The plugin, bridge
   * and pairing state stay loaded either way; only the listener and its sockets
   * are opened or closed, so the switch is instant and reversible.
   */
  async setEnabled(flag) {
    const next = flag === true
    if (next === this.enabled && next === this.listening) {
      return { ok: true, enabled: next }
    }
    if (next) {
      if (this.started && !this.listening) {
        try {
          await this.listen()
        } catch (error) {
          this.enabled = false
          await this.persistEnabled()
          return { ok: false, enabled: false, error: error instanceof Error ? error.message : String(error) }
        }
      }
      this.enabled = true
    } else {
      await this.closeListener()
      this.enabled = false
    }
    await this.persistEnabled()
    return { ok: true, enabled: this.enabled }
  }

  startHeartbeat() {
    this.heartbeat = setInterval(() => {
      const cut = Date.now() - 70 * 1000
      for (const peer of this.peers) {
        if (peer.lastActivity < cut) {
          peer.close(1001, 'heartbeat timeout')
          this.peers.delete(peer)
          continue
        }
        peer.ping()
      }
    }, 25 * 1000)
    this.heartbeat.unref?.()

    this.flushTimer = setInterval(() => this.flushAssistantBuffers(), 33)
    this.flushTimer.unref?.()

    this.saveTimer = setInterval(() => {
      if (this.savePending) void this.saveState()
    }, 750)
    this.saveTimer.unref?.()
  }

  wireBridge() {
    if (this.bridge === null || typeof this.bridge.subscribe !== 'function') return
    try {
      this.unsubscribeBridge = this.bridge.subscribe({
        onAssistant: (payload) => this.queueAssistant(payload),
        onTool: (payload) => this.broadcastTool(payload),
        onApproval: (payload) => this.broadcastApproval(payload),
        onApprovalResolved: (payload) => this.broadcastApprovalResolved(payload),
        onQuestion: (payload) => this.broadcastQuestion(payload),
        onQuestionResolved: (payload) => this.broadcastQuestionResolved(payload),
        onQueue: (payload) => this.broadcastQueue(payload),
        onStatus: (payload) => this.broadcastStatus(payload),
      })
    } catch (error) {
      this.log.warn?.(`remote-mobile: cannot subscribe to bridge: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async stop() {
    if (!this.started) return
    this.started = false
    if (this.unsubscribeBridge !== null) {
      try {
        this.unsubscribeBridge()
      } catch {
        // ignore
      }
      this.unsubscribeBridge = null
    }
    await this.closeListener()
    for (const timer of this.queueTimers.values()) clearTimeout(timer)
    this.queueTimers.clear()
    this.queuedQueues.clear()
    await this.saveState()
    try {
      this.bridge?.dispose?.()
    } catch {
      // ignore
    }
    // The bridge settles its waiters on dispose; drop the mirrored state so a
    // later start cannot inherit stale ids.
    this.pendingApprovals.clear()
    this.pendingQuestions.clear()
    this.answerOrigins.clear()
    this.deviceVisibility.clear()
    this.pushTags.clear()
    this.replyPushAt.clear()
    this.replyBuffer.clear()
    this.replyText.clear()
  }

  scheduleSave() {
    this.savePending = true
  }

  async saveState() {
    this.savePending = false
    if (this.statePath === null || this.auth === null) return
    const tmp = `${this.statePath}.tmp`
    try {
      const state = this.auth.exportState()
      if (this.push !== null) {
        // Drop subscriptions of devices that were revoked (or evicted by the
        // pairing device cap), then persist the VAPID key and subscriptions
        // beside the pairing state in the same 0600 file.
        this.push.pruneToDevices(state.devices.map((device) => device.id))
        state.push = this.push.exportState()
      }
      const payload = JSON.stringify(state, null, 2)
      await writeFile(tmp, payload, { mode: 0o600 })
      await rename(tmp, this.statePath)
    } catch (error) {
      this.log.warn?.(`remote-mobile: cannot persist pairing state: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  isHttps(req) {
    return Boolean(req.socket && req.socket.encrypted) || req.headers['x-forwarded-proto'] === 'https'
  }

  /**
   * Settle one pending approval and record which surface answered it. The origin
   * is always removed, even when the bridge call throws, so the map cannot leak.
   * @returns the bridge result (`false` = no longer pending).
   */
  async answerApproval(requestId, decision, origin) {
    this.answerOrigins.set(requestId, origin)
    try {
      return await this.callBridge('answerApproval', requestId, decision)
    } finally {
      this.answerOrigins.delete(requestId)
    }
  }

  cookieHeader(req, value, maxAgeSeconds) {
    const parts = [
      `${COOKIE_NAME}=${value}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${maxAgeSeconds}`,
    ]
    if (this.isHttps(req)) parts.push('Secure')
    return parts.join('; ')
  }

  clearCookieHeader(req) {
    const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
    if (this.isHttps(req)) parts.push('Secure')
    return parts.join('; ')
  }

  currentDevice(req) {
    if (this.auth === null) return null
    const cookies = parseCookies(req.headers.cookie)
    return this.auth.deviceFromCookie(cookies.get(COOKIE_NAME))
  }

  corsHeaders(req) {
    const origin = req.headers.origin
    if (typeof origin !== 'string') return {}
    const allowed = this.allowedCorsOrigin(origin)
    if (allowed === null) return {}
    const headers = {
      'access-control-allow-origin': allowed,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
      vary: 'origin',
    }
    if (req.headers['access-control-request-private-network'] === 'true') {
      headers['access-control-allow-private-network'] = 'true'
    }
    return headers
  }

  /**
   * The `Access-Control-Allow-Origin` value for a request origin, or null when
   * the origin is untrusted. `null`/`file://` appear when the Desktop app renders
   * the page from disk; those requests are only answered for a loopback peer.
   */
  allowedCorsOrigin(origin) {
    if (origin === 'null' || origin.startsWith('file:')) return 'null'
    try {
      const host = new URL(origin).hostname
      if (host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]') return origin
    } catch {
      return null
    }
    return null
  }

  deskKeyOk(value) {
    return typeof value === 'string' && value.length > 0 && equals(value, this.deskKey)
  }

  /** True when the TCP peer is this machine (address is not spoofable). */
  isLoopbackRequest(req) {
    const address = normalizeIp(req.socket ? req.socket.remoteAddress : '')
    return address === '127.0.0.1' || address === '::1'
  }

  /**
   * The desktop pairing panel may call without the desk key when it runs on the
   * same machine. A loopback client address is not spoofable, and CORS still
   * confines the answer to a loopback page, so remote pages cannot read it.
   */
  deskRequestAllowed(req, url) {
    if (this.deskKeyOk(url.searchParams.get('key'))) return true
    if (!this.isLoopbackRequest(req)) return false
    const origin = req.headers.origin
    if (typeof origin !== 'string') return true
    return this.allowedCorsOrigin(origin) !== null
  }

  /**
   * Bounded diagnostic trail for the desktop panel endpoint. Contains no keys,
   * tokens or cookies: method, path, origin, host, peer and outcome only.
   */
  appendDebug(text) {
    if (this.statePath === null) return
    appendFile(`${this.statePath}.debug.log`, `${new Date().toISOString()} ${text}\n`, { mode: 0o600 }).catch(() => {})
  }

  logDesktopRequest(req, path, allowed) {
    if (this.statePath === null) return
    const line = `${new Date().toISOString()} ${req.method ?? 'GET'} ${path} origin=${String(req.headers.origin ?? '-')} host=${String(req.headers.host ?? '-')} peer=${normalizeIp(req.socket ? req.socket.remoteAddress : '')} ${allowed ? 'allowed' : 'denied'} ua=${String(req.headers['user-agent'] ?? '-').slice(0, 80)}\n`
    appendFile(`${this.statePath}.debug.log`, line, { mode: 0o600 }).catch(() => {})
  }

  /**
   * Trail of non-loopback requests (phones and pairing attempts), so an
   * unreachable device can be told apart from a blocked network path.
   */
  logAccess(req, path) {
    if (this.statePath === null) return
    if (this.isLoopbackRequest(req) && path !== '/api/pair') return
    const line = `${new Date().toISOString()} ${req.method ?? '?'} ${path} peer=${normalizeIp(req.socket ? req.socket.remoteAddress : '')} ua=${String(req.headers['user-agent'] ?? '-').slice(0, 60)}\n`
    appendFile(`${this.statePath}.access.log`, line, { mode: 0o600 }).catch(() => {})
  }

  async handleHttp(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    const method = req.method ?? 'GET'
    this.logAccess(req, path)

    if (path.startsWith('/api/desktop/')) {
      const cors = this.corsHeaders(req)
      if (method === 'OPTIONS') {
        this.logDesktopRequest(req, path, true)
        res.writeHead(204, { ...cors, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' })
        res.end()
        return
      }
      const allowed = this.deskRequestAllowed(req, url)
      this.logDesktopRequest(req, path, allowed)
      if (!allowed) {
        jsonResponse(res, 403, { error: 'forbidden' }, cors)
        return
      }
      await this.handleDesktopApi(req, res, path, method, cors)
      return
    }

    if (path === '/api/health' && method === 'GET') {
      jsonResponse(res, 200, { ok: true, version: VERSION })
      return
    }

    if (path === '/api/state' && method === 'GET') {
      const device = this.currentDevice(req)
      const authStatus = this.auth?.status()
      jsonResponse(res, 200, {
        paired: device !== null,
        device: device === null ? null : {
          id: device.id,
          name: device.name,
          createdAt: device.createdAt,
          canApprove: device.canApprove !== false,
        },
        version: VERSION,
        pinTtlMs: authStatus === undefined ? 0 : Math.max(0, authStatus.pinExpiresAt - Date.now()),
      })
      return
    }

    // Web Push bootstrap. The VAPID public key is safe to hand out (it is sent
    // inside every push message anyway) and the SPA needs it before pairing can
    // be assumed, so this is the one unauthenticated `/api/push/*` route.
    if (path === '/api/push/key' && method === 'GET') {
      if (this.push === null) {
        jsonResponse(res, 200, { enabled: false, publicKey: null })
        return
      }
      jsonResponse(res, 200, { enabled: true, publicKey: this.push.publicKey() })
      return
    }

    if (path.startsWith('/api/push/') && method === 'POST') {
      await this.handlePushApi(req, res, path)
      return
    }

    // Web Share Target (manifest `share_target`, GET): Android's share sheet
    // posts title/text/url here, and we bounce into the app with the payload in
    // the query so the composer can pick it up after pairing/restore.
    if (path === '/share-target' && method === 'GET') {
      const payload = encodeURIComponent(JSON.stringify({
        title: (url.searchParams.get('title') ?? '').slice(0, 200),
        text: (url.searchParams.get('text') ?? '').slice(0, 4000),
        url: (url.searchParams.get('url') ?? '').slice(0, 2000),
      }))
      res.writeHead(302, {
        location: `/?share=${payload}`,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      })
      res.end()
      return
    }

    if (path === '/api/preview' && method === 'GET') {
      const device = this.currentDevice(req)
      if (device === null) {
        jsonResponse(res, 401, { error: 'unauthenticated' })
        return
      }
      const sessionId = url.searchParams.get('session')
      const file = url.searchParams.get('path')
      if (typeof sessionId !== 'string' || sessionId.length === 0 || typeof file !== 'string' || file.length === 0) {
        jsonResponse(res, 400, { error: 'bad-request' })
        return
      }
      try {
        const result = await this.bridge.readUpload(sessionId, file)
        if (!result || result.ok === false) {
          jsonResponse(res, 404, { error: 'not-found' })
          return
        }
        res.writeHead(200, {
          'content-type': result.mediaType,
          'cache-control': 'private, max-age=300',
          'x-content-type-options': 'nosniff',
        })
        res.end(result.data)
      } catch {
        jsonResponse(res, 404, { error: 'not-found' })
      }
      return
    }

    if (path === '/api/upload' && method === 'POST') {
      const device = this.currentDevice(req)
      if (device === null) {
        jsonResponse(res, 401, { error: 'unauthenticated' })
        return
      }
      const header = (value) => (Array.isArray(value) ? value[0] : value)
      const sessionId = header(req.headers['x-dsh-session'])
      const name = header(req.headers['x-dsh-filename'])
      const mediaType = header(req.headers['x-dsh-media-type']) ?? header(req.headers['content-type'])
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        jsonResponse(res, 400, { error: 'missing-session' })
        return
      }
      let body
      try {
        body = await readBodyBuffer(req, 32 * 1024 * 1024)
      } catch (error) {
        jsonResponse(res, error instanceof Error && error.message === 'body-too-large' ? 413 : 400, { error: 'bad-upload' })
        return
      }
      const result = await this.callBridgeResult('saveUpload', sessionId, {
        name: typeof name === 'string' ? name : 'attachment',
        mediaType: typeof mediaType === 'string' ? mediaType : 'application/octet-stream',
        data: body,
      })
      if (!result.ok) {
        const status = result.code === 'bad-request' ? 400 : result.code === 'not-found' ? 404 : 500
        jsonResponse(res, status, { error: result.code })
        return
      }
      jsonResponse(res, 200, result.value)
      return
    }

    if (path === '/api/pair' && method === 'POST') {
      await this.handlePair(req, res)
      return
    }

    if (path === '/api/rotate-pin' && method === 'POST') {
      const device = this.currentDevice(req)
      if (device === null) {
        jsonResponse(res, 401, { error: 'unauthenticated' })
        return
      }
      const { pin, pinExpiresAt } = this.auth.rotatePin()
      jsonResponse(res, 200, { pin, pinExpiresAt })
      return
    }

    if (path === '/api/unpair' && method === 'POST') {
      const device = this.currentDevice(req)
      if (device !== null) {
        this.auth.revoke(device.id)
        this.push?.removeDevice(device.id)
        this.auth.rotateAll()
        this.scheduleSave()
        this.kickDevice(device.id)
      }
      jsonResponse(res, 200, { ok: true }, { 'set-cookie': this.clearCookieHeader(req) })
      return
    }

    if (method === 'GET' || method === 'HEAD') {
      const stat = this.staticCache.get(path)
      if (stat !== undefined) {
        this.serveStatic(req, res, stat)
        return
      }
    }

    if (path.startsWith('/api/')) {
      jsonResponse(res, 404, { error: 'not-found' })
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Not found')
  }

  serveStatic(req, res, stat) {
    const headers = {
      'content-type': stat.type,
      'cache-control': 'no-store, must-revalidate',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'permissions-policy': 'microphone=(), camera=(), geolocation=()',
    }
    // A root-scope service worker for the installable app.
    if (stat.type.startsWith('text/javascript') && req.url?.startsWith('/sw.js')) {
      headers['service-worker-allowed'] = '/'
      headers['cache-control'] = 'no-cache'
    }
    if (stat.type.startsWith('text/html')) {
      headers['content-security-policy'] = [
        "default-src 'self'",
        "script-src 'self'",
        "worker-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "connect-src 'self' ws: wss:",
        "font-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join('; ')
    }
    res.writeHead(200, headers)
    if (req.method === 'HEAD') res.end()
    else res.end(stat.body)
  }

  async handlePair(req, res) {
    let body
    try {
      body = await readJsonBody(req, 8 * 1024)
    } catch {
      jsonResponse(res, 400, { error: 'bad-request' })
      return
    }
    const address = normalizeIp(req.socket.remoteAddress)
    const agent = Array.isArray(req.headers['user-agent']) ? req.headers['user-agent'][0] : req.headers['user-agent']
    let result
    if (typeof body.token === 'string' && body.token.length > 0) {
      result = this.auth.pairWithToken(body.token, agent, address)
      if (!result.ok) {
        jsonResponse(res, 401, { error: result.error })
        return
      }
    } else if (typeof body.pin === 'string' && body.pin.length > 0) {
      result = this.auth.pairWithPin(body.pin, agent, address)
      if (!result.ok) {
        const status = result.error === 'rate-limited' ? 429 : 401
        jsonResponse(res, status, { error: result.error, retryAfterMs: result.retryAfterMs ?? 0 })
        return
      }
    } else {
      jsonResponse(res, 400, { error: 'missing-credentials' })
      return
    }
    this.scheduleSave()
    this.appendDebug(`pair method=${typeof body.token === 'string' && body.token.length > 0 ? 'token' : 'pin'} device=${result.device.name}`)
    jsonResponse(res, 200, { paired: true, device: result.device, version: VERSION }, {
      'set-cookie': this.cookieHeader(req, this.auth.cookieValue(result.device.id), this.auth.cookieMaxAgeSeconds()),
    })
  }

  /**
   * Web Push subscription management for the paired phone. Every route here
   * requires the device cookie; `/api/push/key` is handled in `handleHttp`
   * because it is intentionally public. A device can only remove its own
   * endpoint, never another paired device's.
   */
  async handlePushApi(req, res, path) {
    if (this.push === null) {
      jsonResponse(res, 503, { error: 'starting' })
      return
    }
    const device = this.currentDevice(req)
    if (device === null) {
      jsonResponse(res, 401, { error: 'unauthenticated' })
      return
    }
    let body
    try {
      body = await readJsonBody(req, 8 * 1024)
    } catch {
      jsonResponse(res, 400, { error: 'bad-request' })
      return
    }
    if (path === '/api/push/subscribe') {
      const endpoint = typeof body.subscription?.endpoint === 'string' ? body.subscription.endpoint : ''
      const owned = this.push.subscriptions(device.id)
      const isRefresh = owned.some((item) => item.endpoint === endpoint)
      if (!isRefresh && owned.length >= MAX_SUBSCRIPTIONS_PER_DEVICE) {
        jsonResponse(res, 429, { error: 'too-many-subscriptions' })
        return
      }
      const result = this.push.addSubscription(device.id, body.subscription)
      if (!result.ok) {
        jsonResponse(res, result.error === 'too-many-subscriptions' ? 429 : 400, { error: result.error })
        return
      }
      this.scheduleSave()
      jsonResponse(res, 200, { ok: true, deviceId: device.id })
      return
    }
    if (path === '/api/push/unsubscribe') {
      // The endpoint value is the browser's opaque push URL; it is never logged.
      const endpoint = typeof body.endpoint === 'string' ? body.endpoint : ''
      if (endpoint.length === 0) {
        jsonResponse(res, 400, { error: 'bad-request' })
        return
      }
      const owned = this.push.subscriptions(device.id).some((item) => item.endpoint === endpoint)
      if (owned) {
        this.push.removeSubscription(endpoint)
        this.scheduleSave()
      }
      jsonResponse(res, 200, { ok: true })
      return
    }
    if (path === '/api/push/report') {
      // Diagnostics from the service worker / SPA (bounded, never contains a
      // subscription endpoint, key material or payload content). Every field is
      // collapsed to one line so a client cannot forge log entries.
      const kind = logField(body.kind, 40) || 'unknown'
      const detail = logField(body.detail, 200)
      const scope = logField(body.scope, 120)
      const permission = logField(body.permission, 20)
      this.appendDebug(`push.report kind=${kind} permission=${permission} scope=${scope} detail=${detail}`)
      jsonResponse(res, 200, { ok: true })
      return
    }
    if (path === '/api/push/test') {
      const now = Date.now()
      const recent = (this.pushTestWindows.get(device.id) ?? []).filter((at) => now - at < PUSH_TEST_WINDOW_MS)
      if (recent.length >= PUSH_TEST_MAX_PER_DEVICE) {
        const retryAfterMs = PUSH_TEST_WINDOW_MS - (now - recent[0])
        jsonResponse(res, 429, { error: 'rate-limited', retryAfterMs })
        return
      }
      recent.push(now)
      this.pushTestWindows.set(device.id, recent)
      const payload = {
        kind: 'test',
        title: 'Test notification',
        body: 'Background push is working.',
        tag: `test:${device.id}:${Date.now()}`,
        sessionId: null,
        url: '/',
      }
      let sent = 0
      let gone = 0
      let failed = 0
      const statuses = new Set()
      for (const subscription of this.push.subscriptions(device.id)) {
        const result = await this.push.sendNotification(subscription, payload)
        if (result.ok === true) sent += 1
        else if (result.gone !== true) {
          failed += 1
          if (Number.isFinite(result.status)) statuses.add(result.status)
        }
        if (result.gone === true) gone += 1
      }
      if (gone > 0) this.scheduleSave()
      this.appendDebug(
        `push.test device=${device.id} subs=${this.push.subscriptions(device.id).length} sent=${sent} gone=${gone} failed=${failed}` +
        (statuses.size > 0 ? ` statuses=${[...statuses].join(',')}` : ''),
      )
      // The push service's error body is diagnostic only; keep it out of the
      // HTTP response so the phone cannot use this route as a response oracle.
      jsonResponse(res, 200, {
        ok: sent > 0,
        sent,
        gone,
        failed,
      })
      return
    }
    jsonResponse(res, 404, { error: 'not-found' })
  }

  /** Newest `lastSeenAt` across the paired devices (0 when none). */
  lastConnectedAt(devices) {
    let latest = 0
    for (const device of devices) {
      if (Number.isFinite(device.lastSeenAt) && device.lastSeenAt > latest) latest = device.lastSeenAt
    }
    return latest
  }

  /**
   * Pairing payload rendered by the desktop panel. `requestedAddress` selects one
   * of the detected interfaces (the panel's address chips); an unknown value
   * falls back to the preferred address, which is the Tailscale IP when the node
   * is on a tailnet.
   */
  desktopStatusPayload(requestedAddress = null) {
    const auth = this.auth
    if (auth === null) return null
    const entries = localAddressEntries(this.bindHost)
    if (this.publicUrl !== null) {
      entries.unshift({ address: this.publicUrl, name: 'Tailscale Serve (HTTPS)' })
    }
    const addresses = entries.map((entry) => entry.address)
    if (!this.enabled) {
      const devices = auth.devices()
      return {
        enabled: false,
        version: VERSION,
        port: this.port,
        bindHost: this.bindHost,
        addresses,
        address: null,
        addressDetails: [],
        url: null,
        qrSvg: null,
        pin: null,
        pinExpiresAt: 0,
        tokenExpiresAt: 0,
        devices,
        connectedDevices: 0,
        connectedNames: [],
        lastConnectedAt: this.lastConnectedAt(devices),
        loopbackOnly: false,
      }
    }
    auth.ensureFresh()
    const status = auth.status()
    const chosen = typeof requestedAddress === 'string' && addresses.includes(requestedAddress)
      ? requestedAddress
      : addresses[0]
    const url = chosen.startsWith('http')
      ? `${chosen}/?t=${encodeURIComponent(status.token)}`
      : `http://${chosen}:${this.port}/?t=${encodeURIComponent(status.token)}`
    const connectedNames = [...new Set([...this.peers].map((peer) => peer.device.name))]
    return {
      enabled: true,
      version: VERSION,
      port: this.port,
      bindHost: this.bindHost,
      addresses,
      address: chosen,
      addressDetails: entries,
      url,
      qrSvg: qrSvg(url, { cellSize: 6, margin: 2 }),
      pin: status.pin,
      pinExpiresAt: status.pinExpiresAt,
      tokenExpiresAt: status.tokenExpiresAt,
      devices: status.devices,
      connectedDevices: this.peers.size,
      connectedNames,
      lastConnectedAt: this.lastConnectedAt(status.devices),
      loopbackOnly: addresses.length === 1 && addresses[0] === '127.0.0.1',
    }
  }

  rotateDesktopPairing() {
    const auth = this.auth
    if (auth === null) return null
    const { pin, pinExpiresAt } = auth.rotatePin()
    const { token, tokenExpiresAt } = auth.rotateToken()
    return { pin, pinExpiresAt, token, tokenExpiresAt }
  }

  revokeDesktopDevices(body) {
    const auth = this.auth
    if (auth === null) return null
    if (body && body.all === true) {
      const devices = auth.devices()
      const count = auth.revokeAll()
      // Push subscriptions are per device: revoking the device revokes its
      // notification channel too.
      for (const device of devices) this.push?.removeDevice(device.id)
      for (const peer of [...this.peers]) {
        peer.close(4003, 'revoked')
        this.peers.delete(peer)
      }
      // Invalidate outstanding QR links too: a saved ?t= URL must not be able to
      // silently re-pair after the owner revoked every device.
      auth.rotateAll()
      this.scheduleSave()
      return { ok: true, revoked: count }
    }
    if (body && typeof body.deviceId === 'string' && body.deviceId.length > 0) {
      const removed = auth.revoke(body.deviceId)
      this.push?.removeDevice(body.deviceId)
      this.kickDevice(body.deviceId)
      auth.rotateAll()
      this.scheduleSave()
      return { ok: removed }
    }
    return {}
  }

  /**
   * Flip one paired device's approval permission and persist the shared state.
   * @param {string} deviceId paired-device id
   * @param {boolean} canApprove whether the device may answer approvals
   * @returns the public device, or null when the id is unknown
   */
  setDeviceApproval(deviceId, canApprove) {
    if (this.auth === null) return null
    const device = this.auth.setCanApprove(deviceId, canApprove === true)
    if (device === null) return null
    this.scheduleSave()
    return device
  }

  async handleDesktopApi(req, res, path, method, cors) {
    if (this.auth === null) {
      jsonResponse(res, 503, { error: 'starting' }, cors)
      return
    }
    if (path === '/api/desktop/status' && method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const payload = this.desktopStatusPayload(url.searchParams.get('address'))
      jsonResponse(res, 200, payload ?? { error: 'starting' }, cors)
      return
    }
    if (path === '/api/desktop/rotate' && method === 'POST') {
      const rotated = this.rotateDesktopPairing()
      jsonResponse(res, 200, rotated ?? { error: 'starting' }, cors)
      return
    }
    if (path === '/api/desktop/pending' && method === 'GET') {
      jsonResponse(res, 200, { approvals: this.pendingApprovalsSnapshot() }, cors)
      return
    }
    if (path === '/api/desktop/answer' && method === 'POST') {
      let body
      try {
        body = await readJsonBody(req, 8 * 1024)
      } catch {
        jsonResponse(res, 400, { error: 'bad-request' }, cors)
        return
      }
      if (typeof body.requestId !== 'string' || (body.decision !== 'allow' && body.decision !== 'reject')) {
        jsonResponse(res, 400, { error: 'bad-request' }, cors)
        return
      }
      const accepted = await this.answerApproval(body.requestId, body.decision, 'desktop')
      jsonResponse(res, 200, { ok: accepted !== false }, cors)
      return
    }
    if ((path === '/api/desktop/enable' || path === '/api/desktop/disable') && method === 'POST') {
      const result = await this.setEnabled(path === '/api/desktop/enable')
      jsonResponse(res, result.ok ? 200 : 500, result, cors)
      return
    }
    if (path === '/api/desktop/revoke' && method === 'POST') {
      let body
      try {
        body = await readJsonBody(req, 8 * 1024)
      } catch {
        jsonResponse(res, 400, { error: 'bad-request' }, cors)
        return
      }
      const result = this.revokeDesktopDevices(body)
      if (result === null) {
        jsonResponse(res, 503, { error: 'starting' }, cors)
        return
      }
      if (result.ok === undefined) {
        jsonResponse(res, 400, { error: 'missing-device' }, cors)
        return
      }
      jsonResponse(res, 200, result, cors)
      return
    }
    if (path === '/api/desktop/device' && method === 'POST') {
      let body
      try {
        body = await readJsonBody(req, 8 * 1024)
      } catch {
        jsonResponse(res, 400, { error: 'bad-request' }, cors)
        return
      }
      if (typeof body.deviceId !== 'string' || body.deviceId.length === 0 || typeof body.canApprove !== 'boolean') {
        jsonResponse(res, 400, { error: 'bad-request' }, cors)
        return
      }
      const device = this.setDeviceApproval(body.deviceId, body.canApprove)
      if (device === null) {
        jsonResponse(res, 404, { error: 'missing-device' }, cors)
        return
      }
      jsonResponse(res, 200, { ok: true, device }, cors)
      return
    }
    jsonResponse(res, 404, { error: 'not-found' }, cors)
  }

  /**
   * Same-origin desktop route served by the DSH web server. This avoids CORS and
   * the page CSP entirely when the GUI is served over HTTP. Only loopback
   * requests with a loopback Host header are answered, so a remote page cannot
   * read pairing data even though this route carries no cookie.
   */
  async handlePairingRoute(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const method = req.method ?? 'GET'
    const rawHost = String(req.headers.host ?? '')
    const host = rawHost.startsWith('[') ? rawHost.slice(0, rawHost.indexOf(']') + 1) : rawHost.split(':')[0]
    const loopbackHost = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
    if (!this.isLoopbackRequest(req) || !loopbackHost) {
      jsonResponse(res, 403, { error: 'forbidden' })
      return
    }
    if (this.auth === null) {
      jsonResponse(res, 503, { error: 'starting' })
      return
    }
    if (method === 'GET' && (url.pathname === '/remote-mobile/pairing' || url.pathname === '/remote-mobile/pairing/')) {
      jsonResponse(res, 200, this.desktopStatusPayload(url.searchParams.get('address')))
      return
    }
    if (method === 'GET' && url.pathname === '/remote-mobile/pairing/pending') {
      jsonResponse(res, 200, { approvals: this.pendingApprovalsSnapshot() })
      return
    }
    if (method === 'POST' && url.pathname === '/remote-mobile/pairing/answer') {
      let body
      try {
        body = await readJsonBody(req, 8 * 1024)
      } catch {
        jsonResponse(res, 400, { error: 'bad-request' })
        return
      }
      if (typeof body.requestId !== 'string' || (body.decision !== 'allow' && body.decision !== 'reject')) {
        jsonResponse(res, 400, { error: 'bad-request' })
        return
      }
      const accepted = await this.answerApproval(body.requestId, body.decision, 'desktop')
      jsonResponse(res, 200, { ok: accepted !== false })
      return
    }
    if (method === 'POST' && (url.pathname === '/remote-mobile/pairing/enable' || url.pathname === '/remote-mobile/pairing/disable')) {
      const result = await this.setEnabled(url.pathname.endsWith('/enable'))
      jsonResponse(res, result.ok ? 200 : 500, result)
      return
    }
    if (method === 'POST' && url.pathname === '/remote-mobile/pairing/device') {
      let body
      try {
        body = await readJsonBody(req, 8 * 1024)
      } catch {
        jsonResponse(res, 400, { error: 'bad-request' })
        return
      }
      if (typeof body.deviceId !== 'string' || body.deviceId.length === 0 || typeof body.canApprove !== 'boolean') {
        jsonResponse(res, 400, { error: 'bad-request' })
        return
      }
      const device = this.setDeviceApproval(body.deviceId, body.canApprove)
      if (device === null) {
        jsonResponse(res, 404, { error: 'missing-device' })
        return
      }
      jsonResponse(res, 200, { ok: true, device })
      return
    }
    if (method === 'POST' && url.pathname === '/remote-mobile/pairing/rotate') {
      jsonResponse(res, 200, this.rotateDesktopPairing())
      return
    }
    if (method === 'POST' && url.pathname === '/remote-mobile/pairing/revoke') {
      let body
      try {
        body = await readJsonBody(req, 8 * 1024)
      } catch {
        jsonResponse(res, 400, { error: 'bad-request' })
        return
      }
      const result = this.revokeDesktopDevices(body)
      if (result && result.ok === undefined) {
        jsonResponse(res, 400, { error: 'missing-device' })
        return
      }
      jsonResponse(res, 200, result)
      return
    }
    jsonResponse(res, 404, { error: 'not-found' })
  }

  kickDevice(deviceId) {
    for (const peer of [...this.peers]) {
      if (peer.device.id === deviceId) {
        peer.close(4003, 'revoked')
        this.peers.delete(peer)
      }
    }
  }

  handleUpgrade(req, socket, head) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    this.logAccess(req, '/ws')
    if (url.pathname !== '/ws') {
      socket.destroy()
      return
    }
    const origin = req.headers.origin
    if (typeof origin === 'string') {
      try {
        const parsed = new URL(origin)
        if (parsed.host !== req.headers.host) {
          socket.destroy()
          return
        }
      } catch {
        socket.destroy()
        return
      }
    }
    if (this.auth === null) {
      socket.destroy()
      return
    }
    const cookies = parseCookies(req.headers.cookie)
    const device = this.auth.deviceFromCookie(cookies.get(COOKIE_NAME))
    if (device === null) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    if (head !== undefined && head.length > 0) {
      // Preserve bytes that arrived with the handshake by replaying them.
      socket.unshift(head)
    }
    const peer = new WebSocketPeer(socket, req, device, this.log)
    this.peers.add(peer)
    peer.on('close', () => {
      this.peers.delete(peer)
      this.refreshDeviceVisibility(peer.device.id)
    })
    peer.on('message', (frame) => {
      this.handleFrame(peer, frame).catch((error) => {
        const code = typeof error?.code === 'string' && error.code.length > 0 ? error.code : 'internal'
        peer.sendObject({ type: 'error', code, message: String(error instanceof Error ? error.message : error) })
      })
    })
    this.sendWelcome(peer).catch((error) => {
      this.log.warn?.(`remote-mobile: welcome replay failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  async sendWelcome(peer) {
    let sessions = []
    try {
      sessions = await this.callBridge('listSessions')
    } catch {
      sessions = []
    }
    // Project workspaces are optional/additive: an empty array when the Host
    // cannot list them, never a reason to fail the welcome.
    const workspaces = await this.fetchWorkspaces()
    // Image limits are optional/additive: absent when the Host cannot discover
    // the attachment store, never a reason to fail the welcome.
    let limits = null
    const limitResult = await this.callBridgeResult('imageLimits')
    if (limitResult.ok && limitResult.value !== undefined) limits = limitResult.value
    peer.sendObject({
      type: 'ready',
      version: VERSION,
      server: { name: 'DeepSeek Harness', port: this.port },
      device: {
        id: peer.device.id,
        name: peer.device.name,
        canApprove: peer.device.canApprove !== false,
      },
      sessions: Array.isArray(sessions) ? sessions : [],
      workspaces,
      activeSessionId: null,
      // No session is active for a fresh socket; queue state is replayed by
      // `session.opened` once the phone opens a session.
      queue: [],
      limits,
    })
    // Replay pending interactions so a reconnecting phone still sees questions
    // and approvals that arrived while its socket was down.
    for (const approval of this.pendingApprovals.values()) {
      peer.sendObject({
        type: 'approval.request',
        sessionId: approval.sessionId ?? null,
        requestId: approval.requestId,
        toolName: approval.toolName ?? 'tool',
        title: approval.title ?? 'Approval required',
        reason: approval.reason ?? '',
        displayReason: approval.displayReason ?? null,
        callId: approval.callId ?? null,
        ...(typeof approval.argsPreview === 'string' && approval.argsPreview.length > 0
          ? { argsPreview: approval.argsPreview }
          : {}),
        ...(typeof approval.argsKind === 'string' ? { argsKind: approval.argsKind } : {}),
        ...(approval.detail && typeof approval.detail === 'object' ? { detail: approval.detail } : {}),
        expiresAt: 0,
      })
    }
    for (const question of this.pendingQuestions.values()) {
      peer.sendObject({
        type: 'question.request',
        sessionId: question.sessionId ?? null,
        requestId: question.requestId,
        callId: question.callId ?? null,
        questions: question.questions,
      })
    }
  }

  async callBridge(method, ...args) {
    if (this.bridge === null || typeof this.bridge[method] !== 'function') {
      throw new Error(`bridge method ${method} unavailable`)
    }
    const value = await this.bridge[method](...args)
    if (value !== null && typeof value === 'object' && value.ok === false) {
      const error = new Error(typeof value.error === 'string' ? value.error : `${method} failed`)
      if (typeof value.errorCode === 'string' && value.errorCode.length > 0) error.code = value.errorCode
      throw error
    }
    return value
  }

  /**
   * Call a bridge method without throwing, preserving the protocol error code.
   * Used by the newer frames so a cold/unsupported operation surfaces a
   * friendly `{ type: 'error', code }` frame instead of a generic internal one.
   * @returns `{ ok: true, value }` or `{ ok: false, code, message }`.
   */
  async callBridgeResult(method, ...args) {
    if (this.bridge === null || typeof this.bridge[method] !== 'function') {
      return { ok: false, code: 'internal', message: `bridge method ${method} unavailable` }
    }
    try {
      const value = await this.bridge[method](...args)
      if (value !== null && typeof value === 'object' && value.ok === false) {
        return {
          ok: false,
          code: typeof value.errorCode === 'string' && value.errorCode.length > 0 ? value.errorCode : 'internal',
          message: typeof value.error === 'string' ? value.error : `${method} failed`,
        }
      }
      return { ok: true, value }
    } catch (error) {
      return {
        ok: false,
        code: typeof error?.code === 'string' && error.code.length > 0 ? error.code : 'internal',
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async handleFrame(peer, frame) {
    const type = typeof frame.type === 'string' ? frame.type : ''
    switch (type) {
      case 'ping':
        peer.sendObject({ type: 'pong', t: frame.t ?? 0 })
        return
      case 'client.visibility': {
        // The SPA reports whether its page is visible (foreground). While any
        // phone page is visible no Web Push is sent; unknown/backgrounded is the
        // default so a phone that never reports still receives notifications.
        const visible = frame.visible === true
        this.deviceVisibility.set(peer.device.id, visible)
        peer.sendObject({ type: 'visibility', visible })
        return
      }
      case 'sessions.list': {
        const sessions = await this.callBridge('listSessions')
        peer.sendObject({
          type: 'sessions',
          sessions: Array.isArray(sessions) ? sessions : [],
          workspaces: await this.fetchWorkspaces(),
          activeSessionId: null,
        })
        return
      }
      case 'sessions.open': {
        if (typeof frame.sessionId !== 'string') throw new Error('sessionId required')
        const opened = await this.callBridge('openSession', frame.sessionId)
        peer.sendObject({
          type: 'session.opened',
          session: opened?.session ?? null,
          history: opened?.history ?? [],
          queue: Array.isArray(opened?.queue) ? opened.queue : [],
          context: opened?.context ?? null,
        })
        return
      }
      case 'session.rename': {
        if (typeof frame.sessionId !== 'string' || typeof frame.title !== 'string') {
          throw new Error('sessionId and title required')
        }
        const result = await this.callBridgeResult('renameSession', frame.sessionId, frame.title)
        if (!result.ok) {
          peer.sendObject({ type: 'error', code: result.code, message: result.message })
          return
        }
        const sessions = await this.fetchSessions()
        const session = sessions.find((item) => item && item.id === frame.sessionId) ?? null
        this.broadcast({
          type: 'session.updated',
          sessionId: frame.sessionId,
          title: result.value?.title ?? frame.title,
          session,
        })
        this.broadcast({ type: 'sessions', sessions, workspaces: await this.fetchWorkspaces(), activeSessionId: null })
        return
      }
      case 'session.fork': {
        if (typeof frame.sessionId !== 'string') throw new Error('sessionId required')
        const atSeq = Number.isInteger(frame.atSeq) && frame.atSeq >= 0 ? frame.atSeq : undefined
        const result = await this.callBridgeResult('forkSession', frame.sessionId, atSeq)
        if (!result.ok) {
          peer.sendObject({ type: 'error', code: result.code, message: result.message })
          return
        }
        const forkId = result.value?.sessionId
        this.broadcastSessionRefresh()
        if (typeof forkId !== 'string') return
        // Open the fork for the requesting phone through the normal path; the
        // other devices get the new row from the `sessions` refresh.
        try {
          const opened = await this.callBridge('openSession', forkId)
          peer.sendObject({
            type: 'session.opened',
            session: opened?.session ?? null,
            history: opened?.history ?? [],
            queue: Array.isArray(opened?.queue) ? opened.queue : [],
            context: opened?.context ?? null,
          })
        } catch (error) {
          peer.sendObject({
            type: 'error',
            code: 'internal',
            message: `the fork was created but could not be opened: ${error instanceof Error ? error.message : String(error)}`,
          })
        }
        return
      }
      case 'sessions.search': {
        if (typeof frame.query !== 'string') throw new Error('query required')
        const result = await this.callBridgeResult('searchSessions', frame.query)
        if (!result.ok) {
          peer.sendObject({ type: 'error', code: result.code, message: result.message })
          return
        }
        peer.sendObject({
          type: 'sessions.found',
          query: result.value?.query ?? frame.query,
          results: Array.isArray(result.value?.results) ? result.value.results : [],
          hasMore: result.value?.hasMore === true,
        })
        return
      }
      case 'session.pin':
      case 'session.unpin': {
        if (typeof frame.sessionId !== 'string') throw new Error('sessionId required')
        const result = await this.callBridgeResult('setSessionPinned', frame.sessionId, type === 'session.pin')
        if (!result.ok) {
          peer.sendObject({ type: 'error', code: result.code, message: result.message })
          return
        }
        peer.sendObject({
          type: 'session.pinned',
          sessionId: frame.sessionId,
          pinned: result.value?.pinned === true,
          archived: result.value?.archived === true,
        })
        this.broadcastSessionRefresh()
        return
      }
      case 'session.archive':
      case 'session.unarchive': {
        if (typeof frame.sessionId !== 'string') throw new Error('sessionId required')
        const stopActivity = frame.stopActivity === true
        const result = await this.callBridgeResult(
          'setSessionArchived',
          frame.sessionId,
          type === 'session.archive',
          stopActivity,
        )
        if (!result.ok) {
          peer.sendObject({ type: 'error', code: result.code, message: result.message })
          return
        }
        peer.sendObject({
          type: 'session.archived',
          sessionId: frame.sessionId,
          archived: result.value?.archived === true,
          pinned: result.value?.pinned === true,
        })
        this.broadcastSessionRefresh()
        return
      }
      case 'queue.list': {
        if (typeof frame.sessionId !== 'string') throw new Error('sessionId required')
        const result = await this.callBridgeResult('listQueue', frame.sessionId)
        if (!result.ok) {
          peer.sendObject({ type: 'error', code: result.code, message: result.message })
          return
        }
        peer.sendObject({
          type: 'queue',
          sessionId: frame.sessionId,
          items: Array.isArray(result.value?.items) ? result.value.items : [],
          pendingInput: Array.isArray(result.value?.pendingInput) ? result.value.pendingInput : [],
          running: result.value?.running === true,
          active: result.value?.active === true,
        })
        return
      }
      case 'queue.update': {
        if (typeof frame.sessionId !== 'string' || typeof frame.itemId !== 'string') {
          throw new Error('sessionId and itemId required')
        }
        const action = frame.action === 'edit' || frame.action === 'remove' || frame.action === 'steer'
          ? frame.action
          : null
        if (action === null) throw new Error('action must be edit, remove or steer')
        const result = await this.callBridgeResult(
          'updateQueue',
          frame.sessionId,
          frame.itemId,
          action,
          typeof frame.text === 'string' ? frame.text : undefined,
        )
        if (!result.ok) {
          peer.sendObject({ type: 'error', code: result.code, message: result.message })
          return
        }
        // Ack only to the requesting device; every device learns the new queue
        // from the bridge's own `queue.changed` push. Read the live state once
        // more so the ack carries the full queue-frame shape.
        const state = await this.callBridgeResult('listQueue', frame.sessionId)
        peer.sendObject({
          type: 'queue',
          sessionId: frame.sessionId,
          items: Array.isArray(result.value?.items) ? result.value.items : [],
          pendingInput: state.ok && Array.isArray(state.value?.pendingInput) ? state.value.pendingInput : [],
          running: state.ok ? state.value?.running === true : true,
          active: state.ok ? state.value?.active === true : true,
        })
        return
      }
      case 'context.get': {
        if (typeof frame.sessionId !== 'string') throw new Error('sessionId required')
        const result = await this.callBridgeResult('contextFor', frame.sessionId)
        if (!result.ok) {
          peer.sendObject({ type: 'error', code: result.code, message: result.message })
          return
        }
        peer.sendObject({
          type: 'context',
          sessionId: frame.sessionId,
          usedTokens: result.value?.usedTokens ?? null,
          pressureTokens: result.value?.pressureTokens ?? null,
          projectedTokens: result.value?.projectedTokens ?? null,
          contextWindow: result.value?.contextWindow ?? null,
          basis: typeof result.value?.basis === 'string' ? result.value.basis : 'unknown',
          tokenUsage: result.value?.tokenUsage ?? null,
        })
        return
      }
      case 'changes.list': {
        if (typeof frame.sessionId !== 'string') throw new Error('sessionId required')
        const result = await this.callBridgeResult('changesList', frame.sessionId, frame.limit)
        if (!result.ok) {
          peer.sendObject({ type: 'error', code: result.code, message: result.message })
          return
        }
        peer.sendObject({
          type: 'changes',
          sessionId: frame.sessionId,
          items: Array.isArray(result.value?.items) ? result.value.items : [],
        })
        return
      }
      case 'changes.diff': {
        if (typeof frame.sessionId !== 'string' || !Number.isInteger(frame.seq) || !Number.isInteger(frame.index)) {
          throw new Error('sessionId, seq and index required')
        }
        const result = await this.callBridgeResult('changesDiff', frame.sessionId, frame.seq, frame.index)
        if (!result.ok) {
          peer.sendObject({ type: 'error', code: result.code, message: result.message })
          return
        }
        peer.sendObject({
          type: 'changes.diff',
          sessionId: frame.sessionId,
          seq: result.value?.seq ?? frame.seq,
          index: result.value?.index ?? frame.index,
          kind: typeof result.value?.kind === 'string' ? result.value.kind : 'text',
          path: typeof result.value?.path === 'string' ? result.value.path : '',
          coarse: result.value?.coarse === true,
          hunks: Array.isArray(result.value?.hunks) ? result.value.hunks : [],
        })
        return
      }
      case 'commands.list': {
        if (typeof frame.sessionId !== 'string') throw new Error('sessionId required')
        const result = await this.callBridgeResult('listCommands', frame.sessionId)
        if (!result.ok) {
          peer.sendObject({ type: 'error', code: result.code, message: result.message })
          return
        }
        peer.sendObject({
          type: 'commands',
          sessionId: frame.sessionId,
          available: result.value?.available === true,
          items: Array.isArray(result.value?.items) ? result.value.items : [],
          reason: typeof result.value?.reason === 'string' ? result.value.reason : null,
        })
        return
      }
      case 'commands.execute': {
        if (typeof frame.sessionId !== 'string' || typeof frame.line !== 'string') {
          throw new Error('sessionId and line required')
        }
        const result = await this.callBridgeResult('executeCommand', frame.sessionId, frame.line)
        if (!result.ok) {
          peer.sendObject({ type: 'error', code: result.code, message: result.message })
          return
        }
        peer.sendObject({
          type: 'command.result',
          sessionId: frame.sessionId,
          commandId: result.value?.commandId ?? null,
          name: typeof result.value?.name === 'string' ? result.value.name : '',
          kind: result.value?.kind === 'error' ? 'error' : 'success',
          text: typeof result.value?.text === 'string' ? result.value.text : null,
          sourceEventSeq: result.value?.sourceEventSeq ?? null,
        })
        return
      }
      case 'sessions.create': {
        const cwd = typeof frame.cwd === 'string' ? frame.cwd.trim() : ''
        const created = await this.callBridge('createSession', {
          preset: typeof frame.preset === 'string' ? frame.preset : undefined,
          cwd: cwd.length > 0 ? cwd : undefined,
        })
        peer.sendObject({
          type: 'sessions',
          sessions: await this.fetchSessions(),
          workspaces: await this.fetchWorkspaces(),
          activeSessionId: created?.id ?? null,
        })
        return
      }
      case 'history.load': {
        if (typeof frame.sessionId !== 'string') throw new Error('sessionId required')
        const limit = Number.isInteger(frame.limit) ? Math.min(Math.max(frame.limit, 1), 200) : 50
        const items = await this.callBridge('history', frame.sessionId, { limit })
        peer.sendObject({ type: 'history', sessionId: frame.sessionId, items: Array.isArray(items) ? items : [], hasMore: false })
        return
      }
      case 'prompt': {
        const hasText = typeof frame.text === 'string' && frame.text.trim().length > 0
        const hasAttachments = Array.isArray(frame.attachments) && frame.attachments.length > 0
        if (typeof frame.sessionId !== 'string' || (!hasText && !hasAttachments)) {
          throw new Error('sessionId and text or attachments required')
        }
        await this.callBridge(
          'prompt',
          frame.sessionId,
          typeof frame.text === 'string' ? frame.text : '',
          typeof frame.requestId === 'string' ? frame.requestId : undefined,
          Array.isArray(frame.attachments) ? frame.attachments : undefined,
          frame.mode === 'steer' ? 'steer' : 'queue',
        )
        return
      }
      case 'stop': {
        if (typeof frame.sessionId !== 'string') throw new Error('sessionId required')
        await this.callBridge('cancel', frame.sessionId)
        return
      }
      case 'approval.answer': {
        if (typeof frame.requestId !== 'string') throw new Error('requestId required')
        // Per-device permission: a device the owner restricted may not answer.
        if (peer.device.canApprove === false) {
          peer.sendObject({
            type: 'error',
            code: 'forbidden',
            message: 'this device is not allowed to answer approvals',
          })
          return
        }
        const decision = frame.decision === 'allow' ? 'allow' : frame.decision === 'reject' ? 'reject' : null
        if (decision === null) throw new Error('decision must be allow or reject')
        this.answerOrigins.set(frame.requestId, 'phone')
        let accepted
        try {
          accepted = await this.callBridge('answerApproval', frame.requestId, decision)
        } finally {
          this.answerOrigins.delete(frame.requestId)
        }
        this.appendDebug(`approval.answer req=${frame.requestId} decision=${decision} accepted=${accepted !== false}`)
        if (accepted === false) {
          peer.sendObject({ type: 'error', code: 'not-found', message: 'approval is no longer pending' })
        }
        return
      }
      case 'question.answer': {
        if (!Array.isArray(frame.answers)) throw new Error('answers required')
        const requestId = typeof frame.requestId === 'string' ? frame.requestId : undefined
        if (requestId !== undefined) this.answerOrigins.set(requestId, 'phone')
        let result
        try {
          result = await this.callBridge('answerQuestion', {
            requestId,
            sessionId: typeof frame.sessionId === 'string' ? frame.sessionId : undefined,
            callId: typeof frame.callId === 'string' ? frame.callId : undefined,
            answers: frame.answers,
          })
        } finally {
          if (requestId !== undefined) this.answerOrigins.delete(requestId)
        }
        if (result === false) {
          peer.sendObject({ type: 'error', code: 'not-found', message: 'the question is no longer open' })
        }
        return
      }
      case 'model.list': {
        const models = await this.callBridge('listModels')
        peer.sendObject({ type: 'models', catalog: models?.catalog ?? [], current: models?.current ?? null })
        return
      }
      case 'model.select': {
        if (typeof frame.sessionId !== 'string' || typeof frame.provider !== 'string' || typeof frame.model !== 'string') {
          throw new Error('sessionId, provider and model required')
        }
        await this.callBridge('selectModel', frame.sessionId, {
          provider: frame.provider,
          model: frame.model,
          reasoningEffort: frame.reasoningEffort ?? null,
        })
        return
      }
      case 'preset.list': {
        const presets = await this.callBridge('listPresets')
        peer.sendObject({ type: 'presets', presets: presets?.presets ?? [], current: presets?.current ?? null })
        return
      }
      case 'limits': {
        const result = await this.callBridgeResult('imageLimits')
        peer.sendObject({
          type: 'limits',
          image: result.ok && result.value && typeof result.value === 'object' ? result.value.image ?? null : null,
        })
        return
      }
      case 'preset.select': {
        if (typeof frame.sessionId !== 'string' || typeof frame.preset !== 'string') {
          throw new Error('sessionId and preset required')
        }
        await this.callBridge('selectPreset', frame.sessionId, frame.preset)
        return
      }
      default:
        peer.sendObject({ type: 'error', code: 'bad-request', message: `unknown frame type ${type}` })
    }
  }

  broadcast(value) {
    for (const peer of this.peers) peer.sendObject(value)
  }

  /**
   * Remember assistant text for the "reply ready" push. Runs even with no
   * connected peers: the push is exactly for the case where nobody is watching.
   */
  trackAssistantText(payload) {
    const sessionId = payload?.sessionId
    if (typeof sessionId !== 'string') return
    if (payload.phase === 'start') {
      this.replyBuffer.set(sessionId, '')
      return
    }
    if (payload.phase === 'delta') {
      if (typeof payload.text !== 'string' || payload.text.length === 0) return
      const current = this.replyBuffer.get(sessionId) ?? ''
      if (current.length < 6000) this.replyBuffer.set(sessionId, (current + payload.text).slice(0, 6000))
      return
    }
    if (payload.phase === 'end') {
      const full = this.replyBuffer.get(sessionId) ?? ''
      this.replyBuffer.delete(sessionId)
      if (full.trim().length === 0) return
      this.replyText.set(sessionId, full)
      if (this.replyText.size > 50) {
        const oldest = this.replyText.keys().next().value
        if (oldest !== undefined) this.replyText.delete(oldest)
      }
    }
  }

  queueAssistant(payload) {
    this.trackAssistantText(payload)
    if (this.peers.size === 0) return
    const sessionId = payload?.sessionId
    if (typeof sessionId !== 'string') return
    if (payload.phase === 'start' || payload.phase === 'end') {
      this.flushAssistant(sessionId)
      this.broadcast({ type: `assistant.${payload.phase}`, sessionId, turn: payload.turn, step: payload.step })
      return
    }
    if (payload.phase !== 'delta') return
    let buffer = this.assistantBuffers.get(sessionId)
    if (buffer === undefined) {
      buffer = { text: '', reasoning: '' }
      this.assistantBuffers.set(sessionId, buffer)
    }
    buffer.text += typeof payload.text === 'string' ? payload.text : ''
    if (typeof payload.reasoning === 'string') buffer.reasoning += payload.reasoning
  }

  flushAssistant(sessionId) {
    const buffer = this.assistantBuffers.get(sessionId)
    if (buffer === undefined) return
    this.assistantBuffers.delete(sessionId)
    if (buffer.text.length === 0 && buffer.reasoning.length === 0) return
    this.broadcast({
      type: 'assistant.delta',
      sessionId,
      text: buffer.text,
      reasoning: buffer.reasoning.length > 0 ? buffer.reasoning : null,
    })
  }

  flushAssistantBuffers() {
    if (this.assistantBuffers.size === 0) return
    for (const sessionId of [...this.assistantBuffers.keys()]) this.flushAssistant(sessionId)
  }

  broadcastTool(payload) {
    if (this.peers.size === 0 || payload === null || typeof payload !== 'object') return
    if (payload.phase === 'start') {
      this.broadcast({
        type: 'tool.start',
        sessionId: payload.sessionId,
        callId: payload.callId,
        name: payload.name,
        title: payload.title,
        argsPreview: payload.argsPreview,
        detail: payload.detail ?? null,
        question: payload.question ?? null,
      })
      return
    }
    if (payload.phase === 'end') {
      this.broadcast({
        type: 'tool.end',
        sessionId: payload.sessionId,
        callId: payload.callId,
        ok: payload.ok !== false,
        output: payload.output ?? '',
        durationMs: payload.durationMs ?? 0,
        detail: payload.detail ?? null,
      })
    }
  }

  broadcastApproval(payload) {
    if (payload === null || typeof payload !== 'object' || typeof payload.requestId !== 'string') return
    this.appendDebug(`approval.request session=${String(payload.sessionId ?? '-')} tool=${String(payload.toolName ?? '-')}`)
    this.pendingApprovals.set(payload.requestId, {
      requestId: payload.requestId,
      sessionId: payload.sessionId ?? null,
      toolName: payload.toolName ?? 'tool',
      title: payload.title ?? 'Approval required',
      reason: payload.reason ?? '',
      displayReason: payload.displayReason ?? null,
      callId: payload.callId ?? null,
      // Additive, only present when the bridge correlated the tool call.
      ...(typeof payload.argsPreview === 'string' && payload.argsPreview.length > 0
        ? { argsPreview: payload.argsPreview }
        : {}),
      ...(typeof payload.argsKind === 'string' ? { argsKind: payload.argsKind } : {}),
      ...(payload.detail && typeof payload.detail === 'object' && !Array.isArray(payload.detail)
        ? { detail: payload.detail }
        : {}),
      createdAt: Date.now(),
    })
    this.broadcast({
      type: 'approval.request',
      sessionId: payload.sessionId ?? null,
      requestId: payload.requestId,
      toolName: payload.toolName ?? 'tool',
      title: payload.title ?? 'Approval required',
      reason: payload.reason ?? '',
      displayReason: payload.displayReason ?? null,
      callId: payload.callId ?? null,
      ...(typeof payload.argsPreview === 'string' && payload.argsPreview.length > 0
        ? { argsPreview: payload.argsPreview }
        : {}),
      ...(typeof payload.argsKind === 'string' ? { argsKind: payload.argsKind } : {}),
      ...(payload.detail && typeof payload.detail === 'object' && !Array.isArray(payload.detail)
        ? { detail: payload.detail }
        : {}),
      expiresAt: payload.expiresAt ?? 0,
    })
    this.requestSessionRefresh()
    // Lock-screen notification while the phone page is backgrounded/offscreen.
    this.pushApproval(payload)
  }

  broadcastApprovalResolved(payload) {
    this.pendingApprovals.delete(payload.requestId)
    const by = this.answerOrigins.get(payload.requestId) ?? null
    this.answerOrigins.delete(payload.requestId)
    this.broadcast({
      type: 'approval.resolved',
      sessionId: payload.sessionId ?? null,
      requestId: payload.requestId,
      outcome: payload.outcome ?? 'cancelled',
      by,
    })
  }

  /** Pending approvals for the desktop overlay (both devices show the same list). */
  pendingApprovalsSnapshot() {
    return [...this.pendingApprovals.values()].sort((left, right) => left.createdAt - right.createdAt)
  }

  broadcastQuestion(payload) {
    if (payload === null || typeof payload !== 'object' || typeof payload.requestId !== 'string') return
    this.pendingQuestions.set(payload.requestId, {
      sessionId: payload.sessionId ?? null,
      requestId: payload.requestId,
      callId: payload.callId ?? null,
      questions: Array.isArray(payload.questions) ? payload.questions : [],
    })
    this.broadcast({
      type: 'question.request',
      sessionId: payload.sessionId ?? null,
      requestId: payload.requestId,
      callId: payload.callId ?? null,
      questions: Array.isArray(payload.questions) ? payload.questions : [],
    })
    this.pushQuestion(payload)
  }

  broadcastQuestionResolved(payload) {
    if (typeof payload.requestId === 'string') this.pendingQuestions.delete(payload.requestId)
    const by = typeof payload.requestId === 'string'
      ? (this.answerOrigins.get(payload.requestId) ?? null)
      : null
    if (typeof payload.requestId === 'string') this.answerOrigins.delete(payload.requestId)
    this.broadcast({
      type: 'question.resolved',
      sessionId: payload.sessionId ?? null,
      requestId: payload.requestId ?? null,
      callId: payload.callId ?? null,
      answers: Array.isArray(payload.answers) ? payload.answers : null,
      outcome: payload.outcome ?? 'answered',
      by,
    })
  }

  broadcastStatus(payload) {
    if (payload === null || typeof payload !== 'object') return
    this.broadcast({ type: 'session.status', sessionId: payload.sessionId, running: payload.running === true })
    this.requestSessionRefresh()
    // A turn ended: notify the phone through its service worker if no page is
    // currently visible. At most one such push per session per minute.
    if (payload.running !== true) this.pushReply(payload)
  }

  /**
   * Drop a device's visibility flag once its last socket closed. A missing flag
   * is already "not visible", so nothing needs to be written for other devices.
   */
  refreshDeviceVisibility(deviceId) {
    for (const peer of this.peers) {
      if (peer.device.id === deviceId) return
    }
    this.deviceVisibility.delete(deviceId)
  }

  /** True while any connected phone page reports itself foreground/visible. */
  hasVisiblePeer() {
    for (const peer of this.peers) {
      if (this.deviceVisibility.get(peer.device.id) === true) return true
    }
    return false
  }

  /**
   * Bound and scrub push text: collapse control characters/whitespace, redact
   * secret-looking key/value pairs and truncate to `limit` characters. Push
   * bodies are rendered on a lock screen, so they must stay short and must not
   * carry more than the corresponding approval card.
   */
  pushSafeText(value, limit = PUSH_BODY_CHARS) {
    if (typeof value !== 'string') return ''
    let text = value
      .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
      .replace(/\b(password|passwd|secret|token|api[_-]?key|credential)\b\s*[:=]\s*\S+/giu, '$1=[redacted]')
      .replace(/\s+/gu, ' ')
      .trim()
    if (text.length > limit) text = `${text.slice(0, Math.max(0, limit - 1))}…`
    return text
  }

  /** Forget dedupe tags older than the replay window when the map grows. */
  prunePushTags(now) {
    if (this.pushTags.size <= PUSH_TAG_LIMIT) return
    for (const [tag, at] of this.pushTags) {
      if (now - at >= PUSH_TAG_TTL_MS) this.pushTags.delete(tag)
    }
  }

  /**
   * Best-effort fan-out of one Web Push payload to every stored subscription.
   *
   * Gate order: no store -> skip; remote access switched off -> skip; a visible
   * phone page -> skip; tag seen in the last five minutes -> skip; process-wide
   * 30/min cap -> skip. The call is always detached from the WebSocket path
   * (`void`), never rejects, and logs only aggregate counts, never an endpoint,
   * subscription key or payload.
   */
  async dispatchPush(payload, tag) {
    try {
      if (this.push === null || !this.push.hasSubscriptions()) {
        return { ok: false, sent: 0, gone: 0, skipped: 'empty' }
      }
      // The desktop switch closes remote access entirely: keep the subscriptions
      // (they survive re-enable) but send nothing while it is off.
      if (!this.enabled) return { ok: false, sent: 0, gone: 0, skipped: 'disabled' }
      if (this.hasVisiblePeer()) return { ok: false, sent: 0, gone: 0, skipped: 'visible' }
      const now = Date.now()
      this.prunePushTags(now)
      const seenAt = this.pushTags.get(tag)
      if (typeof seenAt === 'number' && now - seenAt < PUSH_TAG_TTL_MS) {
        return { ok: false, sent: 0, gone: 0, skipped: 'duplicate' }
      }
      if (now - this.pushWindowStart >= PUSH_RATE_WINDOW_MS) {
        this.pushWindowStart = now
        this.pushWindowCount = 0
      }
      if (this.pushWindowCount >= PUSH_MAX_PER_MINUTE) {
        return { ok: false, sent: 0, gone: 0, skipped: 'rate-limited' }
      }
      this.pushWindowCount += 1
      this.pushTags.set(tag, now)
      let sent = 0
      let gone = 0
      for (const subscription of this.push.subscriptions()) {
        let result
        try {
          result = await this.push.sendNotification(subscription, payload)
        } catch {
          result = { ok: false }
        }
        if (result?.ok === true) sent += 1
        if (result?.gone === true) gone += 1
      }
      if (gone > 0) this.scheduleSave()
      return { ok: sent > 0, sent, gone }
    } catch (error) {
      this.log.warn?.(`remote-mobile: web push fan-out failed (${error instanceof Error ? error.name : 'Error'})`)
      return { ok: false, sent: 0, gone: 0 }
    }
  }

  /** Push "approval needed" when no phone page is in the foreground. */
  pushApproval(payload) {
    const requestId = payload.requestId
    const sessionId = typeof payload.sessionId === 'string' && payload.sessionId.length > 0 ? payload.sessionId : null
    const toolName = this.pushSafeText(payload.toolName, 40) || 'tool'
    const reason = this.pushSafeText(payload.reason || payload.displayReason, 140)
    void this.dispatchPush({
      kind: 'approval',
      title: 'Approval needed',
      body: this.pushSafeText(reason.length > 0 ? `${toolName}: ${reason}` : toolName, PUSH_BODY_CHARS),
      tag: `approval:${requestId}`,
      sessionId,
      url: sessionId === null ? '/' : `/?session=${encodeURIComponent(sessionId)}`,
    }, `approval:${requestId}`)
  }

  /** Push "question from Harness" with the first question text, bounded. */
  pushQuestion(payload) {
    const requestId = payload.requestId
    const sessionId = typeof payload.sessionId === 'string' && payload.sessionId.length > 0 ? payload.sessionId : null
    const questions = Array.isArray(payload.questions) ? payload.questions : []
    const first = questions.length > 0 && questions[0] !== null && typeof questions[0] === 'object' ? questions[0] : null
    const text = this.pushSafeText(
      first !== null && typeof first.question === 'string' && first.question.length > 0
        ? first.question
        : first !== null && typeof first.header === 'string' && first.header.length > 0
          ? first.header
          : '',
      PUSH_BODY_CHARS,
    )
    void this.dispatchPush({
      kind: 'question',
      title: 'Question from Harness',
      body: text.length > 0 ? text : 'The agent is waiting for your answer.',
      tag: `question:${requestId}`,
      sessionId,
      url: sessionId === null ? '/' : `/?session=${encodeURIComponent(sessionId)}`,
    }, `question:${requestId}`)
  }

  /**
   * Turn assistant markdown into one short, plain-text notification line:
   * fenced code is dropped, inline markup flattened, whitespace collapsed.
   */
  pushSnippet(value, max) {
    const safe = this.pushSafeText(value, 2000)
    if (safe.length === 0) return ''
    let text = safe
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[*_#>~]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (text.length > max) text = `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
    return text
  }

  /**
   * Push "reply ready" when a session's turn ends. The notification carries the
   * session title plus a bounded excerpt of the assistant's actual reply, so the
   * user gets context without opening the app. Fire-and-forget: it can never
   * delay or fail the status frame. A per-session 60 s quiet period keeps a
   * burst of status events to one notification.
   */
  pushReply(payload) {
    const sessionId = typeof payload.sessionId === 'string' && payload.sessionId.length > 0 ? payload.sessionId : null
    if (sessionId === null || this.push === null || !this.push.hasSubscriptions()) return
    if (this.hasVisiblePeer()) return
    const now = Date.now()
    const last = this.replyPushAt.get(sessionId)
    if (typeof last === 'number' && now - last < PUSH_REPLY_INTERVAL_MS) return
    this.replyPushAt.set(sessionId, now)
    if (this.replyPushAt.size > PUSH_TAG_LIMIT) {
      for (const [id, at] of this.replyPushAt) {
        if (now - at >= PUSH_REPLY_INTERVAL_MS) this.replyPushAt.delete(id)
      }
    }
    void this.fetchSessions().then((sessions) => {
      const session = sessions.find((item) => item !== null && typeof item === 'object' && item.id === sessionId)
      const sessionTitle = this.pushSafeText(session?.title, 60)
      const snippet = this.pushSnippet(this.replyText.get(sessionId) ?? '', 150)
      const title = sessionTitle.length > 0 ? `Reply ready · ${sessionTitle}` : 'Reply ready'
      const tag = `reply:${sessionId}:${Math.floor(Date.now() / PUSH_REPLY_INTERVAL_MS)}`
      return this.dispatchPush({
        kind: 'reply',
        title: this.pushSafeText(title, 80),
        body: snippet.length > 0
          ? snippet
          : sessionTitle.length > 0 ? sessionTitle : 'The session finished a turn.',
        tag,
        sessionId,
        url: `/?session=${encodeURIComponent(sessionId)}`,
      }, tag)
    }).catch(() => {
      // Best-effort only: the phone still gets the status frame.
    })
  }

  /** Read the session list without throwing (empty on failure). */
  async fetchSessions() {
    try {
      const sessions = await this.callBridge('listSessions')
      return Array.isArray(sessions) ? sessions : []
    } catch {
      return []
    }
  }

  /** Read registered project workspaces without throwing (empty on failure). */
  async fetchWorkspaces() {
    const result = await this.callBridgeResult('listWorkspaces')
    return result.ok && Array.isArray(result.value) ? result.value : []
  }

  /** Coalesced `sessions` push after a local session mutation. */
  broadcastSessionRefresh(delayMs = 120) {
    if (this.peers.size === 0) return
    if (this.sessionRefreshTimer !== null) return
    this.sessionRefreshTimer = setTimeout(() => {
      this.sessionRefreshTimer = null
      if (this.peers.size === 0) return
      Promise.all([this.fetchSessions(), this.fetchWorkspaces()])
        .then(([sessions, workspaces]) => this.broadcast({ type: 'sessions', sessions, workspaces, activeSessionId: null }))
        .catch((error) => {
          this.log.warn?.(`remote-mobile: session refresh failed: ${error instanceof Error ? error.message : String(error)}`)
        })
    }, delayMs)
    this.sessionRefreshTimer.unref?.()
  }

  /**
   * Coalesced queue push. The bridge can emit a splice and a turn boundary for
   * the same change; one frame per session per ~120 ms is enough for the SPA.
   */
  broadcastQueue(payload) {
    if (this.peers.size === 0 || payload === null || typeof payload !== 'object') return
    const sessionId = payload.sessionId
    if (typeof sessionId !== 'string') return
    const items = Array.isArray(payload.items) ? payload.items : []
    this.queuedQueues.set(sessionId, items)
    if (this.queueTimers.has(sessionId)) return
    const timer = setTimeout(() => {
      this.queueTimers.delete(sessionId)
      const next = this.queuedQueues.get(sessionId) ?? items
      this.queuedQueues.delete(sessionId)
      if (this.peers.size > 0) this.broadcast({ type: 'queue.changed', sessionId, items: next })
    }, 120)
    timer.unref?.()
    this.queueTimers.set(sessionId, timer)
  }

  requestSessionRefresh() {
    this.broadcastSessionRefresh(250)
  }
}


