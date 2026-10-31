# UNSEEN Web/H5 Release Readiness合同

版本：2026-08-13 Runtime + L3 Book Lab Contract Revision Candidate
当前结论：**NOT READY / NO-GO。** 本文是Release DoD，不是已完成回执。  
首发：invitation-only、简体中文、不可索引的响应式Web/H5。小程序只在Web/H5 R0 sign-off后开工。

法律与合规说明：本文定义工程对象、API、控制和证据；隐私告知、同意、保留、未成年人、跨境、UGC处置、申诉和通知义务必须正式法律/合规复核。本文不冒充法律结论，但相关对象/API不能以后置为理由从v1合同删除。

## 1. V1必须实现的对象与表面

1. Account邮箱OTP、session family、re-auth、logout/logout-all；Account设置/导出/删除。
2. Membership tasks/managementScopes；owner-only MemberInvitation/Membership/collection/owner transfer。
3. External campaign public locator、任务/状态/cap/rate/abuse/revoke、per-visitor challenge/admission/one-time exchange、隔离viewer/contributor principals/sessions与本地二维码read model。
4. contribution batch/items、per-item upload/commit/retry/remove、一次finalize、一份batch receipt、partial success、Account binding recovery。
5. panorama candidate/ticket/upload/commit/validate/status/retry/switch/rollback/history/orphan cleanup；无clear/delete-current。
6. content/placement/reason/audit/per-item manager lock/reopen；viewerPhotoDetail、uploadContext、batch result、management read models。
7. versioned consent/media notice、对象report/case status、appeal/status、generic support、photo/Space/account deletion+ledger、exports。
8. 自动定位分流+人工兜底、visible album、confirmed/current Scene CTA和诚实2D fallback。

不进v1 Core R0：多照片生成全景；L2 SceneNote；depth_limited_parallax；walkable3d；小程序/原生客户端；无session gallery/SEO。L3 Book Lab是本轮必须完成的独立后置MVE，不进入Core 90-action gate，也不得阻断Core主链。

## 2. ACTION/API/string一致性

`product-ui/ACTION-REGISTRY.json`是用户action真源；`product-ui/STRING-CATALOG.zh-CN.json`是简体中文phase真源；`technical/ACTION-API-COVERAGE.json`是transport/API覆盖真源。

Release前必须：

- 三文件都是合法JSON，记录source SHA-256与schemaVersion；
- product action ID与coverage action ID集合完全相等，duplicate/orphan/missing=0；
- 每个action都有transport、endpoint/method或navigation/static目标、authorization、requestSchema、successDTO、stableErrors、idempotency、If-Match/version、releaseLane；
- 每个If-Match/version只引用canonical Version/CAS Dictionary中的精确`table.field`及递增transaction；自由文本幻名命中0；专用epoch只允许`accounts.sessionEpoch`与item`placementAuthorizationVersion`；
- 每个registry stringKey在string catalog存在；null只表示明确不渲染，不允许缺key；
- ACTION snapshot改变时coverage hash失效并阻断build；不能人工口头声明已覆盖。
- canonical暴露的每个HTTP mutation必须与顶层action、workflowSteps或`technicalOperationCoverage`的endpoint+method集合一一相等；所有下属operation也完整声明auth/request/success/errors/idempotency/replay/CAS。若technical entry与顶层action共享method+endpoint，必须是指向唯一parent action的reference，且endpoint/method/auth/request/success/errors/idempotency/replay/CAS逐字段全等；set去重不能充当验收。`EXPORT.DOWNLOAD`固定`credential_reissue`，只缓存resource ref/完成态，绝不缓存signed URL/token。

C3 campaign remediation coverage必须依据产品更新后的ACTION/STRING/TOKENS真源重锁，并以文件读回计算真实array/unique/set、全部source/phase、canonical HTTP mutation双向集合与CAS/idempotency/credential门禁。External多人分享route只能是非敏感campaign locator；每访客派生`#invite=:secret`，member/receipt继续使用各自one-time fragment。当前结果仍只是独立红队候选，**不得**据此宣称实现、Integration或Release通过。

本次revision必须同时保持Core `90 actions / 360 source refs / 810 phases / 59↔59 mutations`，并独立冻结Book Lab `20 actions / 80 source refs / 180 phases / 15↔15 mutations / 5 state machines`；两namespace action ID交集为0。Core CAS为47、Book additions为8、canonical union为55；technical operations为8，internal operations为4。Book gate失败不能被Core gate绿灯掩盖，反之亦然。

## 3. Invitation、session与反枚举

- URL bearer默认禁止；唯一例外闭集为invitation与batch-receipt bootstrap：≥128-bit CSPRNG single-consume secret分别只在精确`#invite=`或`#receipt=`fragment，绝不path/query且family/key不可互换。最早同源bootstrap必须no-store、`Referrer-Policy: no-referrer`、strict CSP、无service worker/第三方脚本/subresource/prefetch，并在任何API/analytics前读入仅内存变量、立即`history.replaceState`清URL，再POST对应同源exchange。
- Invite/receipt fragment与secret不得进入server/CDN/WAF log、console、analytics、error、DOM持久化、local/session storage、IndexedDB、Cache API或后续history。成功原子消费并旋转为HttpOnly Secure SameSite session；刷新/转发旧链接不能重放。OTP/session/reauth等不适用URL例外。
- CredentialCryptoProfile固定CSPRNG 32-byte bearer、domain-separated HMAC-SHA-256+keyId、challenge+identifier+purpose绑定OTP MAC、constant-time compare及KMS双读单写轮换。所有credential/Set-Cookie response为`no-store, private`。
- External P16签发的是可多人分享的非credential campaign URL，二维码仅本地编码同源`/open/{publicCampaignId}`且无query/fragment/tracking；public ID不能直接调用viewer/upload API。无live session访客必须逐人经过challenge/admission，拿到独立maxUses=1 bootstrap，再exchange为隔离principal/session。
- Admission同transaction锁campaign与短TTL challenge，constant-time复验campaignId+clientNonce MAC、TTL、consume/revoke，并校验固定`__Host-` Secure/HttpOnly/SameSite=Strict/Path=/ Cookie、Origin/Host/Fetch-Metadata；A challenge换B campaign统一失败且两边计数不动。再复验Space active、view→shared、upload→open、总成功数、pending、rate/abuse policy；exchange锁campaign+per-visitor grant并原子分配唯一use ordinal。
- Grant拆`bootstrapExpiresAt`与`accessExpiresAt<=campaign expiry`：成功exchange后bootstrap过期不影响session至access expiry；campaign exhausted阻新访客但不杀已成功ordinal，paused/revoked/expired立即阻新链与既有external live authorization。
- Campaign只能保证每次成功兑换/browser principal隔离，不能证明自然人唯一；需要实名参与者去重必须走Account+verified email OTP，严禁持久化设备指纹或在文案/指标中把ordinal称为人数。
- Campaign missing/paused/revoked/expired/exhausted/rate/abuse/wrong state统一`campaign_unavailable`；per-visitor bootstrap invalid/expired/revoked/consumed统一`invite_unavailable`，同status/body等级/等价时延；管理审计才见脱敏原因。
- 内部`CAMPAIGN.SWEEP_EXPIRATIONS`必须以有界批次和统一锁序处理campaign、challenge与未消费grant到期；`expiredAt/expiryProcessedAt/bootstrapExpiredAt`和partial-unique audit事件保证at-least-once幂等。遗弃grant的pending释放、grant/campaign version递增与`grant_bootstrap_expired + pending_released`必须同事务；counter异常或audit失败整笔rollback并告警。
- Identity唯一性由rotation-invariant `identifier_equivalences`与active equivalence→Account唯一绑定承担；可轮换MAC aliases只作lookup并FK到equivalence。每行另存由独立KMS-AEAD key保护的normalized identity envelope；旧`k_equivalence` collision-key epoch/material退休只能在`IDENTITY.REKEY_EQUIVALENCES`排他整表stage/verify/atomic-swap成功后发生。OTP建号先锁/upsert equivalence；MemberInvitation绑定target equivalence。不得以`(keyId,mac)`承担账号唯一性，也不得用机会式登录迁移或永久保留旧key冒充轮换。missing/target mismatch/expired/revoked/accepted/Space inactive对持链者统一`member_invite_unavailable`。
- batch receipt首次exchange由服务端keyed MAC锁定receipt并用loaded version原子消费；不接受客户端If-Match。同Idempotency-Key只返回current/completed，不再消费；不同key/无session统一不可用。之后只靠HttpOnly session或verified Account binding recovery；全链复验Space active。
- account/viewer/contributor/receipt/case sessions使用Secure、HttpOnly、SameSite、CSRF/Origin/Host校验、rotation/revoke；DB只存keyed MAC+keyId。Account session/family保存`issuedSessionEpoch`，每次鉴权与`accounts.sessionEpoch`复验；logout-all递增全局epoch并撤销全部families/sessions。
- viewer授权分支互斥：account分支只需active Space+current epoch+owner/active Membership task=view且不要求shared；external分支必须active+shared+live campaign/grant/viewer principal/session。
- BOLA授权按Space/batch/item/photo组合FK重新查，不信route guard或body role/task/scope。
- Owner transfer按`targetAccountId + targetMembershipId`绑定，无bearer secret/link；GET只列当前目标账号pending，accept以transferId+reauth+transfer version和Space version原子CAS。
- `idempotency_records`必须按principal/challenge/credential family+method+canonical endpoint+key做唯一scope并保存requestHash/replayClass/state。普通DTO、credential reissue、secret-once envelope、completed-state四类逐mutation冻结；同key不同body固定409，credential/Set-Cookie永不从缓存复活，secret envelope过期后只返回completed-without-secret。Account deletion丢失响应只能由原始已消费reauth credential family + 同key/hash + responseRef/createdByIdempotencyRecordId/exact deletionId三向一致的completed-replay分支轮换同一status session；禁止重跑删除或恢复account authority。
- ReauthPurpose是closed action map；`BATCH.DELETE_ITEM→photo_delete`并绑定account+space+photo，其他purpose拒绝。challenge/grant绑定account+sessionEpoch+action+purpose+target，敏感mutation在同transaction消费。Owner transfer每Space最多一条pending并记录spaceVersionAtCreate。

必测：campaign public URL/QR不含secret/tracking且直打业务API无权限；B/D从同一combo URL并发得到不同challenge/grant/ordinal/principal且cross-visitor BOLA为0，C从独立view-only campaign只能查看；Campaign A challenge换Campaign B、nonce变更、同challenge幂等、pending/rate/total/abuse、bootstrap/access双TTL、expiry/revoke与反枚举通过。成功exchange后推进到`bootstrapExpiresAt < now < accessExpiresAt`仍可访问，live authorization不得读取bootstrap TTL。Sweeper对遗弃grant只释放一次pending、重跑零变化；与exchange竞态时只允许一个分支改变counter；challenge expiry不改pending；每个分支均有冻结audit enum且owner DTO只给聚合/脱敏信息。`#invite=`/`#receipt=`闭集在首个字节阶段无subresource/third-party/SW、同步replaceState、Referer/history/DOM/storage/error/analytics零secret；同family并发仅一兑、跨family/key失败、刷新/转发不可重放；另测identifier key轮换不双建号、真实version旧值、全账号sessionEpoch撤销、CSRF、cross-Space ID与并发receipt consume。

## 4. Privacy、consent与media notice

Versioned notices必须在API与UI可读取并按hash记录：

| purpose | 必要说明/记录 |
|---|---|
| Space/panorama | 有权采集/分享、受邀范围、删除/导出、notice version/hash |
| photo upload/locator | 谁可见/审核/改placement、locator处理、batch result/recovery、metadata政策 |
| Account binding | verified email用途、recoveryUntil、撤销方式 |
| object report/appeal | case用途、进度可见范围、禁止滥用 |
| L2 SceneNote | 另版opt-in；contributor_only；不与locator consent捆绑 |
| L3 memory interview | 另版opt-in；AI只基于当前照片可见事实提问；可跳过/重试；模型问题与用户原话分开存 |
| L3 book contribution | 对指定Book、指定personal-memory revision逐条授权；署名、撤回、冻结后影响与已下载PDF不可召回 |
| future walkable3d | 视频/音频/人脸/车牌/空间采集另版；不继承panorama consent |

NoticePurpose闭集见canonical。photo_upload沿用MEDIA_NOTICE.OPEN+UPLOAD.ACCEPT_NOTICE；space_create/panorama_upload/receipt_account_binding/object_report/appeal在目标页面展示并由mutation携带version/hash acknowledgement，不新增产品action。Consent event不可变；withdraw只追加`consent_withdrawal_events`，其他ack追加`notice_ack_events`，不原地写withdrawnAt。

媒体：JPEG/PNG/static WebP/HEIC/HEIF按magic/decoder；EXIF orientation后再derivative/locator；ICC/NCLX→sRGB；动画拒绝；decode bomb隔离/限额；GPS/序列号默认不持久化/不进DTO/log。原图/derivative分hash/provenance。

Viewer媒体只用同源session-auth、non-bearer、repeatable GET。scene-context必须冻结panorama与viewer-safe photo derivative各自的`assetId + assetVersion + sha256 + bytes + contentType`；客户端在解码前逐字比对响应ETag与DTO SHA-256。Panorama每次GET还必须复验`sceneReadiness=ready`、`sceneMode=rotation360`、`spaces.currentPanoramaRevisionId=rid`以及revision ready且未retired；任一授权、revision、asset或placement漂移让旧URL下一次读取立即失败，且读取零业务写。Panorama完整字节与单Range读取都执行同一server-observed **33,554,432 bytes（32 MiB）**上限：整值允许，**33,554,433 bytes**在create/commit/read任一边界稳定fail closed。

## 5. Batch receipt、删除、恢复与导出

### 5.1 Batch与per-item

- 一batch多item，一次finalize一份batch receipt；partial success逐item显示。
- 每item独立delete/revoke/uploaderPlacementWriteEnabled/placementAuthorizationVersion。
- SAVE/CONFIRM/UNDO/RETRY/MARK_OUTSIDE及所有manager placement write共用原子item-lock模板；只锁该item并递增item.version+placementAuthorizationVersion、写event。receipt writer自身合法操作不锁自己；owner reopen只重开该item。
- Account binding只经verified Account/OTP；recovery按current Account bindings，不接收任意receipt ID。
- `accessExpiresAt`、`recoveryUntil`、`revokedAt`分别展示/执行。

### 5.2 Photo deletion

有效receipt item session或owner可请求：立即从viewer/receipt read model撤权→revoke item/signed URLs→cancel jobs→删raw/derivative/thumbnail/suggestion/SceneNote private output→purge CDN→deletion ledger。Ledger只追加immutable attempt/status events，以seq+previousEventId成链，绝不原地改旧event。reviewer不能凭canReview永久删除。

工程目标：授权读取P95 5分钟内失败；primary DB/object/derived 24小时；backup到期≤30天。期限需法律/运维批准后才能对外承诺。

### 5.3 Space deletion/archived

owner+reauth。先在同一transaction切private/paused/archived并撤销外部/member invitation与viewer/contributor/receipt sessions（逐个设置revokedAt并递增真实version），再按ledger级联panorama/batch/photo/assets/jobs/cache。Archived非owner不出现在mySpaces；owner只可summary/export/unarchive/delete/disposition；即使session撤销写漏，所有receipt入口仍以Space-active门fail closed。

### 5.4 Account deletion

revoke session/provider标识；active/archived owned Spaces必须逐一owner transfer或delete，否则409。删除Membership与receipt Account bindings；历史audit actor最小化/pseudonymize按正式retention。不可造orphan owner。Delete request必须原子签发仅可读取exact deletionId粗粒度状态的`__Host-unseen_deletion_status` cookie并清旧account cookie；不得复用case access或让旧account session恢复权限。

### 5.5 Export与restore

Account export、owner Space export使用async job、短期private download。Backup restore先重放deletion/revocation ledger再开流量，不能复活deleted/revoked/hidden/rejected内容。

## 6. UGC report、appeal与support

- Object report只接受valid viewer/receipt/account session；服务端从session/对象关系绑定target，不能相信裸object ID。
- Report create绑定spaceId+target组合FK+actor relation/version并返回高熵caseId+case access session；case status只给current original relation并限流/反枚举。
- Affected receipt/account session可appeal；appeal不自动改photoContentState。
- v1 report/appeal只接受结构化category与文本description/statement，不接受attachment、asset、uploadSession或multipart；未知媒体字段稳定`unsupported_field`，不得临时创建第三条媒体上传链。
- 无session只可创建generic support/security lead；请求schema严格为`{category,description}`。`contact`、targetObjectId或任意未知字段必须在任何durable write前统一`unsupported_field`；数据库前后快照要证明rate/dedupe/audit/idempotency/case/session/credential/actor及其他持久行全部零新增、零改变，不能成为object report旁路。
- Review event用固定`transitionReasonCode`与按action受限的`decisionReasonCode`；APPROVE decision=null。Report/appeal/support保留category，处置结果只复用`decisionReasonCode`，不复用transition enum。
- CaseActorRelationKind仅account/viewer/receipt/case_access，schema用精确FK/version列与XOR CHECK；撤销原viewer/receipt后只允许same active Account或live独立case_access读最小case envelope/申诉，不恢复target。owner/canReview的case list/detail/transition是现有management read model的从属workflow，CAS `content_cases.version`并追加immutable decision event，不新增产品action；纯case transition不得改Photo。

运营SLA、category、非法内容保全、未成年人和法律通知待正式复核；但reports/appeals/support cases及status API是v1必做。

## 7. Abuse、rate limit与恶意文件

组合维度：Account、campaign、per-visitor grant/principal/session、Space、batch/item、object bytes、case、短TTL keyed network/client-risk bucket。初值进版本配置并压测冻结；raw IP、完整UA与设备指纹不得持久化。

- OTP/campaign admission/invitation/receipt exchange防枚举、失败滑窗、指数退避；campaign另有总成功数、pending、per-window/risk bucket与server abuse pause/kill switch；响应不泄露存在性或剩余额度。
- Campaign安全审计只追加immutable events；owner/canInvite只见campaign内聚合和脱敏reason class。Secret、raw bootstrap URL、raw IP、full UA、risk MAC与跨campaign稳定访客键在DB/DTO/log/analytics均为0。
- Upload限batch/item/count/bytes/concurrency；paused/archived硬拒绝；同idempotency key不同bytes 409。REMOVE_ITEM只允许open+failed，其他batch/item状态一律`item_state_conflict`。
- Viewer防ID枚举/批量签名URL；case endpoint防垃圾/骚扰；locator/L2/depth/3D有queue/GPU budget与server kill switch。
- Media allowlist、magic、真实decoder、随机private key、文件名不进object path、bytes/pixels/frame/metadata/CPU/RAM/time limits、sandbox、失败quarantine/delete；malware scan若基础设施允许。

Fixture：polyglot、伪MIME/后缀、truncated HEIC、animated WebP/HEIF sequence、pixel/ICC/EXIF bomb、path traversal、duplicate chunks、decoder crash、AV timeout。

## 8. Content、Placement、Panorama与SceneNote

- Content转移严格按canonical两个不重叠enum；optional note不替代code，非法action/decision组合拒绝。
- Placement建议类映射：uncertain/OOD/ambiguous/abstained/no active policy→needs_confirmation。
- Placement执行失败类映射：failed/timed_out/decoder/retry exhausted→failed。
- failed只给retry/manual/outside；无suggestion不得伪造candidate。
- authKind只service_job/membership/receipt_session/space_owner；space_owner以spaceId+spaces.version授权，不造owner Membership，并保存全部版本快照。
- Space create必须原子创建Scene(version=1, unavailable, rotation360)并由sceneId绑定，不建owner Membership。Panorama release证据必须覆盖绑定exact key的一次性ticket、直传、幂等commit、HEAD/GET真字节与2:1 decoder验证、status/retry、ready-only switch、失败保旧current与orphan cleanup；switch/rollback双CAS Space+Scene并递增两者version；无前台clear/delete-current。
- L2 SceneNote首阶段contributor_only；v1 viewing字段allowlist不含L2字段。withdraw删正文/草稿/private derivatives，只留不可还原正文的最小audit。

## 9. SLI/SLO与告警

以下是待canary实测的目标，不是现状：

| SLI | 目标 |
|---|---|
| Authorized API availability | 30天≥99.9%；预期4xx不计，5xx/timeout计失败 |
| Viewer projection | ≥99.9%，server P95≤1s；album不要求panorama |
| First usable Web | named 4G/25Mbps profile P75≤3s；Scene lazy load单列 |
| Batch commit/finalize durability | ≥99.0%；无重复photo/receipt；partial count正确 |
| Cross-device revision convergence | P95≤5s |
| Locator job | P95≤30s；abstain非系统失败 |
| Authorization leakage | 0 |
| Deletion access revoke | P95≤5min |

告警：error-budget burn、5xx/timeout、upload checksum/count mismatch、viewer auth异常、cross-Space sentinel、queue age/retry storm、pano transaction invariant、item lock/event mismatch、backup lag、restore mismatch、CDN purge、decoder crash、secret-redaction canary。

每个告警有owner/severity/判断树/只读诊断/kill switch/恢复/数据校验/升级/postmortem模板。

## 10. Backup、migration、canary与kill switch

- Metadata RPO≤1h、RTO≤4h目标；隔离环境全量metadata+抽样media restore，验证组合FK与deletion/revocation ledger。
- Migration用expand→backfill→verify→switch read→switch write→contract；legacy scan/dry-run/hash/reject/rollback，不猜missing owner/review/placement。
- Canary：fixture→test Space→1%→5%→25%→100%；每级覆盖viewer、batch、review、placement、pano、revoke/delete/case。
- Server kill switches：newInvitationExchange、newUploads、sharingReads、autoPlacement、placementWrites、panoramaSwitch、SceneNote、bookLabQuestionJobs、bookLabRendering、depthScene、walkableScene。
- Rollback不能回到无batch/item/receipt CAS、无revision的旧writer。

## 11. 五actor与named device/browser

五actor E2E：A owner、B combo campaign contributor/viewer、C独立view-only campaign viewer、D与B同campaign的第二contributor、E scoped member。A以同一combo campaign让B/D分别兑换，另建view-only campaign验证C确无upload task；各浏览器必须得到独立challenge/grant/use ordinal/principal/session，跨访客batch/viewer capability不可串用。它验证授权与业务关系，不是设备数量。

Named matrix至少：小屏/当前iPhone Safari；中端Android/当前Pixel Chrome；微信内置浏览器iOS/Android；Windows Chrome/Edge/Firefox；macOS Safari/Chrome/Firefox。记录精确model/OS/browser/build。

响应式骨架断点唯一为mobile `<=1247px`、desktop `>=1248px`；两侧必须消费同一action/route/state/copy语义，只允许导航容器位置与布局变化。需在1247/1248边界、320–1440连续宽度、横竖屏与200% zoom下验证无第三套语义、无双导航、无隐藏管理能力漂移。

测试：campaign public URL/本地QR零网络与零payload analytics、多人并发admission、reopen/share/revoke/expiry/cap/rate/abuse；per-visitor invitation bootstrap fragment同步清理、严格CSP/no-referrer/no-store、SW/第三方/subresource为0、单次consume及刷新/转发失败；另测OTP、HEIC、batch partial/finalize/recovery、弱网/后台/断网、WebGL/context loss、320px–1440、200% zoom、keyboard/focus/skip link/semantics/contrast/reduced motion、VoiceOver/TalkBack/desktop reader。360必须有可聚焦方向控件、键盘、上一/下一、aria-live位置、非视觉区域/照片列表、回照片/相册路径和2D fallback。

目标WCAG 2.2 AA；法域义务另行复核。简体中文全部action phase/consent/case/delete/recovery人工审校，stable code不能代替人话。

## 12. Dependency、font、media、model与data license

- release artifact有递归SBOM、lock/hash、license/notice/source/build flags/CVE exception owner+expiry。
- 中文字体有Web embedding/subset/redistribution授权、fallback/缺字验证。
- icon/image/audio/demo panorama/photo/3D asset有人物/场地/商用/修改/再分发权利记录。
- AI代码、权重、训练/评测数据、输出用途分别核；DAP、原版3DGS、Instant-NGP等non-commercial不得进商业artifact。
- FFmpeg/decoder记录真实build flags；顶层MIT/Apache/BSD不能代替依赖树。

## 13. Module、Integration、Release证据包

### Module

- local commit/dirty provenance、lock、fixtures/hashes、unit/contract/component results、ACTION/STRING/API coverage、secret/license初扫。
- 不要求deploy identity；只可声称Module PASS。

### Integration

- sandbox deploy identity/artifact/schema/config、真实CloudBase/OSS/OTP traces、五actor E2E、DB/object checksums、auth/error injection、cleanup。

### Release

- campaign admission/exchange load+abuse game day、canary/rollback/kill switch、dashboards/alerts/runbook、backup restore RPO/RTO、named devices/a11y/perf、privacy/security/legal/license审批、UGC运营与on-call。

## 14. L3 Book Lab MVE Gate

Book Lab在Track 5固定Core RC之后才可施工，并以feature flag关闭为默认；8A/8B可与Core Release证据并行，但Core R0前不得对外启用。只有固定MVE与Core R0都通过才可计入本轮全流程完成。模型供应商未冻结时可用确定性`QuestionProvider` fixture证明合同与失败隔离，但不得声称真实问题质量已验证或对外开放。

固定样本：1个Space/事件、1个ready panorama、12–20张confirmed/current照片、3–5位参与者、每图1个初始问题、至少一组同一时刻多方向、至少一对相互冲突但合理的署名回答，生成12–16页同源HTML/PDF。

最低证据：

1. flag off、AI timeout/failure/abstain/skip时Core upload/content/placement/Viewer trace与未启用L3字节等价，Book表/队列写为0；
2. 问题保存1–2条可回源visible facts，身份/情绪推断为0；回答原submission、编辑submission、confirmed revision与model/prompt/policy hash分层可追溯；
3. owner、cross-receipt、cross-Space、Book A→B BOLA全部失败；未grant正文在owner DTO/log/HTML/PDF为0；SceneNote输入为0；
4. 冲突回答分别署名，不生成统一事实；owner只能改书名、删页、换displayPhoto，不能改用户文字或sourcePhoto；
5. HTML/PDF共享同一frozen source manifest，页序、文字、图片、hash逐项对账；用户内容经XSS/remote-resource/RTL/超长中文对抗，PDF逐页渲染无裁字、重叠、缺字、空白页或破图；
6. freeze前withdraw立即移除并使preview stale；freeze后withdraw立即使旧HTML/PDF分发失效并标affected，新版本排除内容，UI明确已下载PDF不可召回；
7. 320/390/1247/1248/1440、200% zoom、键盘/读屏与手机横滑预览通过；request IDs、DB versions、object hashes、HTML snapshot、PDF hash、逐页PNG、`pdftotext`完整性对账齐全；
8. 并发freeze/withdraw、旧If-Match、同幂等key、session revoke与清本机缓存恢复均符合Book五套状态机。

Book Lab MVE不包含实体印刷、支付、订单、地址或物流。Core Web/H5 R0可以独立PASS；但本次总控只有在`Core R0 PASS && Book Lab MVE PASS`时才能宣称“本轮全流程完成”。

## 15. Go/no-go

| Gate | 当前 | Go条件 |
|---|---|---|
| Canonical/ACTION coverage | 历史Core合同曾PASS；当前runtime+Book revision候选正在独立反审 | Codex/桌面Claude按当前锁定hash复验Core90+Book20、phase/mutation/CAS/security且P0/P1=0 |
| Local modules | Track4 PASS；1A/2已有候选但因runtime接缝停笔 | 1A/2整改并与Track4形成Core Local Operable；其他模块各自DoD |
| Sandbox integration | 未授权/未跑 | Track1B+5真实adapter/五actor/raw evidence |
| Locator production gate | 无合格release | cluster/Space/multiplicity-adjusted四bounds联合通过 |
| Trust/reliability | 无release evidence | case/delete/export、SLO/alerts/runbooks/restore/canary |
| Device/a11y/copy | 未跑最终matrix | named matrix + WCAG target +中文sign-off |
| Privacy/legal/license | 未正式批准 | 正式review与证据齐全 |
| Independent red team | 历史C3最终PASS；当前runtime+Book revision尚未完成统一Codex C2与桌面Claude C3 | 两路均以新锁定快照复验P0=0/P1=0 |
| L3 Book Lab MVE | 新授权，尚未施工 | Track8A/8B/8C与本节固定样本、授权/撤回、HTML/PDF、对抗证据全部PASS |

当前维持**NO-GO**。Production blocker不阻止获授权的本地Module施工；本地Module PASS也绝不覆盖Integration/Release blocker；Core R0绿灯也不能冒充本轮Book Lab MVE已完成。
