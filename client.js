/**
 * Workspace Drive Picker — browser half.
 *
 * Shadows the "add workspace" directory flow in both slots
 * (`sidebar.workspaces.directoryFlow` and `conversation.hero.workspace.directoryFlow`)
 * so the dialog opens on something a Windows user can actually navigate:
 *
 *  - **Drives** — a row of one-click chips for every mounted volume. This is the
 *    whole point: Windows has no filesystem root above `C:\`, so a breadcrumb
 *    walk can never cross to `D:\`, and the stock dialog has no drive switcher
 *    at all. The host enumerates them (see `index.js`).
 *  - **This PC** — the same list as a normal row section, so a drive can also be
 *    reached by scrolling rather than by the chips.
 *  - **A path box that is always visible** — type or paste any absolute path.
 *  - **Breadcrumbs from the root, never folded at home** — the stock dialog
 *    collapses its trail at the home directory, which is exactly where the
 *    other drives become unreachable.
 *  - **Remote** — the same two-tab experience `dsh-remote-ssh` provides, because
 *    this plugin shadows *its* dialog too. Both are kept: local picks get the
 *    drive support, and the SSH profiles the user already configured keep
 *    working through that plugin's own host API (proxied by our host half).
 *
 * Priority is `-1000`, below `dsh-remote-ssh`'s `-100`: DSH's slot system
 * renders the lowest-priority occupant, so this plugin wins while remaining a
 * drop-in replacement — uninstalling it puts the previous dialog straight back.
 *
 * @module client.js
 */

window.__ModuleLoader__.load({
  id: 'dsh-workspace-drive-picker',
  factory: require => {
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = React
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    /** Priority that beats `dsh-remote-ssh` (-100) and every stock occupant (0). */
    const SLOT_PRIORITY = -1000

    const SLOT_SIDEBAR = 'sidebar.workspaces.directoryFlow'
    const SLOT_HERO = 'conversation.hero.workspace.directoryFlow'

    const NS = 'workspaceDrivePicker'
    const API = '/workspace-drive-picker'

    const DICT = {
      zh: {
        'title': '选择工作区目录',
        'tab.local': '本机',
        'tab.remote': '远程',
        'thisPc': '此电脑',
        'shortcut.downloads': '下载',
        'shortcut.documents': '文档',
        'shortcut.desktop': '桌面',
        'home': '主目录',
        'open': '打开',
        'go': '转到',
        'up': '上级',
        'choose': '选择此目录',
        'newFolder': '新建文件夹',
        'newFolderIn': '在“{name}”中新建文件夹',
        'folderName': '文件夹名称',
        'create': '创建',
        'cancel': '取消',
        'loading': '加载中…',
        'empty': '这里没有子文件夹',
        'truncated': '文件夹过多，只显示前面一部分。',
        'pathPlaceholder': '输入或粘贴绝对路径，回车跳转',
        'errList': '无法列出该目录',
        'errCreate': '创建文件夹失败',
        'errPath': '路径无效',
        'pickDrive': '切换到此盘',
        'free': '可用 {size} / 共 {total}',
        'profile': '连接',
        'selectProfile': '选择连接…',
        'remotePath': '远程路径',
        'noProfiles': '还没有 SSH 连接，请先在设置 → 远程连接 里添加。',
        'needProfile': '先选择一个连接',
      },
      en: {
        'title': 'Select Workspace Directory',
        'tab.local': 'Local',
        'tab.remote': 'Remote',
        'thisPc': 'This PC',
        'shortcut.downloads': 'Downloads',
        'shortcut.documents': 'Documents',
        'shortcut.desktop': 'Desktop',
        'home': 'Home',
        'open': 'Open',
        'go': 'Go',
        'up': 'Up',
        'choose': 'Select this folder',
        'newFolder': 'New folder',
        'newFolderIn': 'New folder in “{name}”',
        'folderName': 'Folder name',
        'create': 'Create',
        'cancel': 'Cancel',
        'loading': 'Loading…',
        'empty': 'No subfolders here',
        'truncated': 'Too many folders; only the beginning is shown.',
        'pathPlaceholder': 'Type or paste an absolute path, then press Enter',
        'errList': 'Cannot list this folder',
        'errCreate': 'Could not create the folder',
        'errPath': 'Invalid path',
        'pickDrive': 'Switch to this drive',
        'free': '{size} free of {total}',
        'profile': 'Connection',
        'selectProfile': 'Select a connection…',
        'remotePath': 'Remote path',
        'noProfiles': 'No SSH connections yet. Add one in Settings → Remote connections.',
        'needProfile': 'Select a connection first',
      },
    }

    const CSS = `
.wdp_dialog{width:min(680px,100%);height:min(560px,100dvh - 32px);padding:0;display:flex;flex-direction:column;gap:0;overflow:hidden}
.wdp_sheet{display:flex;flex-direction:column;gap:0;flex:1 1 0;min-height:0;height:100%}
.wdp_head{flex:none;display:flex;flex-direction:column;gap:8px;padding:14px 16px 8px}
.wdp_tabRow{display:flex;gap:6px;align-items:center}
.wdp_tab{border:1px solid var(--dsw-alias-border-l2);background:0 0;border-radius:999px;padding:3px 12px;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.wdp_tab:hover{color:var(--dsw-alias-label-primary)}
.wdp_tab.wdp_active{background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3)}
.wdp_driveRow{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.wdp_drive{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l2);background:0 0;border-radius:var(--dsw-radius-sm);padding:3px 10px;font:inherit;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;max-width:100%}
.wdp_drive:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.wdp_drive.wdp_active{background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l4)}
.wdp_driveIcon{font-size:12px;opacity:.75;flex:none}
.wdp_driveMain{display:inline-flex;flex-direction:column;gap:0;min-width:0;text-align:left}
.wdp_driveLetter{font-weight:600;color:var(--dsw-alias-label-primary);font-size:12.5px;line-height:16px}
.wdp_driveVolume{font-size:11px;line-height:14px;color:var(--dsw-alias-label-tertiary);max-width:140px;overflow:hidden;text-overflow:ellipsis}
.wdp_driveFree{font-size:11px;line-height:14px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.wdp_crumbs{display:flex;align-items:center;gap:3px;flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;min-height:24px}
.wdp_crumb{border:none;background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;line-height:20px;padding:0 2px;cursor:pointer;white-space:nowrap;max-width:180px;overflow:hidden;text-overflow:ellipsis}
.wdp_crumb:hover{color:var(--dsw-alias-label-primary)}
.wdp_crumbSep{color:var(--dsw-alias-label-tertiary);flex:none;opacity:.6}
.wdp_pathRow{display:flex;gap:6px;align-items:center}
.wdp_path{flex:1 1 0;min-width:0;height:28px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;padding:0 8px;outline:none}
.wdp_path:focus{border-color:var(--dsw-alias-border-l4)}
.wdp_body{flex:1 1 0;min-height:0;overflow-y:auto;padding:4px 10px 10px 16px;display:flex;flex-direction:column;gap:1px}
.wdp_section{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;padding:6px 6px 2px}
.wdp_row{display:flex;align-items:center;gap:6px;border:none;background:0 0;border-radius:var(--dsw-radius-sm);text-align:left;padding:4px 6px;min-height:28px;font:inherit;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;cursor:pointer;width:100%}
.wdp_row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.wdp_rowName{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wdp_rowIcon{flex:none;color:var(--dsw-alias-label-secondary);font-size:13px}
.wdp_status{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;padding:6px}
.wdp_error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;padding:6px}
.wdp_foot{flex:none;display:flex;gap:8px;align-items:center;padding:12px 16px;border-top:.5px solid var(--dsw-alias-border-l3)}
.wdp_close{border:none;background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:14px;line-height:20px;cursor:pointer;padding:0 4px}
.wdp_close:hover{color:var(--dsw-alias-label-primary)}
.wdp_close:disabled{opacity:.4;cursor:default}
.wdp_footGap{flex:1 1 0}
.wdp_btn{height:28px;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l3);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:0 12px;cursor:pointer}
.wdp_btn:disabled{opacity:.45;cursor:default}
.wdp_btn.wdp_primary{background:var(--dsw-alias-button-info-fill,#3b6ef6);border-color:transparent;color:#fff}
.wdp_btn.wdp_primary:disabled{opacity:.5}
.wdp_createCard{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35);z-index:60}
.wdp_createBox{width:min(380px,92vw);background:var(--dsw-alias-bg-layer-2,#fff);border-radius:var(--dsw-radius-lg,10px);padding:18px 20px;display:flex;flex-direction:column;gap:10px;box-shadow:0 12px 40px rgba(0,0,0,.28)}
.wdp_createTitle{font-size:15px;line-height:22px;color:var(--dsw-alias-label-primary);margin:0}
.wdp_createInput{height:34px;border:1px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;padding:0 8px;outline:none}
.wdp_createActions{display:flex;justify-content:flex-end;gap:8px}
`

    // ---------------------------------------------------------------------
    // Wire helpers
    // ---------------------------------------------------------------------

    /** One shell-relative JSON call with the CSRF marker every route expects. */
    async function call(action, body) {
      const response = await fetch(`${API}/${action}`, {
        method: action === 'drives' ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' },
        body: action === 'drives' ? undefined : JSON.stringify(body ?? {}),
      })
      const payload = await response.json().catch(() => null)
      if (payload !== null && typeof payload === 'object' && payload.ok === true) return payload.value
      throw new Error(String(payload?.error?.message ?? `HTTP ${response.status}`))
    }

    /** Proxy one allowlisted `dsh-remote-ssh` call through our host half. */
    const remoteCall = (method, payload) => call('remote', { method, payload: payload ?? {} })

    // ---------------------------------------------------------------------
    // Path helpers (Windows and POSIX)
    // ---------------------------------------------------------------------

    const isWindowsPath = path => /^[A-Za-z]:/.test(path ?? '') || (path ?? '').includes('\\')

    /** Parent directory, or null at a root. `C:\` and `/` are their own parents. */
    function parentOf(path) {
      const raw = String(path ?? '').replace(/[\\/]+$/, '')
      if (raw === '') return null
      if (/^[A-Za-z]:$/.test(raw)) return raw + '\\'
      const index = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'))
      if (index < 0) return null
      const parent = raw.slice(0, index)
      if (/^[A-Za-z]:$/.test(parent)) return parent + '\\'
      return parent === '' ? (isWindowsPath(path) ? null : '/') : parent
    }

    /** Join one child name onto a base, honouring the base's own separator. */
    function joinChild(base, name) {
      const raw = String(base ?? '')
      const trimmed = raw.replace(/[\\/]+$/, '')
      if (trimmed === '') return (raw.startsWith('/') ? '/' : '') + String(name)
      const usesBackslash = /^[A-Za-z]:$/.test(trimmed) || (trimmed.includes('\\') && !trimmed.includes('/'))
      return trimmed + (usesBackslash ? '\\' : '/') + String(name)
    }

    /** Last segment of a path, for the "new folder in X" sentence. */
    function baseName(path) {
      const raw = String(path ?? '').replace(/[\\/]+$/, '')
      if (/^[A-Za-z]:$/.test(raw)) return raw
      const parts = raw.split(/[\\/]+/).filter(Boolean)
      return parts.at(-1) ?? raw
    }

    /**
     * Free space as a short label: `512M`, `23.5G`, `1.2T`.
     *
     * Only one decimal where it matters and none above three digits, so the
     * chips stay one line wide: `9.9G` reads at a glance, `9.87G` does not.
     * Returns an empty string when the size is unknown, and the caller then
     * omits the element entirely rather than showing "undefined".
     *
     * @param bytes - a byte count, or a non-number for "unknown".
     * @returns the label, or `''`.
     */
    function formatBytes(bytes) {
      const value = Number(bytes)
      if (!Number.isFinite(value) || value <= 0) return ''
      const units = [
        [1024 ** 4, 'T'],
        [1024 ** 3, 'G'],
        [1024 ** 2, 'M'],
      ]
      for (const [size, suffix] of units) {
        if (value >= size) {
          const scaled = value / size
          const digits = scaled >= 100 ? 0 : 1
          return `${scaled.toFixed(digits)}${suffix}`
        }
      }
      return `${Math.max(1, Math.round(value / 1024))}K`
    }

    // ---------------------------------------------------------------------
    // Local panel
    // ---------------------------------------------------------------------

    function LocalPanel(props) {
      const { t, driveFacts, onPicked, busy, alert } = props
      const [path, setPath] = useState('')
      const [draft, setDraft] = useState('')
      const [listing, setListing] = useState(null)
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState(null)
      const [creating, setCreating] = useState(null)
      const [createBusy, setCreateBusy] = useState(false)
      const [createError, setCreateError] = useState(null)
      const alive = useRef(true)
      const sequence = useRef(0)

      // Re-arm on every effect run, not just the first: React 18 runs
      // mount → cleanup → mount, and an effect that only ever clears the flag
      // leaves it stuck at `false` after the first cleanup — every response
      // would be dropped, the dialog would sit on "loading", and its buttons
      // (including Open) would stay disabled with nothing visibly wrong.
      useEffect(() => {
        alive.current = true
        return () => { alive.current = false }
      }, [])

      const load = useCallback(target => {
        const ticket = ++sequence.current
        setLoading(true)
        setError(null)
        call('list', { path: target ?? '' }).then(
          value => {
            if (!alive.current || ticket !== sequence.current) return
            setListing(value)
            setPath(value.path)
            setDraft(value.path)
            setLoading(false)
            alert(null)
          },
          reason => {
            if (!alive.current || ticket !== sequence.current) return
            setLoading(false)
            setError(reason instanceof Error ? reason.message : String(reason))
            // Keep the previous level standing: a typo must not blank the dialog.
          },
        )
      }, [alert])

      // Open where the last pick started, falling back to the host's home
      // directory. `driveFacts.saved` comes from the host, not from browser
      // storage: the GUI origin changes on every restart, so `localStorage`
      // would lose this preference each launch. An unreadable remembered
      // directory (deleted, or on a drive that is now unplugged) is handled by
      // the listing failure path and simply leaves the dialog on the error —
      // the user can still pick a chip or type a path.
      useEffect(() => {
        load(driveFacts?.saved?.path ?? '')
      }, [load, driveFacts?.saved?.path])

      // Remember every level the user lands on, so reopening resumes there.
      // Fire-and-forget: remembering must never delay or block the dialog.
      useEffect(() => {
        if (path === '') return
        call('state', { path, tab: 'local' }).catch(() => {})
      }, [path])

      const submitDraft = useCallback(() => {
        const target = draft.trim()
        if (target === '') return
        load(target)
      }, [draft, load])

      const currentDrive = useMemo(() => {
        if (!isWindowsPath(path)) return null
        const match = /^([A-Za-z]:)/.exec(path)
        return match === null ? null : match[1]
      }, [path])

      const createFolder = useCallback(() => {
        const name = String(creating ?? '').trim()
        if (name === '' || createBusy) return
        if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
          setCreateError(t('errPath'))
          return
        }
        const target = joinChild(path, name)
        setCreateBusy(true)
        setCreateError(null)
        call('mkdir', { path: target }).then(
          () => {
            if (!alive.current) return
            setCreateBusy(false)
            setCreating(null)
            load(target)
          },
          reason => {
            if (!alive.current) return
            setCreateBusy(false)
            setCreateError(reason instanceof Error ? reason.message : String(reason))
          },
        )
      }, [creating, createBusy, path, load, t])

      const roots = driveFacts?.roots ?? []
      const shortcuts = driveFacts?.shortcuts ?? []
      // At a drive root there is nothing above it — Windows has no filesystem
      // parent to walk to, and the drive chips are the way across. Disabling the
      // button says so, instead of reloading the same level behind a live click.
      const up = parentOf(path)
      const canGoUp = up !== null && up.replace(/[\\/]+$/, '') !== path.replace(/[\\/]+$/, '')

      return h(React.Fragment, null,
        // ---- drive chips: the whole reason this plugin exists ----
        h('div', { className: 'wdp_driveRow' },
          roots.map(root => {
            const active = currentDrive !== null && root.path.toUpperCase().startsWith(currentDrive.toUpperCase())
            const free = formatBytes(root.freeBytes)
            const volume = typeof root.volume === 'string' ? root.volume : ''
            return h('button', {
              key: root.path,
              type: 'button',
              className: `wdp_drive${active ? ' wdp_active' : ''}`,
              // The tooltip carries the exact path plus the full capacity, so the
              // chip can stay compact while still answering "which disk is this?".
              title: volume === '' ? root.path : `${root.path}  ${volume}\n${t('free').replace('{size}', free).replace('{total}', formatBytes(root.totalBytes))}`,
              disabled: busy,
              onClick: () => load(root.path),
            },
              h('span', { className: 'wdp_driveIcon', 'aria-hidden': 'true' }, '💽'),
              h('span', { className: 'wdp_driveMain' },
                h('span', { className: 'wdp_driveLetter' }, root.label),
                volume === '' ? null : h('span', { className: 'wdp_driveVolume' }, volume),
              ),
              free === '' ? null : h('span', { className: 'wdp_driveFree' }, free),
            )
          }),
          shortcuts.length > 0 ? h('span', { className: 'wdp_crumbSep', 'aria-hidden': 'true' }, '·') : null,
          shortcuts.map(shortcut => h('button', {
            key: shortcut.path,
            type: 'button',
            className: 'wdp_drive',
            title: shortcut.path,
            disabled: busy,
            onClick: () => load(shortcut.path),
          }, t(`shortcut.${shortcut.key}`))),
        ),

        // ---- breadcrumbs, never folded at home ----
        h('div', { className: 'wdp_crumbs' },
          (listing?.crumbs ?? []).map((crumb, index) => h(React.Fragment, { key: crumb.path },
            index > 0 ? h('span', { className: 'wdp_crumbSep', 'aria-hidden': 'true' }, '›') : null,
            h('button', {
              type: 'button',
              className: 'wdp_crumb',
              disabled: busy,
              title: crumb.path,
              onClick: () => load(crumb.path),
            }, crumb.name),
          )),
        ),

        // ---- always-visible path box ----
        h('div', { className: 'wdp_pathRow' },
          h('input', {
            className: 'wdp_path',
            value: draft,
            placeholder: t('pathPlaceholder'),
            'aria-label': t('pathPlaceholder'),
            spellCheck: false,
            disabled: busy,
            onChange: event => setDraft(event.target.value),
            onKeyDown: event => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              submitDraft()
            },
          }),
          h('button', {
            type: 'button',
            className: 'wdp_btn',
            disabled: busy || loading || draft.trim() === '',
            onClick: submitDraft,
          }, t('go')),
        ),

        // ---- one level ----
        h('div', { className: 'wdp_body' },
          error !== null ? h('div', { className: 'wdp_error', role: 'alert' }, `${t('errList')}: ${error}`) : null,
          loading ? h('div', { className: 'wdp_status', role: 'status' }, t('loading')) : null,
          !loading && listing !== null && listing.entries.length === 0
            ? h('div', { className: 'wdp_status' }, t('empty'))
            : null,
          (listing?.entries ?? []).map(entry => h('button', {
            key: entry.path,
            type: 'button',
            className: 'wdp_row',
            disabled: busy,
            title: entry.path,
            onClick: () => load(entry.path),
          },
            h('span', { className: 'wdp_rowIcon', 'aria-hidden': 'true' }, '📁'),
            h('span', { className: 'wdp_rowName' }, entry.name),
          )),
          listing?.truncated === true ? h('div', { className: 'wdp_status' }, t('truncated')) : null,
        ),

        // ---- footer ----
        h('div', { className: 'wdp_foot' },
          h('button', {
            type: 'button',
            className: 'wdp_btn',
            disabled: busy || !canGoUp,
            onClick: () => { if (canGoUp) load(up) },
          }, t('up')),
          h('button', {
            type: 'button',
            className: 'wdp_btn',
            disabled: busy || path === '',
            onClick: () => { setCreating(''); setCreateError(null) },
          }, t('newFolder')),
          h('div', { className: 'wdp_footGap' }),
          h('button', {
            type: 'button',
            className: 'wdp_btn wdp_primary',
            disabled: busy || path === '' || loading,
            onClick: () => onPicked(path),
          }, busy ? t('loading') : t('choose')),
        ),

        // ---- new-folder dialog ----
        creating === null ? null : h('div', { className: 'wdp_createCard', role: 'presentation' },
          h('div', { className: 'wdp_createBox', role: 'dialog', 'aria-modal': 'true' },
            h('p', { className: 'wdp_createTitle' }, t('newFolderIn').replace('{name}', baseName(path))),
            h('input', {
              className: 'wdp_createInput',
              value: creating,
              autoFocus: true,
              placeholder: t('folderName'),
              'aria-label': t('folderName'),
              disabled: createBusy,
              onChange: event => setCreating(event.target.value),
              onKeyDown: event => {
                if (event.key === 'Enter') { event.preventDefault(); createFolder() }
                if (event.key === 'Escape') { event.preventDefault(); setCreating(null) }
              },
            }),
            createError !== null ? h('div', { className: 'wdp_error', role: 'alert' }, `${t('errCreate')}: ${createError}`) : null,
            h('div', { className: 'wdp_createActions' },
              h('button', { type: 'button', className: 'wdp_btn', disabled: createBusy, onClick: () => setCreating(null) }, t('cancel')),
              h('button', { type: 'button', className: 'wdp_btn wdp_primary', disabled: createBusy || String(creating).trim() === '', onClick: createFolder }, createBusy ? t('loading') : t('create')),
            ),
          ),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // Remote panel — reuses the SSH profiles and API of `dsh-remote-ssh`
    // ---------------------------------------------------------------------

    function RemotePanel(props) {
      const { t, onPicked, onError, busy, alert } = props
      const [profiles, setProfiles] = useState(null)
      const [profileId, setProfileId] = useState('')
      const [listing, setListing] = useState(null)
      const [path, setPath] = useState('/')
      const [draft, setDraft] = useState('/')
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState(null)
      const [creating, setCreating] = useState(false)
      const alive = useRef(true)
      const sequence = useRef(0)

      // Re-armed per effect run for the same reason as the local panel: a
      // cleanup-only effect would leave this `false` after React 18's
      // mount/cleanup/mount cycle and silently drop every profile and listing
      // answer, so the remote tab would render as permanently empty.
      useEffect(() => {
        alive.current = true
        return () => { alive.current = false }
      }, [])

      useEffect(() => {
        remoteCall('listProfiles').then(
          value => {
            if (!alive.current) return
            const list = Array.isArray(value?.profiles) ? value.profiles : []
            setProfiles(list)
            if (list.length > 0) setProfileId(list[0].id)
          },
          reason => {
            if (!alive.current) return
            setProfiles([])
            setError(reason instanceof Error ? reason.message : String(reason))
          },
        )
      }, [])

      const load = useCallback((id, target) => {
        if (id === '' || id === undefined || id === null) return
        const ticket = ++sequence.current
        setLoading(true)
        setError(null)
        const wanted = String(target ?? '').trim()
        remoteCall('listDir', { profileId: id, path: wanted === '' ? undefined : wanted }).then(
          value => {
            if (!alive.current || ticket !== sequence.current) return
            const parent = String(value?.path ?? '')
            const entries = (Array.isArray(value?.entries) ? value.entries : [])
              .filter(entry => entry?.type === 'directory')
              .map(entry => ({
                name: String(entry.name ?? ''),
                path: parent === '' ? String(entry.name ?? '') : `${parent.replace(/\/+$/, '')}/${entry.name}`,
              }))
            setListing({ path: parent, entries })
            setPath(parent)
            setDraft(parent)
            setLoading(false)
            alert(null)
          },
          reason => {
            if (!alive.current || ticket !== sequence.current) return
            setLoading(false)
            setError(reason instanceof Error ? reason.message : String(reason))
          },
        )
      }, [alert])

      useEffect(() => {
        if (profileId === '') return
        load(profileId, '/')
      }, [profileId, load])

      const submitDraft = useCallback(() => {
        if (draft.trim() === '') return
        load(profileId, draft.trim())
      }, [draft, load, profileId])

      if (profiles !== null && profiles.length === 0) {
        return h('div', { className: 'wdp_status' }, t('noProfiles'))
      }

      const parent = path === '/' ? null : path.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/'
      const base = '/' + path.replace(/^\/+/, '')

      return h(React.Fragment, null,
        h('div', { className: 'wdp_pathRow' },
          h('select', {
            className: 'wdp_path',
            value: profileId,
            'aria-label': t('profile'),
            disabled: busy,
            onChange: event => setProfileId(event.target.value),
          },
            profiles === null ? h('option', { value: '' }, t('loading'))
              : profiles.map(profile => h('option', { key: profile.id, value: profile.id }, profile.name ?? profile.host)),
          ),
        ),
        h('div', { className: 'wdp_crumbs' },
          path.split('/').filter(Boolean).map((part, index) => {
            const target = '/' + path.split('/').filter(Boolean).slice(0, index + 1).join('/')
            return h(React.Fragment, { key: target },
              h('span', { className: 'wdp_crumbSep', 'aria-hidden': 'true' }, '›'),
              h('button', {
                type: 'button',
                className: 'wdp_crumb',
                disabled: busy,
                title: target,
                onClick: () => load(profileId, target),
              }, part),
            )
          }),
        ),
        h('div', { className: 'wdp_pathRow' },
          h('input', {
            className: 'wdp_path',
            value: draft,
            placeholder: t('remotePath'),
            'aria-label': t('remotePath'),
            spellCheck: false,
            disabled: busy,
            onChange: event => setDraft(event.target.value),
            onKeyDown: event => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              submitDraft()
            },
          }),
          h('button', { type: 'button', className: 'wdp_btn', disabled: busy || loading, onClick: submitDraft }, t('open')),
        ),
        h('div', { className: 'wdp_body' },
          error !== null ? h('div', { className: 'wdp_error', role: 'alert' }, `${t('errList')}: ${error}`) : null,
          loading ? h('div', { className: 'wdp_status', role: 'status' }, t('loading')) : null,
          !loading && listing !== null && listing.entries.length === 0 ? h('div', { className: 'wdp_status' }, t('empty')) : null,
          (listing?.entries ?? []).map(entry => h('button', {
            key: entry.path,
            type: 'button',
            className: 'wdp_row',
            disabled: busy,
            title: entry.path,
            onClick: () => load(profileId, entry.path),
          },
            h('span', { className: 'wdp_rowIcon', 'aria-hidden': 'true' }, '📁'),
            h('span', { className: 'wdp_rowName' }, entry.name),
          )),
        ),
        h('div', { className: 'wdp_foot' },
          h('button', {
            type: 'button',
            className: 'wdp_btn',
            disabled: busy || parent === null,
            onClick: () => { if (parent !== null) load(profileId, parent) },
          }, t('up')),
          h('div', { className: 'wdp_footGap' }),
          h('button', {
            type: 'button',
            className: 'wdp_btn wdp_primary',
            disabled: busy || creating || profileId === '' || path === '',
            onClick: () => {
              // The owner adopts a LOCAL directory path, so a remote pick must
              // first become a remote workspace (mirrored into a real local
              // folder) and only then hand the mirror path over. Passing the
              // bare remote path would create a nonsense workspace on disk.
              setCreating(true)
              alert(null)
              remoteCall('createRemoteWorkspace', { profileId, remotePath: base }).then(
                value => {
                  if (!alive.current) return
                  setCreating(false)
                  const mirror = String(value?.mirrorPath ?? '')
                  if (mirror === '') {
                    const message = t('errCreate')
                    setError(message)
                    onError?.(message)
                    return
                  }
                  onPicked(mirror)
                },
                reason => {
                  if (!alive.current) return
                  setCreating(false)
                  const message = reason instanceof Error ? reason.message : String(reason)
                  setError(message)
                },
              )
            },
          }, busy || creating ? t('loading') : t('choose')),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // The flow occupant itself
    // ---------------------------------------------------------------------

    function DrivePickerFlow(props) {
      const t = props.t
      const [tab, setTab] = useState('local')
      const [driveFacts, setDriveFacts] = useState(null)
      const [notice, setNotice] = useState(null)
      const opened = useRef(false)

      // The owner keeps `open` true while it adopts the pick (busy), so a
      // re-render must not reset the tab or re-read the drives.
      useEffect(() => {
        if (!props.open) { opened.current = false; return }
        if (opened.current) return
        opened.current = true
        setTab('local')
        setNotice(null)
        call('drives').then(
          value => setDriveFacts(value),
          reason => setNotice(reason instanceof Error ? reason.message : String(reason)),
        )
      }, [props.open])

      if (!props.open) return null

      const close = () => { if (!props.busy) props.onCancel() }

      return h(primitives?.Modal ?? FallbackModal, {
        open: true,
        onClose: close,
        title: t('title'),
        className: 'wdp_dialog',
        closeLabel: t('cancel'),
        // Headless: the stock Modal wraps children in its own `.content`/`.body`
        // boxes, which would break the column layout this dialog depends on —
        // the panels use `flex:1` on the listing and a fixed footer, and a
        // wrapper in between lets the footer be pushed out of the card.
        headless: true,
      },
        h('div', { className: 'wdp_sheet' },
          h('div', { className: 'wdp_head' },
            h('div', { className: 'wdp_tabRow' },
              h('button', {
                type: 'button',
                className: `wdp_tab${tab === 'local' ? ' wdp_active' : ''}`,
                disabled: props.busy,
                onClick: () => setTab('local'),
              }, t('tab.local')),
              h('button', {
                type: 'button',
                className: `wdp_tab${tab === 'remote' ? ' wdp_active' : ''}`,
                disabled: props.busy,
                onClick: () => setTab('remote'),
              }, t('tab.remote')),
              h('div', { className: 'wdp_footGap' }),
              h('button', {
                type: 'button',
                className: 'wdp_close',
                'aria-label': t('cancel'),
                disabled: props.busy,
                onClick: close,
              }, '✕'),
            ),
            notice !== null ? h('div', { className: 'wdp_error', role: 'alert' }, notice) : null,
          ),
          tab === 'local'
            ? h(LocalPanel, {
              t,
              driveFacts,
              busy: props.busy,
              onPicked: props.onPicked,
              alert: setNotice,
            })
            : h(RemotePanel, {
              t,
              busy: props.busy,
              onPicked: props.onPicked,
              onError: props.onError,
              alert: setNotice,
            }),
        ),
      )
    }

    /**
     * A minimal modal used only if the primitives package does not expose one.
     * The stock bundle always provides `Modal`, so this is a safety net rather
     * than a second design.
     */
    function FallbackModal(props) {
      if (!props.open) return null
      return h('div', { className: 'wdp_createCard', role: 'presentation' },
        h('div', {
          className: 'wdp_createBox',
          role: 'dialog',
          'aria-modal': 'true',
          style: { width: 'min(680px,100%)', height: 'min(560px,100dvh - 32px)' },
        },
          props.title === undefined ? null : h('p', { className: 'wdp_createTitle' }, props.title),
          props.children,
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(NS) : key => (DICT.zh[key] ?? key)

        ctx.effect(() => {
          if (typeof ctx.locale?.register !== 'function') return () => {}
          return ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en })
        }, 'workspace-drive-picker: dictionaries')

        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-plugin', 'dsh-workspace-drive-picker')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'workspace-drive-picker: styles')

        // `inject` supplies the face each occupant receives, exactly as the
        // stock browse surface does: the owner passes only its conversation
        // (`open`/`busy`/`onPicked`/`onCancel`/`onError`), everything else —
        // including the bound translator — comes from here.
        const injected = () => ({ t })
        const occupant = owner => h(DrivePickerFlow, { ...owner, t })

        // Both holes get the same dialog: the sidebar's "+" and the
        // conversation hero's workspace picker are two entry points into one
        // flow, and a drive switcher is wanted from either.
        ctx.slots.inject(SLOT_SIDEBAR, () => ctx.slots.register({
          name: SLOT_SIDEBAR,
          id: 'workspace-drive-picker',
          priority: SLOT_PRIORITY,
          locale: NS,
          inject: injected,
        }, occupant))

        ctx.slots.inject(SLOT_HERO, () => ctx.slots.register({
          name: SLOT_HERO,
          id: 'workspace-drive-picker',
          priority: SLOT_PRIORITY,
          locale: NS,
          inject: injected,
        }, occupant))
      },
    }
  },
})
