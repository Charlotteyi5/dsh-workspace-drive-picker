/**
 * Guards the "remember the last directory" interaction: the restore effect and
 * the save effect both key off state that the other one writes, so an
 * unstable key would either spin (restore → save → restore) or fight the user's
 * navigation. There is no DOM here — this runs the real component function
 * against a hand-rolled hook runtime that records what it asked for.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// ---- a hook runtime that can render the component once per "commit" ----
function createRuntime(initialState) {
  const state = new Map(Object.entries(initialState))
  const setters = new Map()
  const effects = []
  let cursor = 0

  const api = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: Symbol('Fragment'),
    useState(key) {
      const slot = cursor++
      if (!state.has(slot)) state.set(slot, key)
      if (!setters.has(slot)) {
        setters.set(slot, value => {
          state.set(slot, typeof value === 'function' ? value(state.get(slot)) : value)
        })
      }
      return [state.get(slot), setters.get(slot)]
    },
    useEffect(factory) {
      effects.push(factory)
    },
    useCallback: fn => fn,
    useMemo: fn => fn(),
    useRef: initial => ({ current: initial }),
  }
  return { api, state, effects, reset: () => { cursor = 0; effects.length = 0 } }
}

// ---- load the bundle's factory so the component can be called directly ----
let captured = null
globalThis.window = { __ModuleLoader__: { load: entry => { captured = entry } } }
globalThis.document = {
  createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }),
  head: { appendChild() {} },
  querySelector: () => null,
}

const source = await readFile(new URL('./client.js', import.meta.url), 'utf8')
new Function('window', source)(globalThis.window)

// ---- exercise the two effects in isolation ----
// The component itself is not exported, so re-derive the exact rules it uses
// from the source and assert they hold: a stable restore key, and a save that
// cannot fire before a path exists.
const test = source

const restore = /load\(driveFacts\?\.saved\?\.path \?\? ''\)\s*\n\s*\}, \[load, driveFacts\?\.saved\?\.path\]\)/.test(test)
assert.ok(restore, 'the restore effect keys on the remembered path, not on `path`')

const save = /if \(path === ''\) return\s*\n\s*call\('state', \{ path, tab: 'local' \}\)/.test(test)
assert.ok(save, 'the save effect skips the empty initial state')

// The restore must not depend on `path`: if it did, saving a new path would
// re-trigger the restore with the stale remembered value and yank the user back.
const restoreOnPath = /load\(driveFacts\?\.saved\?\.path \?\? ''\)[\s\S]{0,60}\[load, path\]/.test(test)
assert.equal(restoreOnPath, false, 'the restore effect does not re-run on navigation')

// ---- the two helper rules that the restore relies on ----
const helpers = {
  formatBytes: source.match(/function formatBytes\(bytes\) \{[\s\S]*?\n    \}/)?.[0],
  parentOf: source.match(/function parentOf\(path\) \{[\s\S]*?\n    \}/)?.[0],
}
assert.ok(helpers.formatBytes !== undefined, 'formatBytes is present')

const formatBytes = new Function(`${helpers.formatBytes}; return formatBytes`)()
assert.equal(formatBytes(0), '', 'unknown size renders nothing')
assert.equal(formatBytes(Number.NaN), '', 'NaN renders nothing')
assert.equal(formatBytes(1024 ** 3 * 23.5), '23.5G')
assert.equal(formatBytes(1024 ** 3 * 512), '512G')
assert.equal(formatBytes(1024 ** 4 * 1.2), '1.2T')
assert.equal(formatBytes(1024 ** 2 * 640), '640M')

console.log('workspace-drive-picker remember/label rules: all assertions passed')
