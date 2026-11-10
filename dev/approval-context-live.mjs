// Live check for Batch E part 1 against the INSTALLED plugin:
//  - approval.request carries argument context when the bridge saw the tool call
//  - per-device approval permission (canApprove) is enforced and togglable
// Creates one sandboxed session, triggers a real danger-full-access approval by
// asking the model to run a command, REJECTS it (no escalation happens), and
// revokes its own test device. Costs one small model call.
import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = 'http://127.0.0.1:3456'
const key = readFileSync(join(homedir(), '.dsh', 'remote-mobile-state.json.desk-key'), 'utf8').trim()
const log = (...args) => console.log('[approval]', ...args)
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
        next: (timeoutMs = 10000) => new Promise((res, rej) => {
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
async function waitFor(client, predicate, label, timeoutMs = 150000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const remaining = Math.max(1, deadline - Date.now())
    const frame = await client.next(remaining)
    if (predicate(frame)) return frame
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
    expect(ready.type === 'ready', 'expected ready frame')
    deviceId = ready.device?.id ?? null
    expect(typeof deviceId === 'string', 'ready.device.id missing')
    expect(ready.device.canApprove === true, 'a fresh device must be allowed to approve')

    // Fake decision while permitted -> reaches the bridge and fails as unknown.
    client.send({ type: 'approval.answer', requestId: 'no-such-approval', decision: 'allow' })
    const unknown = await waitFor(client, (frame) => frame.type === 'error', 'unknown-approval error')
    expect(unknown.code === 'not-found', `unexpected error for unknown approval: ${unknown.code}`)
    log('permitted device reaches the bridge (unknown request -> not-found)')

    // Restrict this device, then the same frame must be refused locally.
    const toggleOff = await fetch(`${BASE}/api/desktop/device`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId, canApprove: false }),
    })
    expect(toggleOff.status === 200, `toggle failed: ${toggleOff.status}`)
    const offPayload = await toggleOff.json()
    expect(offPayload.device?.canApprove === false, 'toggle response did not report canApprove=false')
    client.send({ type: 'approval.answer', requestId: 'no-such-approval', decision: 'allow' })
    const forbidden = await waitFor(client, (frame) => frame.type === 'error', 'forbidden error')
    expect(forbidden.code === 'forbidden', `restricted device should be forbidden, got ${forbidden.code}`)
    log('restricted device is rejected with forbidden')

    // Restore permission so the rest of the check behaves normally.
    const toggleOn = await fetch(`${BASE}/api/desktop/device`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId, canApprove: true }),
    })
    expect(toggleOn.status === 200, 'restore toggle failed')

    const deviceRows = (await (await fetch(`${BASE}/api/desktop/status?key=${encodeURIComponent(key)}`)).json()).devices ?? []
    const own = deviceRows.find((device) => device.id === deviceId)
    expect(own && own.canApprove === true, 'desktop device list did not reflect the restored flag')
    log('desktop device list exposes canApprove')

    client.send({ type: 'sessions.create', cwd: tmpdir() })
    const created = await waitFor(client, (frame) => frame.type === 'sessions', 'session creation')
    sessionId = created.activeSessionId
    expect(typeof sessionId === 'string', 'session was not created')

    const requestId = randomUUID()
    client.send({
      type: 'prompt',
      sessionId,
      requestId,
      text: 'Use the pwsh tool with sandbox_permissions set to "danger-full-access" to run exactly: echo approval-context-live. Do not explain; just run it once.',
    })

    const approval = await waitFor(
      client,
      (frame) => frame.type === 'approval.request' && frame.sessionId === sessionId,
      'approval.request',
    )
    log(`approval received (tool=${approval.toolName})`)
    expect(typeof approval.argsPreview === 'string' && approval.argsPreview.length > 0, 'approval is missing argsPreview')
    expect(approval.argsKind === 'command', `expected argsKind command, got ${approval.argsKind}`)
    expect(approval.detail && approval.detail.kind === 'command', 'approval is missing detail.kind=command')
    expect(/approval-context-live/.test(approval.argsPreview), `argsPreview should contain the command, got: ${approval.argsPreview.slice(0, 120)}`)
    log(`argsPreview OK: ${approval.argsPreview.replace(/\s+/g, ' ').slice(0, 100)}`)

    client.send({ type: 'approval.answer', requestId: approval.requestId, decision: 'reject' })
    const resolved = await waitFor(
      client,
      (frame) => frame.type === 'approval.resolved' && frame.requestId === approval.requestId,
      'approval.resolved',
    )
    expect(resolved.outcome === 'rejected', `expected rejected, got ${resolved.outcome}`)
    log('approval rejected; no escalation granted')

    client.send({ type: 'stop', sessionId })
    console.log('PASS live approval context + device approval permission')
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
