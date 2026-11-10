// Desktop-panel authorization checks: loopback callers get pairing data without
// the injected key (including file:// origins from the Desktop app), remote
// origins are refused, and the same-origin DSH route only answers loopback
// requests with a loopback Host header.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'rm-auth-'))

const { RemoteMobileServer } = await import('../server.js')

const log = { info() {}, warn() {}, error() {} }
const bridge = { async listSessions() { return [] }, subscribe() { return () => {} }, dispose() {} }
const server = new RemoteMobileServer({ logger: log }, { host: '127.0.0.1', port: 0 }, bridge, log)
await server.start()
const base = `http://127.0.0.1:${server.port}`
async function status(headers = {}) {
  return fetch(`${base}/api/desktop/status`, { headers })
}
function fakeExchange({ method = 'GET', url = '/remote-mobile/pairing', host = `127.0.0.1:${server.port}`, origin } = {}) {
  const result = { status: null, body: null }
  const res = {
    headersSent: false,
    writeHead(code) {
      this.headersSent = true
      result.status = code
    },
    end(text) {
      result.body = text === undefined ? null : JSON.parse(text)
    },
    destroy() {},
  }
  const req = {
    method,
    url,
    headers: { host, ...(origin === undefined ? {} : { origin }) },
    socket: { remoteAddress: '127.0.0.1' },
  }
  return { req, res, result }
}
try {
  const plain = await status()
  console.log('no key, no origin:', plain.status)
  if (plain.status !== 200) throw new Error(`expected 200, got ${plain.status}`)

  const loopbackOrigin = await status({ origin: `http://127.0.0.1:${server.port}` })
  console.log('no key, loopback origin:', loopbackOrigin.status)
  if (loopbackOrigin.status !== 200) throw new Error(`expected 200, got ${loopbackOrigin.status}`)

  const nullOrigin = await status({ origin: 'null' })
  console.log('no key, null origin (Desktop file://):', nullOrigin.status)
  if (nullOrigin.status !== 200) throw new Error(`expected 200, got ${nullOrigin.status}`)

  const remoteOrigin = await status({ origin: 'https://evil.example' })
  console.log('no key, remote origin:', remoteOrigin.status)
  if (remoteOrigin.status !== 403) throw new Error(`expected 403, got ${remoteOrigin.status}`)

  const badQuery = await fetch(`${base}/api/desktop/status?key=wrong`, { headers: { origin: 'https://evil.example' } })
  console.log('wrong key query, remote origin:', badQuery.status)
  if (badQuery.status !== 403) throw new Error(`expected 403, got ${badQuery.status}`)

  const ok = fakeExchange()
  await server.handlePairingRoute(ok.req, ok.res)
  console.log('same-origin route, loopback host:', ok.result.status)
  if (ok.result.status !== 200 || typeof ok.result.body?.pin !== 'string') throw new Error('same-origin status failed')

  const remoteHost = fakeExchange({ host: 'evil.example' })
  await server.handlePairingRoute(remoteHost.req, remoteHost.res)
  console.log('same-origin route, remote host:', remoteHost.result.status)
  if (remoteHost.result.status !== 403) throw new Error(`expected 403, got ${remoteHost.result.status}`)

  const rotate = fakeExchange({ method: 'POST', url: '/remote-mobile/pairing/rotate' })
  await server.handlePairingRoute(rotate.req, rotate.res)
  console.log('same-origin rotate:', rotate.result.status, typeof rotate.result.body?.pin)
  if (rotate.result.status !== 200) throw new Error('same-origin rotate failed')

  const revoked = fakeExchange({ method: 'POST', url: '/remote-mobile/pairing/revoke' })
  revoked.req.headers['content-type'] = 'application/json'
  revoked.req.on = (event, handler) => {
    if (event === 'data') handler(Buffer.from('{"all":true}'))
    if (event === 'end') handler()
  }
  await server.handlePairingRoute(revoked.req, revoked.res)
  console.log('same-origin revoke:', revoked.result.status)
  if (revoked.result.status !== 200) throw new Error('same-origin revoke failed')

  console.log('desktop auth PASS')
} finally {
  await server.stop()
}
