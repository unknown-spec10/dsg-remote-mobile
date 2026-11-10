// Transport-level smoke test for the standalone mobile server.
// Runs without DSH: the bridge is a stub. Verifies pairing, cookies, rate
// limiting, desktop API, WebSocket framing and approval round-tripping.
// Usage: node dev/server-smoke.mjs
import { createRequire } from 'node:module'
import { request as httpRequest } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'rm-smoke-'))

import { RemoteMobileServer } from '../server.js'
import { createBridge } from '../bridge.js'
import { createAuth } from '../auth.js'

const require = createRequire(import.meta.url)

function log() {
  const prefix = '[smoke]'
  return {
    info: (...args) => console.log(prefix, ...args),
    warn: (...args) => console.warn(prefix, ...args),
    error: (...args) => console.error(prefix, ...args),
  }
}

function fakeBridge() {
  const handlers = {}
  const calls = []
  const workspace = { pinned: false, archived: false }
  const queue = [{ id: 'q1', placement: 'queued', text: 'queued text' }]
  const sessionOf = (id) => ({
    id,
    title: id === 's1' ? 'Smoke session' : 'New session',
    running: true,
    updatedAt: Date.now(),
    preset: 'standard',
    model: id === 's1' ? { provider: 'deepseek', model: 'deepseek-v4.1-flash' } : null,
    pinned: workspace.pinned,
    archived: workspace.archived,
    agentAvailable: true,
    workspaceId: 'ws1',
  })
  const workspaces = [
    { id: 'ws1', title: 'Project One', path: '/projects/one', sessionIds: ['s1'] },
    { id: 'ws2', title: 'Project Two', path: '/projects/two', sessionIds: [] },
  ]
  const bridge = {
    calls,
    handlers,
    workspace,
    queue,
    async listSessions() {
      calls.push(['listSessions'])
      return [sessionOf('s1')]
    },
    async listWorkspaces() {
      calls.push(['listWorkspaces'])
      return workspaces
    },
    async openSession(id) {
      calls.push(['openSession', id])
      return {
        session: sessionOf(id),
        history: [{ id: 'seq:1', kind: 'user', text: 'hello', ts: Date.now() }],
        queue: queue.slice(),
        context: {
          usedTokens: 1234,
          pressureTokens: 1200,
          projectedTokens: 1234,
          contextWindow: 64000,
          basis: 'usage',
          tokenUsage: { inputTokens: 900, outputTokens: 100, totalTokens: 1000, reasoningTokens: null },
        },
      }
    },
    async contextFor(id) {
      calls.push(['contextFor', id])
      if (id !== 's1') {
        return { ok: false, error: 'invalid sessionId', errorCode: 'bad-request' }
      }
      return {
        ok: true,
        sessionId: id,
        usedTokens: 1234,
        pressureTokens: 1200,
        projectedTokens: 1234,
        contextWindow: 64000,
        basis: 'usage',
        tokenUsage: { inputTokens: 900, outputTokens: 100, totalTokens: 1000, reasoningTokens: null },
      }
    },
    async changesList(id) {
      calls.push(['changesList', id])
      return {
        ok: true,
        sessionId: id,
        items: [{
          seq: 7,
          available: true,
          turn: 2,
          total: 1,
          added: 8,
          deleted: 1,
          files: [{ index: 0, path: 'src/app.ts', display: 'src/app.ts', added: 8, deleted: 1, binary: false, oversized: false }],
        }],
      }
    },
    async changesDiff(id, seq, index) {
      calls.push(['changesDiff', id, seq, index])
      if (seq !== 7) {
        return { ok: false, error: 'this change is no longer available (the session is not live on this Host)', errorCode: 'unavailable' }
      }
      return {
        ok: true,
        sessionId: id,
        seq,
        index,
        kind: 'text',
        path: 'src/app.ts',
        coarse: false,
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' context', '+added'] }],
      }
    },
    async listCommands(id) {
      calls.push(['listCommands', id])
      return {
        ok: true,
        sessionId: id,
        available: true,
        items: [
          { name: 'compact', description: 'Compact older conversation history', hint: null, attachments: false },
          { name: 'feedback', description: 'Record feedback about this session', hint: '<text>', attachments: false },
          { name: 'goal', description: 'Set or view the goal for a long-running task', hint: '[<objective>|clear]', attachments: true },
          { name: 'plan', description: 'Enter or leave plan mode', hint: '[off|message]', attachments: true },
        ],
      }
    },
    async executeCommand(id, line) {
      calls.push(['executeCommand', id, line])
      const name = line.trim().replace(/^\//, '').split(/\s+/)[0]
      if (!['compact', 'feedback', 'goal', 'plan'].includes(name)) {
        return { ok: false, error: 'this command is not available from the phone', errorCode: 'forbidden' }
      }
      return {
        ok: true,
        sessionId: id,
        commandId: 'cmd-1',
        name,
        kind: 'success',
        text: name === 'compact' ? 'Compacted.' : null,
        sourceEventSeq: null,
      }
    },
    async createSession({ preset } = {}) {
      calls.push(['createSession', preset])
      return { id: 's2', title: 'New session', running: false, preset: preset ?? 'standard', model: null }
    },
    async history(id, opts) {
      calls.push(['history', id, opts])
      return [{ id: 'seq:2', kind: 'assistant', text: 'hi there', ts: Date.now() }]
    },
    async prompt(id, text, requestId, attachments, mode) {
      calls.push(['prompt', id, text, requestId, mode, attachments])
      // Emulate the Host rejecting a steer while the turn is idle.
      if (mode === 'steer' && text === 'steer me') {
        return { ok: false, error: 'the running turn no longer accepts steering', errorCode: 'bad-request' }
      }
    },
    async renameSession(id, title) {
      calls.push(['renameSession', id, title])
      if (typeof title !== 'string' || title.trim().length === 0) {
        return { ok: false, error: 'a title needs at least one visible character', errorCode: 'bad-request' }
      }
      return { ok: true, sessionId: id, title: title.trim(), seq: 7 }
    },
    async forkSession(id, atSeq) {
      calls.push(['forkSession', id, atSeq])
      return { ok: true, sessionId: 's2', sourceSessionId: id }
    },
    async searchSessions(query) {
      calls.push(['searchSessions', query])
      return {
        ok: true,
        query,
        results: [{ id: 's1', title: 'Smoke session', snippet: 'hello there', updatedAt: 1 }],
        hasMore: false,
      }
    },
    async setSessionPinned(id, pinned) {
      calls.push(['setSessionPinned', id, pinned])
      workspace.pinned = pinned === true
      return { ok: true, sessionId: id, pinned: workspace.pinned, archived: workspace.archived }
    },
    async setSessionArchived(id, archived, stopActivity) {
      calls.push(['setSessionArchived', id, archived, stopActivity])
      workspace.archived = archived === true
      return { ok: true, sessionId: id, pinned: workspace.pinned, archived: workspace.archived }
    },
    async listQueue(id) {
      calls.push(['listQueue', id])
      if (id !== 's1') {
        return { ok: false, error: 'this session is not live on the Host; open it first', errorCode: 'not-live' }
      }
      return { ok: true, sessionId: id, items: queue.slice(), pendingInput: [], running: true, active: true }
    },
    async updateQueue(id, itemId, action, text) {
      calls.push(['updateQueue', id, itemId, action, text])
      if (action === 'remove') {
        for (let i = queue.length - 1; i >= 0; i -= 1) if (queue[i].id === itemId) queue.splice(i, 1)
      } else if (action === 'edit') {
        for (const item of queue) if (item.id === itemId) item.text = text
      }
      return { ok: true, sessionId: id, items: queue.slice() }
    },
    async listModels() {
      calls.push(['listModels'])
      return {
        catalog: [{
          provider: 'deepseek',
          model: 'deepseek-v4.1-flash',
          label: 'V4.1 Flash',
          reasoning: {
            efforts: [
              { id: 'low', name: 'Low', description: 'Faster' },
              { id: 'high', name: 'High', description: 'Deeper' },
            ],
            defaultEffort: 'high',
          },
        }],
        current: { provider: 'deepseek', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
      }
    },
    async imageLimits() {
      calls.push(['imageLimits'])
      return {
        image: {
          maxBytes: 2621440,
          maxDimension: 4096,
          maxImages: 2,
          maxMessageBytes: 5242880,
          mediaTypes: ['image/png', 'image/jpeg'],
        },
      }
    },
    async selectModel(id, selection) {
      calls.push(['selectModel', id, selection])
    },
    async listPresets() {
      calls.push(['listPresets'])
      return { presets: [{ id: 'standard', title: 'Standard', description: '' }], current: 'standard' }
    },
    async selectPreset(id, preset) {
      calls.push(['selectPreset', id, preset])
    },
    async answerApproval(requestId, decision) {
      calls.push(['answerApproval', requestId, decision])
      const accepted = typeof requestId === 'string' && requestId.startsWith('req-')
      // The real bridge resolves the pending promise and reports the settlement
      // through the onApprovalResolved callback; the server forwards that frame.
      if (accepted) handlers.onApprovalResolved?.({ sessionId: 's1', requestId, outcome: decision === 'allow' ? 'allowed-once' : 'rejected' })
      return accepted
    },
    subscribe(next) {
      Object.assign(handlers, next)
      return () => {
        for (const key of Object.keys(handlers)) delete handlers[key]
      }
    },
    dispose() {},
  }
  return bridge
}

function httpJson(base, path, { method = 'GET', body, cookie, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base)
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method,
      headers: {
        ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        ...(cookie === undefined ? {} : { cookie }),
        ...headers,
      },
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let data = null
        try {
          data = text.length === 0 ? null : JSON.parse(text)
        } catch {
          data = text
        }
        resolve({ status: res.statusCode, headers: res.headers, data })
      })
    })
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

/** Minimal masked text WebSocket client for the smoke test. */
function openSocket(url) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const key = randomBytes(16).toString('base64')
    const req = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    })
    req.on('upgrade', (res, socket, head) => {
        if (head && head.length > 0) socket.unshift(head)
      const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
      assert.equal(res.headers['sec-websocket-accept'], accept, 'websocket accept header')
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
          if (opcode === 0x9) {
            socket.write(Buffer.from([0x8a, 0]))
            continue
          }
          if (opcode === 0x8) {
            socket.end()
            return
          }
          if (opcode === 0x1) push(JSON.parse(payload.toString('utf8')))
        }
      })
      const client = {
        socket,
        next: (timeoutMs = 3000) => new Promise((res, rej) => {
          if (queue.length > 0) {
            res(queue.shift())
            return
          }
          const timer = setTimeout(() => rej(new Error('websocket message timeout')), timeoutMs)
          waiters.push((value) => {
            clearTimeout(timer)
            res(value)
          })
        }),
        send: (value) => {
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
          socket.write(Buffer.concat([header, mask, masked]))
        },
        close: () => socket.end(),
      }
      resolve(client)
    })
    req.on('error', reject)
    req.end()
  })
}

/**
 * Bridge-level checks for Batch D (inline image attachments).
 *
 * Uses a fake Cordis context so the real bridge builds the prompt content:
 * a stored phone image must become a real `{type:'image',mediaType,data}`
 * part in addition to the path-reference text, and a Host rejection must fall
 * back to a text-only retry.
 */
async function runBridgeImageChecks() {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const base = mkdtempSync(join(tmpdir(), 'rm-image-'))
  const uploadDir = join(base, 'var', 'remote-mobile-uploads')
  await mkdir(uploadDir, { recursive: true })
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
  const imagePath = join(uploadDir, 'photo.png')
  const filePath = join(uploadDir, 'notes.txt')
  await writeFile(imagePath, imageBytes)
  await writeFile(filePath, 'notes')

  const calls = []
  let rejectImagesOnce = false
  let historyText = ''
  const agent = { id: 's1', session: { id: 's1', header: {} } }
  const controller = {
    async prompt(request) {
      calls.push(request)
      const hasImage = Array.isArray(request.content) && request.content.some((part) => part.type === 'image')
      if (hasImage && rejectImagesOnce) {
        rejectImagesOnce = false
        const error = new Error('inline image rejected by test Host')
        error.code = 'session/attachment-invalid'
        throw error
      }
      return { accepted: true }
    },
    async events() {
      return {
        records: [{
          type: 'event',
          event: {
            type: 'user/message',
            seq: 0,
            time: 1,
            data: { source: { kind: 'user' }, content: [{ type: 'text', text: historyText }] },
          },
        }],
      }
    },
  }
  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    get(name) {
      if (name === 'sessionController') return controller
      if (name === 'agents') return { get(id) { return id === 's1' ? agent : undefined } }
      if (name === 'workingDirectory') return { get() { return base } }
      return undefined
    },
  }
  const bridge = createBridge(ctx, {})

  // 1 image + 1 text file: text part mentions the file path, image part is base64.
  const result = await bridge.prompt('s1', 'look at this', 'r1', [
    { path: imagePath, name: 'photo.png', mediaType: 'image/png' },
    { path: filePath, name: 'notes.txt', mediaType: 'text/plain' },
  ])
  assert.equal(result, undefined, 'image prompt should succeed')
  let content = calls.at(-1).content
  assert.equal(content.length, 2, 'expected text + image parts')
  assert.equal(content[0].type, 'text')
  assert.match(content[0].text, /look at this/)
  assert.match(content[0].text, /Attached files from the user's phone/)
  assert.match(content[0].text, /notes\.txt/)
  assert.match(content[0].text, /Attached images from the user's phone/)
  assert.equal(content[1].type, 'image')
  assert.equal(content[1].mediaType, 'image/png')
  assert.equal(content[1].data, imageBytes.toString('base64'))

  // History still yields clean text plus structured attachment metadata.
  historyText = content[0].text
  const historyItems = await bridge.history('s1')
  assert.equal(historyItems.length, 1)
  assert.equal(historyItems[0].kind, 'user')
  assert.equal(historyItems[0].text, 'look at this')
  assert.equal(historyItems[0].attachments.length, 2)
  assert.ok(historyItems[0].attachments.some((item) =>
    item.path === imagePath && item.name === 'photo.png' && item.mediaType === 'image/png'))
  assert.ok(historyItems[0].attachments.some((item) =>
    item.path === filePath && item.name === 'notes.txt' && item.mediaType === 'text/plain'))

  // Image-only prompt: no user text is fabricated; the image part is still sent.
  await bridge.prompt('s1', '', 'r2', [{ path: imagePath, name: 'photo.png', mediaType: 'image/png' }])
  content = calls.at(-1).content
  assert.equal(content.length, 2)
  assert.equal(content[0].type, 'text')
  assert.match(content[0].text, /Attached images from the user's phone/)
  assert.equal(content[1].type, 'image')

  // Host rejection: exactly one retry, text-only, same request id.
  rejectImagesOnce = true
  const beforeRetry = calls.length
  await bridge.prompt('s1', 'again', 'r3', [{ path: imagePath, name: 'photo.png', mediaType: 'image/png' }])
  assert.equal(calls.length, beforeRetry + 2, 'expected one rejected attempt plus one retry')
  const retried = calls.at(-1)
  assert.equal(retried.requestId, 'r3')
  assert.equal(retried.content.length, 1)
  assert.equal(retried.content[0].type, 'text')
  assert.match(retried.content[0].text, /Attached files from the user's phone/)
  assert.ok(!retried.content.some((part) => part.type === 'image'), 'retry must not carry image parts')

  // No attachments service in this fake context: limits are simply unavailable.
  assert.equal(bridge.imageLimits(), null)

  // Deployment limits clamp the inline policy (count + per-image bytes) and are
  // advertised to the SPA in the `{ image: {...} }` shape.
  const cappedCalls = []
  const cappedBridge = createBridge({
    logger: { warn() {}, info() {}, error() {} },
    get(name) {
      if (name === 'sessionController') {
        return { async prompt(request) { cappedCalls.push(request); return { accepted: true } } }
      }
      if (name === 'agents') return { get(id) { return id === 's1' ? agent : undefined } }
      if (name === 'workingDirectory') return { get() { return base } }
      if (name === 'attachments') {
        return {
          imageLimits: {
            maxImageBytes: 64,
            maxMessageImageBytes: 64,
            maxImagesPerMessage: 1,
            maxImageDimension: 512,
            mediaTypes: ['image/png'],
          },
        }
      }
      return undefined
    },
  })
  const secondImagePath = join(uploadDir, 'photo2.png')
  await writeFile(secondImagePath, imageBytes)
  await cappedBridge.prompt('s1', 'two images', 'r5', [
    { path: imagePath, name: 'photo.png', mediaType: 'image/png' },
    { path: secondImagePath, name: 'photo2.png', mediaType: 'image/png' },
  ])
  const cappedContent = cappedCalls.at(-1).content
  assert.equal(cappedContent.filter((part) => part.type === 'image').length, 1, 'image-count cap applies')
  assert.match(cappedContent[0].text, /Attached files from the user's phone/)
  assert.match(cappedContent[0].text, /photo2\.png/)
  const cappedLimits = cappedBridge.imageLimits()
  assert.equal(cappedLimits.image.maxImages, 1)
  assert.equal(cappedLimits.image.maxBytes, 64)
  assert.deepEqual(cappedLimits.image.mediaTypes, ['image/png'])

  // An image over the per-image byte cap keeps only its path reference.
  const oversizedPath = join(uploadDir, 'oversized.png')
  await writeFile(oversizedPath, Buffer.alloc(128, 7))
  await cappedBridge.prompt('s1', 'too big', 'r6', [
    { path: oversizedPath, name: 'oversized.png', mediaType: 'image/png' },
  ])
  assert.ok(!cappedCalls.at(-1).content.some((part) => part.type === 'image'), 'oversized image must stay textual')
  cappedBridge.dispose()

  bridge.dispose()
  console.log('PASS bridge image attachment checks')
}

/**
 * Bridge-level checks for Batch E approval context (callId → scrubbed preview).
 * Uses the real bridge with a fake Cordis context: a `tool/call` event seen
 * before the approval must produce bounded, secret-free card context; an unknown
 * callId must omit it.
 */
async function runApprovalContextChecks() {
  const listeners = new Map()
  const approvals = []
  const agent = { id: 's1', session: { id: 's1', header: {} } }
  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    get() { return undefined },
    on(name, callback) {
      listeners.set(name, callback)
      return () => listeners.delete(name)
    },
  }
  const bridge = createBridge(ctx, { hasApprovalPeers: () => true })
  const unsubscribe = bridge.subscribe({ onApproval: (payload) => approvals.push(payload) })
  const emitSessionEvent = (event) => listeners.get('session/event')({ id: 's1', header: {} }, event)
  const settle = async (requestId, decision = 'reject') => bridge.answerApproval(requestId, decision)
  const ask = async (request) => {
    const before = approvals.length
    const promise = listeners.get('approval/request')(request, () => Promise.resolve('unavailable'))
    for (let index = 0; index < 50 && approvals.length === before; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    return { payload: approvals.at(-1), promise }
  }

  // Shell command carrying secret-looking arguments: command shown, secrets dropped.
  emitSessionEvent({
    type: 'tool/call',
    seq: 1,
    time: 1,
    data: {
      turn: 1,
      step: 1,
      callId: 'call-shell',
      name: 'pwsh',
      arguments: JSON.stringify({ command: 'echo hi', password: 'hunter2', apiKey: 'sk-live-123' }),
    },
  })
  let result = await ask({ agent, toolName: 'pwsh', callId: 'call-shell', reason: 'run command' })
  assert.equal(result.payload.argsKind, 'command')
  assert.match(result.payload.argsPreview, /echo hi/)
  assert.ok(!result.payload.argsPreview.includes('hunter2'), 'password value must not be cached')
  assert.ok(!result.payload.argsPreview.includes('sk-live-123'), 'api key value must not be cached')
  assert.deepEqual(result.payload.detail, { kind: 'command' })
  await settle(result.payload.requestId)
  assert.equal(await result.promise, 'rejected')

  // Unknown callId: all additive fields omitted.
  result = await ask({ agent, toolName: 'read', callId: 'never-seen', reason: 'read a file' })
  assert.equal(result.payload.argsPreview, undefined)
  assert.equal(result.payload.argsKind, undefined)
  assert.equal(result.payload.detail, undefined)
  await settle(result.payload.requestId, 'allow')
  await result.promise

  // File write: path only, never the payload content.
  emitSessionEvent({
    type: 'tool/call',
    seq: 2,
    time: 2,
    data: {
      turn: 1,
      step: 1,
      callId: 'call-write',
      name: 'write',
      arguments: JSON.stringify({ path: 'notes/todo.md', content: 'TOP SECRET BODY' }),
    },
  })
  result = await ask({ agent, toolName: 'write', callId: 'call-write' })
  assert.equal(result.payload.argsKind, 'write')
  assert.equal(result.payload.detail.path, 'notes/todo.md')
  assert.ok(!result.payload.argsPreview.includes('TOP SECRET BODY'), 'write body must not be previewed')
  await settle(result.payload.requestId)
  await result.promise

  // Edit: path plus a bounded diff head.
  emitSessionEvent({
    type: 'tool/call',
    seq: 3,
    time: 3,
    data: {
      turn: 1,
      step: 1,
      callId: 'call-edit',
      name: 'str_replace_editor',
      arguments: JSON.stringify({ path: 'src/app.js', old_string: 'const a = 1', new_string: 'const a = 2' }),
    },
  })
  result = await ask({ agent, toolName: 'str_replace_editor', callId: 'call-edit' })
  assert.equal(result.payload.argsKind, 'edit')
  assert.equal(result.payload.detail.path, 'src/app.js')
  assert.match(result.payload.argsPreview, /src\/app\.js/)
  assert.match(result.payload.argsPreview, /- const a = 1/)
  assert.match(result.payload.argsPreview, /\+ const a = 2/)
  await settle(result.payload.requestId)
  await result.promise

  // Long commands are bounded at ~600 characters.
  emitSessionEvent({
    type: 'tool/call',
    seq: 4,
    time: 4,
    data: {
      turn: 1,
      step: 1,
      callId: 'call-long',
      name: 'bash',
      arguments: JSON.stringify({ command: `echo ${'x'.repeat(2000)}` }),
    },
  })
  result = await ask({ agent, toolName: 'bash', callId: 'call-long' })
  assert.ok(result.payload.argsPreview.length <= 600, 'preview must be bounded')
  await settle(result.payload.requestId)
  await result.promise

  unsubscribe()
  bridge.dispose()
  console.log('PASS approval context checks')
}

async function main() {
  await runBridgeImageChecks()
  await runApprovalContextChecks()
  const bridge = fakeBridge()
  const ctx = { logger: log() }
  const server = new RemoteMobileServer(ctx, { enabled: true, host: '127.0.0.1', port: 0 }, bridge, log())
  await server.start()
  const base = `http://127.0.0.1:${server.port}`
  console.log('server:', base)

  try {
    const health = await httpJson(base, '/api/health')
    assert.equal(health.status, 200)
    assert.equal(health.data.ok, true)

    const state = await httpJson(base, '/api/state')
    assert.equal(state.data.paired, false)

    // --- Web Push surface: public VAPID key, cookie-gated subscription API. ---
    const pushKey = await httpJson(base, '/api/push/key')
    assert.equal(pushKey.status, 200, `push key: ${JSON.stringify(pushKey.data)}`)
    assert.equal(pushKey.data.enabled, true)
    assert.match(pushKey.data.publicKey, /^[A-Za-z0-9_-]+$/)
    const vapidRaw = Buffer.from(pushKey.data.publicKey, 'base64url')
    assert.equal(vapidRaw.length, 65, 'VAPID public key must be a raw 65-byte P-256 point')
    assert.equal(vapidRaw[0], 4)
    const pushSubscribeNoAuth = await httpJson(base, '/api/push/subscribe', {
      method: 'POST',
      body: { subscription: { endpoint: 'https://push.example.test/x', keys: { p256dh: 'x', auth: 'y' } } },
    })
    assert.equal(pushSubscribeNoAuth.status, 401, 'push subscribe requires the paired-device cookie')
    const pushTestNoAuth = await httpJson(base, '/api/push/test', { method: 'POST', body: {} })
    assert.equal(pushTestNoAuth.status, 401, 'push test requires the paired-device cookie')

    const desktop = await httpJson(base, `/api/desktop/status?key=${server.deskKey}`)
    assert.equal(desktop.status, 200, `desktop status: ${JSON.stringify(desktop.data)}`)
    assert.match(desktop.data.pin, /^\d{4}$/)
    assert.match(desktop.data.url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=/)
    assert.ok(desktop.data.qrSvg.startsWith('<svg'))

    const forbidden = await httpJson(base, '/api/desktop/status?key=wrong', { headers: { origin: 'https://evil.example' } })
    assert.equal(forbidden.status, 403, 'a non-loopback origin must not read pairing data')
    const loopbackNoKey = await httpJson(base, '/api/desktop/status')
    assert.equal(loopbackNoKey.status, 200, 'the loopback desktop page may read pairing data without a key')

    const pin = desktop.data.pin
    // Wrong PINs trip the limiter after five attempts.
    for (let i = 0; i < 5; i += 1) {
      const bad = await httpJson(base, '/api/pair', { method: 'POST', body: { pin: '0000' === pin ? '1111' : '0000' } })
      assert.equal(bad.status, 401)
    }
    const limited = await httpJson(base, '/api/pair', { method: 'POST', body: { pin } })
    assert.equal(limited.status, 429, 'rate limit should reject after five failures')

    // Restart-free unlock: rotating the PIN clears nothing, but a new IP window would.
    // The smoke test only asserts the limiter works; pairing uses the token instead.
    const fresh = await httpJson(base, `/api/desktop/status?key=${server.deskKey}`)
    const token = new URL(fresh.data.url).searchParams.get('t')
    const paired = await httpJson(base, '/api/pair', { method: 'POST', body: { token } })
    assert.equal(paired.status, 200, `pair: ${JSON.stringify(paired.data)}`)
    const cookiePair = paired.headers['set-cookie']
    const cookie = (Array.isArray(cookiePair) ? cookiePair[0] : cookiePair).split(';')[0]
    assert.match(cookie, /^dsh_rm_session=/)
    const again = await httpJson(base, '/api/pair', { method: 'POST', body: { token } })
    assert.equal(again.status, 401, 'pairing token must be single use')

    const authed = await httpJson(base, '/api/state', { cookie })
    assert.equal(authed.data.paired, true)

    // Invalid subscription shapes are a client error, never a stored record.
    const pushBadShape = await httpJson(base, '/api/push/subscribe', {
      method: 'POST',
      cookie,
      body: { subscription: { endpoint: 'not-a-url', keys: { p256dh: 'x', auth: 'y' } } },
    })
    assert.equal(pushBadShape.status, 400)
    assert.equal(pushBadShape.data.error, 'invalid-subscription')
    // No subscriptions yet: push.test is a no-op that touches no network.
    const pushEmptyTest = await httpJson(base, '/api/push/test', { method: 'POST', cookie, body: {} })
    assert.equal(pushEmptyTest.status, 200, `push test: ${JSON.stringify(pushEmptyTest.data)}`)
    assert.equal(pushEmptyTest.data.sent, 0)
    assert.equal(pushEmptyTest.data.gone, 0)
    assert.equal(pushEmptyTest.data.ok, false)

    // Unauthenticated upgrades must be refused.
    await new Promise((resolve, reject) => {
      const req = httpRequest({
        hostname: '127.0.0.1',
        port: server.port,
        path: '/ws',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
          'Sec-WebSocket-Version': '13',
        },
      })
      req.on('response', (res) => {
        try {
          assert.equal(res.statusCode, 401)
          res.resume()
          resolve()
        } catch (error) {
          reject(error)
        }
      })
      req.on('upgrade', () => reject(new Error('unauthenticated upgrade was accepted')))
      req.on('error', reject)
      req.end()
    })

    const authedWs = await new Promise((resolve, reject) => {
      const target = new URL(`ws://127.0.0.1:${server.port}/ws`)
      const key = randomBytes(16).toString('base64')
      const req = httpRequest({
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13',
          Cookie: cookie,
        },
      })
      req.on('response', (res) => reject(new Error(`upgrade refused: ${res.statusCode}`)))
      req.on('upgrade', (res, socket, head) => {
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
        const client = {
          next: (timeoutMs = 3000) => new Promise((res, rej) => {
            if (queue.length > 0) {
              res(queue.shift())
              return
            }
            const timer = setTimeout(() => rej(new Error('ws timeout')), timeoutMs)
            waiters.push((value) => {
              clearTimeout(timer)
              res(value)
            })
          }),
          send: (value) => {
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
            socket.write(Buffer.concat([header, mask, masked]))
          },
          close: () => socket.end(),
        }
        resolve(client)
      })
      req.on('error', reject)
      req.end()
    })

    // Skip unrelated pushes so a design-driven background frame (for example the
    // session-list refresh sent after an approval arrives) cannot fail an
    // assertion about a different frame.
    const nextOfType = async (client, type, timeoutMs = 3000) => {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const remaining = Math.max(1, deadline - Date.now())
        const frame = await client.next(remaining)
        if (frame && frame.type === type) return frame
        if (Date.now() >= deadline) throw new Error(`timed out waiting for ${type}`)
      }
    }

    const ready = await authedWs.next()
    assert.equal(ready.type, 'ready')
    assert.equal(ready.device.canApprove, true, 'ready.device should expose canApprove')
    assert.equal(ready.limits.image.maxImages, 2, 'ready should advertise image limits')
    assert.equal(ready.limits.image.maxBytes, 2621440)
    assert.ok(Array.isArray(ready.workspaces), 'ready should carry registered workspaces')
    assert.equal(ready.workspaces.length, 2)
    assert.equal(ready.workspaces[0].id, 'ws1')
    assert.equal(ready.workspaces[0].title, 'Project One')
    assert.deepEqual(ready.workspaces[0].sessionIds, ['s1'])

    // The SPA reports page visibility so the server can suppress Web Push while
    // the app is in the foreground. The frame is acknowledged.
    authedWs.send({ type: 'client.visibility', visible: true })
    const visibleFrame = await nextOfType(authedWs, 'visibility')
    assert.equal(visibleFrame.visible, true)
    authedWs.send({ type: 'client.visibility', visible: false })
    const hiddenFrame = await nextOfType(authedWs, 'visibility')
    assert.equal(hiddenFrame.visible, false)

    authedWs.send({ type: 'sessions.list' })
    const sessions = await authedWs.next()
    assert.equal(sessions.type, 'sessions')
    assert.equal(sessions.sessions.length, 1)
    assert.equal(sessions.sessions[0].workspaceId, 'ws1', 'session rows should carry workspaceId')
    assert.ok(Array.isArray(sessions.workspaces), 'sessions frames should carry workspaces')
    assert.equal(sessions.workspaces.length, 2)

    authedWs.send({ type: 'sessions.open', sessionId: 's1' })
    const opened = await authedWs.next()
    assert.equal(opened.type, 'session.opened')
    assert.equal(opened.session.id, 's1')
    assert.ok(Array.isArray(opened.queue) && opened.queue.length === 1, 'session.opened must carry the queue')
    assert.ok(opened.context && opened.context.contextWindow === 64000, 'session.opened must carry the context meter')

    authedWs.send({ type: 'prompt', sessionId: 's1', text: 'do the thing', requestId: 'r1' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.ok(bridge.calls.some((call) => call[0] === 'prompt' && call[1] === 's1'))

    // Streaming frames from the bridge reach the phone.
    bridge.handlers.onAssistant({ sessionId: 's1', phase: 'start', turn: 1, step: 1 })
    bridge.handlers.onAssistant({ sessionId: 's1', phase: 'delta', text: 'hello ' })
    bridge.handlers.onAssistant({ sessionId: 's1', phase: 'delta', text: 'stream' })
    bridge.handlers.onAssistant({ sessionId: 's1', phase: 'end', turn: 1, step: 1 })
    assert.equal((await authedWs.next()).type, 'assistant.start')
    const delta = await authedWs.next()
    assert.equal(delta.type, 'assistant.delta')
    assert.match(delta.text, /hello/)
    assert.equal((await authedWs.next()).type, 'assistant.end')

    bridge.handlers.onTool({ sessionId: 's1', phase: 'start', callId: 'c1', name: 'pwsh', title: 'Run command', argsPreview: 'Get-ChildItem', detail: null })
    const toolStart = await authedWs.next()
    assert.equal(toolStart.type, 'tool.start')
    bridge.handlers.onTool({ sessionId: 's1', phase: 'end', callId: 'c1', ok: true, output: 'ok', durationMs: 5 })
    assert.equal((await authedWs.next()).type, 'tool.end')

    bridge.handlers.onApproval({
      sessionId: 's1',
      requestId: 'req-1',
      toolName: 'pwsh',
      title: 'Approval required',
      reason: 'run command',
      displayReason: null,
      callId: 'c1',
      argsPreview: 'echo hi',
      argsKind: 'command',
      detail: { kind: 'command' },
      expiresAt: 0,
    })
    const approval = await authedWs.next()
    assert.equal(approval.type, 'approval.request')
    assert.equal(approval.requestId, 'req-1')
    assert.equal(approval.argsPreview, 'echo hi')
    assert.equal(approval.argsKind, 'command')
    assert.deepEqual(approval.detail, { kind: 'command' })
    // A new approval makes the server refresh the session list so the SPA can
    // badge the owning session; that push is what the notice bar relies on.
    const refreshed = await nextOfType(authedWs, 'sessions')
    assert.ok(Array.isArray(refreshed.sessions), 'session refresh after approval is malformed')
    authedWs.send({ type: 'approval.answer', requestId: 'req-1', decision: 'allow' })
    const resolved = await nextOfType(authedWs, 'approval.resolved')
    assert.equal(resolved.outcome, 'allowed-once')

    // An approval whose tool call was never correlated omits the additive fields.
    bridge.handlers.onApproval({
      sessionId: 's1',
      requestId: 'req-plain',
      toolName: 'read',
      title: 'Approval required',
      reason: '',
      displayReason: null,
      callId: null,
      expiresAt: 0,
    })
    const plainApproval = await nextOfType(authedWs, 'approval.request')
    assert.equal(plainApproval.argsPreview, undefined)
    assert.equal(plainApproval.argsKind, undefined)
    assert.equal(plainApproval.detail, undefined)
    authedWs.send({ type: 'approval.answer', requestId: 'req-plain', decision: 'reject' })
    const plainResolved = await nextOfType(authedWs, 'approval.resolved')
    assert.equal(plainResolved.outcome, 'rejected')

    authedWs.send({ type: 'model.list' })
    const modelsFrame = await nextOfType(authedWs, 'models')
    assert.equal(modelsFrame.catalog[0].reasoning.efforts.length, 2)
    assert.equal(modelsFrame.catalog[0].reasoning.defaultEffort, 'high')
    assert.equal(modelsFrame.current.reasoningEffort, 'high')

    // Image limits can be requested on demand (Batch D).
    authedWs.send({ type: 'limits' })
    const limitsFrame = await nextOfType(authedWs, 'limits')
    assert.equal(limitsFrame.image.maxImages, 2)
    assert.deepEqual(limitsFrame.image.mediaTypes, ['image/png', 'image/jpeg'])

    // Attachment descriptors are forwarded to the bridge unchanged.
    authedWs.send({
      type: 'prompt',
      sessionId: 's1',
      text: 'photo',
      requestId: 'r4',
      attachments: [{ path: '/tmp/photo.png', name: 'photo.png', mediaType: 'image/png', size: 1 }],
      mode: 'queue',
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.ok(bridge.calls.some((call) => call[0] === 'prompt' && Array.isArray(call[5]) && call[5].length === 1))

    authedWs.send({ type: 'preset.select', sessionId: 's1', preset: 'minimal' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.ok(bridge.calls.some((call) => call[0] === 'selectPreset' && call[2] === 'minimal'))

    // --- Batch C1: session summaries carry workspace/live annotations. ---
    authedWs.send({ type: 'sessions.list' })
    const annotated = await nextOfType(authedWs, 'sessions')
    assert.equal(annotated.sessions[0].pinned, false)
    assert.equal(annotated.sessions[0].archived, false)
    assert.equal(annotated.sessions[0].agentAvailable, true)

    // Rename: ack (`session.updated`) plus a `sessions` refresh.
    authedWs.send({ type: 'session.rename', sessionId: 's1', title: '  Renamed session  ' })
    const updated = await nextOfType(authedWs, 'session.updated')
    assert.equal(updated.sessionId, 's1')
    assert.equal(updated.title, 'Renamed session')
    assert.equal(updated.session.id, 's1')
    await nextOfType(authedWs, 'sessions')
    assert.ok(bridge.calls.some((call) => call[0] === 'renameSession' && call[2].includes('Renamed')))

    // An empty title is a friendly bad-request error, not an internal crash.
    authedWs.send({ type: 'session.rename', sessionId: 's1', title: '   ' })
    const renameError = await nextOfType(authedWs, 'error')
    assert.equal(renameError.code, 'bad-request')

    // Fork: the requester gets the forked session through the normal open path.
    authedWs.send({ type: 'session.fork', sessionId: 's1' })
    const forked = await nextOfType(authedWs, 'session.opened')
    assert.equal(forked.session.id, 's2')
    assert.ok(Array.isArray(forked.history))
    assert.ok(Array.isArray(forked.queue))
    await nextOfType(authedWs, 'sessions')
    assert.ok(bridge.calls.some((call) => call[0] === 'forkSession' && call[1] === 's1'))

    // Literal content search.
    authedWs.send({ type: 'sessions.search', query: 'hello' })
    const found = await nextOfType(authedWs, 'sessions.found')
    assert.equal(found.query, 'hello')
    assert.equal(found.results[0].id, 's1')
    assert.match(found.results[0].snippet, /hello/)
    assert.ok(Array.isArray(found.results))

    // Pin / archive: ack frame then a refreshed annotated `sessions`.
    authedWs.send({ type: 'session.pin', sessionId: 's1' })
    const pinned = await nextOfType(authedWs, 'session.pinned')
    assert.equal(pinned.sessionId, 's1')
    assert.equal(pinned.pinned, true)
    await nextOfType(authedWs, 'sessions')
    authedWs.send({ type: 'session.archive', sessionId: 's1', stopActivity: true })
    const archived = await nextOfType(authedWs, 'session.archived')
    assert.equal(archived.sessionId, 's1')
    assert.equal(archived.archived, true)
    await nextOfType(authedWs, 'sessions')
    assert.ok(bridge.calls.some((call) => call[0] === 'setSessionArchived' && call[2] === true && call[3] === true))

    // --- Batch C2: queue list/edit + live-only guard. ---
    authedWs.send({ type: 'queue.list', sessionId: 's1' })
    const queueFrame = await nextOfType(authedWs, 'queue')
    assert.equal(queueFrame.sessionId, 's1')
    assert.equal(queueFrame.items.length, 1)
    assert.equal(queueFrame.items[0].text, 'queued text')
    authedWs.send({ type: 'queue.update', sessionId: 's1', itemId: 'q1', action: 'edit', text: 'edited text' })
    const edited = await nextOfType(authedWs, 'queue')
    assert.equal(edited.items[0].text, 'edited text')
    assert.ok(bridge.calls.some((call) => call[0] === 'updateQueue' && call[3] === 'edit'))

    // A cold session is refused with the dedicated code, not an internal error.
    authedWs.send({ type: 'queue.list', sessionId: 'cold' })
    const notLive = await nextOfType(authedWs, 'error')
    assert.equal(notLive.code, 'not-live')

    // The bridge's queue push reaches connected phones.
    bridge.handlers.onQueue({ sessionId: 's1', items: [{ id: 'q1', placement: 'queued', text: 'edited text' }] })
    const pushed = await nextOfType(authedWs, 'queue.changed')
    assert.equal(pushed.sessionId, 's1')
    assert.equal(pushed.items[0].text, 'edited text')

    // --- Batch C3: context meter, changed files, allow-listed commands. ---
    authedWs.send({ type: 'context.get', sessionId: 's1' })
    const contextFrame = await nextOfType(authedWs, 'context')
    assert.equal(contextFrame.sessionId, 's1')
    assert.equal(contextFrame.usedTokens, 1234)
    assert.equal(contextFrame.contextWindow, 64000)
    assert.equal(contextFrame.basis, 'usage')

    authedWs.send({ type: 'changes.list', sessionId: 's1', limit: 5 })
    const changesFrame = await nextOfType(authedWs, 'changes')
    assert.equal(changesFrame.items.length, 1)
    assert.equal(changesFrame.items[0].available, true)
    assert.equal(changesFrame.items[0].files[0].path, 'src/app.ts')
    assert.ok(!JSON.stringify(changesFrame).includes('C:'), 'changed files must not leak an absolute path')

    authedWs.send({ type: 'changes.diff', sessionId: 's1', seq: 7, index: 0 })
    const diffFrame = await nextOfType(authedWs, 'changes.diff')
    assert.equal(diffFrame.kind, 'text')
    assert.equal(diffFrame.path, 'src/app.ts')
    assert.equal(diffFrame.hunks.length, 1)
    assert.ok(diffFrame.hunks[0].lines.includes('+added'))
    authedWs.send({ type: 'changes.diff', sessionId: 's1', seq: 999, index: 0 })
    const diffGone = await nextOfType(authedWs, 'error')
    assert.equal(diffGone.code, 'unavailable')

    authedWs.send({ type: 'commands.list', sessionId: 's1' })
    const commandsFrame = await nextOfType(authedWs, 'commands')
    assert.equal(commandsFrame.available, true)
    assert.equal(commandsFrame.items.length, 4, 'every Host command should reach the phone')
    const commandNames = commandsFrame.items.map((item) => item.name)
    for (const name of ['compact', 'feedback', 'goal', 'plan']) {
      assert.ok(commandNames.includes(name), `commands frame is missing ${name}`)
    }
    assert.ok(!commandNames.includes('export'), 'export must stay hidden from the phone')
    const goalItem = commandsFrame.items.find((item) => item.name === 'goal')
    assert.equal(goalItem.hint, '[<objective>|clear]')
    assert.equal(goalItem.attachments, true)
    authedWs.send({ type: 'commands.execute', sessionId: 's1', line: '/goal ship the release' })
    const commandResult = await nextOfType(authedWs, 'command.result')
    assert.equal(commandResult.name, 'goal')
    assert.equal(commandResult.kind, 'success')
    assert.ok(bridge.calls.some((call) =>
      call[0] === 'executeCommand' && call[2] === '/goal ship the release'), 'arguments must be preserved')
    authedWs.send({ type: 'commands.execute', sessionId: 's1', line: '/compact' })
    const compactResult = await nextOfType(authedWs, 'command.result')
    assert.equal(compactResult.name, 'compact')
    assert.equal(compactResult.kind, 'success')
    authedWs.send({ type: 'commands.execute', sessionId: 's1', line: '/danger' })
    const commandForbidden = await nextOfType(authedWs, 'error')
    assert.equal(commandForbidden.code, 'forbidden')

    // Prompt mode passthrough and the Host's steer rejection.
    authedWs.send({ type: 'prompt', sessionId: 's1', text: 'steer please', requestId: 'r2', mode: 'steer' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.ok(bridge.calls.some((call) => call[0] === 'prompt' && call[4] === 'steer'))
    authedWs.send({ type: 'prompt', sessionId: 's1', text: 'steer me', requestId: 'r3', mode: 'steer' })
    const steerError = await nextOfType(authedWs, 'error')
    assert.equal(steerError.code, 'bad-request')

    // --- Batch E: per-device approval permission. ---
    const deviceId = authed.data.device.id
    const remoteOrigin = await httpJson(base, '/api/desktop/device', {
      method: 'POST',
      body: { deviceId, canApprove: false },
      headers: { origin: 'https://evil.example' },
    })
    assert.equal(remoteOrigin.status, 403, 'remote origins must not toggle device permission')

    const toggledOff = await httpJson(base, `/api/desktop/device?key=${server.deskKey}`, {
      method: 'POST',
      body: { deviceId, canApprove: false },
    })
    assert.equal(toggledOff.status, 200, `toggle-off: ${JSON.stringify(toggledOff.data)}`)
    assert.equal(toggledOff.data.ok, true)
    assert.equal(toggledOff.data.device.canApprove, false)
    const stateOff = await httpJson(base, '/api/state', { cookie })
    assert.equal(stateOff.data.device.canApprove, false)

    // A restricted device cannot answer approvals: error frame, bridge untouched.
    bridge.handlers.onApproval({ sessionId: 's1', requestId: 'req-perm', toolName: 'pwsh', title: 'Approval required', reason: '', displayReason: null, callId: null, expiresAt: 0 })
    await nextOfType(authedWs, 'approval.request')
    authedWs.send({ type: 'approval.answer', requestId: 'req-perm', decision: 'allow' })
    const forbiddenApproval = await nextOfType(authedWs, 'error')
    assert.equal(forbiddenApproval.code, 'forbidden')
    assert.ok(!bridge.calls.some((call) => call[0] === 'answerApproval' && call[1] === 'req-perm'))

    // The flag round-trips through the persisted shared state file.
    await server.saveState()
    const persisted = JSON.parse(await readFile(server.statePath, 'utf8'))
    const reloaded = createAuth({ secret: persisted.secret })
    reloaded.importState(persisted)
    assert.equal(reloaded.devices().find((device) => device.id === deviceId)?.canApprove, false)

    // The VAPID key pair and subscription store persist under the `push` field
    // of the same 0600 state file, so background push survives a Host restart.
    assert.ok(persisted.push !== null && typeof persisted.push === 'object', 'state file must carry the push field')
    assert.equal(persisted.push.vapid.publicKey, pushKey.data.publicKey, 'persisted VAPID public key must match the served key')
    assert.equal(typeof persisted.push.vapid.privateKey?.d, 'string', 'VAPID private key must persist')
    assert.ok(Array.isArray(persisted.push.subscriptions), 'push subscriptions array must persist')

    // Restoring the flag lets the same device answer again.
    const toggledOn = await httpJson(base, `/api/desktop/device?key=${server.deskKey}`, {
      method: 'POST',
      body: { deviceId, canApprove: true },
    })
    assert.equal(toggledOn.data.device.canApprove, true)
    const stateOn = await httpJson(base, '/api/state', { cookie })
    assert.equal(stateOn.data.device.canApprove, true)
    bridge.handlers.onApproval({ sessionId: 's1', requestId: 'req-perm-ok', toolName: 'read', title: 'Approval required', reason: '', displayReason: null, callId: null, expiresAt: 0 })
    await nextOfType(authedWs, 'approval.request')
    authedWs.send({ type: 'approval.answer', requestId: 'req-perm-ok', decision: 'allow' })
    const allowed = await nextOfType(authedWs, 'approval.resolved')
    assert.equal(allowed.outcome, 'allowed-once')
    assert.ok(bridge.calls.some((call) => call[0] === 'answerApproval' && call[1] === 'req-perm-ok'))

    authedWs.close()
    // A cleanly closed socket must leave the peer set. A leaked peer keeps
    // hasApprovalPeers() true and would route approvals to a phone that is gone.
    const peerDeadline = Date.now() + 2000
    while (server.peers.size > 0 && Date.now() < peerDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(server.peers.size, 0, 'a closed socket must be removed from the peer set')
    console.log('PASS transport smoke test')
  } finally {
    await server.stop()
  }
}

main().catch((error) => {
  console.error('FAIL', error)
  process.exitCode = 1
})


