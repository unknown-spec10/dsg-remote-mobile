// Live check for Batch C3 against the INSTALLED plugin: context meter, changed
// files + diff, and the allow-listed command palette. Creates one throwaway
// session in a fresh temp directory, asks the model to write and then edit a
// file (sandboxed workspace write), and verifies the frames. Costs one small
// model turn. Revokes its own device; leaves the temp session cold.
import { readFileSync, mkdtempSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = 'http://127.0.0.1:3456'
const key = readFileSync(join(homedir(), '.dsh', 'remote-mobile-state.json.desk-key'), 'utf8').trim()
const log = (...args) => console.log('[changes]', ...args)
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
async function waitFor(client, predicate, label, timeoutMs = 180000) {
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
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-rm-changes-'))
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
    log(`ready: ${ready.type} device=${ready.device?.id ?? '?'}`)
    deviceId = ready.device?.id ?? null
    client.send({ type: 'sessions.create', cwd: workspace })
    const created = await waitFor(client, (frame) => frame.type === 'sessions', 'session creation')
    sessionId = created.activeSessionId
    expect(typeof sessionId === 'string', 'session was not created')
    log(`session: ${sessionId} cwd=${workspace}`)

    client.send({
      type: 'prompt',
      sessionId,
      requestId: randomUUID(),
      text: 'Use the write tool to create a file named hello.txt in the current working directory containing the text one. Do not explain; just call the write tool once.',
    })
    // The write may need an explicit sandbox escalation on this deployment; if the
    // Host asks, approve it from the phone so the turn can finish and the
    // workspace recorder runs. Some turns write without asking, so accept either.
    let approved = false
    {
      const deadline = Date.now() + 180000
      for (;;) {
        const remaining = Math.max(1, deadline - Date.now())
        const frame = await client.next(remaining)
        log(`frame: ${frame.type} ${frame.sessionId ?? ''} ${frame.code ?? ''} ${frame.outcome ?? ''}`)
        if (frame.type === 'approval.request' && frame.sessionId === sessionId) {
          approved = true
          log(`approval: tool=${frame.toolName} kind=${frame.argsKind ?? '-'}`)
          client.send({ type: 'approval.answer', requestId: frame.requestId, decision: 'allow' })
          continue
        }
        if (frame.type === 'approval.resolved' && approved) {
          log(`approval: ${frame.outcome}`)
          continue
        }
        if (frame.type === 'error' && frame.sessionId === sessionId) {
          throw new Error(`turn failed: ${frame.code} ${frame.message}`)
        }
        if (frame.type === 'assistant.end' && frame.sessionId === sessionId) break
        if (Date.now() >= deadline) throw new Error('timed out waiting for the turn to finish')
      }
    }
    log('turn ended')
    await new Promise((resolve) => setTimeout(resolve, 800))

    client.send({ type: 'context.get', sessionId })
    const context = await waitFor(client, (frame) => frame.type === 'context' && frame.sessionId === sessionId, 'context frame')
    expect(typeof context.usedTokens === 'number' && context.usedTokens > 0, 'context meter should report used tokens after a turn')
    expect(context.basis === 'usage' || context.basis === 'estimated', `unexpected context basis: ${context.basis}`)
    log(`context: used=${context.usedTokens} window=${context.contextWindow} basis=${context.basis}`)

    client.send({ type: 'changes.list', sessionId })
    const changes = await waitFor(client, (frame) => frame.type === 'changes' && frame.sessionId === sessionId, 'changes frame')
    expect(Array.isArray(changes.items) && changes.items.length > 0, 'no workspace/changes events were reported')
    const serialized = JSON.stringify(changes)
    const leaks = ['C:', '\\\\Users', '/Users', 'dsh-rm-changes-'].filter((needle) => serialized.includes(needle))
    expect(leaks.length === 0, `changed-file payload leaked an absolute path (${leaks.join(', ')})`)
    const available = changes.items.filter((item) => item.available)
    expect(available.length > 0, 'no live change summary was available')
    const entry = available[available.length - 1]
    const file = (entry.files ?? []).find((item) => String(item.path).includes('hello.txt') || String(item.display).includes('hello.txt'))
    expect(file, `hello.txt missing from the change summary: ${JSON.stringify(entry.files)}`)
    log(`changes: seq=${entry.seq} files=${entry.files.length} hello index=${file.index} +${file.added} -${file.deleted}`)

    client.send({ type: 'changes.diff', sessionId, seq: entry.seq, index: file.index })
    const diff = await waitFor(client, (frame) => frame.type === 'changes.diff' && frame.sessionId === sessionId, 'changes.diff frame')
    expect(diff.kind === 'text', `expected a text diff, got ${diff.kind}`)
    expect(Array.isArray(diff.hunks) && diff.hunks.length > 0, 'diff has no hunks')
    const lines = diff.hunks.flatMap((hunk) => hunk.lines)
    expect(lines.some((line) => String(line).startsWith('+')), 'diff has no added lines')
    log(`diff: kind=text hunks=${diff.hunks.length} lines=${lines.length}`)

    client.send({ type: 'commands.list', sessionId })
    const commands = await waitFor(client, (frame) => frame.type === 'commands' && frame.sessionId === sessionId, 'commands frame')
    expect(typeof commands.available === 'boolean', 'commands frame must report availability')
    if (commands.available && commands.items.some((item) => item.name === 'compact')) {
      client.send({ type: 'commands.execute', sessionId, line: '/compact' })
      const result = await waitFor(
        client,
        (frame) => frame.type === 'command.result' || frame.type === 'error',
        'command result',
      )
      if (result.type === 'command.result') {
        expect(result.name === 'compact', `unexpected command result: ${JSON.stringify(result)}`)
        log(`command: compact ${result.kind}`)
      } else {
        expect(result.code === 'bad-request' || result.code === 'not-live', `unexpected command error: ${result.code} ${result.message}`)
        log(`command: compact rejected (${result.code}) — acceptable, logged for review`)
      }
    } else {
      log(`commands: allowlist not available here (${commands.reason ?? 'no compact'})`)
    }

    client.send({ type: 'stop', sessionId })
    console.log('PASS live context meter + changed files + command palette')
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
