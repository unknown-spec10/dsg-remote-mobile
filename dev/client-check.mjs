// Client-half smoke test: executes the browser factory with a fake module
// loader and React shim, then asserts the settings slot registration.
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

let loaded = null
const window = {
  location: { hostname: '127.0.0.1', protocol: 'http:', href: 'http://127.0.0.1:64459/' },
  __ModuleLoader__: {
    load(descriptor) {
      loaded = descriptor
    },
  },
}
globalThis.window = window

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
new Function('window', source)(window)

assert.ok(loaded, 'client bundle registers a module loader entry')
assert.equal(loaded.id, 'dsh-remote-mobile')
assert.equal(typeof loaded.factory, 'function')

const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('react.fragment'),
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  useEffect: () => {},
  useCallback: (callback) => callback,
  useMemo: (factory) => factory(),
  useRef: () => ({ current: null }),
  useLayoutEffect: () => {},
  memo: (component) => component,
}
let client = null
const previous = globalThis.__clientExports
const exports = loaded.factory((name) => {
  if (name === 'react') return react
  throw new Error(`unexpected require(${name})`)
})
client = exports
globalThis.__clientExports = exports
void previous

assert.equal(typeof client.apply, 'function', 'client half exports apply')
assert.deepEqual(client.inject, ['slots'])

const registrations = []
const ctx = {
  slots: {
    inject(key, callback) {
      registrations.push(`inject:${key}`)
      callback()
    },
    register(spec, component) {
      registrations.push(`register:${spec.name}:${spec.id}`)
      assert.equal(typeof spec.order, 'number')
      assert.equal(typeof component, 'function', 'slot component is a function')
      if (spec.name === 'settings.section') assert.equal(typeof spec.label, 'string')
      return () => {}
    },
  },
}
client.apply(ctx)
assert.ok(registrations.includes('inject:settings.section'), 'injects into settings.section')
assert.ok(registrations.includes('register:settings.section:remote-mobile'), 'registers the pairing panel')
assert.ok(registrations.includes('inject:shell.overlay'), 'injects the desktop approval dock')
assert.ok(registrations.includes('register:shell.overlay:remote-mobile-approvals'), 'registers the approval dock')
console.log('client-half smoke PASS:', registrations.join(' | '))
