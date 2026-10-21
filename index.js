/**
 * Workspace Drive Picker — host half.
 *
 * The stock "add workspace" flow can only *walk* a directory tree, and Windows
 * has no single filesystem root: the breadcrumbs stop at `D:\` and can never
 * reach `E:\`. This plugin supplies the missing piece — an enumeration of the
 * switchable roots — plus a local directory listing, because the shipped
 * `browse` capability is not mounted in the desktop composition (the desktop
 * uses the native OS chooser instead, which this plugin shadows).
 *
 * Routes, all under one `prefix` registration:
 *
 * | path                              | job |
 * | --------------------------------- | --- |
 * | `/workspace-drive-picker/drives`  | drive letters + home shortcuts |
 * | `/workspace-drive-picker/list`    | one level of the local filesystem |
 * | `/workspace-drive-picker/mkdir`   | create a folder (the picker's "new folder") |
 * | `/workspace-drive-picker/remote`  | allowlisted proxy onto `dsh-remote-ssh` |
 *
 * The remote route exists so the browser half can reuse the SSH directory
 * picker that `dsh-remote-ssh` already ships — the user's existing profiles and
 * remote workspaces keep working untouched. Only `listProfiles` / `listDir` /
 * `mkdir` / `createRemoteWorkspace` are forwarded: a directory picker needs
 * nothing else, so this route can never become a general-purpose SSH console.
 * `createRemoteWorkspace` is the one that matters for correctness — the owner
 * conversation adopts a **local** path, so a remote pick has to be mirrored
 * first and the mirror path handed back (that is what the remote plugin's own
 * picker does too).
 *
 * Every handler answers only requests carrying `X-Requested-With`, the same
 * CSRF fence the other plugin routes use: a cross-site `fetch` cannot set a
 * non-simple header without a preflight, and this server answers no preflights.
 *
 * @module index.js
 */

import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, statfs, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const ROUTE_BASE = '/workspace-drive-picker'

/** Round-trip bound for one proxied `dsh-remote-ssh` call. */
const REMOTE_TIMEOUT_MS = 20_000

/** Methods the browser half may proxy. Deliberately tiny — see the module note. */
const PROXY_METHODS = new Set(['listProfiles', 'listDir', 'mkdir', 'createRemoteWorkspace'])

/** One listing's row bound: the dialog renders a flat list, so a directory with
 *  tens of thousands of children must not ship a multi-megabyte body. */
const MAX_ENTRIES = 500

/** Request body bound, so a hostile page cannot balloon host memory. */
const MAX_BODY_BYTES = 1_000_000

/**
 * How long a volume-label reading stays warm. The query spawns PowerShell
 * (~430 ms measured on this machine), which is far too slow to run on every
 * dialog open, but volume labels and free space change slowly enough that a
 * couple of minutes of staleness is invisible to a user picking a folder.
 */
const VOLUME_CACHE_MS = 2 * 60 * 1000

/** Where the "last opened directory" and the last tab are remembered.
 *  Deliberately on the host, not in the browser: the GUI's origin changes on
 *  every restart (`127.0.0.1:52844` → `:54740` → …), so `localStorage` would
 *  silently forget the preference each time the app is relaunched. */
const STATE_FILE = join(homedir(), '.dsh', 'workspace-drive-picker.json')

/** Services needed: the route registrar, present in every web composition. */
export const inject = ['webServer']


/**
 * True when the shell's own fetch marker is present — the CSRF fence.
 * @param req - the incoming request.
 * @returns whether the marker is present.
 */
function hasRequestedWith(req) {
  const raw = req.headers['x-requested-with']
  return typeof raw === 'string' && raw.length > 0
}

/** Write one JSON body with an explicit status and no caching. */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** Success envelope, matching `dsh-remote-ssh`'s shape so one client path serves both. */
function sendOk(res, value) {
  sendJson(res, 200, { ok: true, value })
}

/** Failure envelope in the same shape. */
function sendError(res, status, message) {
  sendJson(res, status, { ok: false, error: { message } })
}

/**
 * Read and parse a JSON request body.
 * @param req - the incoming request.
 * @returns the parsed object; an empty object for an empty body.
 */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  const parsed = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object')
  }
  return parsed
}

/** Warm cache for the volume-label reading, plus the in-flight promise so a
 *  burst of opens shares one PowerShell spawn. */
let volumeCache = { at: 0, value: null, pending: null }

/**
 * Read each fixed volume's label, size, and free space.
 *
 * Node has no API for a Windows volume label — `statfs` gives sizes only — so
 * the labels come from `Win32_LogicalDisk` through PowerShell. Measured at
 * ~430 ms for six volumes, which is why the answer is cached: a picker must not
 * pay that on every open.
 *
 * `DriveType=3` is "local fixed disk", so removable media and network shares are
 * left out; a stale mapped drive would otherwise stall the list.
 *
 * Any failure (PowerShell missing, policy-blocked, non-Windows) degrades to an
 * empty map — the dialog then shows bare drive letters, which is what it did
 * before labels existed. A volume label is never worth an error dialog.
 *
 * @returns a map of `"C:"` → `{label, totalBytes, freeBytes}`.
 */
async function readVolumeFacts() {
  const now = Date.now()
  if (volumeCache.value !== null && now - volumeCache.at < VOLUME_CACHE_MS) return volumeCache.value
  if (volumeCache.pending !== null) return volumeCache.pending

  volumeCache.pending = (async () => {
    const facts = new Map()
    if (process.platform !== 'win32') return facts
    const script =
      'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ' +
      'Select-Object DeviceID,VolumeName,Size,FreeSpace | ConvertTo-Json -Compress'
    try {
      const { stdout } = await run(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { timeout: 10_000, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
      )
      const parsed = JSON.parse(stdout.trim() === '' ? '[]' : stdout)
      // ConvertTo-Json emits a bare object when exactly one volume matched.
      const rows = Array.isArray(parsed) ? parsed : [parsed]
      for (const row of rows) {
        const id = String(row?.DeviceID ?? '').trim()
        if (!/^[A-Za-z]:$/.test(id)) continue
        const total = Number(row?.Size)
        const free = Number(row?.FreeSpace)
        facts.set(id.toUpperCase(), {
          label: String(row?.VolumeName ?? '').trim(),
          totalBytes: Number.isFinite(total) && total > 0 ? total : 0,
          freeBytes: Number.isFinite(free) && free >= 0 ? free : 0,
        })
      }
    } catch {
      // Leave the map empty: bare letters are a fine fallback.
    }
    return facts
  })().then(
    facts => {
      volumeCache = { at: Date.now(), value: facts, pending: null }
      return facts
    },
    () => {
      volumeCache = { at: Date.now(), value: new Map(), pending: null }
      return new Map()
    },
  )
  return volumeCache.pending
}

/**
 * Enumerate the roots a picker should offer as one-click chips.
 *
 * Windows exposes no listing of the form `C:\..\`, so the letters must be
 * probed: `readdir('D:\\')` succeeds on a mounted volume and fails on an
 * absent or empty one — the same test Explorer's "This PC" performs. Probes run
 * in parallel because a stale mapped network letter can take a moment to fail,
 * and a picker must not stall on a dead mapping.
 *
 * POSIX has a single root, so `/` is the only entry; the home shortcuts below
 * still save the most typing.
 *
 * @returns `{roots, shortcuts, home, platform, separator, saved}`.
 */
async function listRoots() {
  const home = homedir()
  const roots = []

  if (process.platform === 'win32') {
    const [letters, volumes] = await Promise.all([
      Promise.allSettled(
        Array.from({ length: 26 }, async (_unused, index) => {
          const path = `${String.fromCharCode(65 + index)}:\\`
          await readdir(path)
          return path
        }),
      ),
      readVolumeFacts(),
    ])
    for (const outcome of letters) {
      if (outcome.status !== 'fulfilled') continue
      const path = outcome.value
      const key = path.slice(0, 2).toUpperCase()
      const volume = volumes.get(key) ?? null
      roots.push({
        label: path.slice(0, 2),
        path,
        // Empty string when the volume is unlabeled — the client then shows the
        // letter alone rather than an empty parentheses pair.
        volume: volume?.label ?? '',
        freeBytes: volume?.freeBytes ?? 0,
        totalBytes: volume?.totalBytes ?? 0,
      })
    }
  } else {
    roots.push({ label: '/', path: '/', volume: '', freeBytes: 0, totalBytes: 0 })
    for (const mountRoot of ['/Volumes', '/mnt']) {
      let entries
      try {
        entries = await readdir(mountRoot, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
        const path = join(mountRoot, entry.name)
        let freeBytes = 0
        let totalBytes = 0
        try {
          const stats = await statfs(path)
          freeBytes = stats.bavail * stats.bsize
          totalBytes = stats.blocks * stats.bsize
        } catch {
          // A mount that cannot report sizes still lists.
        }
        roots.push({ label: entry.name, path, volume: '', freeBytes, totalBytes })
      }
    }
  }

  // Convenience shortcuts. Labeled per locale on the client; the key is stable.
  const shortcuts = []
  for (const [key, name] of [
    ['downloads', 'Downloads'],
    ['documents', 'Documents'],
    ['desktop', 'Desktop'],
  ]) {
    const path = join(home, name)
    try {
      await readdir(path)
      shortcuts.push({ key, path })
    } catch {
      // Folder absent on this account — offer the rest.
    }
  }

  return {
    roots,
    shortcuts,
    home,
    platform: process.platform,
    separator: sep,
    saved: await readState(),
  }
}

/**
 * Read the remembered picker state.
 *
 * Lives on the host because the GUI's origin changes on every restart, which
 * makes browser storage useless for a preference that has to survive one
 * launch. A corrupt or absent file is simply "nothing remembered" — the
 * preference must never be able to block the dialog.
 *
 * @returns `{path, tab}` with an empty path when nothing is remembered.
 */
async function readState() {
  try {
    const raw = await readFile(STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return {
      path: typeof parsed?.path === 'string' ? parsed.path : '',
      tab: parsed?.tab === 'remote' ? 'remote' : 'local',
    }
  } catch {
    return { path: '', tab: 'local' }
  }
}

/**
 * Persist the remembered picker state. Best-effort: a read-only home or a
 * concurrent writer must not turn remembering into a visible failure.
 * @param state - `{path, tab}` to store.
 */
async function writeState(state) {
  const payload = JSON.stringify(
    {
      path: typeof state.path === 'string' ? state.path : '',
      tab: state.tab === 'remote' ? 'remote' : 'local',
    },
    null,
    2,
  )
  try {
    await mkdir(join(homedir(), '.dsh'), { recursive: true })
    await writeFile(STATE_FILE, `${payload}\n`, 'utf8')
  } catch {
    // Remembering is a convenience, never a requirement.
  }
}

/**
 * Split a path into its ancestor chain, root included, so the breadcrumbs can
 * jump anywhere without a second round trip.
 * @param path - an absolute path.
 * @returns the chain from root down to `path`, each `{name, path}`.
 */
function ancestors(path) {
  const isWindows = /^[A-Za-z]:/.test(path)
  const crumbs = []
  if (isWindows) {
    const parts = path.split(/[\\/]+/).filter((part) => part !== '')
    const drive = parts.shift()
    if (drive === undefined) return [{ name: '/', path: '/' }]
    let current = `${drive}\\`
    crumbs.push({ name: drive, path: current })
    for (const part of parts) {
      current = current.endsWith('\\') ? `${current}${part}` : `${current}\\${part}`
      crumbs.push({ name: part, path: current })
    }
    return crumbs
  }
  const parts = path.split('/').filter((part) => part !== '')
  let current = '/'
  crumbs.push({ name: '/', path: current })
  for (const part of parts) {
    current = current.endsWith('/') ? `${current}${part}` : `${current}/${part}`
    crumbs.push({ name: part, path: current })
  }
  return crumbs
}

/**
 * List one directory level for the picker.
 *
 * Directories are returned sorted by name (numeric-aware, so `v10` sorts after
 * `v9`). Symlinks are kept even when their target is not a directory — they may
 * still lead somewhere, and the browser reports an unreadable target on click
 * rather than hiding a folder the user can reach from Explorer.
 *
 * @param path - absolute directory path; empty opens the home directory.
 * @returns `{path, entries, truncated, crumbs, home}`.
 */
async function listLocal(path) {
  const home = homedir()
  const target = typeof path === 'string' && path.trim() !== '' ? path.trim() : home
  const dirents = await readdir(target, { withFileTypes: true })
  const entries = []
  let truncated = false
  for (const dirent of dirents) {
    if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue
    if (entries.length >= MAX_ENTRIES) {
      truncated = true
      break
    }
    entries.push({ name: dirent.name, path: join(target, dirent.name) })
  }
  entries.sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }))
  return { path: target, entries, truncated, crumbs: ancestors(target), home }
}

/**
 * Forward one allowlisted call to `dsh-remote-ssh`'s HTTP API.
 *
 * That plugin registers `/remote-ssh/api` as a prefix route on this same
 * webserver, so a loopback request is the supported way to reach it without
 * importing its private module. The `Host`/`Origin` of the original request are
 * preserved so its trust verdict matches what the browser's own call would
 * have produced, and `X-Requested-With` satisfies its CSRF fence.
 *
 * @param base - this server's origin.
 * @param req - the original request whose trust headers are forwarded.
 * @param method - one of {@link PROXY_METHODS}.
 * @param payload - JSON body for that method.
 * @returns the inner `value` on success.
 */
async function proxyRemote(base, req, method, payload) {
  if (!PROXY_METHODS.has(method)) throw new Error(`unsupported method: ${method}`)

  const headers = {
    'content-type': 'application/json',
    'x-requested-with': 'XMLHttpRequest',
  }
  for (const name of ['host', 'origin']) {
    const value = req.headers[name]
    if (typeof value === 'string' && value !== '') headers[name] = value
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS)
  try {
    const response = await fetch(`${base}/remote-ssh/api/${method}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    const body = await response.json().catch(() => null)
    if (body !== null && typeof body === 'object' && body.ok === true) return body.value
    throw new Error(String(body?.error?.message ?? body?.error?.code ?? `HTTP ${response.status}`))
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Route one request by its sub-path. Kept as a plain table so a new action is
 * one entry rather than another `webServer.register` effect.
 * @param ctx - the plugin context.
 * @param req - the incoming request.
 * @param res - the response owner.
 */
async function dispatch(ctx, req, res) {
  if (!hasRequestedWith(req)) {
    sendError(res, 403, 'missing X-Requested-With')
    return
  }
  const { pathname } = new URL(req.url ?? '/', 'http://dsh.internal')
  const action = pathname.slice(ROUTE_BASE.length).replace(/^\/+/, '')

  if (req.method !== 'POST' && action !== 'drives') {
    sendError(res, 405, 'method not allowed')
    return
  }

  try {
    switch (action) {
      case 'drives':
        sendOk(res, await listRoots())
        return
      case 'list': {
        const body = await readBody(req)
        sendOk(res, await listLocal(typeof body.path === 'string' ? body.path : ''))
        return
      }
      case 'mkdir': {
        const body = await readBody(req)
        const target = String(body.path ?? '').trim()
        if (target === '') throw new Error('path is required')
        await mkdir(target, { recursive: true })
        sendOk(res, { path: target })
        return
      }
      case 'state': {
        const body = await readBody(req)
        await writeState({ path: body.path, tab: body.tab })
        sendOk(res, await readState())
        return
      }
      case 'remote': {
        const body = await readBody(req)
        const method = typeof body.method === 'string' ? body.method : ''
        const payload = body.payload !== null && typeof body.payload === 'object' ? body.payload : {}
        sendOk(res, await proxyRemote(ctx.webServer.getOrigin(), req, method, payload))
        return
      }
      default:
        sendError(res, 404, `unknown action: ${action}`)
    }
  } catch (error) {
    sendError(res, 400, error instanceof Error ? error.message : String(error))
  }
}

/**
 * Install the route.
 * @param ctx - the plugin context (provides `webServer`).
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_BASE,
        handler: (req, res) => dispatch(ctx, req, res),
      }),
    'workspace-drive-picker: local picker routes',
  )
}
