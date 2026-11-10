// End-to-end check for the phone SPA against the LIVE plugin: installs a paired
// device cookie into headless Chrome, then asserts the Sessions sheet is grouped
// by project with archived sessions hidden by default, and that the Commands
// sheet lists the Host palette with no stuck loading state.
//
// Manual-ish check (needs the plugin installed and running on 127.0.0.1:3456 and
// a headless Chrome). It rewrites nothing on the Host; it pairs a temporary
// device and revokes it at the end.
import { writeFileSync } from 'node:fs'
import { mkdtempSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
const BASE = 'http://127.0.0.1:3456'
const PORT = Number(process.env.CDP_PORT || 9344)
const WIDTH = 412
const HEIGHT = 915
const OUT = process.env.OUT || join(tmpdir(), 'rm-ui-sessions.png')
const OUT_COMMANDS = process.env.OUT_COMMANDS || join(tmpdir(), 'rm-ui-commands.png')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function pairDevice() {
  const key = readFileSync(join(homedir(), '.dsh', 'remote-mobile-state.json.desk-key'), 'utf8').trim()
  const status = await (await fetch(`${BASE}/api/desktop/status?key=${encodeURIComponent(key)}`)).json()
  assert.equal(status.enabled, true, 'remote access must be enabled on the desktop')
  const token = new URL(status.url).searchParams.get('t')
  assert.ok(token, 'desktop status did not expose a pairing token')
  const paired = await fetch(`${BASE}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  assert.equal(paired.status, 200, `pair failed: ${paired.status}`)
  const cookieHeader = paired.headers.get('set-cookie') ?? ''
  const value = cookieHeader.split(';')[0].split('=').slice(1).join('=')
  const device = (await paired.json()).device
  return { cookie: value, deviceId: device?.id, key }
}

function launchChrome() {
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
  return chrome
}

async function connect() {
  let version = null
  for (let i = 0; i < 60; i += 1) {
    try {
      version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()
      break
    } catch {
      await sleep(250)
    }
  }
  assert.ok(version, 'headless Chrome did not expose a debugging endpoint')
  const ws = new WebSocket(version.webSocketDebuggerUrl)
  const pending = new Map()
  const waiters = new Map()
  const consoleErrors = []
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
    if (message.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(message.params?.exceptionDetails?.exception?.description ?? 'uncaught exception')
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
      consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '))
    }
    if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
      consoleErrors.push(message.params.entry.text)
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
  return { ws, send, waitFor, consoleErrors }
}

const chrome = launchChrome()
const pairing = await pairDevice()
let failures = 0
try {
  const { ws, send, waitFor, consoleErrors } = await connect()
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Page.enable', {}, sessionId)
  await send('Runtime.enable', {}, sessionId)
  await send('Log.enable', {}, sessionId)
  await send('Network.enable', {}, sessionId)
  await send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 2.4,
    mobile: true,
    screenWidth: WIDTH,
    screenHeight: HEIGHT,
  }, sessionId)
  await send('Network.setCookie', {
    name: 'dsh_rm_session',
    value: pairing.cookie,
    domain: '127.0.0.1',
    path: '/',
    httpOnly: true,
  }, sessionId)

  const loaded = waitFor('Page.loadEventFired')
  await send('Page.navigate', { url: BASE + '/' }, sessionId)
  await loaded
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed')
    return result.result.value
  }
  const waitForApp = async (timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await evaluate("!document.getElementById('app').hidden && document.getElementById('boot').hidden")) return
      await sleep(300)
    }
    throw new Error('the SPA did not become visible')
  }
  await waitForApp()
  // Wait for the initial session open to settle: `session` closes any open
  // sheet, so an early open would race this check (and the SPA's own restore).
  for (let i = 0; i < 50; i += 1) {
    const title = await evaluate("document.getElementById('session-title').textContent.trim()")
    if (title && title !== 'Sessions') break
    await sleep(200)
  }
  await sleep(1500)
  // Start from a clean project-collapse state so the run never depends on a
  // previous profile's localStorage.
  await evaluate("window.localStorage.removeItem('dsh-remote-projects.v1')")

  // --- Sessions sheet -------------------------------------------------------
  // A late initial `session` frame closes any open sheet, so retry once.
  const openSessionsSheet = async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await evaluate("document.getElementById('btn-sessions').click()")
      await sleep(800)
      if (await evaluate("document.getElementById('sheet').classList.contains('is-open')")) return true
    }
    return false
  }
  assert.equal(await openSessionsSheet(), true, 'the Sessions sheet must open and stay open')
  assert.equal(
    await evaluate("document.getElementById('sheet').classList.contains('is-open')"),
    true,
    'the Sessions sheet must stay open (a session navigation closes it)',
  )
  const sessions = await evaluate(`(() => {
    const body = document.getElementById('sheet-body')
    const sections = [...body.querySelectorAll('.sheet-session-section')]
    const rows = [...body.querySelectorAll('.row')]
    const archivedRows = [...body.querySelectorAll('.row.is-archived')]
    const filter = body.querySelector('.sheet-filter')
    return {
      projects: sections.filter((section) => section.classList.contains('project-section')).map((section) => ({
        id: section.getAttribute('data-workspace-id'),
        title: section.querySelector('.project-title')?.textContent ?? '',
        path: section.querySelector('.project-path')?.textContent ?? '',
        count: section.querySelector('.project-count')?.textContent ?? '',
        collapsed: section.querySelector('.project-body')?.hidden === true,
      })),
      ungrouped: sections.some((section) => section.querySelector('.sheet-section')?.textContent === 'Ungrouped'),
      rows: rows.length,
      archivedRows: archivedRows.length,
      filterText: filter ? filter.textContent.trim() : null,
      hasOldArchivedToggle: !!body.querySelector('.archived-toggle'),
    }
  })()`)
  assert.ok(sessions.projects.length > 0, 'the session list must be grouped into project sections')
  assert.ok(sessions.projects.some((project) => project.title.length > 0), 'a project section needs a title')
  assert.equal(sessions.archivedRows, 0, 'archived sessions must not appear in the default list')
  assert.equal(sessions.hasOldArchivedToggle, false, 'the old collapsed Archived toggle must be gone')
  assert.match(sessions.filterText ?? '', /Show archived \(\d+\)/, 'archived sessions need an explicit Show archived control')
  assert.ok(sessions.ungrouped, 'sessions without a registered project belong to Ungrouped')

  // Collapse/expand one project.
  const beforeCollapse = sessions.projects[0].collapsed
  await evaluate("document.querySelector('.project-header').click()")
  await sleep(500)
  const afterCollapse = await evaluate("document.querySelector('.project-header').classList.contains('is-collapsed')")
  assert.equal(afterCollapse, !beforeCollapse, 'tapping a project header must toggle its collapsed state')
  await evaluate("document.querySelector('.project-header').click()")
  await sleep(400)

  // Show archived, then hide again.
  await evaluate("document.querySelector('.sheet-filter').click()")
  await sleep(500)
  const revealed = await evaluate("document.querySelectorAll('#sheet-body .row.is-archived').length")
  assert.ok(revealed > 0, 'Show archived must reveal archived sessions')
  const hideText = await evaluate("document.querySelector('.sheet-filter')?.textContent.trim() ?? ''")
  assert.equal(hideText, 'Hide archived')
  await evaluate("document.querySelector('.sheet-filter').click()")
  await sleep(400)
  assert.equal(await evaluate("document.querySelectorAll('#sheet-body .row.is-archived').length"), 0, 'Hide archived must hide them again')

  const sessionShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId)
  writeFileSync(OUT, Buffer.from(sessionShot.data, 'base64'))

  // --- Commands sheet -------------------------------------------------------
  await evaluate("document.getElementById('sheet-close').click()")
  await sleep(400)
  await evaluate("document.getElementById('btn-menu').click()")
  await sleep(500)
  const clicked = await evaluate(`(() => {
    const row = [...document.querySelectorAll('#sheet-body .row')].find((node) => /command/i.test(node.textContent))
    if (!row) return false
    row.click()
    return true
  })()`)
  assert.equal(clicked, true, 'the session menu must offer Commands')
  await sleep(1500)
  const commands = await evaluate(`(() => {
    const body = document.getElementById('sheet-body')
    return {
      loading: !!body.querySelector('.sheet-loading'),
      items: [...body.querySelectorAll('.row')].map((row) => row.textContent.replace(/\\s+/g, ' ').trim()),
      sub: document.getElementById('sheet-sub').textContent,
    }
  })()`)
  await sleep(2500)
  const settled = await evaluate("!!document.getElementById('sheet-body').querySelector('.sheet-loading')")
  assert.equal(commands.loading, false, 'the Commands sheet must not be stuck on its loading spinner')
  assert.equal(settled, false, 'the Commands spinner must stay gone after the list settles')
  assert.ok(commands.items.length >= 2, 'the phone must list the Host command palette, not only compact')
  assert.ok(commands.items.some((text) => text.startsWith('/compact')), 'compact must be listed')
  assert.ok(!commands.items.some((text) => text.startsWith('/export')), 'export must stay desktop-only')
  assert.ok(!commands.items.some((text) => text.startsWith('/permission')), 'the sandbox policy command must stay desktop-only')
  assert.match(commands.sub, /Harness command/, 'the Commands sheet must describe the Host palette')
  const commandsShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId)
  writeFileSync(OUT_COMMANDS, Buffer.from(commandsShot.data, 'base64'))

  // Argument commands open the input sheet.
  const hintRow = commands.items.find((text) => text.includes(' · '))
  if (hintRow) {
    await evaluate(`(() => {
      const row = [...document.querySelectorAll('#sheet-body .row')].find((node) => /\\(/.test(node.textContent) || node.textContent.includes(' · '))
      row?.click()
    })()`)
    await sleep(600)
    const inputSheet = await evaluate(`(() => ({
      title: document.getElementById('sheet-title').textContent,
      hasInput: !!document.querySelector('#sheet-body input.sheet-search'),
      hasRun: [...document.querySelectorAll('#sheet-body .row')].some((row) => /Run command/i.test(row.textContent)),
    }))()`)
    assert.match(inputSheet.title, /^\//, 'the command input sheet is headed by the command name')
    assert.equal(inputSheet.hasInput, true, 'argument commands need an input field')
    assert.equal(inputSheet.hasRun, true, 'argument commands need a Run command action')
    await evaluate("document.getElementById('sheet-close').click()")
    await sleep(300)
  }

  assert.deepEqual(consoleErrors, [], 'the SPA must not log console errors')
  console.log(`PASS phone UI check (projects=${sessions.projects.length}, commands=${commands.items.length}, screenshots=${OUT}, ${OUT_COMMANDS})`)
  ws.close()
} catch (error) {
  failures += 1
  console.error('FAIL', error instanceof Error ? error.message : error)
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
if (failures > 0) process.exitCode = 1
