# 01 — UNSEEN 源码、云、Schema 与历史验收库存

审计时间：2026-08-13 00:18–00:34 AEST（UTC+10）  
审计方式：只读文件、Git 元数据、公开 HTTP GET、公开 OSS GET；唯一执行测试是纯本地 Fake OSS 单元测试。未登录账号，未调用任何业务写接口，未发出 POST/PUT/DELETE，未部署、发布或修改既有工程。  
秘密处理：所有 AccessKey、Secret、Token、签名、Policy、AppID、环境 ID 和服务 URL 的值均不在本报告中展开。旧文档只作为历史声明，不作为“当前已跑通”的证明。

状态口径：

- **NOW**：本轮审计当场只读观察到的现状；会明确它证明到哪一步。
- **PROTOTYPE**：源码、schema、测试或本地流程存在，但没有当前生产端到端证据。
- **DEMO**：静态样例、硬编码数据、iframe 包装或只读展示。
- **ABSENT**：在写明的搜索范围内未找到；不把一个冲突副本的缺文件外推成全局不存在。

## 核心硬结论（10 条）

1. **iCloud 有三个 ADVX 源根，必须合并盘点。** 当前主根 `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX` 的 `work/unseen-panorama-rebuild/backend/` 是空目录，且没有 `cloudbaserc.json`；但 `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX 3/work/unseen-panorama-rebuild` 保留了完整 CloudBase SCF 后端、配置模板、测试与历史部署备份。因此正确表述是“当前主副本缺后端源文件”，不是“项目从未有后端”。未发现 `ADVX 4`。
2. **当前公开 Web 静态部署可精确对应主副本 V11 三文件。** 2026-08-13 00:32:33 AEST 公开 GET 得到的 `web/index.html`、`web/unseen.js`、`web/unseen-core.mjs` SHA-256 与主副本逐字节一致；腾讯 8 月 12 日本地 R2 的 `web/unseen.js` hash 不同，且其进度文件明确“未部署、云写入 0”。这只证明静态前端在线，不证明业务写闭环。
3. **CloudBase SCF 在线，但线上源码身份和云写均未证明。** 2026-08-13 00:24:31 AEST，公开健康 GET 返回 HTTP 200、`service=unseen-cloudbase-backend`、`version=1`。健康响应没有 source hash/build ID；本地 `version: 1` 是固定常量，不能据此把线上函数绑定到本地 `backend/lib/service.js` hash `babd…`。本地 Fake OSS 测试 10/10 通过，证明代码合同可运行，不证明生产 OSS 可写。
4. **“阿里云后端”真实部分是 OSS；未证实有正在运行的阿里计算后端。** 原 `/Users/max/code/spatial-memory` 是 FastAPI + 本地 `space.json` + Mac Python worker + 阿里 OSS；后来独立 Web 是腾讯 CloudBase SCF 计算 + 阿里 OSS 作为状态库和对象存储。`deploy/server/` 有 ECS/systemd 安装包，但未找到 ECS 实例、systemd journal、部署回执或当前进程证据。
5. **阿里云四级证据为：配置存在=是；代码可写=是；历史云写证据=有；当前重跑=否。** 本机配置文件字段非空；Python OSS 适配器和 CloudBase OSS V1 适配器都实现写入；旧台账/报告保存了历史写入声明和本地回执。审计未使用密钥做签名请求。当前公开 `s4` manifest 可读，但其中 legacy 上传 Policy 已于 2026-08-04 17:17:53 AEST 过期，不能作为“现在可写”的依据。
6. **原 Web/算法仓是现存最完整能力库，但不是可直接认定的生产母工程。** `/Users/max/code/spatial-memory` Git HEAD 为 `572956…`，当前有 13 个 tracked 修改和 32 个 untracked 文件；本轮没有 8777 监听器或 worker。它包含 CLIP 方位、审核、OSS 发布、全景/深度数据和大量历史夹具；DAP 模型随附许可证是 CC BY-NC 4.0，商业正式 App 不能默认沿用。
7. **微信小程序有真实云函数源码，但与 Web 不是同一数据面。** 主副本保存 `miniapp/cloudfunctions/unseenNative/index.js`：微信云数据库四集合 + 私有云存储 + OPENID 所有者校验；Web managed backend 则把状态和媒体都存进阿里 OSS。代码合同相似，底层 ID、认证、存储和 manifest 生成彼此独立；本轮未调用微信云函数，当前部署/写入状态未验证。
8. **灵光是平台数据库/媒体/AI 定位原型，不是已核实的共享生产后端。** 新 artifact 有两表 SQL、`window.lingguang.db`、`uploadImage` 和 `ai.vllm` 粗定位；数据库没有 owner/user/auth 字段，页面“owner”只是本地历史标记。历史报告只证明本地 QA；同一报告明确平台预览没有可查询的 `instanceId/PASS`，当前平台状态未复证。
9. **秒哒有 Supabase schema 和历史跨会话读取声明，但权限与上传都不足以当正式闭环。** V27 包含 `spaces/tasks/imprint_points/space_photos` 和三个公开 bucket；最终 migration 取消 UPDATE/DELETE，却仍允许 anon 全局 SELECT 与 INSERT，`owner_id` 只是浏览器 device ID。2026-08-09 报告声明生产数据库 `ACTIVE_HEALTHY`、跨会话读取成功，同时把生产照片上传标为 HOLD；本轮未重新访问 Supabase。V27 的上传页还直接 iframe 到腾讯旧 Web，数据面并未收拢。
10. **算法实验很多，但没有一个已接进统一生产 API/schema。** `unseen-locator-lab` 有 12 候选方向 + OpenAI/本机 bridge 重排 + ORB/RANSAC 几何细化；原仓有 CLIP、paircheck、DAP；重建工程有 Web/小程序多帧拼接；灵光有 VLLM yaw/pitch。Locator Lab 的 D1 schema 实际为空且 hosting 配置 `d1=null/r2=null`。最早六张 AI 视觉参考图只在 `ADVX 2` 完整保存，可列为“母版候选”，仍须 Max 最终核实，不能由旧 README 自动裁决。

## 1. 源根与冲突副本

| 绝对路径 | 审计时 stat / 大小 | Git 可追溯性 | 判断 |
|---|---:|---|---|
| `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX` | mtime `2026-08-13T00:29:50+1000`；`1,490,268 KiB` | 根 `.git` 是空骨架，`rev-parse` 失败 | 当前主根；不能用根 Git 给全树定版 |
| `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX 2` | mtime `2026-08-13T00:26:28+1000`；`261,212 KiB`（iCloud 水合会改变目录 stat） | 根 Git 有对象但无有效 HEAD | 保存最早视觉图、Locator Lab、AI 婚礼 Demo、7 月 31 日重建副本 |
| `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX 3` | mtime `2026-08-05T19:59:07+1000`；`12,732 KiB` | 根无有效 Git | 保存缺失的完整 CloudBase backend、部署配置和 8 月 2–4 日 artifacts |
| `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/advx-2026-official-backup 2` | mtime `2026-07-26T05:15:01+1000`；`568,744 KiB` | 未发现源码仓 | 只有活动媒体；不是应用源码备份 |
| `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/advx-2026-official-backup`、`… 3` | `0 KiB` | 无 | **ABSENT**：空目录 |
| `/Users/max/Documents/Codex/2026-08-12/unseen-local-web-review-2026-08-12`、`unseen-tencent-handoff`、`unseen-tencent-local-web-desktop-r4` | 三目录均 `0` 个文件 | 无 | **ABSENT**：Codex 占位目录，不是额外源码副本 |

未找到名为 `ADVX 4` 的同级目录。主根内 `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/_双胞胎冲突/work/unseen-panorama-rebuild` 也是空目录；不能拿它覆盖 `ADVX 3` 的完整副本。

## 2. 平台 / 工程 / hash 清单

“source manifest”是本轮按绝对路径排序后，对常见源码扩展逐文件 SHA-256 再汇总的定位指纹；生成物、`node_modules`、`.git`、artifacts、backups、releases 被排除。关键文件另给内容 hash。

| 平台 / 状态 | 工程绝对路径与版本 | 关键 hash / 日期 | 后端、存储与事实边界 |
|---|---|---|---|
| 原 Web / **PROTOTYPE** | `/Users/max/code/spatial-memory`；Git `572956343baadaacdcbbbd2298d026af843b88a4`；commit `2026-08-05T14:31:00+10:00` | HEAD archive `0a2e898f…`；`server/space.py` `00c45d54…` (`2026-07-30`)；`worker.py` `78bfbf66…`；`publish.py` `367673a4…`；`oss.py` `585c433c…` | FastAPI；本地 `server/spaces/<sid>/space.json` 为写真值；Mac worker 轮询阿里 OSS；无 SQL DB；当前 13 tracked 修改 + 32 untracked，未运行 |
| 公开 Web V11 / 静态 **NOW**，写链 **PROTOTYPE** | `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/work/unseen-panorama-rebuild`；无 Git HEAD；source manifest `2542c7b7…` / 130 files | `web/index.html` live/local `32c1a164…`；`web/unseen.js` live/local `50157d61…`；`web/unseen-core.mjs` live/local `3e9ad91a…`，均于 `2026-08-13T00:32:33+1000` 复核 | 静态站当前可对应；managed API 客户端存在；此精确副本没有 SCF backend 源码/config |
| CloudBase managed Web backend / 在线探针 **NOW**、业务 **PROTOTYPE** | `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX 3/work/unseen-panorama-rebuild`；无 Git HEAD；source manifest `a8d1901e…` / 174 files | `backend/index.js` `f7090a5b…`；`service.js` `babd1169…`；`oss-v1.js` `191e8b3b…`；`config.js` `1476f592…`；`cloudbaserc.json` `8e736fd8…`；backend manifest `9b1c489a…`；mtime `2026-08-02` | 腾讯 SCF 计算；阿里 OSS 同时作状态库与媒体库；本地 Fake OSS 10/10；live health 200，但无线上 build hash、无本轮写入 |
| 微信小程序 native cloud / **PROTOTYPE** | 主副本 `…/work/unseen-panorama-rebuild/miniapp` | `cloudfunctions/unseenNative/index.js` `b30b4b7d…` (`2026-08-02T19:28:15+1000`)；其 E2E 脚本 `2c57625a…` | 微信云数据库 `unseen_spaces/unseen_creates/unseen_uploads/unseen_slots` + 微信私有云存储；OPENID；本轮未调用云端 |
| 腾讯 8/12 本地 Web / **PROTOTYPE** | `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/work/unseen-tencent-local-web-2026-08-12`；source manifest `ae430f7d…` / 147 files | `web/unseen.js` `34fea851…` (`2026-08-12T21:39:04+1000`)；`PROGRESS-R2.md` `2d3c6c23…` | IndexedDB `unseen-upload-first`；一张全景 + 普通照片 + 人工四向 + WebGL 360 可本机刷新；历史记录明确云写 0、未部署；不是跨设备闭环 |
| 灵光 V11 工作副本 / **PROTOTYPE** | `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/work/unseen-panorama-lingguang-new-artifact`；source manifest `90de28e8…` / 178 files | migration `8bf75a1c…`；contract `623da4a3…`；`src/lib/db.ts` `b85e7c9a…`；`photoPose.ts` `a43751ec…`；artifact descriptor `e168f0b7…` | 平台 SQL + 平台图片上传 + VLLM；无服务端身份/所有权字段；平台预览当前未验证 |
| 灵光旧工作副本 / **PROTOTYPE（被后版覆盖）** | `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/work/unseen-panorama-lingguang`；source manifest `27bbc472…` / 53 files | migration `018cee5c…`；`db.ts` `b9498e58…` | 较早两表版本；留作迁移线索，不应选作母工程 |
| 灵光 8/12 本地复跑副本 / **PROTOTYPE** | `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/work/unseen-local-web-review-2026-08-12` | `package.json` `ee494f1e…`；`PROGRESS.md` `83baa444…`；无 Git | 约 1.05 GiB 含依赖/本地 QA；不是额外云后端 |
| 秒哒 V27 / **PROTOTYPE；历史部署声明** | `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/output/UNSEEN-秒哒-v27-桌面修复源码包-2026-08-09.tar.gz` | archive `c731673e…`；migrations `69fad7f1…` / `a23ad156…` / `611c15e4…` / `8cd0e23f…`；`src/lib/api.ts` `672cf1c1…` | 浏览器直连 Supabase DB/Storage；RLS 不提供真实 owner 隔离；上传页 iframe 到腾讯旧 Web；本轮未访问线上 Supabase |
| Locator Lab / **PROTOTYPE** | `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX 2/unseen-locator-lab`；Git `dc07f279…` (`2026-07-26`)；10 tracked 修改 + 19 untracked | HEAD archive `05f6f2dc…`；`localizer.ts` `108ab99e…`；`geometry-refiner.ts` `e20e2156…`；`vision-rank-server.ts` `1c991fb1…` | 算法实验；`.openai/hosting.json` 的 D1/R2 均为 null；`db/schema.ts` 明确 empty；无持久后端 |
| AI 婚礼 panorama / **DEMO** | `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX 2/ai-wedding-panorama-demo`；Git `662a2e8c…`，clean | HEAD archive `43b4c62c…`；worker `2ed36d7f…`；empty schema `13ddacbf…` | 静态/展示 demo；D1/R2 未绑定 |
| ModelScope / **DEMO** | `/Users/max/code/modelscope-unseen`；Git `573bd775…`，clean | `app.py` `73dc549b…`；README `1747f8e6…` | Gradio iframe 包装公开 Web；无自己的后端 |
| UI 审计 / 历史证据工具 | `/Users/max/code/unseen-audit` | `audit.mjs` `f2f06376…`；`audit.json` `a446ffbb…` (`2026-08-08`) | Playwright 截图/布局审计，不是产品服务 |

## 3. 后端、API、schema、认证与对象存储

| 数据面 | API / 写真值 | schema / object key | 认证与隔离 | 当前等级 |
|---|---|---|---|---|
| 原 Python | FastAPI 路由；`server/space.py` 原子改本地 JSON；`worker.py` 拉 OSS inbox 后定位并重发 | `server/spaces/<sid>/space.json`；nodes/photos/tasks；公开投影 `psm-space/1` | host key 本机单独存 `host.json`；照片有 auto/review/approved/rejected/quarantined；无统一用户账号 | **PROTOTYPE**；历史跑过，当前服务/worker 不在 |
| Web managed SCF | JSON actions：`health/createSpace/finalizeSpace/photoTicket/commitPhoto/maintenance` | 私有状态：`unseen-backend/v1/{spaces,staging,tickets,uploads,slots,commits,rate}`；公开 `spaces/<sid>/space.json`；state schema `unseen-managed-state/1`，manifest `psm-space/1` | hostKey 发布；commitToken 提交；15 分钟 exact-key private POST policy；没有用户表；公开空间任何人可凭 sid 取票 | 本地 **PROTOTYPE**；health **NOW**；生产写未验证 |
| 微信 native | `createSpace/finalizeSpace/getSpace/preparePhoto/commitPhoto/listMySpaces/deleteOwnedSpace` | 4 个 CloudBase collections；`unseen/v1/staging|uploads/...` 私有文件 | OPENID；创建者能发布/列出/删除；投稿人由 OPENID 参与幂等 ID；与 Web sid/data 不共享 | **PROTOTYPE**，当前部署未复证 |
| 灵光 | `window.lingguang.db.query/execute`；`uploadImage`；`ai.vllm` | `unseen_spaces`、`unseen_photos`；照片含 yaw/pitch/confidence/source/reason | SQL 无 owner/user/auth；本地 history 的 `owner:boolean` 只控制 UI | **PROTOTYPE**；数据隔离不达正式要求 |
| 秒哒 | Supabase JS 直连 | `spaces/tasks/imprint_points/space_photos`；public buckets `memory_media/panoramas/photo_uploads` | anon/auth 全局 SELECT、INSERT；后续 migration 移除 UPDATE/DELETE；device ID 不是服务端身份 | **PROTOTYPE**；历史 DB 读取声明，当前未复证 |
| 腾讯 8/12 本地 | 浏览器 IndexedDB | DB `unseen-upload-first`；Blob + yaw/pitch/anchor/positionState | 单浏览器 origin；无跨设备身份/隔离 | **PROTOTYPE**，明确不算云 |
| Locator / Wedding Sites | Worker 有 D1 binding 类型，但真实 schema `export {}`，hosting `d1=null/r2=null` | 无业务表 | 无业务身份 | **DEMO/PROTOTYPE**，不能宣称有 Cloudflare DB |

CloudBase managed backend 的本地纯单元测试于 `2026-08-13T00:23:07+1000` 用 Node `v22.23.1` 执行：10 tests、10 pass、0 fail，覆盖图片规则、精确私有 policy、create/finalize/ticket/commit 幂等、凭据 fail-closed、维护清理、90 张容量和 OSS V1 签名规范。测试使用 `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX 3/work/unseen-panorama-rebuild/backend/test/fake-oss.js`，没有访问线上 bucket。

## 4. 阿里云四级证据梯

| 层级 | 结论 | 绝对证据 | 不能推出什么 |
|---|---|---|---|
| 1. 配置存在 | **是** | `/Users/max/.config/psm/aliyun.json`，mode `0600`，163 bytes，mtime `2026-07-24T20:14:27+1000`；`bucket/region/accessKeyId/accessKeySecret` 四字段均非空，值已遮蔽 | 不证明 AK 仍有效、不证明权限最小化 |
| 2. 代码可写 | **是** | Python `/Users/max/code/spatial-memory/server/oss.py` hash `585c433c…`；SCF `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX 3/work/unseen-panorama-rebuild/backend/lib/oss-v1.js` hash `191e8b3b…`；SCF Fake OSS 10/10 | 不证明生产环境变量等于本机配置，不证明实际 OSS 请求成功 |
| 3. 历史云写证据 | **有，但只算历史** | `/Users/max/code/spatial-memory/PROGRESS.md` hash `5b143000…`；5 个 `.published.json`、4 个 `.ingested.json`、3 个 `.worker.json`；最新 s4 `.published.json` hash `798f778e…`、mtime `2026-07-30T13:30:48+1000`；ADVX 3 release 文档与 policy backups | 旧 ledger/文档不能证明现在还能写；历史文档中的数量与当前公开 manifest 也可能不同 |
| 4. 当前重新实跑 | **否** | 本轮只做 health GET、静态文件 GET、公开 s4 manifest GET；没有 create/ticket/OSS POST/commit/cleanup | 不能宣称跨设备创建、普通照片上传或刷新持久化当前通过 |

2026-08-13 00:32:56 AEST 对公开 OSS 的只读观察：`spaces/s4/space.json` SHA-256 `051b3332…`，schema `psm-space/1`，published=true，1 node，9 photos；公开读取可用。其发布的 legacy policy `expiresAt=2026-08-04T17:17:53+1000`，审计时已过期。公开可读 ≠ 当前可写。

`/Users/max/code/spatial-memory/deploy/server/` 只有 README、`setup.sh`、`sync-space.sh`、`unseen-worker@.service`；关键 hashes 分别为 `a8b4999a…`、`29f05732…`、`7549b091…`、`9384daab…`。README 自身说当前 worker 依赖人工启动，并要求未来购买 ECS、创建 RAM 用户、上传配置和启用 systemd；没有发现执行回执。因此“有 ECS 部署包”是 **PROTOTYPE**，“已有阿里 ECS 后端”在本次范围为 **ABSENT/未验证**。

## 5. CloudBase 完整历史后端精核

完整历史源位于：

`/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX 3/work/unseen-panorama-rebuild`

- 后端 13 files，绝对路径 + 内容 hash 汇总 `9b1c489ad18ea6278d1c6c770610e5e0500315c63c8a24858d1e7dfcd783934e`。
- `cloudbaserc.json` 只有 `{{env.*}}` 占位符，声明一个 `unseenBackend` 函数；文件 mode `0600`、mtime `2026-08-02T18:10:21+1000`、hash `8e736fd8…`，不含提交进仓的真实秘密值。
- `tools/deploy_cloudbase_backend.py` hash `c105419c…`：从 `/Users/max/.config/psm/aliyun.json` 读 OSS credential，在内存中构造 CloudBase 环境变量，并用同一 secret 派生 token/space/host/rate/maintenance secret。它会执行 `tcb fn deploy`，本轮没有运行。
- README 要求使用独立 RAM 身份，但现有配置究竟是主账号还是 RAM、权限是否按模板收紧，**未验证**。部署脚本的变量名不能代替账号侧证据。
- `backend/ram-policy.template.json` hash `d54b4e21…`，允许 managed prefixes 的 Get/Put/Delete/PutACL 与 bucket List；只是模板，不是已绑定策略的证明。
- `tools/test_cloud_e2e.py` hash `d8b0ecf4…` 会真实执行 create → OSS POST → finalize → ticket → OSS POST → commit，并在 finally 中 DELETE 测试对象；本轮为防云写而明确未运行。
- `web/test-production-cloud.mjs` hash `e6031010…` 是测试源码，不是测试结果。
- 2026-08-02 release 文档 `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX 3/work/unseen-panorama-rebuild/docs/UNSEEN-standalone-web-miniapp-release-20260802.md` hash `8713fe05…` 声称“生产 API + OSS 14 项断言通过”和跨浏览器跑通；未找到对应原始 stdout、JUnit/JSON 结果、SCF deployment receipt 或 deployed source hash，所以只记为**历史声明**。
- `artifacts/cloudbase-backups/` 26 个静态备份、`artifacts/policy-backups/` 2 个 manifest、合计 artifacts 38 files，manifest hash `1a296f68…`；policy backups 含 AccessKeyId/policy/signature 字段，值全部遮蔽，且对应签名已过期。它们证明当时保存过云端内容，不证明当前写入。
- live health 的 `version=1` 与本地源码里的固定数值相同，但没有 hash，因此线上对应哪个 commit/副本 **未验证**。

## 6. 数据、算法实验和许可

### 原空间数据与历史处理痕迹

`/Users/max/code/spatial-memory/server/spaces` 当前有 96 个空间目录、92 个 `space.json`、91 个 pano 相关文件、559 个 photos 文件、86 个 `depth.json`。这些是本地数据集/夹具和历史状态，不自动等于线上当前数据。

关键算法：

- CLIP / 网格方位：`/Users/max/code/spatial-memory/server/compose_server.py` hash `3f0da829…`；`server/space.py` hash `00c45d54…`。
- Paircheck：`/Users/max/code/spatial-memory/server/paircheck.py` hash `e6297129…`。
- 匹配/评估/深度：`tools/match.py` `e6b3b60f…`；`tools/eval.py` `303ebccd…`；`tools/depth.py` `48737964…`；`matches.json` `e8f01cd3…`。
- DAP：`vendor/DAP/weights/model.pth` 1,460,746,347 bytes，hash `247f3375…`；`vendor/DAP/LICENSE` hash `9cd15dd7…`，CC BY-NC 4.0。技术实验存在，商业许可不成立。
- 多帧全景：主重建工程 `web/pano-capture.js` `5b5a4f89…`、`web/pano-sweep.js` `dc6521a0…`、`miniapp/utils/pano-core.js` `37ad875a…`；另有 dynamic stitch / residual warp / seam blending 测试。它们是源码/历史测试库存，本报告不把它们升格为生产能力。
- Locator Lab：12 个全环候选、AI/bridge 排名、multi-scale FAST+ORB、Homography/Affine/Fundamental RANSAC；关键 hash 见平台表。Git 工作树不干净，未执行会写 build 目录的完整测试。
- 灵光 AI pose：`src/lib/photoPose.ts` 用全景 + 普通照片调用平台 VLLM，confidence < 0.35 降为手工 8 方位；算法输入输出会入 SQL。当前平台 AI 调用未复跑。

### 视觉母版候选资产（未裁决）

`/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX 2/UNSEEN-原始参考图` 有 6 张早期 WebP + 1 张功能参考图 + README；目录 manifest SHA-256 `a7fa8c1e…`，图片 mtime `2026-07-25`。六张品牌候选的 hashes：

`01 bdb33edb…`、`02 56fe68ea…`、`03 7e4685ac…`、`04 d8e83572…`、`05 497b5c2c…`、`06 6b3a4327…`；第 7 张功能参考 `8f0aab41…`。主根同名目录为空。依据 Max 最新裁决，只能标“疑似最早 AI 视觉母版候选，待核实”。

## 7. 密钥 / 配置存在性（值全部遮蔽）

| 配置绝对路径 | 权限 / mtime | 仅核实到 | 当前有效性 |
|---|---|---|---|
| `/Users/max/.config/psm/aliyun.json` | `0600`；`2026-07-24T20:14:27+1000` | bucket/region/AK ID/AK secret 非空；Python 与部署脚本会读 | **未验证**；未用 AK 发请求；本机无 `aliyun`/`ossutil` CLI |
| `/Users/max/.config/psm/wechat.json` | `0600`；`2026-07-29T14:29:59+1000` | appid/secret/note 非空 | **未验证**；未登录开发者工具、未调用云函数 |
| `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX 3/work/unseen-panorama-rebuild/cloudbaserc.json` | `0600`；`2026-08-02` | 只有 env placeholders；本机有 `/opt/homebrew/bin/tcb` 和 `/opt/homebrew/bin/cloudbase` | 没有在常见 `~/.config/cloudbase`、`~/.tcb` 路径找到会话配置；未运行 status/login/deploy |
| `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/.codex-tmp/unseen-miaoda-v26-local-20260809/app-dd5e9nnkw4qp/.env` | `0644`；`2026-08-05T08:58:03+1000` | Supabase URL、anon key、app ID 非空（anon key 为客户端公开级凭据，仍不在报告展开） | **未验证**；V27 正式源码包不含 `.env` |
| `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX 2/.codex-tmp/unseen-v9-src.ErLhi5/src/app-d9d8b2ig54w1/.env` | `0600`；`2026-07-26T00:33:56+1000` | Expo public Supabase URL/anon/app ID 非空 | 旧 V9 配置，**未验证** |
| `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX 2/unseen-locator-lab/.dev.vars` | `0600`；`2026-07-25T23:01:51+1000` | bridge URL/token/unauthenticated flag 非空 | 本地 bridge 当前未运行；**未验证** |

本轮 shell 环境没有 `ALIYUN/OSS/TCB/CLOUDBASE/WECHAT/WX/SUPABASE/VISION/OPENAI` 前缀环境变量。配置文件“存在”不能等同于密钥有效或服务已授权。

## 8. 历史验收 / 部署证据清单

| 证据 | hash / 日期 | 能证明 | 不能证明 |
|---|---|---|---|
| `/Users/max/code/spatial-memory/PROGRESS.md` | `5b143000…`；mtime `2026-07-30T23:03:20+1000` | 保存历史命令、OSS 201、worker/publish、浏览器流程的文字记录 | 当前服务、当前 policy、当前数据量 |
| `/Users/max/code/spatial-memory/server/spaces/s4/.published.json` | `798f778e…`；`2026-07-30T13:30:48+1000` | 本地发布器曾写 ledger | 线上对象现状或跨设备业务闭环 |
| `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX 3/work/unseen-panorama-rebuild/docs/UNSEEN-standalone-web-miniapp-release-20260802.md` | `8713fe05…`；mtime `2026-08-04` | 历史发布口径与 14 项 E2E 声明 | 无原始日志，不能当前复证；不能对应线上 source hash |
| `…/ADVX 3/work/unseen-panorama-rebuild/artifacts/cloudbase-backups/` | 26 静态 files；总 artifacts manifest `1a296f68…` | 2026-08-02–04 保存过部署前静态文件 | SCF 后端版本、数据库写入 |
| `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/output/unseen-delivery-evidence-2026-08-08/UNSEEN-交付回归证据-2026-08-08.md` | `f7209077…` | 灵光本地 QA 声称创建→照片→手调→360→刷新 | 报告明确平台预览未确认；不是跨设备云证据 |
| `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/output/unseen-delivery-evidence-2026-08-09/UNSEEN-P0二次验收-2026-08-09.md` | `0347245b…` | 秒哒历史 DB 健康与跨会话读取声明；灵光本地测试声明 | 同文把秒哒生产照片上传、灵光预览、完整生产交付列为 HOLD |
| `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/output/unseen-ui-audit-2026-08-11/UNSEEN-V11-产品体验复跑报告-2026-08-11.md` | `9f279288…` | UI/浏览器体验历史复跑 | V11 不再自动是视觉母版；不证明云写 |
| `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/work/unseen-tencent-local-web-2026-08-12/PROGRESS-R2.md` | `2d3c6c23…`；`2026-08-12` | 本地 IndexedDB 核心旅程的历史复验 | 文件明确未部署、未发布、未写云端 |

## 9. 源码归档包

| 绝对路径 | SHA-256 | 日期 / 说明 |
|---|---|---|
| `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/work/unseen-lingguang-v11-formal-source.tar.gz` | `a5b994e9…` | `2026-08-07T22:47:58+1000`；V11 候选源码，不等于当前平台实例 |
| `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/output/UNSEEN-灵光-源码包-2026-08-09.tar.gz` | `f5d4e9b3…` | `2026-08-09T02:03:00+1000` |
| `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/output/UNSEEN-灵光-源码包-2026-08-08.tar.gz` | `96cc95a4…` | `2026-08-08T15:38:26+1000` |
| `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/UNSEEN-Lingguang-V6-compatible-source.tar.gz` | `8631dcc8…` | `2026-08-06` |
| `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/work/unseen-lingguang-v5-formal-source.tar.gz` | `71d4f887…` | `2026-08-07` |
| `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/work/unseen-lingguang-v7-formal-source.tar.gz` | `dc36a5f8…` | `2026-08-07` |
| `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/work/unseen-lingguang-v9-formal-source.tar.gz` | `2f9cc684…` | `2026-08-07` |
| `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/work/unseen-panorama-lingguang-v3-photo-marker-source.tar.gz` | `3f7ec7f6…` | `2026-08-06` |
| `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/output/UNSEEN-秒哒-v27-桌面修复源码包-2026-08-09.tar.gz` | `c731673e…` | `2026-08-09`；不含 `.env` |
| `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/.codex-tmp/unseen-miaoda-v25-source-20260809.zip` | `2bfc8196…` | `2026-08-09` |
| `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX 2/.codex-tmp/unseen-v9-src.ErLhi5/app.zip` | `dbde1266…` | `2026-07-26`；旧 Supabase/Expo 源 |

## 10. 可复跑的只读命令

以下命令不会显示秘密值，也不会写云端。路径和输出时间会随 iCloud 水合、用户后续编辑变化。

```zsh
# 1) 找所有 ADVX 同级根；能直接发现 ADVX / ADVX 2 / ADVX 3，且当前没有 ADVX 4
find '/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents' \
  -maxdepth 1 -type d -iname 'advx*' -print

# 2) 原仓 Git 与工作树计数
repo='/Users/max/code/spatial-memory'
GIT_OPTIONAL_LOCKS=0 git -C "$repo" rev-parse HEAD
GIT_OPTIONAL_LOCKS=0 git -C "$repo" log -1 --format='%cI|%s'
GIT_OPTIONAL_LOCKS=0 git -C "$repo" diff --name-only | wc -l
GIT_OPTIONAL_LOCKS=0 git -C "$repo" ls-files --others --exclude-standard | wc -l

# 3) 完整历史 SCF 后端关键内容 hash
scf='/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX 3/work/unseen-panorama-rebuild'
shasum -a 256 "$scf/backend/index.js" "$scf/backend/lib/config.js" \
  "$scf/backend/lib/service.js" "$scf/backend/lib/oss-v1.js" "$scf/cloudbaserc.json"

# 4) 纯本地 Fake OSS 测试；不访问 bucket
node --test "$scf"/backend/test/*.test.js

# 5) 只读 live health；仅白名单输出，不展开 URL 或其他响应字段
core='/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/work/unseen-panorama-rebuild/web/unseen-core.mjs'
api=$(awk -F'"' '/export const UNSEEN_API_URL/{print $2; exit}' "$core")
curl -fsS --max-time 20 "$api" | jq '{ok,service:(.data.service // .service),version:(.data.version // .version),time:(.data.time // .time)}'

# 6) 公开 Web 静态文件与主副本比 hash
site=$(awk -F'"' '/^APP_URL =/{print $2;exit}' '/Users/max/code/modelscope-unseen/app.py')
curl -fsSL --max-time 20 "${site}web/unseen.js" | shasum -a 256
shasum -a 256 '/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/work/unseen-panorama-rebuild/web/unseen.js'

# 7) 只读公开 OSS manifest；明确排除 upload policy/signature 值
oss=$(awk -F'"' '/export const DEFAULT_OSS_BASE/{print $2;exit}' "$core")
curl -fsS --max-time 20 "$oss/spaces/s4/space.json" | \
  jq '{schema,id,published,nodes:((.nodes//[])|length),photos:((.photos//[])|length),expiresAt:(.upload.expiresAt//.expiresAt//null)}'

# 8) 配置只看 stat 和字段名，不打印值
stat -f '%N|%z|%Sm|%Sp' -t '%Y-%m-%dT%H:%M:%S%z' \
  '/Users/max/.config/psm/aliyun.json' '/Users/max/.config/psm/wechat.json'
jq 'keys' '/Users/max/.config/psm/aliyun.json'
jq 'keys' '/Users/max/.config/psm/wechat.json'

# 9) 当前本地 runtime 只读检查
lsof -nP -iTCP:8777 -sTCP:LISTEN
ps -axo pid=,command= | rg '[s]erver\.(worker|compose_server)'
```

明确不要在只读阶段运行：

- `/Users/max/code/spatial-memory/server/oss.py selftest`（会 PUT/DELETE）；
- `/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX 3/work/unseen-panorama-rebuild/tools/test_cloud_e2e.py`（会 create、OSS POST、commit、DELETE）；
- `tools/test_native_cloud_e2e.js`（会写微信云 DB/Storage 并清理）；
- `tools/deploy_cloudbase_backend.py`、`tcb fn deploy`、任何发布/上传命令。

## 11. 当前未验证 / 阻断项

1. 线上 `unseenBackend` 没有返回 build/source hash，也没有保存 SCF deployment receipt；无法把 live `version=1` 绑定到本地任一 hash。
2. 阿里 AK 当前有效性、账号类型（主账号或 RAM）、实际 policy 绑定与最小权限均未验证；只知道本地字段非空。
3. 没有本轮真实 create → panorama upload → finalize → photo ticket → photo upload → commit → 跨设备 refresh 证据；这是下一阶段 R1 的关键缺口。
4. 微信 `unseenNative` 当前 Active 状态、数据库规则、存储规则和真机跨设备链路未验证。
5. 秒哒 Supabase 与灵光平台实例当前状态未复跑；历史报告的 GO/HOLD 保留原日期，不升级为 NOW。
6. ECS/server worker 只有部署材料，没有正在运行的远端实例证据。

