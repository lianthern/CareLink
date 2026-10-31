# UNSEEN 本地版本切换与回滚演练

`release-candidate.mjs` 仅在明确指定的临时目录或项目 `.task` 目录工作。它不会修改生产 `/opt`、systemd、Caddy 或数据库，也不替代验收协调者的生产发布步骤。

先提交完整候选；该工具从给定 Git commit 使用 `git archive` 打包运行目录，未提交内容不会进入产物。候选必须同时包含旧入口、新 `/app` 和当前服务入口。清单中每个运行文件都有 SHA-256，当前版本通过 `BUILD_ID` 与 commit 对齐。

```sh
node deploy/release-candidate.mjs stage --source "$PWD" --revision CANDIDATE_SHA --root "$PWD/.task/unseen-app/release-rehearsal"
node deploy/release-candidate.mjs rollback --root "$PWD/.task/unseen-app/release-rehearsal"
node --test test/release-candidate.test.mjs
```

目录结构：

- `releases/<完整 SHA>/`：完整独立运行版本与 `release-manifest.json`；不会原地覆盖历史版本。
- `current`：以同文件系统 symlink rename 原子切换；旧版本切换期间仍完整存在。
- `previous`：保留前一版，回滚后与当前版交换。
- `last-receipt.json`：最近成功安装的 commit、前一版、接口状态与校验回执。
- `.release-lock/owner.json`：互斥保护与 PID。意外终止会保留锁；确认 PID 不存在并检查 current/previous 后，才可移除这一个锁目录重试。

发布前会验证文件清单与 hash、实际启动候选 Node 子进程、检查 `/api/health` 的 build ID、旧 `/` 与 `/index.html`、`/unseen-demo`、新 `/app` 的真实 HTTP 响应，并比对实际返回的新旧 HTML 字节。切换后再次从 `current` 启动验证；失败则恢复原 current/previous 并验证原版本。回滚前验证前一版完整 hash；篡改或缺失文件会阻止切换。

所有 smoke 子进程使用显式假密钥、不可达 loopback 上游地址、独立临时 STATE_DIRECTORY，只执行只读页面/健康 GET。它们不读取密钥库、不发照片、不消费付费 API、结束后清除自己新建的临时状态。已有生产状态不在版本包内。正式生产迁移应先备份并保留其原 STATE_DIRECTORY，账号/API/SQLite 仍由 UNSEEN canonical backend 单独持有。

测试包含：真实 Git 仓库两版 → 本地 HTTP → 原子切换 → 回滚；切换后注入失败并恢复原版；坏进程拒绝激活；资产篡改阻止回滚；拒绝生产路径、已有非管理目录和 Git symlink。故障注入用于切换恢复分支，不冒充线上故障或真实服务商验收。该工具不会自动删除历史 releases，也不会停启当前机器已有服务。
