// Live check for the v2 context meter + Host command palette. Creates a
// throwaway session, runs one short prompt (no tools), then verifies context.get,
// commands.list (every command the live agent offers) and one harmless execution.
// Revokes its own device.
import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = 'http://127.0.0.1:3456'
const key = readFileSync(join(homedir(), '.dsh', 'remote-mobile-state.json.desk-key'), 'utf8').trim()
const log = (...args) => console.log('[commands]', ...args)
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
        next: (timeoutMs = 20000) => new Promise((res, rej) => {
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
async function waitFor(client, predicate, label, timeoutMs = 120000) {
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
    const ready = await client.next(); log('ready: ' + ready.type)
    deviceId = ready.device?.id ?? null
    client.send({ type: 'sessions.create', cwd: tmpdir() })
    const created = await waitFor(client, (frame) => frame.type === 'sessions', 'session creation'); log('session: ' + created.activeSessionId)
    sessionId = created.activeSessionId
    expect(typeof sessionId === 'string', 'session was not created')

    client.send({ type: 'prompt', sessionId, requestId: randomUUID(), text: 'Reply with exactly: OK' })
    await waitFor(client, (frame) => frame.type === 'assistant.end' && frame.sessionId === sessionId, 'turn end')
    log('prompt turn finished')

    client.send({ type: 'context.get', sessionId })
    const context = await waitFor(client, (frame) => frame.type === 'context' && frame.sessionId === sessionId, 'context frame')
    expect(typeof context.usedTokens === 'number' && context.usedTokens > 0, 'context meter should report used tokens')
    expect(context.basis === 'usage' || context.basis === 'estimated', `unexpected context basis: ${context.basis}`)
    log(`context: used=${context.usedTokens} window=${context.contextWindow} basis=${context.basis}`)

    client.send({ type: 'commands.list', sessionId })
    const commands = await waitFor(client, (frame) => frame.type === 'commands' && frame.sessionId === sessionId, 'commands frame')
    expect(typeof commands.available === 'boolean', 'commands frame must report availability')
    const names = commands.items.map((item) => item.name)
    log(`commands: available=${commands.available} items=${names.join(',') || '-'}`)
    expect(commands.available === true, 'a live agent must expose its command catalog')
    expect(names.length > 1, 'the phone must see every Host command, not just compact')
    expect(names.includes('compact'), 'compact must stay available')
    expect(!names.includes('export'), 'export is desktop-only and must be hidden from the phone')
    expect(!names.includes('permission'), 'the sandbox/approval policy command must stay desktop-only')
    expect(new Set(names).size === names.length, 'command names must be unique')
    for (const item of commands.items) {
      expect(typeof item.description === 'string' && item.description.length > 0, `command ${item.name} needs a description`)
      expect(item.hint === null || typeof item.hint === 'string', `command ${item.name} needs a string hint or null`)
    }
    const withHint = commands.items.find((item) => typeof item.hint === 'string' && item.hint.length > 0)
    if (withHint) {
      log(`command hints exposed: /${withHint.name} ${withHint.hint}`)
    }

    const compact = commands.items.find((item) => item.name === 'compact')
    if (compact) {
      client.send({ type: 'commands.execute', sessionId, line: '/compact' })
      const result = await waitFor(
        client,
        (frame) => frame.type === 'command.result' || frame.type === 'error',
        'command result',
      )
      if (result.type === 'command.result') {
        expect(result.name === 'compact', 'command result named the wrong command')
        log(`command: compact ${result.kind}${result.text ? ` (${String(result.text).slice(0, 60)})` : ''}`)
      } else {
        log(`command: compact refused (${result.code}: ${result.message})`)
      }
    }

    // Argument passthrough: `/goal` with no objective only reports state and
    // never starts a model turn, so it is safe to execute from a throwaway session.
    const goal = commands.items.find((item) => item.name === 'goal')
    if (goal) {
      client.send({ type: 'commands.execute', sessionId, line: '/goal' })
      const result = await waitFor(
        client,
        (frame) => frame.type === 'command.result' || frame.type === 'error',
        'goal command result',
      )
      if (result.type === 'command.result') {
        expect(result.name === 'goal', 'goal command result named the wrong command')
        log(`command: goal ${result.kind}${result.text ? ` (${String(result.text).slice(0, 60)})` : ''}`)
      } else {
        log(`command: goal refused (${result.code}: ${result.message})`)
      }
    } else {
      log('command: goal not registered in this composition')
    }

    // A command that is not in the live catalog must be refused by the bridge.
    client.send({ type: 'commands.execute', sessionId, line: '/definitely-not-a-command' })
    const refused = await waitFor(client, (frame) => frame.type === 'error', 'forbidden command error')
    expect(refused.code === 'forbidden', `unknown commands must be forbidden, got ${refused.code}`)
    log('unknown command refused')

    // Policy-changing commands must never reach the Host from the phone.
    client.send({ type: 'commands.execute', sessionId, line: '/permission danger-full-access' })
    const denied = await waitFor(client, (frame) => frame.type === 'error', 'policy command error')
    expect(denied.code === 'forbidden', `permission changes must be forbidden, got ${denied.code}`)
    log('policy command refused')

    client.send({ type: 'stop', sessionId })
    // Leave no clutter behind: archive the throwaway session this check created.
    client.send({ type: 'session.archive', sessionId })
    await waitFor(client, (frame) => frame.type === 'session.archived' && frame.sessionId === sessionId, 'cleanup archive')
    log('throwaway session archived for cleanup')
    console.log('PASS live context meter + command palette')
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


