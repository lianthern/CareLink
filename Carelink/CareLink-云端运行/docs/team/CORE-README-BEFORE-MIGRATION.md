> 历史 README，保留于 2026-09-20；其中的线上状态和测试清单可能过期。当前入口见根目录 README。

# UNSEEN

婚礼当天，现场照片散在几十个宾客各自的手机里，没人看得到全貌。UNSEEN 把这些照片收上来，判定每张是在场地的哪个方位拍的，再放回一个全景空间里——于是同一场婚礼可以按「站在哪儿看」来重逛，而不是翻一个按时间排的相册。

## 当前架构

公网入口 `unseen.maxxam.xyz`，跑在一台腾讯云轻量应用服务器（香港）上。**整套线上服务是单机单进程**：

- `infra/integration/local-operable.mjs` 是唯一的进程入口，同时挂起三件事——Web 静态资源、canonical API、以及 job worker。没有独立的 API 服务器或队列中间件。
- 存储：SQLite（`journal_mode=WAL`）存结构化数据，媒体文件直接落文件系统。
- 方位判定：Python CLIP sidecar 作为子进程拉起（`services/locator/sidecar/server.py`，venv 在同目录 `.venv/`），默认监听 `8791`，由 `infra/integration/clip-sidecar-process.mjs` 管生命周期。只在 `UNSEEN_LOCATOR_MODE=clip` 时启用。
- 入口反代：Caddy 终止 443，转发到本机回环端口。仓库里的样例与默认值是 `127.0.0.1:4282`（`UNSEEN_API_PORT`，见 `ops/release/Caddyfile.example`），但**生产机上 systemd 单元通过环境变量覆盖成了 4300**——排查线上问题请以 4300 为准，别拿 4282 去打生产。

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| `services/api` | canonical API、领域逻辑、SQLite 访问 |
| `services/jobs` | 后台任务（与 api 同进程运行，测试挂在 api 套件里） |
| `services/locator` | 方位判定；含 `sidecar/` 下的 Python CLIP 服务 |
| `apps/web` | Web 前端 |
| `packages/viewer` | 全景浏览器组件 |
| `packages/book-renderer` | 相册/成书渲染 |
| `infra` | 集成层，`integration/local-operable.mjs` 是线上进程入口 |
| `ops` | systemd unit、Caddy、备份、告警等运维配置样例 |
| `runbooks` | 部署与运维 runbook |

小程序（`apps/miniapp`）还在 `cc/miniapp` 分支上施工，尚未并入 main。

## 测试

根目录关卡：

```
npm run check
```

它等于 `build` + `test`，现在只包含四道真关卡：`contracts:check`（防 `packages/contracts/generated/` 被手改）、`format:check`、`secret:scan`、`backend:baseline`。

四套单元测试各自独立跑：

```
cd services/api      && npm test   # 含 services/jobs 的用例
cd apps/web          && npm test
cd services/locator  && npm test   # 含 eval/offline 的用例
cd packages/viewer   && npm test
```

`services/api/tests/decoder-runtime.test.mjs` 会断言本机 ffmpeg/ffprobe 的版本号，本机版本对不上时这一条会红，与业务代码无关。

## 部署

生产部署走不可变 release 目录，大致是：打 git bundle → scp 到服务器 → `git clone` 到 `/opt/unseen/releases/<sha>` → 把 systemd 的 `WorkingDirectory` 切到新 release → 把 CLIP venv 重新 symlink 进新目录（每个 release 是全新 clone，venv 不在 Git 里）→ restart。

生产进程当前监听 `127.0.0.1:4300`（systemd 单元里用环境变量覆盖了仓库默认的 4282），连线上排查时用这个端口。

完整步骤、校验命令和回滚规则见 `runbooks/release/PRODUCTION-DEPLOYMENT.md`，服务器现状与密钥位置见 vault 里的技术总纲。

## 历史说明

`archive/c4-bootstrap/` 是 2026-08 那套「C4 bootstrap 冻结」治理流程的存档（冻结清单、进度与证据文档），只作历史记录。`contracts/source/` 同属那一时期的历史合同文档——**它们都不再是变更闸门**，改代码不需要走 RFC。`scripts/gates/` 下对应的冻结/溯源脚本按保留纪律留在原地，但已从 `build` / `test` / `check` 链路摘掉，属休眠代码。细节见 `archive/c4-bootstrap/README.md`。
