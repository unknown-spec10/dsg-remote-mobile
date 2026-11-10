// Verifies the desktop on/off switch: listener closes, payload reports off,
// and enabling brings the port back. Uses an isolated DSH_HOME.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'rm-toggle-'))

const { RemoteMobileServer } = await import('../server.js')

const log = { info() {}, warn() {}, error() {} }
const bridge = { async listSessions() { return [] }, subscribe() { return () => {} }, dispose() {} }
const server = new RemoteMobileServer({ logger: log }, { host: '127.0.0.1', port: 0 }, bridge, log)
await server.start()
const base = `http://127.0.0.1:${server.port}`
async function health() {
  try {
    const response = await fetch(`${base}/api/health`)
    return response.ok
  } catch {
    return false
  }
}
try {
  if (!(await health())) throw new Error('server should be listening at start')
  const onPayload = server.desktopStatusPayload()
  if (onPayload.enabled !== true || typeof onPayload.qrSvg !== 'string') throw new Error('expected enabled payload')
  if (onPayload.connectedDevices !== 0 || !Array.isArray(onPayload.connectedNames)) throw new Error('expected connection fields')
  if (typeof onPayload.lastConnectedAt !== 'number') throw new Error('expected lastConnectedAt number')
  console.log('start: enabled, health ok')

  const off = await server.setEnabled(false)
  if (off.ok !== true || off.enabled !== false) throw new Error('disable failed')
  if (server.listening) throw new Error('listener should be closed')
  if (await health()) throw new Error('health should fail while disabled')
  const offPayload = server.desktopStatusPayload()
  if (offPayload.enabled !== false || offPayload.url !== null || offPayload.qrSvg !== null) throw new Error('expected off payload')
  if (offPayload.connectedDevices !== 0 || typeof offPayload.lastConnectedAt !== 'number') throw new Error('expected off connection fields')
  console.log('disabled: listener closed, payload off, healthendpoint unreachable')

  const back = await server.setEnabled(true)
  if (back.ok !== true || back.enabled !== true) throw new Error(`enable failed: ${JSON.stringify(back)}`)
  if (!(await health())) throw new Error('health should work after re-enable')
  const again = server.desktopStatusPayload()
  if (again.enabled !== true || typeof again.pin !== 'string') throw new Error('expected enabled payload after re-enable')
  console.log('re-enabled: listener back, pairing payload restored')
  console.log('toggle PASS')
} finally {
  await server.stop()
}
