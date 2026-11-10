// Live check for the reasoning-effort contract against the INSTALLED plugin:
// model.list must advertise efforts for reasoning-capable models, model.select
// must accept an effort id, and the session must echo the chosen effort.
// Creates a throwaway session; no model prompt is sent (no token cost).
import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { randomBytes } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = 'http://127.0.0.1:3456'
const key = readFileSync(join(homedir(), '.dsh', 'remote-mobile-state.json.desk-key'), 'utf8').trim()
const log = (...args) => console.log('[effort]', ...args)
const expect = (value, message) => {
  if (!value) throw new Error(message)
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
async function waitFor(client, predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const remaining = Math.max(1, deadline - Date.now())
    const frame = await client.next(remaining)
    if (predicate(frame)) return frame
    if (frame && frame.type === 'error') log(`skipped error while waiting for ${label}: ${frame.code} ${frame.message}`)
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
  }
}

async function main() {
  const status = await (await fetch(`${BASE}/api/desktop/status?key=${encodeURIComponent(key)}`)).json()
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
  let sessionId = null
  try {
    const ready = await client.next()
    deviceId = ready.device?.id ?? null
    client.send({ type: 'sessions.create', cwd: tmpdir() })
    const created = await waitFor(client, (frame) => frame.type === 'sessions', 'session creation')
    sessionId = created.activeSessionId
    expect(typeof sessionId === 'string', 'session was not created')

    client.send({ type: 'model.list' })
    const models = await waitFor(client, (frame) => frame.type === 'models', 'models frame')
    expect(Array.isArray(models.catalog) && models.catalog.length > 0, 'empty model catalog')
    const withReasoning = models.catalog.find((entry) => entry.reasoning && Array.isArray(entry.reasoning.efforts) && entry.reasoning.efforts.length > 0)
    if (!withReasoning) {
      log('this deployment advertises no reasoning-capable model; catalog shape checked only')
      const plain = models.catalog[0]
      expect(plain.reasoning === undefined, 'models without a reasoning control must omit the field')
    } else {
      log(`model: ${withReasoning.label} efforts=[${withReasoning.reasoning.efforts.map((effort) => effort.id).join(', ')}] default=${withReasoning.reasoning.defaultEffort ?? '-'}`)
      const target = withReasoning.reasoning.efforts.find((effort) => effort.id !== withReasoning.reasoning.defaultEffort)
        ?? withReasoning.reasoning.efforts[0]
      client.send({
        type: 'model.select',
        sessionId,
        provider: withReasoning.provider,
        model: withReasoning.model,
        reasoningEffort: target.id,
      })
      client.send({ type: 'sessions.list' })
      const refreshed = await waitFor(client, (frame) => frame.type === 'sessions', 'sessions after model select')
      const row = refreshed.sessions.find((entry) => entry.id === sessionId)
      expect(row && row.model, 'session row has no model after select')
      expect(row.model.provider === withReasoning.provider && row.model.model === withReasoning.model, 'selected model not echoed')
      expect(row.model.reasoningEffort === target.id, `effort not echoed: expected ${target.id}, got ${row.model.reasoningEffort}`)
      log(`selected ${withReasoning.model} with effort ${target.id}; session echoes it`)

      client.send({ type: 'model.select', sessionId, provider: withReasoning.provider, model: withReasoning.model })
      client.send({ type: 'sessions.list' })
      const defaulted = await waitFor(client, (frame) => frame.type === 'sessions', 'sessions after default select')
      const defaultRow = defaulted.sessions.find((entry) => entry.id === sessionId)
      expect(defaultRow && defaultRow.model, 'session row lost its model')
      log(`re-selected with host default; echoed effort=${defaultRow.model.reasoningEffort ?? 'null'}`)
    }

    client.send({ type: 'stop', sessionId })
    console.log('PASS live reasoning-effort contract')
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

