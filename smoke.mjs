/**
 * Host-half smoke test: exercise the four routes and the path helpers against
 * a fake `webServer`, without a running GUI.
 *
 * Run with `node smoke.mjs`. Exits non-zero on the first failed assertion.
 */

import assert from 'node:assert/strict'

import { apply } from './index.js'

/** Collect the registered route handler so the test can drive it directly. */
function buildHost() {
  const routes = []
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
      getOrigin() {
        return 'http://127.0.0.1:52844'
      },
    },
    effect(factory) {
      factory()
    },
  }
  apply(ctx)
  assert.equal(routes.length, 1, 'one prefix route is registered')
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/workspace-drive-picker')
  return routes[0].handler
}

/** A tiny request whose body is the given JSON. */
function makeRequest(path, body, headers = {}) {
  const text = body === undefined ? '' : JSON.stringify(body)
  const buffer = Buffer.from(text, 'utf8')
  return {
    method: 'POST',
    url: `http://127.0.0.1:52844/workspace-drive-picker${path}`,
    headers: { 'x-requested-with': 'XMLHttpRequest', ...headers },
    async *[Symbol.asyncIterator]() {
      if (buffer.length > 0) yield buffer
    },
  }
}

/** A response recorder: captures status and the parsed body. */
function makeResponse() {
  const state = { status: 0, body: null }
  return {
    state,
    writeHead(status) {
      state.status = status
    },
    end(payload) {
      state.body = JSON.parse(payload)
    },
  }
}

const handler = buildHost()

/** Run one request through the handler. */
async function call(path, body, headers) {
  const res = makeResponse()
  await handler(makeRequest(path, body, headers), res)
  return res.state
}

// ---- 1. CSRF fence: no marker means no answer ----
{
  const result = await call('/drives', undefined, { 'x-requested-with': '' })
  assert.equal(result.status, 403, 'a request without the marker is refused')
}

// ---- 2. Drive enumeration finds at least one readable root ----
{
  const result = await call('/drives')
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  const facts = result.body.value
  assert.ok(Array.isArray(facts.roots) && facts.roots.length > 0, 'at least one root')
  for (const root of facts.roots) {
    assert.equal(typeof root.label, 'string')
    assert.equal(typeof root.path, 'string')
  }
  assert.equal(typeof facts.home, 'string')
  assert.equal(typeof facts.platform, 'string')
  if (process.platform === 'win32') {
    for (const root of facts.roots) {
      assert.match(root.path, /^[A-Za-z]:\\$/, `windows root form: ${root.path}`)
    }
  }
}

// ---- 3. Listing the home directory returns folders and a full breadcrumb chain ----
{
  const result = await call('/list', { path: '' })
  assert.equal(result.status, 200)
  const listing = result.body.value
  assert.equal(typeof listing.path, 'string')
  assert.ok(listing.crumbs.length >= 2, 'breadcrumbs reach the root')
  assert.equal(listing.crumbs.at(-1).path, listing.path, 'last crumb is the current level')
  assert.equal(listing.crumbs[0].path, listing.crumbs[0].name === '/' ? '/' : listing.crumbs[0].path)
  for (const entry of listing.entries) {
    assert.equal(typeof entry.name, 'string')
    assert.ok(entry.path.toLowerCase().endsWith(entry.name.toLowerCase()), 'entry path ends with its name')
  }
}

// ---- 4. Listing an absent directory fails without throwing out of the handler ----
{
  const result = await call('/list', { path: process.platform === 'win32' ? 'Q:\\nope-not-here' : '/nope-not-here' })
  assert.equal(result.status, 400)
  assert.equal(result.body.ok, false)
  assert.equal(typeof result.body.error.message, 'string')
}

// ---- 5. mkdir rejects an empty path, and creating then listing sees the folder ----
{
  const empty = await call('/mkdir', { path: '' })
  assert.equal(empty.status, 400)

  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const base = await mkdtemp(join(tmpdir(), 'wdp-smoke-'))
  try {
    const target = join(base, 'made here')
    const created = await call('/mkdir', { path: target })
    assert.equal(created.status, 200)
    assert.equal(created.body.value.path, target)

    const listed = await call('/list', { path: base })
    assert.equal(listed.status, 200)
    assert.deepEqual(listed.body.value.entries.map(entry => entry.name), ['made here'])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

// ---- 6. The proxy rejects methods outside the allowlist ----
{
  const result = await call('/remote', { method: 'remoteExec', payload: { command: 'whoami' } })
  assert.equal(result.status, 400)
  assert.match(String(result.body.error.message), /unsupported method/)
}

// ---- 7. An unknown sub-path is a 404, not a crash ----
{
  const result = await call('/whatever', {})
  assert.equal(result.status, 404)
}

console.log('workspace-drive-picker host smoke: all assertions passed')
