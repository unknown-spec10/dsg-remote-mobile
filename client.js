// Client half of dsh-remote-mobile (browser module of the DSH Web UI).
// Renders the pairing panel inside Settings: QR, fallback PIN, address,
// expiry countdown and paired-device management. All data comes from the Host
// server over a key-gated loopback endpoint.
window.__ModuleLoader__.load({
  // The registration id MUST equal the client module's manifest row id (the
  // package name). The module system keys factories by package name; a short
  // id (e.g. `dsh-remote-mobile`) leaves the package row unresolved, so the
  // bundle is loaded a second time and the second registration throws
  // "duplicate factory registration".
  id: '@deep-podder/dsh-remote-mobile',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const styles = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        gap: '18px',
        maxWidth: '720px',
        color: 'var(--dsw-alias-label-primary)',
      },
      header: {
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
      },
      title: {
        margin: 0,
        fontSize: '18px',
        fontWeight: 600,
        letterSpacing: '-0.01em',
      },
      subtitle: {
        margin: 0,
        fontSize: '13px',
        lineHeight: 1.5,
        color: 'var(--dsw-alias-label-secondary)',
      },
      card: {
        display: 'flex',
        gap: '24px',
        flexWrap: 'wrap',
        padding: '20px',
        borderRadius: '14px',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)',
      },
      qrWrap: {
        width: '196px',
        height: '196px',
        padding: '10px',
        borderRadius: '12px',
        background: '#FFFFFF',
        boxSizing: 'border-box',
        flex: '0 0 auto',
      },
      qrImg: { width: '100%', height: '100%', display: 'block' },
      details: {
        display: 'flex',
        flex: '1 1 260px',
        minWidth: '240px',
        flexDirection: 'column',
        gap: '14px',
      },
      label: {
        fontSize: '11px',
        fontWeight: 600,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: 'var(--dsw-alias-label-secondary)',
      },
      pin: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '34px',
        fontWeight: 600,
        letterSpacing: '0.28em',
        lineHeight: 1.1,
        margin: 0,
        color: 'var(--dsw-alias-label-primary)',
      },
      address: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '12px',
        lineHeight: 1.5,
        wordBreak: 'break-all',
        margin: 0,
        color: 'var(--dsw-alias-label-secondary)',
      },
      row: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' },
      button: {
        appearance: 'none',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: '8px',
        padding: '7px 12px',
        fontSize: '12px',
        fontWeight: 500,
        cursor: 'pointer',
        lineHeight: 1.4,
      },
      muted: {
        appearance: 'none',
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '12px',
        cursor: 'pointer',
        padding: 0,
        textDecoration: 'underline',
        textUnderlineOffset: '2px',
      },
      meta: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      banner: {
        padding: '10px 12px',
        borderRadius: '10px',
        fontSize: '12px',
        lineHeight: 1.5,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-secondary)',
      },
      warn: {
        padding: '10px 12px',
        borderRadius: '10px',
        fontSize: '12px',
        lineHeight: 1.5,
        border: '1px solid var(--dsw-alias-state-warn-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-state-warn-primary)',
      },
      error: {
        padding: '10px 12px',
        borderRadius: '10px',
        fontSize: '12px',
        lineHeight: 1.5,
        border: '1px solid var(--dsw-alias-state-error-primary)',
        color: 'var(--dsw-alias-state-error-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
      },
      devices: {
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      },
      device: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '10px 12px',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
      },
      dot: {
        width: '7px',
        height: '7px',
        borderRadius: '50%',
        background: 'var(--dsw-alias-state-success-primary)',
        flex: '0 0 auto',
      },
      spacer: { flex: '1 1 auto' },
      toggleRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '14px',
        padding: '12px 14px',
        borderRadius: '12px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      confirmRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        flexWrap: 'wrap',
        padding: '12px 14px',
        borderRadius: '12px',
        border: '1px solid var(--dsw-alias-state-warn-primary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        lineHeight: 1.5,
      },
    }

    function switchStyle(on) {
      return {
        position: 'relative',
        width: '42px',
        height: '24px',
        flex: '0 0 auto',
        padding: 0,
        border: 'none',
        borderRadius: '999px',
        cursor: 'pointer',
        background: on ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-border-l2)',
        transition: 'background 160ms ease',
      }
    }

    function switchKnobStyle(on) {
      return {
        position: 'absolute',
        top: '3px',
        left: on ? '21px' : '3px',
        width: '18px',
        height: '18px',
        borderRadius: '50%',
        background: '#FFFFFF',
        transition: 'left 160ms ease',
        boxShadow: '0 1px 2px rgba(0, 0, 0, 0.28)',
      }
    }

    function formatRelative(ts) {
      if (!Number.isFinite(ts)) return ''
      const delta = Date.now() - ts
      if (delta < 60_000) return 'just now'
      if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} min ago`
      if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} h ago`
      return `${Math.floor(delta / 86_400_000)} d ago`
    }

    function formatCountdown(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return 'expired'
      const seconds = Math.ceil(ms / 1000)
      if (seconds < 60) return `${seconds}s`
      return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
    }

    function PairingPanel() {
      const injected = typeof window !== 'undefined' ? window.__DSH_REMOTE_MOBILE__ : undefined
      const bootstrap = injected !== undefined && typeof injected === 'object' && Number.isInteger(injected.port)
        ? injected
        : undefined
      const localPage = typeof window !== 'undefined' && (
        window.location.protocol === 'file:'
        || window.location.hostname === '127.0.0.1'
        || window.location.hostname === 'localhost'
        || window.location.hostname === '::1'
        || window.location.hostname === '[::1]'
      )
      const [status, setStatus] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [busyToggle, setBusyToggle] = useState(false)
      const [confirmOff, setConfirmOff] = useState(false)
      const [copied, setCopied] = useState(false)
      const copiedTimer = useRef(null)
      const [tick, setTick] = useState(0)
      const [selectedAddress, setSelectedAddress] = useState(null)

      // Try the injected keyed endpoint first, then the DSH web server's
      // same-origin route (immune to page CSP and file:// origins), then the
      // bare loopback endpoint. The first one that answers is reused.
      const sources = useMemo(() => {
        const list = []
        if (bootstrap !== undefined) {
          list.push({ base: `http://127.0.0.1:${bootstrap.port}`, key: bootstrap.key })
        }
        list.push({ base: '', key: null })
        if (localPage) {
          list.push({ base: `http://127.0.0.1:${bootstrap !== undefined ? bootstrap.port : 3456}`, key: null })
        }
        return list
      }, [bootstrap, localPage])
      const activeIndex = useRef(-1)

      const opUrl = useCallback((source, op, query) => {
        const base = source.base === ''
          ? (op === 'status' ? '/remote-mobile/pairing' : `/remote-mobile/pairing/${op}`)
          : (source.key
            ? `${source.base}${op === 'status' ? '/api/desktop/status' : `/api/desktop/${op}`}?key=${encodeURIComponent(source.key)}`
            : `${source.base}${op === 'status' ? '/api/desktop/status' : `/api/desktop/${op}`}`)
        if (!query) return base
        return `${base}${base.includes('?') ? '&' : '?'}${query}`
      }, [])

      const request = useCallback(async (op, options = {}) => {
        const failures = []
        const order = []
        if (activeIndex.current >= 0) order.push(activeIndex.current)
        for (let index = 0; index < sources.length; index += 1) {
          if (!order.includes(index)) order.push(index)
        }
        const { query, ...init } = options
        for (const index of order) {
          const source = sources[index]
          try {
            const response = await fetch(opUrl(source, op, query), {
              cache: 'no-store',
              mode: 'cors',
              credentials: 'omit',
              ...init,
              headers: init.body === undefined
                ? undefined
                : { 'content-type': 'application/json', ...(init.headers ?? {}) },
            })
            if (!response.ok) {
              failures.push(`${source.base === '' ? 'same-origin' : source.base}: HTTP ${response.status}`)
              continue
            }
            const data = await response.json()
            activeIndex.current = index
            return data
          } catch (cause) {
            failures.push(`${source.base === '' ? 'same-origin' : source.base}: ${cause instanceof Error ? cause.message : String(cause)}`)
          }
        }
        throw new Error(`Could not reach the local pairing server (${failures.join('; ')})`)
      }, [opUrl, sources])

      const load = useCallback(async () => {
        try {
          const next = await request('status', selectedAddress === null ? {} : { query: `address=${encodeURIComponent(selectedAddress)}` })
          setStatus(next)
          setError(null)
          if (next !== null && next.enabled === false) setConfirmOff(false)
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }, [request, selectedAddress])

      useEffect(() => {
        void load()
        const poll = setInterval(() => void load(), 5000)
        const clock = setInterval(() => setTick((value) => value + 1), 1000)
        return () => {
          clearInterval(poll)
          clearInterval(clock)
          if (copiedTimer.current !== null) clearTimeout(copiedTimer.current)
        }
      }, [load])

      const rotate = useCallback(async () => {
        setBusy(true)
        try {
          await request('rotate', { method: 'POST', body: '{}' })
          await load()
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(false)
        }
      }, [request, load])

      const revoke = useCallback(async (deviceId) => {
        setBusy(true)
        try {
          await request('revoke', { method: 'POST', body: JSON.stringify({ deviceId }) })
          await load()
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(false)
        }
      }, [request, load])

      const revokeAll = useCallback(async () => {
        setBusy(true)
        try {
          await request('revoke', { method: 'POST', body: JSON.stringify({ all: true }) })
          await load()
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(false)
        }
      }, [request, load])

      const setDevicePermission = useCallback(async (deviceId, canApprove) => {
        setBusy(true)
        try {
          await request('device', { method: 'POST', body: JSON.stringify({ deviceId, canApprove }) })
          await load()
          setError(null)
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(false)
        }
      }, [request, load])

      const copy = useCallback(async () => {
        if (status === null || status.url === null) return
        try {
          await navigator.clipboard.writeText(status.url)
          setCopied(true)
          copiedTimer.current = setTimeout(() => {
            copiedTimer.current = null
            setCopied(false)
          }, 1600)
        } catch {
          setError('Clipboard is not available in this browser.')
        }
      }, [status])

      const toggleEnabled = useCallback(async (next) => {
        setBusyToggle(true)
        setConfirmOff(false)
        try {
          await request(next ? 'enable' : 'disable', { method: 'POST', body: '{}' })
          await load()
          setError(null)
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusyToggle(false)
        }
      }, [request, load])

      const pinRemaining = status === null || status.enabled === false ? 0 : status.pinExpiresAt - Date.now()

      const deviceList = status !== null && status.devices.length > 0
        ? h('div', { style: styles.devices }, status.devices.map((device) => h('div', { key: device.id, style: styles.device },
          h('span', { style: styles.dot }),
          h('div', null,
            h('div', { style: { fontSize: '13px', fontWeight: 500 } }, device.name),
            h('div', { style: styles.meta }, `Paired ${formatRelative(device.createdAt)} · last seen ${formatRelative(device.lastSeenAt)}`)),
          h('span', { style: styles.spacer }),
          h('button', {
            type: 'button',
            role: 'switch',
            'aria-checked': device.canApprove !== false,
            'aria-label': `Allow ${device.name} to answer approvals`,
            title: device.canApprove !== false
              ? 'This device can answer approvals'
              : 'This device cannot answer approvals',
            disabled: busy,
            style: switchStyle(device.canApprove !== false),
            onClick: () => setDevicePermission(device.id, !(device.canApprove !== false)),
          }, h('span', { style: switchKnobStyle(device.canApprove !== false) })),
          h('button', { type: 'button', style: styles.muted, disabled: busy, onClick: () => revoke(device.id) }, 'Revoke'))))
        : h('div', { style: styles.banner }, 'No devices paired yet.')

      const pairingCard = h('div', { style: styles.card },
        h('div', { style: styles.qrWrap },
          h('img', {
            style: styles.qrImg,
            alt: 'Pairing QR code',
            src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(status === null ? '' : status.qrSvg)}`,
          })),
        h('div', { style: styles.details },
          h('div', null,
            h('div', { style: styles.label }, 'PIN'),
            h('p', { style: styles.pin, 'aria-label': `PIN ${status === null ? '' : status.pin}` }, status === null ? '' : status.pin)),
          h('div', null,
            h('div', { style: styles.label }, 'Address'),
            h('p', { style: styles.address }, status === null ? '' : status.url),
            status !== null && Array.isArray(status.addressDetails) && status.addressDetails.length > 1
              ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '6px' } },
                status.addressDetails.map((entry) => h('button', {
                  key: entry.address,
                  type: 'button',
                  onClick: () => setSelectedAddress(entry.address),
                  'aria-pressed': status.address === entry.address,
                  style: status.address === entry.address
                    ? { ...styles.button, borderColor: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-brand-primary)' }
                    : { ...styles.button, fontSize: '11px', padding: '5px 8px' },
                }, entry.address.startsWith('http') ? entry.name : `${entry.address}${entry.name ? ` · ${entry.name}` : ''}`)))
              : null,
            status !== null && Array.isArray(status.addresses) && status.addresses.some((address) => address.startsWith('100.') || address.startsWith('https://'))
              ? h('p', { style: styles.meta }, 'Use the Tailscale address when the phone is away from this Wi-Fi. Open Tailscale on the phone first.')
              : null),
          h('div', { style: styles.row },
            h('button', { type: 'button', style: styles.button, onClick: copy }, copied ? 'Copied' : 'Copy link'),
            h('button', { type: 'button', style: styles.button, disabled: busy, onClick: rotate }, 'New PIN')),
          h('div', { style: styles.meta }, `PIN expires in ${formatCountdown(pinRemaining)}`)))

      const devicesSection = h('div', null,
        h('div', { style: styles.label }, 'Paired devices'),
        deviceList,
        status !== null && status.devices.length > 0
          ? h('div', { style: { marginTop: '12px' } },
            h('button', { type: 'button', style: styles.muted, disabled: busy, onClick: revokeAll }, 'Revoke all devices'))
          : null)

      const body = status === null
        ? h('div', { style: styles.banner }, 'Starting the local mobile server…')
        : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px' } },
          status.enabled === false
            ? h('div', { style: styles.banner }, 'Remote access is off. The phone cannot pair or connect while the switch is off.')
            : pairingCard,
          status.enabled === false
            ? null
            : status.loopbackOnly
              ? h('div', { style: styles.warn }, 'Only a loopback address was detected. A phone cannot reach this machine until it has a LAN or Tailscale address.')
              : null,
          devicesSection)

      const connectedNames = status !== null && Array.isArray(status.connectedNames) ? status.connectedNames : []
      const connectedCount = status !== null && Number.isFinite(status.connectedDevices) ? status.connectedDevices : 0
      const lastConnectedLabel = status === null || !status.lastConnectedAt ? 'never' : formatRelative(status.lastConnectedAt)
      const toggleSubtitle = status === null
        ? 'Checking…'
        : status.enabled === false
          ? `Off · last connected ${lastConnectedLabel}`
          : connectedCount > 0
            ? `${connectedNames.length > 0 ? connectedNames.join(', ') : 'A device'} connected now`
            : `Last connected ${lastConnectedLabel}`

      return h('div', { style: styles.page },
        h('div', { style: styles.header },
          h('h2', { style: styles.title }, 'Remote mobile access'),
          h('p', { style: styles.subtitle }, 'Scan the QR code with your phone, or open the address and enter the PIN. Devices must be on the same network — preferably Tailscale or a trusted Wi-Fi.')),
        h('div', { style: styles.toggleRow },
          h('div', { style: { flex: '1 1 auto' } },
            h('div', { style: { fontSize: '13px', fontWeight: 600 } },
              status !== null && status.enabled === false ? 'Remote access is off' : 'Remote access is on'),
            h('div', { style: styles.meta }, toggleSubtitle)),
          h('button', {
            type: 'button',
            role: 'switch',
            'aria-checked': status !== null && status.enabled !== false,
            'aria-label': 'Enable remote mobile access',
            disabled: busyToggle || status === null,
            onClick: () => {
              if (status === null) return
              if (status.enabled === false) {
                void toggleEnabled(true)
                return
              }
              if (connectedCount > 0) {
                setConfirmOff(true)
                return
              }
              void toggleEnabled(false)
            },
            style: switchStyle(status !== null && status.enabled !== false),
          }, h('span', { style: switchKnobStyle(status !== null && status.enabled !== false) }))),
        confirmOff && status !== null && status.enabled !== false
          ? h('div', { style: styles.confirmRow },
            h('div', { style: { flex: '1 1 240px', fontSize: '12px' } },
              `${connectedNames.length > 0 ? connectedNames.join(', ') : 'A phone'} is connected. Turning access off disconnects it until you turn it back on.`),
            h('button', {
              type: 'button',
              style: styles.button,
              disabled: busyToggle,
              onClick: () => void toggleEnabled(false),
            }, 'Turn off'),
            h('button', {
              type: 'button',
              style: styles.muted,
              onClick: () => setConfirmOff(false),
            }, 'Cancel'))
          : null,
        error !== null ? h('div', { style: styles.error }, error) : null,
        body)
    }

    /**
     * Desktop approval dock. Both the phone and the desktop show the same
     * pending approvals; whichever answers first settles the request, and the
     * dock disappears on the next poll. It only appears while a phone is
     * connected (otherwise the shipped desktop approval UI owns the request).
     */
    function ApprovalDock() {
      const [approvals, setApprovals] = useState([])
      const [busyId, setBusyId] = useState(null)

      const load = useCallback(async () => {
        const sources = ['/remote-mobile/pairing/pending', 'http://127.0.0.1:3456/api/desktop/pending']
        for (const url of sources) {
          try {
            const response = await fetch(url, {
              cache: 'no-store',
              credentials: 'omit',
              mode: url.startsWith('http') ? 'cors' : 'same-origin',
            })
            if (!response.ok) continue
            const data = await response.json()
            setApprovals(Array.isArray(data && data.approvals) ? data.approvals : [])
            return
          } catch {
            // try the next source
          }
        }
      }, [])

      useEffect(() => {
        void load()
        const timer = setInterval(() => void load(), 1500)
        return () => clearInterval(timer)
      }, [load])

      const answer = useCallback(async (requestId, decision) => {
        setBusyId(requestId)
        try {
          const sources = ['/remote-mobile/pairing/answer', 'http://127.0.0.1:3456/api/desktop/answer']
          for (const url of sources) {
            try {
              const response = await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ requestId, decision }),
                cache: 'no-store',
                credentials: 'omit',
                mode: url.startsWith('http') ? 'cors' : 'same-origin',
              })
              if (!response.ok) continue
              setApprovals((previous) => previous.filter((item) => item.requestId !== requestId))
              return
            } catch {
              // try the next source
            }
          }
        } catch {
          // Both sources refused; the approval dock stays available for a retry.
        } finally {
          setBusyId(null)
        }
      }, [])

      if (approvals.length === 0) return null
      const item = approvals[0]
      const reason = item.displayReason || item.reason || ''
      const card = {
        position: 'fixed',
        right: '20px',
        bottom: '20px',
        zIndex: 60,
        width: 'min(420px, calc(100vw - 40px))',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        padding: '14px 16px',
        borderRadius: '14px',
        background: 'var(--dsw-alias-bg-overlay)',
        border: '1px solid var(--dsw-alias-border-l2)',
        boxShadow: '0 12px 32px rgba(0, 0, 0, 0.28)',
        color: 'var(--dsw-alias-label-primary)',
      }
      const eyebrow = {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        fontSize: '11px',
        fontWeight: 600,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: 'var(--dsw-alias-state-warn-primary)',
      }
      const tool = {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '13px',
        fontWeight: 600,
      }
      const body = { margin: 0, fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' }
      const actions = { display: 'flex', justifyContent: 'flex-end', gap: '8px' }
      const button = {
        appearance: 'none',
        borderRadius: '8px',
        padding: '7px 12px',
        fontSize: '12px',
        fontWeight: 500,
        cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
      }
      const primary = { ...button, background: 'var(--dsw-alias-label-primary)', borderColor: 'transparent', color: 'var(--dsw-alias-bg-base)', fontWeight: 600 }
      const busy = busyId === item.requestId
      return h('div', { style: card, role: 'status', 'aria-live': 'polite' },
        h('div', { style: eyebrow }, `Approval needed${approvals.length > 1 ? ` · ${approvals.length}` : ''}`),
        h('div', { style: tool }, item.toolName || 'tool'),
        reason.length > 0 ? h('p', { style: body }, reason) : null,
        h('div', { style: actions },
          h('button', { type: 'button', style: button, disabled: busy, onClick: () => void answer(item.requestId, 'reject') }, busy ? 'Sending…' : 'Reject'),
          h('button', { type: 'button', style: primary, disabled: busy, onClick: () => void answer(item.requestId, 'allow') }, busy ? 'Sending…' : 'Approve')))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'remote-mobile',
          order: 60,
          label: 'Remote mobile access',
        }, PairingPanel))
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'remote-mobile-approvals',
          order: 20,
        }, ApprovalDock))
      },
    }
  },
})
