# UNSEEN 正式施工编排合同

状态：原始C4已完成；当前进入controller-only `runtime erratum + L3 Book Lab`合同修订窗口。受影响Track停笔；只有新revision的Codex C2、桌面Claude C3与C4 effective-revision re-freeze均PASS后才可恢复。
目标：并行提高速度，同时让每个任务只理解并完成一个模块；接口和文件所有权清楚，避免上下文污染与并发覆盖。

## 1. 总体原则

1. **一个总控，不写业务模块。** 总控持有冻结合同、接口接缝、P0/P1裁决、集成顺序与最终验收。
2. **每个模块一个写者。** 任何时刻同一文件 / migration / schema 只有一个任务可写；其他任务只读。
3. **先冻结接口，再并行实现。** Track 0L 完成前，其他任务只能准备 fixture / 测试计划，不能各自创造 schema。
4. **上下文最小化。** 每个任务只收到：全局不变量、自己的合同文件、允许路径、依赖接口、验收与禁止区；不复制完整聊天史。
5. **主分支不靠口头合并。** 每个模块交付机器证据、截图 / trace、未知项与反例；总控按冻结 manifest 复核后才进入集成。
6. **正式产品与研究隔离。** rotation360 主链可发布；DAP 商用替代和 true3D 研究使用独立目录、feature flag、数据与许可证 gate，不影响核心 App。
7. **并行必须隔离 Git 状态。** Track 0L 产出冻结 commit 后，`/Users/max/code/unseen` 的 `main` 只读；任何正式任务必须在 C4 登记的独立 worktree / branch 中工作。不同目录但共用一个 index、HEAD 或 lockfile 不算隔离。

## 2. 依赖与汇合顺序

```text
effective-revision re-freeze
   ├── Track 1A · 本地 Canonical API / DB / Auth / Media
   ├── Track 2 · Web App / 双端 UI / 文案状态
   └── Track 8B · Book 独立 Web package / HTML+PDF renderer（冻结fixture）
             ↓ 1A/2停笔
   ├── Track 5 · Stage L：Core Local Operable（真实本地API+Web+Viewer；定位fixture醒目标记；非R0）
   ├── Track 8A · Book 独立 API/data/jobs package（冻结fixture）
   └── Track 3A · 定位数据 / Eval / Worker（先离线）
             ↓ Max获得本地可操作版；继续分波纳入6A及获授权的1B/3B
Track 5 · Stage RC：五 actor / 浏览器E2E并固定 Core RC（单一集成写者）
             ↓ fixed Core RC + 1A/2 inert seam
       ├── Track 6B · Trust/Safety/Privacy/Observability/Release evidence
       └── Track 8A/8B · 仅写各自精确extension seam后停笔
                         ↓
              Track 8C · Book Lab 单写集成与E2E
             ↓
Track 7 · 小程序薄客户端（仅 Web/H5 R0 sign-off PASS 后）

独立后置：Track R-C · 商用深度有限视差；Track R-D · video/scan→walkable3d POC
```

Track 0L 历史bootstrap保持不变。当前合同revision严格串行且最多只允许controller写者；其C4 re-freeze完成后首波精确恢复Track 1A、2，并创建Track 8B，Track 4保持已验收commit只读。1A/2停笔交付后，第二波切换为Track 5 Stage L、Track 8A与Track 3A，仍不超过三个active module writers；8B此时必须停笔交commit。Track 5先给Max一个本地可操作版本；该节点不等待3A/6A、1B、3B、真实模型或Release证据，也绝不冒充Integration/R0。Stage L交付后再按三写者上限轮换启动6A；Track 1B必须等待可删除的隔离云环境授权，Track 3B必须等待真实数据许可。Track 5仍是Core唯一跨模块集成写者，吸收后续获授权证据后在Stage RC固定Core RC。8A/8B在fixed Core RC前只能基于冻结合同与醒目标记的确定性fixture施工自己的隔离package，不能写Core extension seam或宣称真实Core集成；fixed Core RC且原owner停笔后才可各写一次精确seam，随后由8C单写集成。Track 6B可与该接缝/8C阶段按三写者上限并行。Book对外启用与本轮完成声明仍必须等待Core R0。Track 6A不写业务API或Web页面；Track 7只在Web/H5 R0 release sign-off后开工，不得先发展第二套后端。

### 2.1 Worktree / branch 矩阵

原始13个Track路径由历史 Track 0L 在bootstrap commit后创建；其历史起点保持不可变。8A/8B/8C不会重跑0L，也不从历史bootstrap伪造起点：C4 re-freeze后controller从本次effective revision commit创建8A/8B并把精确起点写入一次性`WORKTREE-REGISTRATION-8A-8B.json`；8C仍保持不存在，直到Track 5交付fixed Core RC后才从该RC创建并写一次性`WORKTREE-REGISTRATION-8C.json`。任何时刻最多三个module worktree处于active写状态，`main`始终禁止直接提交。

| Track | Branch | 唯一 worktree | 起点 / 汇合 |
|---|---|---|---|
| 0L | `main` | `/Users/max/code/unseen` | 严格串行建立冻结 commit；之后只读 |
| 1A | `track/1a-api` | `/Users/max/code/unseen-worktrees/1a-api` | 冻结 commit；交独立模块 commit |
| 2 | `track/2-web` | `/Users/max/code/unseen-worktrees/2-web` | 同上 |
| 3A | `track/3a-locator-offline` | `/Users/max/code/unseen-worktrees/3a-locator-offline` | 同上 |
| 4 | `track/4-viewer` | `/Users/max/code/unseen-worktrees/4-viewer` | 同上 |
| 6A | `track/6a-trust-ops` | `/Users/max/code/unseen-worktrees/6a-trust-ops` | 同上 |
| 1B | `track/1b-cloud-sandbox` | `/Users/max/code/unseen-worktrees/1b-cloud-sandbox` | 以已批准的 1A commit 为起点；交 adapter commit |
| 3B | `track/3b-locator-shadow` | `/Users/max/code/unseen-worktrees/3b-locator-shadow` | 以已批准的 3A commit 为起点；交 shadow evidence commit |
| 5 | `integration/r0` | `/Users/max/code/unseen-worktrees/5-integration` | 从冻结 commit 建立；Stage L先交本地可操作证据，Stage RC再固定Core RC；唯一Core集成worktree |
| 6B | `track/6b-release` | `/Users/max/code/unseen-worktrees/6b-release` | 以 Track 5 固定 RC commit 为起点；只收发行证据 |
| 7 | `track/7-miniapp` | `/Users/max/code/unseen-worktrees/7-miniapp` | 以 Web/H5 R0 PASS commit 为起点 |
| 8A | `track/8a-book-api` | `/Users/max/code/unseen-worktrees/8a-book-api` | 以本次effective revision为起点先交fixture-backed Book API/domain package；fixed Core RC后只补精确seam |
| 8B | `track/8b-book-web` | `/Users/max/code/unseen-worktrees/8b-book-web` | 以本次effective revision为起点先交fixture-backed Book Web/renderer package；fixed Core RC后只补精确seam |
| 8C | `integration/book-lab` | `/Users/max/code/unseen-worktrees/8c-book-integration` | 以同一Core RC建立；按总控批准顺序汇入8A/8B；唯一Book集成worktree |
| R-C | `research/depth-parallax` | `/Users/max/code/unseen-worktrees/r-c-depth` | 以 R0 或总控明确登记的研究基线 commit 为起点 |
| R-D | `research/walkable3d` | `/Users/max/code/unseen-worktrees/r-d-walkable3d` | 同上 |

Track 5 Stage L汇合时，Track 1A/2/4先停笔并交commit；Stage RC再要求3A/6A及已获授权的1B/3B证据按门禁进入。Track 5只按manifest顺序cherry-pick，不允许直接合并带未声明文件的分支。冲突即退回原Track：暂停Track 5、仅重开一个原owner worktree修复并交新commit，再恢复Track 5。禁止在integration worktree顺手改业务模块。

根 workspace 配置、根 package manifest 与唯一 lockfile 只归 Track 0L 在历史冻结前写；后续合同revision只能由一次性的`track/root-maintenance`串行更新。模块任务可改自己独占目录内的package manifest，但不得更新根lockfile；新增依赖必须提交带必要性、版本、许可、安全和替代方案的RFC。若依赖阻塞模块，总控暂停所有受影响写者，只开启一次性的`track/root-maintenance`串行更新根配置与lockfile、跑全量基线并生成新base commit；随后从新base重建受影响worktree。Track 5阶段由Track 5串行持有Core根lockfile；Track 8阶段只有8C在8A/8B停笔后可串行更新Book集成所需根lockfile。

## 3. 全局共享接口与唯一所有者

| 共享点 | 唯一所有者 | 其他任务规则 |
|---|---|---|
| OpenAPI / JSON Schema / enum / error codes | C4 前为总控合同整改；C4 后无模块写者 | Track 0L 只生成冻结包；各模块只消费。变更必须停受影响写者、走总控 RFC 并重跑 C2/C3/C4 |
| DB migrations | Track 1A | Track 3A 只提交 migration request；Track 2 不写 DB |
| 视觉 tokens / string keys / page & action IDs | C4 前为总控产品合同整改；C4 后无模块写者 | Track 2 只在 `apps/web/**` 消费与映射；Track 4 只消费 viewer tokens；不得修改冻结源或另起皮肤 |
| 定位算法 release / dataset manifests | Track 3A | Track 1A 只保存 opaque versioned output |
| Viewer adapter / yaw transform / context-loss | Track 4 | Track 2 通过稳定接口嵌入，不复制渲染器 |
| 集成 compose / E2E fixtures / release candidate config | Track 5 | 其他任务不并发修改 |
| privacy / retention / abuse / SLO / release checklist | Track 6A/6B 分段 | 6A 产政策输入和测试；6B 只基于固定 RC 收发行证据；业务模块不自行降低门槛 |
| L3 Book schema/API/QuestionProvider port | Track 8A | re-freeze后先只消费Book合同与冻结fixture；fixed Core RC后才消费Account/receipt/photo/placement/media extension seam；不得改Core 90-action真源 |
| L3 Book IA/string/HTML+PDF renderer | Track 8B | re-freeze后继承六图、tokens与冻结fixture独立施工；fixed Core RC后才接Web secondary slots；不得改Core页面与Viewer内核 |
| L3 Book integration/E2E | Track 8C | 只汇合8A/8B与固定Core RC；接缝失败退回原owner，不在集成树修业务代码 |

### 3.1 固定接缝与生成物

- Track 0L 以冻结 ACTION / STRING / TOKENS / API coverage 为唯一输入，生成 `packages/contracts/generated/**`；生成器只在 `scripts/contracts/**`，版本由根 lockfile 固定。生成物禁止手改，CI 必须执行“重新生成后工作树无差异”。任何 schema / enum / string key 变化先停受影响写者、走总控 RFC、重跑 C2/C3/C4。
- Viewer 公共接口只存在于 `packages/viewer/src/public/**`；Track 2 独占 `apps/web/src/adapters/viewer/**`，把 Web 状态映射到该接口。Track 4 不得写 `apps/web/**`，Track 2 不得复制 yaw / WebGL / context-loss 内核。
- 定位 runtime 只消费 Track 0L 生成的 `locator-job` 合同：请求至少携带 Space / Scene / panorama revision / Photo / media checksum / policy release；响应只有 versioned candidate、abstain/OOD/ambiguous 或 failed/timed_out。Track 1A 只负责队列、状态和 opaque release 持久化；Track 3A 只负责 worker 与 release artifact。需要 DB 变化时，Track 3A 只能提交 migration RFC。
- C4 冻结最小 notice/purpose/version/hash 合同。Track 6A 的政策正文与配置只写 `policy-inputs/**`，产出 immutable versioned artifact；Track 1A/2 只消费冻结结构与批准后的 artifact。并行期间不得直接改对方目录，最终接线只由 Track 5 完成。
- Core RC必须暴露Book extension seam但默认feature flag关闭。Track 1A在`services/api/src/extensions/index.mjs`预置惰性loader，它只接受`registerBookLabExtension({registerRoutes,registerInternalJobs,readCorePhotoContext,authorizeCorePhotoParticipant,appendAudit,featureFlags})`，且只能在flag on时加载`services/api/src/extensions/book-lab.mjs`；Track 2在`apps/web/src/extensions/index.js`预置惰性loader与两个secondary slot `photoDetail.afterPlacementSecondary` / `manageOverview.secondary`，只接受`registerBookLabWebExtension({registerRoute,registerSecondarySlot,apiClient,featureFlags})`并在flag on时加载`apps/web/src/extensions/book-lab.js`。flag off时两端必须同时满足Book route/DOM/API mount/job dispatch/DB write全为0，且不导入Book业务bundle。Track 8A/8B只填各自的extension与业务子树，不改Core loader、路由或页面。任何Book故障都不能写Core Photo/content/placement/Viewer状态。QuestionProvider与renderer均为可替换port，正式模型/供应商未冻结时只准确定性fixture证据。

## 4. 正式施工任务

### Track 0L · 唯一母仓与本地冻结合同包

完成后状态：从已取证的腾讯正式 Web / recovered backend 建立一个可复现母仓；冻结 `contracts` 包、构建、测试、配置模板与 provenance，任何模块从同一 commit 开工。

生命周期：Track 0L 是 **C4 内部唯一 bootstrap**，不是 C4 后的普通实现 Track。只有 C2 与 `C3-contract` 均 PASS 才可创建 0L；0L 之外的任何施工任务仍禁止。0L 产出实际母仓、bootstrap commit、worktree/branch 矩阵和完整 `FREEZE-MANIFEST.json` 后，总控独立读回并宣布 C4 Freeze Complete；I0 才能创建 Track 1A/2/4 等模块任务。若 0L 失败或 provenance/hash 不一致，C4 继续 FAIL，销毁未冻结 worktree，不得绕过。

唯一四元组（C4 前不得改名或另选源）：

- 新母仓绝对路径：`/Users/max/code/unseen`；这是新建 Git 仓，不在旧工程原地施工。
- 目标分支：`main`；Track 0L 首个冻结 commit 是所有并行任务的共同 starting state。
- 正式 Web 只读来源：`/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX/work/unseen-panorama-rebuild`，以 source manifest `2542c7b7…` / 130 files 及 `technical/EVIDENCE/01-INVENTORY-CLOUD.md` 的逐文件关键 hash 为准。
- recovered backend 只读来源：`/Users/max/Library/Mobile Documents/com~apple~CloudDocs/Documents/ADVX 3/work/unseen-panorama-rebuild`，以 source manifest `a8d1901e…` / 174 files、backend manifest `9b1c489a…` 及同一证据文件的关键 hash 为准。

两处旧来源均无可信 Git HEAD，因此 immutable source manifest 是 provenance，不得伪称 commit。Track 0L 必须先把完整逐文件 manifest 重算并与 C4 记录比对；不一致即停，不得猜测导入。

一次性导入矩阵（Track 0L 独占，完成首个冻结 commit 后权限即终止）：

| 只读来源 | 母仓目标 | 处理 | 后续唯一写者 |
|---|---|---|---|
| 正式 Web 来源 | `imports/legacy-web/**` | 按 C4 完整 manifest 原样导入；排除缓存、依赖目录、构建产物、密钥和本机状态；逐项记录 included/excluded 与 hash | 只读 provenance；Track 2 从中移植到 `apps/web/**` |
| recovered backend 来源 | `imports/recovered-backend/**` | 同上；保留可复跑 baseline fixture，任何疑似 secret 立即停并从导入集排除 | 只读 provenance；Track 1A 从中移植到 `services/api/**` |
| 冻结产品/技术合同 | `contracts/source/**` | 仅复制 C4 manifest 列出的权威文件并验证 hash | Track 0L / 后续仅总控 RFC |

Track 0L 不得把 legacy 目录直接命名为正式 `apps/web` 或 `services/api`，不得把历史部署配置、真实凭证、`.env`、用户数据、云状态或旧生成物带入母仓。它只写：新母仓 bootstrap、上述 `imports/**` / `contracts/source/**`、`packages/contracts/**`、`scripts/contracts/**`、根构建/测试配置和基线 manifest。  
不写：正式业务 UI、正式 API 实现、算法、云资源。  
门槛：clean checkout 可构建；backend baseline tests；contract generation；secret scan；正式静态源与 recovered backend provenance；冻结 commit/hash。

### Track 1A · 本地 Canonical 后端、账号、权限与媒体链

完成后状态：Account/Membership、view/upload invitation、member invitation、receipt、Space/Photo/Scene、审核、全景 revision、位置 revision、对象存储 ticket/commit 和最小 read models 都由真实服务端强制并可跨设备恢复。

只写：`services/api/src/**`、`services/api/db/migrations/**`、`services/api/tests/**`、`services/api/package.json`、`services/jobs/dispatch/**`、`services/jobs/tests/**`；MediaStore port 只能位于 `services/api/src/ports/media/**`。  
不写：Web UI、定位模型、viewer、发布页面。  
门槛：权限/跨 Space/撤销/过期/幂等/CAS/日志脱敏矩阵；真实字节校验；全景原子换版与 stale；receipt/member invitation 跨 session 与跨设备恢复；对象/DB hash 对账；runtime-remediation A–D：A scene-context exact asset identity与session-auth媒体谓词、B identity整表排他重键、C support非法字段零任何durable write、D account deletion exact status session与reauth-family idempotency scope。
在fixed Core RC前还必须交付上述API inert loader的输入shape、flag-off零挂载证据与结构反例；它只提供空接缝，不包含Book业务实现。

### Track 2 · Web 产品端、双端 UI 与逐页文案

完成后状态：响应式 Web/H5 按冻结 IA 和 A“共光”方向完成；手机与电脑共享 page/action/string IDs；P01–P18（含 P06B、P09B 等补充状态页）的初始、loading、成功、失败、恢复、空态、权限丢失全部可操作。

只写：`apps/web/**`（不含 viewer 内核；Viewer 接线仅 `apps/web/src/adapters/viewer/**`）、Web 测试、视觉截图基线。  
不写：API schema、DB、算法、viewer math。  
门槛：六图风格对照；320/390/430/768/959/960/1247/1248/1280/1440；`<1248` 固定手机布局、`>=1248` 固定电脑布局，不产生第三套 IA；1248→1440 只增外留白，容器、字号、换行与卡片几何保持稳定；键盘/读屏/200% zoom/reduced motion；string key 覆盖；无角色选择、Demo、多图全景、技术词；每页唯一主动作且无死路；runtime-remediation Web接缝必须消费scene-context中两类exact asset identity、用session cookie读取非bearer媒体并在decode前核ETag/SHA，不缓存旧媒体授权。
在fixed Core RC前还必须交付上述Web inert loader、两个secondary slot、flag-off零DOM/零route/零network/零bundle导入证据；它不预先实现Book界面。

### Track 3A · 自动空间定位数据、评测与 Worker

完成后状态：建立经许可的跨 Space 标注集、双人 QA、可复现 baseline 和 abstain/OOD policy；只有单侧置信界全部过门槛的 release 才能 high auto-confirm，否则保持人工确认。

只写：`services/locator/**`、`datasets/manifests/offline/**`、`eval/offline/**`、`release-evidence/locator-offline/**` 与 model release metadata。  
不写：产品 UI、canonical schema、云权限。  
门槛：space-level split、near-duplicate 去重、双人标注/裁决、ID/OOD/模糊多解分层；CI bounds；模型/预处理/数据/阈值 hash；shadow/canary/rollback；失败不丢照片。

### Track 4 · 360 Viewer、照片回现场与诚实降级

完成后状态：verified 2:1 全景真实 WebGL 环视；照片按 canonical yaw/pitch/current revision 打开；返回原照片；context loss/不支持时明确兼容图；手机触摸与电脑鼠标键盘均可用。

只写：`packages/viewer/**` 与 viewer fixtures/tests。公共入口只放 `packages/viewer/src/public/**`；必要的 Web adapter 由 Track 2 在其独占目录实现。  
不写：页面 IA、DB、定位阈值、DAP/true3D 正式入口。  
门槛：canonical↔viewer yaw seam；initial yaw≤冻结门槛；刷新/返回；照片与 panorama checksum/revision/assetId/assetVersion；媒体ETag与DTO SHA在decode前一致；WebGL/context loss；触摸/键盘/焦点；30 分钟稳定性；2D 不冒充 360。

### Track 5 · 核心集成、五 actor 与指定设备/浏览器 E2E

完成后状态分两级。Stage L `Core Local Operable`：A owner与至少一位参与者在本机用真实本地API、持久媒体、正式Web和Track4 Viewer完成创建→成品全景→邀请→照片上传→定位fixture明确标记的high/needs-confirmation/failed→本人修正→owner审核→照片回现场→清本机缓存重开。Stage RC再由A owner、B contributor/viewer、C viewer-only、D 第二 contributor、E scoped member在隔离环境完成完整外层E2E并固定Core RC。五actor验证业务授权关系，不等于设备数量。

只写：`tests/e2e/**`、`infra/integration/**`、`config/rc/**`、`release-evidence/local-operable/**`、Track 5 自有 package manifest，以及 Track 5 阶段串行持有的根 lockfile。
不写：降低合同门槛、skip/todo、mock 被测云服务冒充 E2E。  
Track 5 不得直接写 `apps/**`、`services/**`、`packages/viewer/**` 或模块 tests。接缝失败必须按 §2.1 退回原 owner 单写者修复；不存在“必要接缝修复”这一模糊越权口子。
Stage L门槛：真实本地API/Web/Viewer三方锁定SHA，production adapter路径、原始媒体字节/hash、session-auth媒体、位置/审核/回现场、刷新恢复均可操作；fixture定位在UI与证据中醒目标记；正常路径console/network 0；证据写`release-evidence/local-operable/**`。它只可称`Core Local Operable`，不得称Integration、RC、R0或production-ready。Stage RC门槛：冻结合同全部外层行为；五actor E2E；runtime-remediation A–D证据矩阵按 A 媒体、B 身份、C 支持、D 删除逐条包含结构断言与破坏性反例；另按technical release contract的named device/browser matrix覆盖iPhone Safari、Pixel Chrome、微信内置浏览器iOS/Android、Windows Chrome/Edge/Firefox、macOS Safari/Chrome/Firefox，并记录精确设备/OS/浏览器/build。正常路径console/network 0；非预期云写0；越权泄露0；request IDs/DB/object checksums/screenshots/traces/cleanup；错误注入→恢复。

### Track 6A / 6B · 信任安全、隐私、可运维与发行就绪

完成后状态：首发 Web/H5 的政策、产品页、API级联、滥用防护、日志/监控/告警、备份恢复、迁移/回滚、许可、支持和发布材料形成可审计 release gate。

Track 6A 只写：`policy-inputs/**`、`ops/security/**`、`ops/observability/**`、`runbooks/drafts/**`、`tests/security-contract/**`。  
Track 6B 只写：`release-evidence/r0/**`、`ops/release/**`、`runbooks/release/**`；它对 `release-evidence/cloud-sandbox/**`、`release-evidence/locator-shadow/**`、`release-evidence/locator-offline/**` 仅只读汇总，不复制或改写原证据。它只能在 Track 5 交付固定 RC commit 后收证，不得回写产品模块。业务 API/DB/删除/导出/举报实现始终归 Track 1A；Web 页面始终归 Track 2。  
不写：`services/api/**`、`apps/web/**`、擅自作法律承诺、部署生产、购买服务。  
门槛：版本化同意；账号/照片/Space 删除与对象/CDN/备份口径；举报申诉；EXIF/GPS；恶意文件/限流；SLI/SLO/告警；RPO/RTO恢复演练；canary/kill switch/rollback；SBOM/font/media notices；指定真机、性能和无障碍矩阵；人工法律复核状态明确。

### Track 1B · 隔离 sandbox 真云适配

开工门槛：Track 1A provider ports 已冻结；Max 已明确授权一个可删除、与生产隔离的 CloudBase / OSS / OTP sandbox；secret 只通过本机批准的 secret store 注入。  
只写：`adapters/cloud/cloudbase/**`、`infra/sandbox/**`、`tests/cloud-sandbox/**`、`release-evidence/cloud-sandbox/**`、`adapters/cloud/cloudbase/package.json`。  
只读：`services/api/**` 的 provider port 与 `packages/contracts/**`；不得反向改 API/schema，不得触碰生产 project、bucket、域名或用户数据。  
交接：独立 commit + 原始 request IDs、对象/DB hash、清理记录与成本；由 Track 5 在固定 RC 中接入。  
门槛：create/upload/commit/read/delete/expiry/retry/rollback 真链；服务端字节校验；无意外云写；sandbox 可完全清理。

### Track 3B · 获授权真实数据 shadow gate

开工门槛：Track 3A 离线基线可复现；有书面数据许可、用途/保留/撤回范围和标注方案；不得把历史婚礼素材默认视为已授权。  
只写：`datasets/authorized/**`、`eval/shadow/**`、`release-evidence/locator-shadow/**`。Track 3A 对这些子树无写权限。  
只读：`services/locator/**` 与 generated contracts；不得改 production policy、DB migration 或 UI。  
交接：版本化 dataset manifest、双人标注/裁决、预注册阈值、shadow 结果、误放/拒识反例和销毁证明。  
门槛：所有置信区间与严重误放/OOD 门槛过关才可提 release RFC；否则唯一输出是 abstain / 人工确认。

### Track 7 · 小程序薄客户端

开工门槛：Web/H5 R0 release sign-off 已通过。  
完成后状态：小程序只调用同一 canonical API，使用同一 page/action/string IDs、权限和状态，不再写 native 第二套业务真值。

只写：`apps/miniapp/**` 与其适配测试。  
门槛：相同 invite/photo/placement IDs；真机相册/弱网/后台恢复；权限拒绝；与 Web 交叉设备 E2E；不出现多图全景或平台专属业务状态。

### Track 8A / 8B / 8C · L3 Book Lab 照片问答成书

开工门槛：本次runtime+Book合同revision的Codex C2、桌面Claude C3与C4 re-freeze均PASS；Book feature flag默认off。8A/8B可先基于冻结合同与明确标记的确定性fixture独立开工；只有写Core extension seam、8C集成与对外启用要求Track 5固定Core RC。Track 8不得偷偷进入正在施工的1A/2/4 worktree。

Track 8A完成后状态：个人记忆问答、QuestionProvider port、最多一次追问、immutable confirmed revision、逐书逐revision授权/撤回、Book/draft/freeze/render job与session-auth preview/PDF API均由服务端强制；AI失败不写Core状态。
只写：`services/book-lab/**`；只有1A writer已停且fixed Core RC存在时，才可条件写精确接缝`services/api/src/extensions/book-lab.mjs`。
不写：Core 90-action合同、既有upload/placement/Viewer实现、Web页面、模型供应商采购。
门槛：Book BOLA/consent/withdraw/freeze/CAS/idempotency、QuestionProvider abstain/timeout、Core零写、source provenance与渲染manifest对账。

Track 8B完成后状态：BL01–BL06在手机/电脑复用“共光”视觉与同一20-action/string真源；照片提问、回答/一次追问、编辑确认、逐书授权、书稿编辑与HTML/PDF预览可用，不变成聊天页或Studio。
只写：`packages/book-lab-web/**`、`packages/book-renderer/**`；只有Track2 writer已停且fixed Core RC存在时，才可条件写精确接缝`apps/web/src/extensions/book-lab.js`。
不写：Core Web route/IA、Viewer内核、API schema/DB、用户回答AI改写、模板市场、印刷/支付/订单/物流。
门槛：六图继承；20 actions × 9 phases = 180个动作状态完整，BL01–BL06只渲染当前页面适用状态；每页唯一主动作；320/390/1247/1248/1440、200% zoom、键盘/读屏；XSS/remote-resource/RTL/超长中文；HTML/PDF同manifest且逐页不裁字。

Track 8C是唯一Book集成写者。
只写：`tests/e2e/book-lab/**`、`infra/integration/book-lab/**`、`config/book-lab-rc/**`、`release-evidence/book-lab/**`，以及8A/8B停笔后串行持有的根lockfile。
不写：`services/**`、`apps/**`、`packages/book-renderer/**`业务代码；接缝失败必须暂停8C并退回8A或8B。
门槛：固定1事件、1 ready panorama、12–20照片、3–5参与者、每图1问、冲突署名视角、12–16页HTML/PDF；未授权正文泄露0；freeze前后撤回、affected、新版本与下载不可召回文案；在fixed Core RC上的Core 90-action regression全绿，但不要求Core R0先PASS。

## 5. 后置研究任务

### Track R-C · 商用深度有限视差

独立批准模型下载、GPU 与真实全景数据后才开工。只写 `research/depth-parallax/**` 与 `release-evidence/research/depth-parallax/**`；branch/worktree/starting commit 按 §2.1，其他产品、API、viewer 正式入口与云生产全部只读/禁止。先递归许可/SBOM，再做 equirectangular seam/极区/边界/非平凡深度与盲评 benchmark。交付独立研究 commit、许可树、设备/模型/data manifest 与 go/no-go 报告；通过后也只能提交正式接入 RFC。任何失败回 rotation360，产品只称“有限视差”。

### Track R-D · video/scan → walkable3d POC

只用获准内部 fixture。只写 `research/walkable3d/**` 与 `release-evidence/research/walkable3d/**`；branch/worktree/starting commit 按 §2.1，禁止写正式产品入口、canonical schema、生产云和未授权数据。必须同时产 camera map、visual field、metric geometry、collider、navmesh、coordinate frame 与 device report；只有好看的 splat/NeRF 不算可走 3D。交付独立研究 commit、fixture许可/销毁记录、benchmark和 go/no-go；任何正式接入必须另走 RFC。POC 失败不阻塞正式 Web/H5。

## 6. 施工任务的最小上下文包

每个新任务只接收：

1. 本文件“总体原则”与自己的 Track 段；
2. 冻结 manifest 和与自己有关的 1–3 份合同；
3. 允许写路径、禁止路径和依赖 commit；
4. 可复跑基线、完成门槛和证据输出目录；
5. 一个接缝表：消费什么接口、由谁拥有、何时可以请求变更。

不向模块任务投递完整历史聊天、旧 PRD、被 superseded 的 V11 施工史或其他模块的内部实现。需要澄清时只向总控提交一条带影响、证据与推荐的 RFC，不自行另立语义。

## 6.1 C4 冻结清单与单写者锁

历史`C4 Freeze Complete`与后续effective contract revision都只由根目录唯一`FREEZE-MANIFEST.json`表示。v2至少包含：

1. 产品、技术、总控合同逐文件绝对路径、SHA-256、权威副本与状态；
2. ACTION / STRING / TOKENS / ACTION-API coverage 的数量、集合 hash 与相互引用 hash；
3. 历史Track 0L四元组、不可变bootstrap commit `a790b3a2d152701e75171cb4dfdeeda52e7bfbd5`、完整source manifests与effectiveContractRevision；历史起点不得用动态SELF伪造；
4. 原始13个Track的唯一可写路径、只读依赖、真实历史starting commit与requiredContractRevision；Track 8A/8B冻结`effective_revision_freeze`与fixture-only边界，C4完成后以精确effective revision SHA创建并写`/Users/max/Documents/Codex/2026-08-13/unseen-track8-bootstrap/WORKTREE-REGISTRATION-8A-8B.json`；Track 8C只冻结`future_fixed_gate`，fixed RC后才创建并写同目录`WORKTREE-REGISTRATION-8C.json`；
5. 本revision的Codex C2与桌面Claude Code C3验收结果；冻结前P0/P1必须为0。非权限、隐私、数据一致性或真实接缝的P2须逐项登记为`post-local debt`，但不阻塞re-freeze或Core Local Operable；
6. R0 证据根与 go/no-go owner。

不在该 manifest 的文件不得作为施工语义依据。合同变更只能由总控登记 RFC、停止受影响写者、更新合同与 manifest、重新交叉验收后生效；模块任务不得自行修改冻结合同。

进入 Track 5 Stage L 前，只有 Track 1A、2 与 4 必须停笔并交付 commit；3A可按三写者波次与Stage L并行，6A也不得被误设为本地可操作版前置。进入 Track 5 Stage RC 汇合前，3A、6A以及已获授权的1B/3B才必须停笔并交付各自批准的commit。Track 5 获得集成配置与经总控逐项批准的接缝文件临时独占权；原模块写者只读复验，不得并发修同一文件。

## 6.2 R0 的唯一含义

`Core Local Operable = PASS`只表示真实本地API+Web+Viewer核心流可由Max操作，证据在`release-evidence/local-operable/`，允许醒目标记的定位fixture，不要求sandbox、真实定位数据或Release审批；它不参与overall表达式，也绝不推导Integration/RC/R0。`Web/H5 Core R0 = PASS`仅当Module、Integration、Release三层全部PASS、独立产品/视觉与技术/安全终审P0=0/P1=0，且证据写入`release-evidence/r0/`后成立。`Book Lab MVE = PASS`只按独立Track8证据成立。总控是三个节点的唯一go/no-go owner；Web页面完成、H5手测通过或产生release candidate都不能单独称R0；Core R0绿灯也不能冒充本轮全流程完成。Track7只消费Core R0；本轮总体完成必须同时满足`Core R0 PASS && Book Lab MVE PASS`。

## 7. 总控收网

每个 Track 完成不等于产品完成。总控按以下顺序收网：

1. 锁定分支/commit与文件范围，复跑模块公开证据；
2. 检查是否改了非归属文件、判卷脚本或合同门槛；
3. 由 Track 5 完成接缝集成；
4. 独立产品/视觉与技术/安全验收；
5. 桌面 Claude Code 执行 `R0-customer-review`，对Core release candidate再做客户视角反审；它不能冒充冻结前的 `C3-contract`；
6. Track 8C完成后另做独立`Book-MVE-customer-review`与Book权限/撤回/渲染红队，回执、checkpoint与反例只落`release-evidence/book-lab/`；它不得借Core R0 review结论，只有此独立验收P0/P1=0才可由controller判`Book Lab MVE = PASS`；
7. 只有所有 release gate 通过，才进入生产部署 / 发布的单独授权动作。
