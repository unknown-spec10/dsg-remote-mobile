// Live check for the v2 session-management frames against the INSTALLED plugin.
// Pairs with the desktop panel token, creates a throwaway session in the temp
// directory, exercises rename / search / pin / archive / cold-queue guards, then
// revokes its own device. No model prompt is sent, so it costs no tokens.
import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { randomBytes } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = 'http://127.0.0.1:3456'
const KEY_PATH = join(homedir(), '.dsh', 'remote-mobile-state.json.desk-key')
const key = readFileSync(KEY_PATH, 'utf8').trim()

const log = (...args) => console.log('[live]', ...args)

function fail(message) {
  throw new Error(message)
}

function expect(value, message) {
  if (!value) fail(message)
}

async function jsonFetch(path, init = {}) {
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
        next: (timeoutMs = 5000) => new Promise((res, rej) => {
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

async function nextOfType(client, type, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const remaining = Math.max(1, deadline - Date.now())
    const frame = await client.next(remaining)
    if (frame && frame.type === type) return frame
    if (frame && frame.type === 'error') log(`unexpected error frame while waiting for ${type}: ${frame.code} ${frame.message}`)
    if (Date.now() >= deadline) fail(`timed out waiting for ${type}`)
  }
}

async function nextOfTypes(client, types, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const remaining = Math.max(1, deadline - Date.now())
    const frame = await client.next(remaining)
    if (frame && types.includes(frame.type)) return frame
    if (Date.now() >= deadline) fail(`timed out waiting for ${types.join(' or ')}`)
  }
}

async function main() {
  const stamp = Date.now()
  const status = await (await jsonFetch(`/api/desktop/status?key=${key}`)).json()
  expect(status.enabled === true, 'remote access is disabled')
  const token = new URL(status.url).searchParams.get('t')
  expect(token, 'desktop status did not expose a pairing token')

  const paired = await jsonFetch('/api/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  expect(paired.status === 200, `pair failed: ${paired.status}`)
  const rawCookie = paired.headers.get('set-cookie') ?? ''
  const cookie = rawCookie.split(';')[0]
  expect(cookie.startsWith('dsh_rm_session='), 'pair did not set the session cookie')

  const client = await openSocket(cookie)
  let deviceId = null
  let createdId = null
  try {
    const ready = await nextOfType(client, 'ready')
    expect(Array.isArray(ready.sessions), 'ready.sessions must be an array')
    expect(Array.isArray(ready.queue), 'ready.queue must be an array')
    deviceId = ready.device?.id ?? null

    const cwd = tmpdir()
    client.send({ type: 'sessions.create', cwd })
    const created = await nextOfType(client, 'sessions')
    createdId = created.activeSessionId
    expect(typeof createdId === 'string' && createdId.startsWith('session-'), 'sessions.create did not activate a session')
    const row = created.sessions.find((item) => item.id === createdId)
    expect(row, 'created session missing from the sessions frame')
    expect(typeof row.agentAvailable === 'boolean', 'every session row must carry an agentAvailable boolean')
    expect(row.pinned === false && row.archived === false, 'new session must be unpinned and unarchived')
    log(`created ${createdId} (cwd=${cwd})`)

    client.send({ type: 'session.rename', sessionId: createdId, title: `Phone test ${stamp}` })
    const updated = await nextOfType(client, 'session.updated')
    expect(updated.sessionId === createdId, 'session.updated carries the wrong session')
    expect(updated.title === `Phone test ${stamp}`, `unexpected renamed title: ${updated.title}`)
    const refreshed = await nextOfType(client, 'sessions')
    expect(refreshed.sessions.some((item) => item.id === createdId && item.title === `Phone test ${stamp}`), 'rename was not reflected in the session list')
    log('rename OK')

    client.send({ type: 'session.rename', sessionId: createdId, title: '   ' })
    const badRename = await nextOfType(client, 'error')
    expect(badRename.code === 'bad-request', `empty title should be bad-request, got ${badRename.code}`)
    log('rename validation OK')

    client.send({ type: 'sessions.search', query: 'Phone test' })
    const searchFrame = await nextOfTypes(client, ['sessions.found', 'error'], 30000)
    if (searchFrame.type === 'error') {
      expect(searchFrame.code === 'unavailable', `unexpected search error: ${searchFrame.code} ${searchFrame.message}`)
      log('search disabled by this deployment config (graceful unavailable)')
    } else {
      expect(searchFrame.query === 'Phone test', 'search echoed the wrong query')
      expect(Array.isArray(searchFrame.results), 'search results must be an array')
      expect(typeof searchFrame.hasMore === 'boolean', 'search must report hasMore')
      log(`search OK (${searchFrame.results.length} results)`)
    }

    client.send({ type: 'session.pin', sessionId: createdId })
    const pinned = await nextOfType(client, 'session.pinned')
    expect(pinned.sessionId === createdId && pinned.pinned === true, 'pin did not take effect')
    const pinnedList = await nextOfType(client, 'sessions')
    expect(pinnedList.sessions.some((item) => item.id === createdId && item.pinned === true), 'pinned session not annotated in the list')
    client.send({ type: 'session.unpin', sessionId: createdId })
    const unpinned = await nextOfType(client, 'session.pinned')
    expect(unpinned.pinned === false, 'unpin did not take effect')
    log('pin/unpin OK')

    client.send({ type: 'session.archive', sessionId: createdId })
    const archived = await nextOfType(client, 'session.archived')
    expect(archived.sessionId === createdId && archived.archived === true, 'archive did not take effect')
    const archivedList = await nextOfType(client, 'sessions')
    expect(archivedList.sessions.some((item) => item.id === createdId && item.archived === true), 'archived session should stay listed and be annotated')
    client.send({ type: 'session.unarchive', sessionId: createdId })
    const unarchived = await nextOfType(client, 'session.archived')
    expect(unarchived.archived === false, 'unarchive did not take effect')
    log('archive/unarchive OK')

    client.send({ type: 'sessions.list' })
    const listed = await nextOfType(client, 'sessions')
    expect(listed.sessions.some((item) => item.id === createdId), 'new session missing from sessions.list')
    const cold = listed.sessions.find((item) => item.agentAvailable === false)
    if (cold) {
      client.send({ type: 'queue.list', sessionId: cold.id })
      const notLive = await nextOfType(client, 'error')
      expect(notLive.code === 'not-live', `queue.list on a cold session should be not-live, got ${notLive.code}`)
      log('cold live-only guard OK')
    } else {
      log('cold live-only guard skipped (no cold session available)')
    }
    client.send({ type: 'stop', sessionId: createdId })
    // Leave no clutter behind: archive the throwaway session this check created.
    client.send({ type: 'session.archive', sessionId: createdId })
    const cleaned = await nextOfType(client, 'session.archived')
    expect(cleaned.archived === true, 'cleanup archive did not take effect')
    log('throwaway session archived for cleanup')
    log(`sessions.list OK (${listed.sessions.length} sessions)`)

    console.log('PASS live session features (rename/search/pin/archive/guards)')
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
