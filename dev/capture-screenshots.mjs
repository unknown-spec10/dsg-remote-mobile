// Regenerate the README screenshots from the DEV mock server (no Host, no real
// sessions, no personal data). Starts mobile/mock-server.js on a private port,
// pairs a temporary demo device, drives the SPA with headless Chrome over CDP
// and writes PNGs to docs/screenshots/.
//
// Usage: node dev/capture-screenshots.mjs
// Env: CHROME_PATH (default Windows Chrome path), CDP_PORT (default 9345),
//      MOCK_PORT (default 3471), RM_PIN (default 1234 for the mock).
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const OUT_DIR = join(ROOT, 'docs', 'screenshots')
const MOCK = join(ROOT, 'mobile', 'mock-server.js')
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
const MOCK_PORT = Number(process.env.MOCK_PORT || 3471)
const CDP_PORT = Number(process.env.CDP_PORT || 9345)
const PIN = process.env.RM_PIN || '1234'
const BASE = `http://127.0.0.1:${MOCK_PORT}`
const WIDTH = 390
const HEIGHT = 844
const DPR = 2

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForHttp(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const response = await fetch(url)
      if (response.ok) return response
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${url}`)
    await sleep(200)
  }
}

function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'rm-shot-chrome-'))
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    'about:blank',
  ], { stdio: 'ignore' })
  return chrome
}

async function connect() {
  let version = null
  for (let i = 0; i < 80; i += 1) {
    try {
      version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()
      break
    } catch {
      await sleep(250)
    }
  }
  if (!version) throw new Error('headless Chrome did not expose a debugging endpoint')
  const ws = new WebSocket(version.webSocketDebuggerUrl)
  const pending = new Map()
  const waiters = new Map()
  let nextId = 0
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else resolve(message.result)
      return
    }
    if (message.method && waiters.has(message.method)) {
      for (const resolve of waiters.get(message.method).splice(0)) resolve(message.params)
    }
  })
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  const waitFor = (method, timeoutMs = 15000) => new Promise((resolve, reject) => {
    const list = waiters.get(method) ?? []
    list.push(resolve)
    waiters.set(method, list)
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeoutMs)
  })
  return { ws, send, waitFor }
}

const mock = spawn(process.execPath, [MOCK], {
  env: { ...process.env, PORT: String(MOCK_PORT), HOST: '127.0.0.1', RM_PIN: PIN },
  stdio: 'ignore',
})
const chrome = launchChrome()
try {
  await waitForHttp(`${BASE}/api/state`)
  mkdirSync(OUT_DIR, { recursive: true })
  const { ws, send, waitFor } = await connect()
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Page.enable', {}, sessionId)
  await send('Runtime.enable', {}, sessionId)
  await send('Network.enable', {}, sessionId)
  await send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: DPR,
    mobile: true,
    screenWidth: WIDTH,
    screenHeight: HEIGHT,
  }, sessionId)

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed')
    return result.result.value
  }
  const setScheme = (scheme) => send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: scheme }],
  }, sessionId)
  const shot = async (name) => {
    const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId)
    const target = join(OUT_DIR, name)
    writeFileSync(target, Buffer.from(image.data, 'base64'))
    console.log(`wrote ${target}`)
  }
  const navigate = async (url) => {
    const loaded = waitFor('Page.loadEventFired')
    await send('Page.navigate', { url }, sessionId)
    await loaded
  }
  const waitForExpression = async (expression, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return
      await sleep(250)
    }
    throw new Error(`timed out waiting for: ${expression}`)
  }

  // 1. Pairing screen (no device cookie yet), light scheme.
  await setScheme('light')
  await navigate(`${BASE}/`)
  await waitForExpression("!document.getElementById('pairing').hidden && document.getElementById('boot').hidden")
  await sleep(400)
  await shot('pairing-light.png')

  // Pair the demo device over HTTP (the same flow a QR/PIN would use).
  const paired = await fetch(`${BASE}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: PIN }),
  })
  if (!paired.ok) throw new Error(`mock pair failed: ${paired.status}`)
  const cookieValue = (paired.headers.get('set-cookie') ?? '').split(';')[0].split('=').slice(1).join('=')
  await send('Network.setCookie', {
    name: 'rm_session',
    value: cookieValue,
    domain: '127.0.0.1',
    path: '/',
    httpOnly: true,
  }, sessionId)

  // 2. Chat, light scheme.
  await navigate(`${BASE}/`)
  await waitForExpression("!document.getElementById('app').hidden && document.getElementById('boot').hidden")
  await waitForExpression("document.getElementById('session-title').textContent.trim() !== 'Sessions'")
  await sleep(1500)
  await shot('chat-light.png')

  // 3. Sessions sheet grouped by project (light).
  await evaluate("document.getElementById('btn-sessions').click()")
  await sleep(900)
  await shot('sessions-light.png')
  await evaluate("document.getElementById('sheet-close').click()")
  await sleep(500)

  // 4. Commands sheet (dark).
  await setScheme('dark')
  await sleep(600)
  await evaluate("document.getElementById('btn-menu').click()")
  await sleep(600)
  const opened = await evaluate(`(() => {
    const row = [...document.querySelectorAll('#sheet-body .row')].find((node) => /command/i.test(node.textContent))
    if (!row) return false
    row.click()
    return true
  })()`)
  if (!opened) throw new Error('the mock session menu did not offer Commands')
  await sleep(1400)
  if (await evaluate("!!document.getElementById('sheet-body').querySelector('.sheet-loading')")) {
    throw new Error('the Commands sheet is still loading')
  }
  await shot('commands-dark.png')

  ws.close()
  console.log('PASS screenshots regenerated from the mock server')
} finally {
  chrome.kill()
  mock.kill()
}
