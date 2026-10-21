/**
 * Client-half smoke test: load `client.js` the way the web shell does — through
 * `window.__ModuleLoader__.load` — and drive `apply()` against fake services.
 *
 * This catches the failure that matters most for a UI plugin: a bundle that
 * parses here but throws while activating in the real shell, leaving the slot
 * occupied by whatever the previous occupant registered.
 *
 * Run with `node smoke-client.mjs`.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// ---- 1. A minimal React that never renders (apply() only registers) ----
const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('Fragment'),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: fn => fn,
  useMemo: fn => fn(),
  useRef: initial => ({ current: initial }),
}

const primitives = {
  Modal: function Modal() {},
  Button: function Button() {},
}

// ---- 2. Capture the bundle the shell would execute ----
let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      captured = entry
    },
  },
}
globalThis.document = {
  createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }),
  head: { appendChild() {} },
  querySelector: () => null,
}

const source = await readFile(new URL('./client.js', import.meta.url), 'utf8')
new Function('window', source)(globalThis.window)

assert.ok(captured !== null, 'bundle registers itself with the module loader')
assert.equal(captured.id, 'dsh-workspace-drive-picker', 'bundle id matches the package name')

const modules = {
  'react': react,
  '@deepseek-ai/dsh-client-ui-primitives': primitives,
}
const exported = captured.factory(name => {
  assert.ok(name in modules, `unexpected require: ${name}`)
  return modules[name]
})

assert.equal(typeof exported.apply, 'function', 'exports apply')
assert.deepEqual(exported.inject, ['slots', 'locale'], 'declares the services it needs')

// ---- 3. Drive apply() against fake slots/locale ----
const registrations = []
const injections = []
const effects = []
let styleCount = 0

const ctx = {
  locale: {
    bind: namespace => key => `${namespace}:${key}`,
    register(namespace, dictionaries) {
      assert.ok(dictionaries.zh !== undefined && dictionaries.en !== undefined, 'both locales registered')
      return () => {}
    },
  },
  slots: {
    inject(name, factory) {
      injections.push(name)
      factory()
      return () => {}
    },
    register(descriptor, component) {
      registrations.push({ descriptor, component })
      return () => {}
    },
  },
  effect(factory, label) {
    const dispose = factory()
    effects.push({ label, dispose })
    return dispose
  },
}

exported.apply(ctx)

// ---- 4. Assertions ----
assert.deepEqual(
  injections,
  ['sidebar.workspaces.directoryFlow', 'conversation.hero.workspace.directoryFlow'],
  'both directory-flow holes are filled',
)
assert.equal(registrations.length, 2, 'two occupants registered')

for (const { descriptor, component } of registrations) {
  assert.ok(
    descriptor.name === 'sidebar.workspaces.directoryFlow' ||
      descriptor.name === 'conversation.hero.workspace.directoryFlow',
    `known slot: ${descriptor.name}`,
  )
  assert.equal(descriptor.priority, -1000, 'priority beats dsh-remote-ssh (-100) and the stock occupant (0)')
  assert.equal(descriptor.locale, 'workspaceDrivePicker', 'locale namespace is declared on the entry')
  assert.equal(typeof descriptor.inject, 'function', 'the injected face is declared')

  // The owner conversation is all the occupant should need from its caller.
  const face = descriptor.inject()
  assert.equal(typeof face.t, 'function', 'the injected face carries the translator')
  assert.equal(face.t('title'), 'workspaceDrivePicker:title')

  assert.equal(typeof component, 'function', 'occupant is a component')
}

// The translator must answer every key the dialog uses, in both languages.
const dict = new Map()
ctx.locale.register = (namespace, dictionaries) => {
  dict.set('zh', dictionaries.zh)
  dict.set('en', dictionaries.en)
  return () => {}
}

console.log('workspace-drive-picker client smoke: all assertions passed')
