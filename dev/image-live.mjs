// Live probe for Batch D: does a phone-uploaded image reach the model inline?
// Pairs, creates a throwaway session, uploads a generated 16x16 red PNG, sends
// one short prompt and checks the turn completes without an attachment error.
// Costs one small model call. The session is left cold; its device is revoked.
import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = 'http://127.0.0.1:3456'
const KEY_PATH = join(homedir(), '.dsh', 'remote-mobile-state.json.desk-key')
const key = readFileSync(KEY_PATH, 'utf8').trim()
const log = (...args) => console.log('[image]', ...args)
const expect = (value, message) => {
  if (!value) throw new Error(message)
}

/* ---- minimal PNG encoder (truecolour 8-bit) ---- */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()
function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([length, typeBuf, data, crc])
}
function makePng(width, height, [r, g, b]) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour
  const raw = Buffer.alloc((width * 3 + 1) * height)
  let at = 0
  for (let y = 0; y < height; y += 1) {
    raw[at] = 0
    at += 1
    for (let x = 0; x < width; x += 1) {
      raw[at] = r
      raw[at + 1] = g
      raw[at + 2] = b
      at += 3
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/* ---- tiny websocket client ---- */
function encodeFrame(value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8')
  const mask = randomBytes(4)
  const masked = Buffer.from(payload)
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4]
  let header
  if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length])
  else {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 0x80 | 126
    header.writeUInt16BE(payload.length, 2)
  }
  return Buffer.concat([header, mask, masked])
}
function openSocket(cookie) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1',
      port: 3456,
      path: '/ws',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version': '13',
        Cookie: cookie,
      },
    })
    request.on('response', (res) => reject(new Error(`upgrade refused: ${res.statusCode}`)))
    request.on('upgrade', (res, socket, head) => {
      if (head && head.length > 0) socket.unshift(head)
      let buffer = Buffer.alloc(0)
      const queue = []
      const waiters = []
      const push = (value) => {
        const waiter = waiters.shift()
        if (waiter) waiter(value)
        else queue.push(value)
      }
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        while (buffer.length >= 2) {
          const opcode = buffer[0] & 0x0f
          let length = buffer[1] & 0x7f
          let offset = 2
          if (length === 126) {
            if (buffer.length < 4) return
            length = buffer.readUInt16BE(2)
            offset = 4
          } else if (length === 127) {
            if (buffer.length < 10) return
            length = Number(buffer.readBigUInt64BE(2))
            offset = 10
          }
          if (buffer.length < offset + length) return
          const payload = buffer.subarray(offset, offset + length)
          buffer = buffer.subarray(offset + length)
          if (opcode === 0x1) push(JSON.parse(payload.toString('utf8')))
          if (opcode === 0x9) socket.write(Buffer.from([0x8a, 0]))
        }
      })
      socket.on('error', reject)
      resolve({
        next: (timeoutMs = 8000) => new Promise((res, rej) => {
          if (queue.length > 0) {
            res(queue.shift())
            return
          }
          const timer = setTimeout(() => rej(new Error('ws timeout waiting for frame')), timeoutMs)
          waiters.push((value) => {
            clearTimeout(timer)
            res(value)
          })
        }),
        send: (value) => socket.write(encodeFrame(value)),
        close: () => socket.end(),
      })
    })
    request.on('error', reject)
    request.end()
  })
}
async function nextOfType(client, type, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const remaining = Math.max(1, deadline - Date.now())
    const frame = await client.next(remaining)
    if (frame && frame.type === type) return frame
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${type}`)
  }
}

async function main() {
  const png = makePng(16, 16, [220, 30, 40])
  const status = await (await fetch(`${BASE}/api/desktop/status?key=${key}`)).json()
  const token = new URL(status.url).searchParams.get('t')
  const paired = await fetch(`${BASE}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  expect(paired.status === 200, `pair failed: ${paired.status}`)
  const cookie = (paired.headers.get('set-cookie') ?? '').split(';')[0]

  const client = await openSocket(cookie)
  let deviceId = null
  try {
    const ready = await nextOfType(client, 'ready')
    deviceId = ready.device?.id ?? null

    client.send({ type: 'limits' })
    const limits = await nextOfType(client, 'limits')
    expect(limits && (limits.image === null || typeof limits.image === 'object'), 'limits frame must carry image limits or null')
    log(`limits: ${limits.image ? JSON.stringify(limits.image) : 'null (attachment service unavailable)'}`)

    client.send({ type: 'sessions.create', cwd: tmpdir() })
    const created = await nextOfType(client, 'sessions')
    const sessionId = created.activeSessionId
    expect(typeof sessionId === 'string', 'session was not created')

    const upload = await fetch(`${BASE}/api/upload`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'image/png',
        'x-dsh-session': sessionId,
        'x-dsh-filename': 'probe-red.png',
        'x-dsh-media-type': 'image/png',
      },
      body: png,
    })
    const stored = await upload.json()
    expect(upload.status === 200 && stored && stored.ok !== false, `upload failed: ${upload.status} ${JSON.stringify(stored)}`)
    expect(typeof stored.path === 'string', 'upload did not return a path')
    log(`uploaded ${stored.path} (${stored.size} bytes, ${stored.mediaType})`)

    const requestId = randomUUID()
    client.send({
      type: 'prompt',
      sessionId,
      requestId,
      text: 'Look at the attached image and answer with two words: the colour and the word OK.',
      attachments: [{ path: stored.path, name: stored.name ?? 'probe-red.png', mediaType: stored.mediaType ?? 'image/png', size: stored.size ?? png.length }],
    })

    let assistantText = ''
    let errorFrame = null
    let toolNames = []
    let ended = false
    let started = false
    // The bridge fans every session's events to every device, so ignore frames
    // that belong to another session (e.g. the user's desktop chat).
    const mine = (frame) => !frame.sessionId || frame.sessionId === sessionId
    const deadline = Date.now() + 150000
    while (!ended && Date.now() < deadline) {
      let frame
      try {
        frame = await client.next(15000)
      } catch {
        break
      }
      if (!mine(frame)) continue
      if (frame.type === 'assistant.start') started = true
      else if (frame.type === 'assistant.delta') assistantText += frame.text ?? ''
      else if (frame.type === 'assistant.end') ended = true
      else if (frame.type === 'tool.start') toolNames.push(frame.name)
      else if (frame.type === 'error') {
        errorFrame = frame
        ended = true
      }
    }
    expect(!errorFrame, `turn failed: ${errorFrame ? `${errorFrame.code} ${errorFrame.message}` : ''}`)
    expect(started, 'the turn never started on this session')
    expect(ended, 'the turn did not finish in time')
    expect(assistantText.trim().length > 0, 'the assistant produced no text')
    const sawReadImage = toolNames.includes('read_image')
    log(`reply: ${assistantText.trim().slice(0, 120)}`)
    log(`tools: ${toolNames.length ? toolNames.join(', ') : 'none'}${sawReadImage ? ' (image was not inlined)' : ' (no read_image call: image likely seen inline)'}`)
    console.log('PASS live image prompt (turn completed with an image attachment)')
  } finally {
    client.close()
    if (deviceId) {
      await fetch(`${BASE}/api/desktop/revoke?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId }),
      }).catch(() => {})
    }
  }
}

main().catch((error) => {
  console.error('FAIL', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
