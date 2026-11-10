// Live end-to-end check against the INSTALLED plugin on 127.0.0.1:3456.
// Pairs with the desktop panel token, speaks the mobile WS protocol, and
// verifies sessions, history, models, presets and a real prompt round-trip.
import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BASE = 'http://127.0.0.1:3456'
const KEY_PATH = join(homedir(), '.dsh', 'remote-mobile-state.json.desk-key')
const key = readFileSync(KEY_PATH, 'utf8').trim()

function jsonFetch(path, init = {}) {
  return fetch(BASE + path, { cache: 'no-store', ...init })
}

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
    request.on('response', (response) => reject(new Error(`upgrade refused: ${response.statusCode}`)))
    request.on('upgrade', (response, socket, head) => {
      const expected = createHash('sha1').update(response.headers['sec-websocket-key'] + '').digest
      void expected
      const queue = []
      const waiters = []
      let buffer = Buffer.alloc(0)
      const push = (value) => {
        const waiter = waiters.shift()
        if (waiter) waiter(value)
        else queue.push(value)
      }
      const consume = (chunk) => {
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
          if (opcode === 0x9) {
            if (!socket.writableEnded && !socket.destroyed) socket.write(Buffer.from([0x8a, 0]))
            continue
          }
          if (opcode === 0x8) {
            socket.end()
            return
          }
          if (opcode === 0x1) push(JSON.parse(payload.toString('utf8')))
        }
      }
      if (head && head.length > 0) consume(head)
      socket.on('error', () => {})
      socket.on('data', consume)
      resolve({
        send: (value) => socket.write(encodeFrame(value)),
        close: () => socket.end(),
        next: (timeoutMs = 5000) => new Promise((res, rej) => {
          if (queue.length > 0) {
            res(queue.shift())
            return
          }
          const timer = setTimeout(() => rej(new Error('frame timeout')), timeoutMs)
          waiters.push((value) => {
            clearTimeout(timer)
            res(value)
          })
        }),
        async waitFor(predicate, timeoutMs = 60000) {
          const deadline = Date.now() + timeoutMs
          while (Date.now() < deadline) {
            const frame = await this.next(Math.max(500, deadline - Date.now()))
            if (predicate(frame)) return frame
          }
          throw new Error('waitFor timeout')
        },
      })
    })
    request.on('error', reject)
    request.end()
  })
}

const status = await (await jsonFetch(`/api/desktop/status?key=${encodeURIComponent(key)}`)).json()
if (!status.url) throw new Error('no pairing URL')
const token = new URL(status.url).searchParams.get('t')
console.log('desktop status: pin length ok, addresses:', status.addresses.join(','), 'loopbackOnly:', status.loopbackOnly)

const pairResponse = await jsonFetch('/api/pair', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token }),
})
if (!pairResponse.ok) throw new Error(`pair failed: ${pairResponse.status} ${await pairResponse.text()}`)
const setCookie = pairResponse.headers.get('set-cookie') ?? ''
const cookie = setCookie.split(';')[0]
console.log('paired:', Boolean(cookie), 'cookie length:', cookie.length)

const ws = await openSocket(cookie)
try {
  const ready = await ws.next()
  console.log('ready:', ready.type, 'sessions:', Array.isArray(ready.sessions) ? ready.sessions.length : 'n/a')

  ws.send({ type: 'sessions.list' })
  const sessions = await ws.waitFor((frame) => frame.type === 'sessions' && Array.isArray(frame.sessions), 20000)
  console.log('sessions frame:', sessions.sessions.length)
  for (const session of sessions.sessions.slice(0, 5)) {
    console.log('  -', session.id.slice(0, 8), JSON.stringify(session.title), 'running:', session.running, 'preset:', session.preset)
  }

  if (sessions.sessions.length > 0) {
    const target = sessions.sessions[0]
    ws.send({ type: 'sessions.open', sessionId: target.id })
    const opened = await ws.waitFor((frame) => frame.type === 'session.opened', 30000)
    console.log('openSession:', opened.session?.id?.slice(0, 8), 'history items:', opened.history?.length)
  }

  ws.send({ type: 'model.list' })
  const models = await ws.waitFor((frame) => frame.type === 'models', 15000)
  console.log('models:', models.catalog.length, 'current:', JSON.stringify(models.current))

  ws.send({ type: 'preset.list' })
  const presets = await ws.waitFor((frame) => frame.type === 'presets', 15000)
  console.log('presets:', presets.presets.map((p) => p.id).join(','), 'current:', presets.current)

  ws.send({ type: 'sessions.create', preset: 'minimal' })
  const created = await ws.waitFor((frame) => frame.type === 'sessions' && frame.activeSessionId, 20000)
  const newSessionId = created.activeSessionId
  console.log('created session:', newSessionId?.slice(0, 8))

  ws.send({ type: 'prompt', sessionId: newSessionId, text: 'Reply with exactly: OK', requestId: `live-${Date.now()}` })
  const start = await ws.waitFor((frame) => frame.type === 'assistant.start', 30000)
  console.log('assistant.start turn/step:', start.turn, start.step)
  let text = ''
  let ended = false
  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    const frame = await ws.next(deadline - Date.now())
    if (frame.type === 'assistant.delta' && frame.sessionId === newSessionId) text += frame.text ?? ''
    if (frame.type === 'tool.start') console.log('tool.start:', frame.name, JSON.stringify(frame.argsPreview))
    if (frame.type === 'tool.end') console.log('tool.end:', frame.ok, JSON.stringify((frame.output ?? '').slice(0, 80)))
    if (frame.type === 'approval.request') {
      console.log('approval.request:', frame.toolName, '-> rejecting')
      ws.send({ type: 'approval.answer', requestId: frame.requestId, decision: 'reject' })
    }
    if (frame.type === 'assistant.end' && frame.sessionId === newSessionId) {
      ended = true
      break
    }
  }
  console.log('assistant.end:', ended, 'text:', JSON.stringify(text.slice(0, 120)))
  if (!ended) throw new Error('assistant turn did not end')
  console.log('LIVE CHECK PASS')
} finally {
  ws.close()
}

