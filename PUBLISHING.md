# 发布记录 / Publish notes

GitHub 仓库：<https://github.com/Charlotteyi5/dsh-workspace-drive-picker>

## 发布方式（因为 git 传输不通）

本机网络下 `github.com:443` 不可达，但 `api.github.com` 正常，所以 **git push 会失败**：

```
fatal: unable to access '...': Failed to connect to github.com:443
```

因此首次发布是走 GitHub REST API 逐个文件创建 blob 完成的（`gh api -X PUT .../contents/<path>`），
线上历史因此是 **12 个独立提交**（每个文件一条），HEAD = `efbc727`（"add smoke.mjs"）。

本地仓库只有 **1 个提交**（完整快照）。两者的树内容**完全相同**（逐字节校验通过），但**历史不相关**。

## 网络恢复后如何同步

`github.com:443` 恢复后，**不要**直接 `git push`（会被拒：`non-fast-forward` 且历史无共同祖先）。
按下面一种处理：

### 方案 A：让本地认领线上历史（推荐，保留已发布内容）

```bash
cd <本目录>
git fetch origin main
git reset --mixed FETCH_HEAD     # 本地文件不动，索引与 HEAD 指向线上 HEAD
git add -A
git commit -m "..."              # 之后正常提交与推送
```

### 方案 B：用本地完整快照覆盖线上历史

```bash
cd <本目录>
git push --force origin main
```

只在确认线上那 12 条提交没有别人依赖时才用。

## 保密审查

发布前跑过 [`audit.mjs`](audit.mjs)，扫描以下类别，全部通过：

| 类别 | 结果 |
|---|---|
| API key / token（`gho_`、`ghp_`、`sk-`、`AKIA`、`xox*`、`AIza`） | 无 |
| 赋值式密钥（`api_key=` / `token=` / `password=` …） | 无 |
| 私钥块（`BEGIN * PRIVATE KEY`） | 无 |
| 个人 home 路径（`C:\Users\<name>`、`/home/<name>`、`/Users/<name>`） | 无 |
| 邮箱地址 | 无（提交身份用的是 GitHub noreply） |
| 私有网段 IP（10.x / 192.168.x / 172.16–31.x） | 无 |

发布前清除过的内容：

- README 安装示例里本机真实路径 `C:\Users\admin\Documents\...` → 换成 `<仓库所在的绝对路径>` / `D:\plugins\...`
- README 状态文件示例与本机真实卷标 `D:\Learning` → 换成 `D:\work`
- `smoke-state.mjs` 里同名的真实卷标 → 换成 `D:\work\demo`

保留的（有意公开）：GitHub 用户名 `Charlotteyi5`（仓库 URL 与 author 字段）、
`package.json` 的 `repository` 字段。**这些是你选择公开的身份，不属于泄露。**
