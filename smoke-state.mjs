/**
 * Check the two new host behaviours against the real filesystem:
 * volume labels/free space, and the remembered directory.
 */

import assert from 'node:assert/strict'

import { apply } from './index.js'

const routes = []
apply({
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
    getOrigin() {
      return 'http://127.0.0.1:1'
    },
  },
  effect(factory) {
    factory()
  },
})
const handler = routes[0].handler

function makeRequest(path, body) {
  const buffer = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), 'utf8')
  return {
    method: 'POST',
    url: `http://127.0.0.1:1/workspace-drive-picker${path}`,
    headers: { 'x-requested-with': 'XMLHttpRequest' },
    async *[Symbol.asyncIterator]() {
      if (buffer.length > 0) yield buffer
    },
  }
}

async function call(path, body) {
  const state = { status: 0, body: null }
  await handler(makeRequest(path, body), {
    writeHead(status) {
      state.status = status
    },
    end(payload) {
      state.body = JSON.parse(payload)
    },
  })
  return state
}

// ---- 1. Volume labels and free space arrive with the roots ----
{
  const started = Date.now()
  const first = await call('/drives')
  const coldMs = Date.now() - started
  assert.equal(first.status, 200)
  const facts = first.body.value

  const labeled = facts.roots.filter(root => typeof root.volume === 'string' && root.volume !== '')
  console.log(`roots: ${facts.roots.length}, labeled: ${labeled.length}, cold query: ${coldMs} ms`)
  for (const root of facts.roots) {
    console.log(
      `  ${root.label}  volume=${JSON.stringify(root.volume)}  free=${(root.freeBytes / 1e9).toFixed(1)} GB / ${(root.totalBytes / 1e9).toFixed(1)} GB`,
    )
    assert.equal(typeof root.volume, 'string')
    assert.equal(typeof root.freeBytes, 'number')
    assert.equal(typeof root.totalBytes, 'number')
    assert.ok(root.totalBytes >= 0 && root.freeBytes >= 0)
    assert.ok(root.freeBytes <= root.totalBytes, 'free space never exceeds total')
  }
  if (process.platform === 'win32') {
    assert.ok(labeled.length > 0, 'at least one Windows volume reports a label')
  }

  const again = await call('/drives')
  const warmMs = Date.now() - started - coldMs
  console.log(`warm query: ${warmMs} ms (cache should make this much cheaper)`)
  assert.deepEqual(again.body.value.roots, facts.roots, 'the cached answer matches')
  assert.ok(warmMs < coldMs, 'the second call avoids the PowerShell spawn')
}

// ---- 2. The remembered directory round-trips ----
{
  const { rm } = await import('node:fs/promises')
  const { homedir } = await import('node:os')
  const { join } = await import('node:path')
  const stateFile = join(homedir(), '.dsh', 'workspace-drive-picker.json')
  const backup = await import('node:fs/promises').then(fs =>
    fs.readFile(stateFile, 'utf8').catch(() => null),
  )

  try {
    const written = await call('/state', { path: 'D:\\work\\demo', tab: 'local' })
    assert.equal(written.status, 200)
    assert.equal(written.body.value.path, 'D:\\work\\demo')

    const readBack = await call('/drives')
    assert.equal(readBack.body.value.saved.path, 'D:\\work\\demo', 'roots carries the remembered path')

    const remoteTab = await call('/state', { path: 'D:\\work\\demo', tab: 'remote' })
    assert.equal(remoteTab.body.value.tab, 'remote', 'the tab is remembered too')

    // A bogus tab collapses to local rather than persisting nonsense.
    const junk = await call('/state', { path: 'C:\\', tab: 'not-a-tab' })
    assert.equal(junk.body.value.tab, 'local')
  } finally {
    const fs = await import('node:fs/promises')
    if (backup === null) await rm(stateFile, { force: true })
    else await fs.writeFile(stateFile, backup, 'utf8')
  }
}

console.log('workspace-drive-picker volumes/state smoke: all assertions passed')
