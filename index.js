// Host half of dsh-remote-mobile: starts the standalone phone server, wires it
// to the DSH runtime through bridge.js, and publishes pairing data to the
// desktop page so the Client half can render the QR/PIN panel.
import { createBridge } from './bridge.js'
import { RemoteMobileServer } from './server.js'

const VERSION = '0.0.5'

/**
 * @param {object} ctx Cordis host context
 * @param {{ enabled?: boolean, host?: string, port?: number }} [config]
 */
export function apply(ctx, config = {}) {
  const log = ctx.logger ?? console
  if (config.enabled === false) {
    log.info?.('remote-mobile: disabled by configuration')
    return
  }

  // The bridge needs to know whether a phone is actually connected before it
  // intercepts a waterfall request; if not, the desktop answerer stays in charge.
  // The server reference is assigned synchronously below.
  let server
  const hasPeers = () => server !== undefined && server.peers.size > 0
  const bridge = createBridge(ctx, {
    log,
    hasApprovalPeers: hasPeers,
    hasQuestionPeers: hasPeers,
  })
  server = new RemoteMobileServer(ctx, config, bridge, log)

  ctx.effect(() => {
    let stopping = false
    server.start().catch((error) => {
      log.error?.(`remote-mobile: server failed to start: ${error instanceof Error ? error.message : String(error)}`)
    })
    return () => {
      if (stopping) return
      stopping = true
      return server.stop()
    }
  }, 'remote-mobile.server')

  // Same-origin routes on the DSH web server. The desktop panel uses these when
  // cross-origin fetch is blocked (page CSP or file:// origin); the server
  // answers them only for loopback callers with a loopback Host header.
  //
  // Registration waits for the `webServer` service instead of reading it once:
  // at profile boot this row can apply before the HTTP carrier is active, and a
  // one-shot `ctx.get('webServer')` would then silently skip the routes (the
  // panel would show 404 on its same-origin fallback and fail to recover).
  const routePaths = [
    '/remote-mobile/pairing',
    '/remote-mobile/pairing/rotate',
    '/remote-mobile/pairing/revoke',
    '/remote-mobile/pairing/enable',
    '/remote-mobile/pairing/disable',
    '/remote-mobile/pairing/pending',
    '/remote-mobile/pairing/answer',
    '/remote-mobile/pairing/device',
  ]
  const registerRoutes = (scope) => {
    const carrier = scope.webServer ?? scope.get?.('webServer')
    if (!carrier || typeof carrier.register !== 'function') return
    for (const path of routePaths) {
      scope.effect(() => carrier.register({
        kind: 'exact',
        path,
        handler: (req, res) => {
          server.handlePairingRoute(req, res).catch((error) => {
            log.warn?.(`remote-mobile: pairing route failed: ${error instanceof Error ? error.message : String(error)}`)
            if (!res.headersSent) {
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
              res.end('{"error":"internal"}')
            } else {
              res.destroy()
            }
          })
        },
      }), `remote-mobile.route:${path}`)
    }
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], registerRoutes)
  } else {
    registerRoutes(ctx)
  }

  // Same-origin bootstrap for the desktop Client half. The web server renders
  // index injections per authenticated page, so the page's own session gates
  // access; owner-only keeps liveshare viewers out.
  ctx.effect(() => ctx.on('webserver/index-inject', (table, peer) => {
    const kind = peer && peer.principal ? peer.principal.kind : 'owner'
    if (kind !== 'owner') return
    if (!Array.isArray(table)) return
    table.push({
      kind: 'global',
      name: '__DSH_REMOTE_MOBILE__',
      value: {
        enabled: true,
        version: VERSION,
        port: server.port,
        key: server.deskKey,
        bindHost: server.bindHost,
      },
    })
  }), 'remote-mobile.index-inject')
}
