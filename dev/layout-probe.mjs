// One-off layout diagnostic: drives a real headless Chrome against the live
// phone SPA at a phone viewport, then reports any horizontal overflow and takes
// a screenshot. Uses only Node built-ins (global WebSocket + fetch).
import { writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
const BASE = 'http://127.0.0.1:3456'
const PORT = Number(process.env.CDP_PORT || 9333)
const WIDTH = Number(process.env.WIDTH || 412)
const HEIGHT = Number(process.env.HEIGHT || 915)
const OUT = process.env.OUT || join(tmpdir(), 'rm-layout.png')
const MOCK = process.env.MOCK === '1'
const TARGET_BASE = MOCK ? process.env.MOCK_URL : BASE

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function pairDevice() {
  const key = (await import('node:fs')).readFileSync(join(homedir(), '.dsh', 'remote-mobile-state.json.desk-key'), 'utf8').trim()
  const status = await (await fetch(`${BASE}/api/desktop/status?key=${encodeURIComponent(key)}`)).json()
  const token = new URL(status.url).searchParams.get('t')
  const paired = await fetch(`${BASE}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  const cookieHeader = paired.headers.get('set-cookie') ?? ''
  const value = cookieHeader.split(';')[0].split('=').slice(1).join('=')
  const device = (await paired.json()).device
  return { cookie: value, deviceId: device?.id, key }
}

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'rm-chrome-'))
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    'about:blank',
  ], { stdio: 'ignore' })

  let pairing = null
  if (!MOCK) pairing = await pairDevice()

  try {
    let version = null
    for (let i = 0; i < 40; i += 1) {
      try {
        version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()
        break
      } catch {
        await sleep(250)
      }
    }
    if (!version) throw new Error('chrome did not expose a debugging endpoint')

    const ws = new WebSocket(version.webSocketDebuggerUrl)
    const pending = new Map()
    let nextId = 0
    const sessionWaiters = new Map()
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id)
        pending.delete(message.id)
        if (message.error) reject(new Error(JSON.stringify(message.error)))
        else resolve(message.result)
        return
      }
      if (message.method && sessionWaiters.has(message.method)) {
        for (const resolve of sessionWaiters.get(message.method).splice(0)) resolve(message.params)
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
      const list = sessionWaiters.get(method) ?? []
      list.push(resolve)
      sessionWaiters.set(method, list)
      setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeoutMs)
    })

    const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })

    await send('Page.enable', {}, sessionId)
    await send('Runtime.enable', {}, sessionId)
    await send('Network.enable', {}, sessionId)
    await send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 2.4,
      mobile: true,
      screenWidth: WIDTH,
      screenHeight: HEIGHT,
    }, sessionId)

    if (!MOCK && pairing) {
      await send('Network.setCookie', {
        name: 'dsh_rm_session',
        value: pairing.cookie,
        domain: '127.0.0.1',
        path: '/',
        httpOnly: true,
      }, sessionId)
    }

    const loaded = waitFor('Page.loadEventFired')
    await send('Page.navigate', { url: TARGET_BASE + '/' }, sessionId)
    await loaded
    await sleep(4000)

    const expression = `(() => {
      const vw = window.innerWidth;
      const doc = document.documentElement;
      const offenders = [];
      for (const el of document.querySelectorAll('body *')) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        const overflowRight = rect.right - vw;
        if (overflowRight > 1 && rect.width > 0) {
          offenders.push({
            tag: el.tagName.toLowerCase(),
            cls: (el.className && String(el.className).slice(0, 80)) || '',
            id: el.id || '',
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            width: Math.round(rect.width),
            over: Math.round(overflowRight),
          });
        }
      }
      offenders.sort((a, b) => b.over - a.over);
      const app = document.querySelector('.app');
      const appRect = app ? app.getBoundingClientRect() : null;
      const center = (selector) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0) return null;
        return Math.round((rect.left + rect.width / 2 - vw / 2) * 10) / 10;
      };
      const chip = document.querySelector('#composer-model');
      const chipRect = chip ? chip.getBoundingClientRect() : null;
      return {
        innerWidth: vw,
        scrollWidth: doc.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        appWidth: appRect ? Math.round(appRect.width) : null,
        appRight: appRect ? Math.round(appRect.right) : null,
        titleCenterOffset: center('.titleblock'),
        meterCenterOffset: center('#context-meter'),
        chipRight: chipRect && chipRect.width > 0 ? Math.round(chipRect.right) : null,
        offenders: offenders.slice(0, 15),
      };
    })()`
    const evaluated = await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId)
    console.log(JSON.stringify(evaluated.result.value, null, 2))

    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId)
    writeFileSync(OUT, Buffer.from(shot.data, 'base64'))
    console.log('screenshot:', OUT)

    ws.close()
  } finally {
    chrome.kill()
    if (pairing?.deviceId) {
      await fetch(`${BASE}/api/desktop/revoke?key=${encodeURIComponent(pairing.key)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: pairing.deviceId }),
      }).catch(() => {})
    }
  }
}

main().catch((error) => {
  console.error('FAIL', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
