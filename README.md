# dsh-workspace-drive-picker

给 DSH「添加工作区」的目录选择器加上**盘符一键直达**。

## 它解决什么

Windows 没有比 `C:\` 更上一层的统一根目录。DSH 自带的选择器只能沿目录树往上走，走到 `D:\` 就再也上不去了，**跨不到别的盘**；而它的面包屑还会在主目录处折叠，正好把通往其他盘的那段路藏起来。想换盘只能手打路径。

本插件接管两个目录流 slot（`sidebar.workspaces.directoryFlow` 与 `conversation.hero.workspace.directoryFlow`），把这些补上：

- **盘符条**：一排 chip，点一下直接跳到该盘根（宿主端枚举 A:–Z:，实际挂载的才出现）。每个 chip 显示**卷标**与**剩余空间**（`C: System 316.7G`），悬停出完整路径与总容量。
- **常用目录**：下载 / 文档 / 桌面。
- **常显路径框**：粘贴任意绝对路径回车即跳。
- **完整面包屑**：从根开始，不在主目录折叠。
- **新建文件夹**：在当前层建，建完直接进去。
- **记住上次的目录**：下次打开「添加工作区」直接回到上次停留的那一层。
- **本机 / 远程两个标签**：远程那半复用 `dsh-remote-ssh` 已配好的 SSH 连接与工作区，不重配。

## 卷标与剩余空间从哪来

Node 没有读取 Windows 卷标的 API（`statfs` 只给容量），所以宿主侧用一条 PowerShell 查询：

```powershell
Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" |
  Select-Object DeviceID,VolumeName,Size,FreeSpace | ConvertTo-Json -Compress
```

`DriveType=3` 是「本地固定磁盘」，可移动盘与网络映射盘不参与，避免失效的映射盘拖慢列表。实测六个卷约 **430 ms**，因此结果缓存 2 分钟；缓存期内再开弹窗是 **3 ms**。

查询失败（PowerShell 被策略拦、非 Windows、WMI 不可用）一律降级为**空卷标 + 不显示剩余空间**，弹窗退回纯盘符，绝不因为一个卷标而报错。

## 记住上次目录为什么存在宿主

GUI 的源每次重启都会变（`127.0.0.1:52844` → `:54740` → `:56261` …），`localStorage` 按源隔离，于是**每次重启都会静默忘掉**这个偏好。所以状态写在宿主：

```
~/.dsh/workspace-drive-picker.json
{ "path": "D:\\work", "tab": "local" }
```

写入是 best-effort（只读 home、并发写都不影响弹窗）；文件损坏或不存在就是「没有记住」，绝不阻塞流程。记住的目录若已被删除或所在盘未挂载，列举会失败并在弹窗内报错，此时点盘符条或手打路径都能继续。

## 为什么优先级是 −1000

DSH 的 slot 是**遮蔽**语义：同一个 slot 里优先级最低（数字最小）的占用者负责渲染。`dsh-remote-ssh` 用 −100 接管了这两个 slot，官方 browse 是 0。本插件取 −1000，因此在它之上渲染，同时保持可插拔：卸掉它，原来那个界面原样回来，不需要改任何配置。

## 安装

```powershell
# 把仓库克隆到本地任意位置，然后在该目录里执行：
dsh plugin --profile desktop add file:<仓库所在的绝对路径>
```

例如仓库放在 `D:\plugins\dsh-workspace-drive-picker`：

```powershell
dsh plugin --profile desktop add file:D:\plugins\dsh-workspace-drive-picker
```

CLI 不可用时也可以手动登记：在 `~/.dsh/profiles/desktop/package.json` 的
`dependencies` 里加一行 `file:` 引用，再把它加进 `dsh.profile.bundles`，然后 `pnpm install`。

装完重启 DSH 桌面端、刷新页面。

## 卸载

从 `package.json` 移除该依赖与 bundle 行，`pnpm install`，重启。原来的选择器自动恢复。

## 结构

| 文件 | 职责 |
|---|---|
| [`index.js`](index.js) | 宿主半：一个 `prefix` 路由 `/workspace-drive-picker`，五个动作 `drives`（盘符 + 卷标 + 剩余空间 + 记住的目录）/ `list`（列一层）/ `mkdir` / `state`（读写记住的目录）/ `remote`（白名单代理到 `dsh-remote-ssh` 的 `/remote-ssh/api`） |
| [`client.js`](client.js) | 浏览器半：接管两个 directory-flow slot 的对话框 |
| [`smoke.mjs`](smoke.mjs) | 宿主半冒烟测试，不用开 GUI：`node smoke.mjs` |

## 安全边界

- 每条路由都要求 `X-Requested-With`，与同宿主上其他插件路由一致的 CSRF 栅栏；跨站页面无法在无预检的情况下设置该头。
- 代理只放行 `listProfiles` / `listDir` / `mkdir` / `createRemoteWorkspace`，所以这条路由**不可能**变成通用 SSH 控制台。
- 单层列举上限 500 条、请求体上限 1 MB，避免巨大目录拖垮对话框或宿主内存。

## 已知限制

- 盘符枚举靠 `readdir('X:\\')` 探测，**读不动但确实存在的**卷（例如权限全拒的卷）不会出现在盘符条里 —— 仍可从路径框手打进入。
- 远程面板只列目录，不在远端建文件夹（远端建目录请用 `dsh-remote-ssh` 自己的设置页）。

## 开发时踩过的两个坑（改代码前先看）

### 1. `alive` ref 必须在 effect 里重新置 `true`

```js
// 错误：第一次 cleanup 之后永远是 false
useEffect(() => () => { alive.current = false }, [])

// 正确
useEffect(() => {
  alive.current = true
  return () => { alive.current = false }
}, [])
```

React 18 在开发模式下会跑 **mount → cleanup → mount**。只清不置的写法会让 `alive` 在第一轮 cleanup 后卡在 `false`，于是**每个响应都被丢弃**：`loading` 永远停在 `true`，底部按钮（含「选择此目录」）全部 `disabled`，点上去**看起来完全没反应**，控制台也没有任何报错。这个 bug 从代码上读很难发现，症状又极易误判成「按钮没绑事件」。

### 2. `Modal` 要传 `headless`

官方 `Modal` 默认会把 children 包进它自己的 `.content` / `.body` 两层容器。本对话框依赖「头部固定 + 列表 `flex:1` + 页脚固定」的纵向布局，多出来的包装层会让页脚被挤出卡片外看不见。传 `headless: true` 自己管布局：`.wdp_dialog`（卡片本身）`overflow:hidden`，内部 `.wdp_sheet` 用 `height:100%` 撑满。

## 测试

```bash
node smoke.mjs          # 宿主半：路由、盘符枚举、CSRF 栅栏、白名单、404
node smoke-client.mjs   # 浏览器半：按 web shell 的方式加载 bundle，验证 apply() 注册的两个 slot
node smoke-state.mjs    # 卷标/剩余空间真实读数 + 记住的目录往返
node smoke-remember.mjs # 「恢复」与「保存」两个 effect 不会互相打架的规则
```

都不需要开 GUI。`smoke-client.mjs` 用假的 `window.__ModuleLoader__` / `React` / `slots` / `locale` 把 `apply()` 跑一遍 —— 这是重启前唯一能发现「bundle 能解析但激活时抛错」的手段。`smoke-state.mjs` 会**真跑**那条 PowerShell 查询，并断言冷/热两次调用的耗时差距，防止有人把缓存删掉却没人发现。

### 3. 恢复与保存的两个 effect 不能互相触发

「记住上次目录」是两个 effect：一个用**记住的路径**去 `load`，一个在 `path` 变化时 `state` 保存。如果恢复效应的依赖里混进了 `path`，那么用户每跳一层 → 保存新路径 → 恢复效应重跑 → 把用户拽回旧目录，看起来就是「点盘符没反应 / 一直弹回原处」。规则（`smoke-remember.mjs` 守着）：**恢复只依赖 `load` 与 `driveFacts?.saved?.path`，保存只依赖 `path` 且在 `path === ''` 时直接 return。**

