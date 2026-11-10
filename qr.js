// QR rendering for the pairing URL. Wraps the vendored MIT encoder so the
// server can return a compact, crisp SVG without any network dependency.
import qrcode from './vendor/qrcode.js'

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * Render `text` as a QR code SVG string.
 * @param {string} text
 * @param {{ cellSize?: number, margin?: number, dark?: string, light?: string }} [options]
 * @returns {string}
 */
export function qrSvg(text, options = {}) {
  const cellSize = options.cellSize ?? 6
  const margin = options.margin ?? 2
  const dark = options.dark ?? '#0B0D12'
  const light = options.light ?? '#FFFFFF'
  const code = qrcode(0, 'M')
  code.addData(text, 'Byte')
  code.make()
  const count = code.getModuleCount()
  const size = count * cellSize + margin * 2
  const parts = []
  for (let row = 0; row < count; row += 1) {
    let col = 0
    while (col < count) {
      if (!code.isDark(row, col)) {
        col += 1
        continue
      }
      let run = 1
      while (col + run < count && code.isDark(row, col + run)) run += 1
      parts.push(`M${margin + col * cellSize},${margin + row * cellSize}h${run * cellSize}v${cellSize}h-${run * cellSize}z`)
      col += run
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="Pairing QR code"><rect width="${size}" height="${size}" fill="${escapeXml(light)}"/><path d="${parts.join('')}" fill="${escapeXml(dark)}"/></svg>`
}

/** A data URI form for embedding in an `<img>` without inlining raw SVG. */
export function qrDataUri(text, options = {}) {
  return `data:image/svg+xml;base64,${Buffer.from(qrSvg(text, options), 'utf8').toString('base64')}`
}
