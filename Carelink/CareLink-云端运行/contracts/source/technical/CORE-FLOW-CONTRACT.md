# UNSEEN 核心照片产品合同

版本：2026-08-13 Runtime + L3 Book Lab Contract Revision Candidate
唯一状态、授权、schema 与 API：`CANONICAL-STATE-AND-API.md`。  
目标：成品2:1 panorama + 一次多选普通照片，在真实后端完成邀请、batch upload、自动/人工定位、审核、照片回现场、batch receipt 与跨设备恢复。

## 0. 冻结边界

1. 首页只有“打开空间/登录”；external invitation exchange 后才出现 view/upload任务。
2. Membership只有tasks与managementScopes；owner隐式全部。effectiveCanView/effectiveCanUpload只作派生read model。
3. canInvite只处理external invitation；canPublish只处理sharing。
4. 账号成员邀请、accepted Membership、collection与item reopen均owner-only。
5. 首发仅invitation-only简体中文响应式Web/H5；不存在无会话查看入口。小程序在Web/H5 R0 sign-off后再开。
6. 相册与Scene正交；没有panorama仍可在有效view授权下看visible照片。
7. 当前Web只收成品2:1；多照片/28帧/横扫生成全景不在产品范围。
8. 一次多选建立一个contribution batch；逐item upload/commit，一次finalize签发一个batch receipt；partial success可表达。
9. 自动定位只有active frozen policy的same-scene high可confirmed+auto；不确定类needs_confirmation；执行失败类failed。
10. uploader以batch receipt session按item编辑；manager改一张只锁该item，owner可按item reopen。
11. P16 external invitation是可多人分享的非credential campaign URL；每位访客另获独立一次性bootstrap和隔离principal，禁止把同一bearer secret改成多人可重放。
12. Scene mode只有rotation360/depth_limited_parallax/walkable3d；L2 SceneNote首阶段contributor_only，v1 viewing字段allowlist不含L2字段。
13. 所有CAS只引用canonical §4.1真实`version`字段；专用epoch仅`accounts.sessionEpoch`与item的`placementAuthorizationVersion`。

## 1. Owner与Account Member

1. owner登录，从“我的空间”创建active/private/paused Space。
   - `SPACE.OPEN_CREATE`只导航到`/spaces/new`；`SPACE.CREATE`才POST，Create DTO仅`{name}`，成功进入`/manage/{spaceId}?tab=setup`。
2. owner/canManageScene上传成品2:1 candidate必须经过create绑定ticket→exact-key直传→幂等commit→HEAD/GET真字节/decoder/2:1校验→status→ready revision→CAS switch；candidate failed保旧current并清理orphan。
3. owner-only切collection open/paused。
4. owner或canPublish切sharing private/shared。
5. owner-only创建绑定已验证账号标识的MemberInvitation。missing/账号HMAC不匹配/expired/revoked/accepted均不建Membership，对持链者统一`member_invite_unavailable`。
6. Membership tasks控制view/upload，managementScopes控制五项管理能力；任一scope都不能暗授任务能力。

## 2. External campaign 与 per-visitor invitation

1. P16创建一个campaign，`taskMode=view|upload|combo`唯一映射tasks；entryTask必须属于tasks，combo默认view。Campaign状态为active/paused/revoked/expired/exhausted。
2. Campaign URL为同源`/open/{publicCampaignId}`，只有非敏感locator，无query/fragment/tracking、无viewer/upload/API权限；可供多人分享并由owner/canInvite管理重开。二维码只本地渲染该URL，不调用网络二维码服务或上报payload。
3. 每个无live session访客依次获得绑定campaignId+nonce的固定`__Host-` Strict短TTL challenge→通过Origin/Host/Fetch-Metadata、campaign/Space/expiry/总量/pending/速率/滥用检查→独立per-visitor grant与一次性`#invite`→exchange→隔离viewer/contributor principal/session。A challenge换B campaign统一失败；公共URL绝不直接变成可重放bearer。
4. Exchange原子分配campaign内唯一且不复用的use ordinal；同一challenge/idempotency重试不多占计数，不同访客并发得到不同principal。组合任务的viewer/contributor ID分离但共享campaign/use ordinal审计键。
5. 签发/admission前Space active；view要求shared；upload要求open。admission/exchange/viewer read/upload/batch各阶段都复验当前Space/campaign/grant/principal/session状态。
6. Campaign unavailable原因统一`campaign_unavailable`；per-visitor bootstrap invalid/expired/revoked/consumed统一`invite_unavailable`；status/body/timing不可枚举，详情仅脱敏管理审计。
7. Grant拆`bootstrapExpiresAt`与`accessExpiresAt<=campaign expiry`；exchange成功后bootstrap过期不截断session，campaign expiry/revoke立即fail closed。首次exchange按服务端canonical `entryTask`直接返回album或upload destination；`/s/{spaceId}`只作已有account/session的live capability re-entry fallback。已有同campaign live session重开不新增use；新浏览器占新ordinal；派生`#invite`不得分享/重放。
8. “逐访客”只表示每次兑换/browser principal隔离，不证明自然人唯一；需要实名去重必须转Account+verified email OTP，禁止以设备指纹暗示识别了人。

## 3. Batch upload与本人结果

1. `GET uploadContext`返回版本化media notice、格式/限额、consent要求和创建batch能力。
2. `UPLOAD.OPEN`只导航并加载uploadContext；`UPLOAD.SELECT_FILES`只在P07以POST创建batch，必须current consent + live effective upload。P06/P08只能先OPEN；历史batch/receipt/binding不产生上传能力。
3. 一次多选创建一个batch和每文件一个item；每item独立upload session、commit、validation、retry/remove。
4. `UPLOAD.REMOVE_ITEM`只允许open batch中的failed item执行`failed→removed`；selected/uploading/validating/committed/removed/deleted或非open batch全部拒绝。相同幂等key回放原结果不等于再次转移。
5. JPEG/PNG/static WebP/HEIC/HEIF均按真字节/decoder；orientation、ICC/NCLX、animation、decode bomb与GPS政策见canonical。
6. batch finalize用If-Match+Idempotency-Key，只执行一次；冻结committed/failed/removed item snapshot并签发一个batch receipt。finalized后该batch不得再增删或重试item。
7. batchResult逐item显示partial success。failed item不造photo；需要重传时新建batch；一次batch不制造多个receipt secret。
8. finalize返回一次`/uploads/open#receipt=<secret>`结果链接；receipt secret≥128-bit、只在fragment/内存，按与invite同级的最早同源bootstrap规则清URL后POST exchange。首次exchange不接受客户端If-Match：服务端以family-separated keyed MAC命中并锁receipt，用loaded `batch_receipts.version`+`consumedAt IS NULL`+Space active原子UPDATE；只有一个并发成功，之后靠HttpOnly session或Account binding recovery。同Idempotency-Key只返回current/completed，不再次消费；invite/receipt key不可互换。
9. Account binding必须由邮箱OTP或既有verified Account建立；恢复只按当前Account bindings查，不接受任意receipt ID。
10. accessExpiresAt、recoveryUntil、revokedAt分开；恢复旋转版本、撤销旧session，不返回新bearer secret。
11. 所有batch mutation以及receipt exchange/session refresh/recovery/read/delete每次沿组合FK复验Space active；archived统一`batch_access_unavailable`，不写batch/item/photo、不签/刷新session、不返回内容。Archive transaction撤销现有receipt sessions并递增其version。

## 4. Placement、content与Scene

- Placement建议类：uncertain/OOD/ambiguous/abstained/no active policy→needs_confirmation。
- Placement执行失败类：job failed/timed_out/decoder failure/retry exhausted→failed。
- failed可retry/manual/outside_scene，但manual不得伪造suggestion。
- 人工placement为confirmed+manual；显式outside_scene写null pose；panorama switch令旧placement stale。
- authKind只允许service_job/membership/receipt_session/space_owner；space_owner以spaceId+spaces.version授权且不创建影子owner Membership。revision保存全部membership/receipt/item/policy/panorama版本快照。
- SAVE/CONFIRM/UNDO/RETRY/MARK_OUTSIDE及所有manager placement write复用同一原子模板：写photo/job/revision、只锁该item、递增item.version+placementAuthorizationVersion并追加event；同batch其他item不受影响。receipt writer自身合法操作不锁自己；owner-only reopen同事务记event。
- MARK_OUTSIDE同时允许未被manager锁定且writeEnabled/version匹配的exact receipt item writer，或same-Space owner/canEditPlacement；两端共用同一组合FK、CAS与事件合同。
- Content event唯一字段为`transitionReasonCode + decisionReasonCode + optional note`；两个enum与action-specific allowlist按canonical §6.1，APPROVE的decision必须null，decision=`other`必须非空note。
- rejected不能直达visible；必须manual_reopened到pending，再manual_approved。
- panorama transport必须具备candidate/ticket/upload/commit/validate/status/retry/switch/rollback与orphan cleanup；UI仍可只呈现一个上传动作，不提供前台直接移除current的能力。

## 4.1 Account session与owner transfer

- 每个account session/family签发时保存`issuedSessionEpoch`；每次鉴权与`accounts.sessionEpoch`比较。
- logout-all单transaction递增`accounts.sessionEpoch`与`accounts.version`，撤销该账号全部family/session；不是只撤当前family。
- logout-all、Space archive/restore/delete request、Account delete request、Owner transfer create/accept都必须消费fresh、purpose-bound、一次性且绑定当前`accounts.sessionEpoch`的reauth grant。
- Owner transfer按`targetAccountId + targetMembershipId`绑定，不发secret/link；每Space仅一条pending并记录`spaceVersionAtCreate`。accept锁transfer+Space，复验pending/未过期/current owner/Space version/active target Membership/精确reauth后原子切owner。

## 4.2 Security原语

- CredentialCryptoProfile、rotation-invariant `identifier_equivalences`、可轮换MAC aliases、OTP原子建号、closed ReauthPurpose/action map与`idempotency_records`/四种replay class以canonical §0.1、§4.3–4.7为唯一来源。identity唯一性不由`(keyId,mac)`承担；credential/Set-Cookie永不缓存复活；同key不同request hash固定409。
- `identifier_equivalences`另存由独立KMS-AEAD key保护的normalized identity envelope；旧`k_equivalence` collision-key epoch/material退休前必须由内部`IDENTITY.REKEY_EQUIVALENCES`在排他锁下完成整表stage→计数/唯一性校验→原子swap。机会式登录重键或永久保留旧key都不构成正式轮换。
- URL bearer默认禁止；唯一例外闭集为≥128-bit CSPRNG、single-consume `#invite=`与`#receipt=` bootstrap。External campaign public URL不是credential，只能启动admission，不能访问业务API。Bootstrap必须由最早同源无第三方/no-store/no-referrer/strict-CSP/no-service-worker页面在任何subresource/API/analytics前只读入内存并立即replaceState，再POST各自exchange并旋转成HttpOnly Secure SameSite session；family/key不可互换，secret不得持久化或记录。
- viewer授权只能选一支：account=active Space+current sessionEpoch+owner/active Membership task=view且不要求shared；external=active+shared+live campaign/per-visitor grant/viewer principal/session。两支不能拼接补权。
- `SPACE.CREATE`同transaction创建Space(version=1)+Scene(version=1, unavailable, rotation360)，ownerAccountId为唯一owner且不造owner Membership；panorama switch/rollback对Space+Scene双CAS并分别递增version。
- content case带spaceId、target组合FK与唯一`CaseActorRelationKind=account|viewer|receipt|case_access` XOR分支；viewer保存campaign/principal/grant/session/Space exact FK/version，其余分支保存各自精确receipt/Membership/Space snapshot，不接受aggregate authorization字段。viewer/receipt另签高熵case access session；资源撤权后只允许same active Account或live case_access读最小case envelope/申诉，不恢复target访问。owner/canReview case list/detail/transition从属现有management read model，不新增产品action；纯case处置不能越权改变Photo。
- `SUPPORT.SUBMIT_SAFETY_LEAD`首发request只接受`{category,description}`；`contact`与任意未知字段统一`unsupported_field`，且必须在任何durable write前拒绝。数据库前后快照必须证明rate/dedupe/audit/idempotency/case/session/credential/actor及其他持久行全部零新增、零改变。
- `ACCOUNT.DELETE_REQUEST`与`deletion_status_sessions`同transaction创建，响应使用`credential_reissue`并签精确绑定该deletionId的`__Host-unseen_deletion_status` HttpOnly Strict cookie；同时清旧account cookie。丢失响应重放只允许原始已消费reauth credential family + 相同Idempotency-Key/requestHash命中同一idempotency responseRef，且`createdByIdempotencyRecordId`三向一致；只能轮换同一status session version，零删除/account重执行。该credential只能读取粗粒度删除状态，不复用case access，也不能恢复任何账号或空间权限。
- viewer panorama/photo媒体只经同源session-auth、non-bearer、repeatable GET读取；scene-context不得返回capability secret、signed query/fragment、private object key或custom authorization header。每次GET复验live授权且不写业务状态；v1 panorama上限固定32 MiB，32 MiB+1稳定拒绝。

## 5. V1 read models

| Read model | 主授权 | 边界 |
|---|---|---|
| homeConfig | none | 只有打开空间/登录 |
| mySpacesView | Account | active owner/Membership；archived只owner摘要 |
| viewerSpace | Account view task / external viewer | visible album；Scene正交；字段allowlist限于v1 |
| viewerPhotoDetail | 同上+visible | 唯一Scene CTA谓词、举报能力；current photo/panorama不可变identity与同源session-auth媒体URL；字段allowlist限于v1 |
| uploadContext | Account upload task / external contributor | 媒体notice/limits/batch；无album |
| batchResult/batchReceiptView | batch actor/receipt session | 只含本batch及逐item状态 |
| batchItemResult | receipt session | 单item内容/placement/lock/delete/revoke |
| batchItemPlacementEditView | receipt item predicate / management member | 最小Scene投影与版本 |
| managementView/queues | owner/对应managementScope | 按scope裁剪 |
| externalCampaignShare | owner/canInvite | 非敏感campaign URL/本地QR payload、tasks/status/expiry/cap聚合；无bootstrap/risk/访客标识 |
| ownerTransfersView | target Account | 只含当前账号pending/unexpired transfer |
| case/deletion/export status | original actor | 高熵ID、粗粒度状态、反枚举 |

## 6. 五个 actor E2E

这里的“五个”是actor，不是设备数量：

- A：owner Account；
- B：同一campaign的external contributor/viewer；
- C：独立view-only campaign的external viewer；
- D：同一campaign的第二contributor；
- E：scoped Account member。

必须跑：

1. A创建Space、首个panorama并原子switch；owner打开collection，owner/canPublish打开sharing。
2. A在P16创建一条combo campaign并本地渲染只含public URL的二维码；B/D并发从同一campaign进入，各自challenge/grant/use ordinal/principal/session不同，batch/item互不可读写。只有publicCampaignId直打viewer/upload API失败；同challenge重试不重复占位；Campaign A challenge换Campaign B只得`campaign_unavailable`且两campaign计数不变。
3. B一次选3图：2 committed、1 failed；单图retry后finalize一次，得到一份batch receipt和整批结果；finalize后重传必须新建batch。
4. finalize的一次性`#receipt=`结果链接在最早bootstrap清URL；两个并发receipt exchange仅一个成功，`#invite`值/端点互换失败，刷新/转发旧链接失败。B绑定verified Account后在新设备恢复，旧sessions失效。
5. E只有canReview时可review但不能改placement；授canEditPlacement后改B item A并只锁A，item B仍可写。A按item reopen。
6. failed/needs_confirmation/confirmed/outside_scene/content五种路径按canonical转移；非法transition/decision组合失败。
7. C从独立view-only campaign获得viewer principal，可在无Scene时看visible album且不能upload；裸ID、private、revoked/paused/expired campaign、revoked grant都读不到。B在bootstrap TTL前成功exchange后，把测试时钟推进到`bootstrapExpiresAt < now < accessExpiresAt`仍可访问；Campaign exhausted只阻新访客，不杀已成功且未过期的ordinal，revoke立即阻全部external session。
8. replacement pano跑create/ticket/commit/status；伪MIME、非2:1、key mismatch或validation fail时旧current/placement不变并清orphan；只有ready revision可switch，switch/rollback后旧placement全stale。
9. archived后非owner mySpaces消失；Archive transaction撤销全部旧receipt sessions。任何receipt exchange/refresh/recovery/read继续按组合Space active fail closed并只返回`batch_access_unavailable`；A只可摘要/导出/unarchive/delete/disposition。
10. valid session对象report返回caseId；report/appeal提交attachment/asset/uploadSession字段固定拒绝且不创建第三条媒体链；无session support不能绑定对象。清本机cache后状态从API恢复。
11. logout-all后同账号所有family/session因epoch不匹配立即失败；新登录使用新epoch。
12. MemberInvitation六类不可用原因外部响应不可区分；owner audit可区分但不泄露secret/标识。
13. Owner create transfer不产生link；非target账号accept失败，target accept无双owner中间态，current owner可按version撤销pending。
14. 生成一个在TTL内成功exchange的grant与一个遗弃grant；推进时钟并运行内部`CAMPAIGN.SWEEP_EXPIRATIONS`。只允许遗弃grant写`bootstrapExpiredAt`并把pending减一次，必须同事务追加`grant_bootstrap_expired + pending_released`；同cutoff重跑零变化。另与exchange并发，证明只有一个分支消费pending；challenge expiry只写`expiryProcessedAt + challenge_expired`且不改pending。成功session在`bootstrapExpiresAt < now < accessExpiresAt`仍可访问。
15. 以同一verified identifier建立active与dormant账号等价行；运行`IDENTITY.REKEY_EQUIVALENCES`完成整表迁移并退休旧key后，两者仍解析到原账号。任一collision、缺envelope或中途失败整批回滚；机会式只重键active行不得通过。
16. `SUPPORT.SUBMIT_SAFETY_LEAD`提交`contact`或未知字段稳定失败；以数据库前后全量快照证明零任何durable write（含rate/dedupe/audit/idempotency/case/session/credential/actor），合法`{category,description}`仍按rate/dedupe与反枚举合同运行。
17. Account delete request原子清旧account cookie并签exact deletion-status cookie；退出账号后仍只能读取同一deletionId的粗粒度状态，cross-id/过期/revoked均不可用，且Set-Cookie永不进入幂等缓存。
18. scene-context向真实Track 2→Track 4接缝提供完整photo/panorama identity与同源媒体URL；撤权后原URL立即失效，Range读取零业务写，33,554,432 bytes通过而+1拒绝，照片按current placement进入正确yaw/pitch。

C3 campaign remediation必须以最新产品ACTION/STRING/TOKENS hash重锁coverage：P16 create/copy/QR表达可重开的非敏感campaign URL；campaign entry内部生成每访客`/open#invite=:secret`，member/receipt仍分别使用`/member-invitations/accept#invite=:secret`与`/uploads/open#receipt=:secret`。`MANAGE.OPEN_NEXT`成功只允许target/empty，并发有界重选失败进入产品冻结的stable error `concurrent_change`。Owner transfer create/revoke回到`/account`；report/appeal无附件。该结果仍须独立C3反审，不代表Release PASS。

通过只代表Integration gate，不等于Release gate。

## 7. Named device/browser matrix

设备矩阵与五actor分开，至少覆盖：

- 小屏iPhone Safari、当前iPhone Safari；
- 4–6GB中端Android Chrome、当前Pixel/同级Chrome；
- 微信内置浏览器iOS与Android；
- Windows Chrome、Edge、Firefox；
- macOS Safari、Chrome、Firefox。

矩阵按精确型号/OS/browser/build记录；测试campaign URL无权限且可多人各自admission、campaign QR本地零网络/零analytics、闭集`#invite=`/`#receipt=`bootstrap的清理/单次兑换/互换失败/刷新转发失败、无第三方/CSP/no-referrer/no-service-worker，以及OTP、HEIC、弱网/恢复、batch partial success、WebGL/context loss、键盘/读屏/200% zoom。actor可复用设备，设备也可跑多个actor；不得把“五actor”写成“五设备”。

## 8. R2-A统计Gate

- Primary analysis unit为burst/near-duplicate cluster；按Space分层且cluster-aware。
- high correctness/catastrophic denominator均为high∩evaluable ID；coverage为全部evaluable ID；OOD为预注册OOD clusters。
- 至少10 Spaces、300 ID、300 OOD、每Space≥20 ID，双标+裁决、模糊/多解规则预注册。
- 四项作为一个family控制one-sided family-wise error≤0.05；默认Bonferroni每项98.75%单侧bound。
- 调整后：correctness LCB≥95%；catastrophic UCB≤1%；OOD high UCB≤1%；coverage LCB≥30%。
- 样本动态增加到联合过线或no-go预算；点估计/固定300不能放行。

## 9. L2 SceneNote

L1后、默认off、独立consent、async、contributor_only。confirm后仍只在本人batch item结果出现；v1 viewer DTO/route永不返回。withdraw删除正文/草稿/private derivatives，只留不可还原正文的最小audit provenance。失败/skip/close不改变upload/content/placement/viewer。

## 10. L3 Book Lab：照片问答成书

L3是Track 5固定Core RC之后才可施工的独立后置能力，默认off；8A/8B可与Core Release证据并行，但Book不得在Core R0前对外启用，也不得据此宣称本轮完成。它进入本轮全流程施工与最终验收，但不改变或阻断上传、定位、审核、Scene与Viewer。Book flag关闭、AI失败/超时、skip或close时，Core表、队列、read model与用户结果必须与未启用L3完全相同。

最小链路固定为：confirmed/current照片→一个基于画面可见事实的问题→用户回答→最多一次可选追问→编辑确认形成immutable personal-memory revision→用户对指定一本Book、指定memory revision另行授权→主人生成HTML/PDF预览→冻结版本。AI只提出问题，不改写回答或生成“用户原话”；首版不做长对话、统一叙事或自动合并冲突。

`SceneNote`始终`contributor_only`，不能作为Book输入。Book source必须来自用户确认的personal-memory revision与active per-book grant；Book A授权不能用于Book B，owner不能读取未授权正文。每个source entry保留photo/asset hash、scene/node/panorama/placement revision、yaw/pitch、时间、作者/credit、原始与确认submission、grant、withdrawal与version provenance。换展示图不能改变sourcePhoto。

冻结前撤回立即移出draft并使preview stale；冻结后撤回令旧HTML/PDF分发失效并标`affected`，新版本必须排除撤回内容。已下载PDF无法召回，产品必须明确说明。不同参与者的矛盾回答保留署名视角，绝不自动写成唯一事实。

本轮Book Lab MVE固定：1个事件、1个ready panorama、12–20张confirmed/current照片、3–5位参与者、每图1个初始问题、至少一组同一时刻多方向与一对冲突回答，输出同一source manifest驱动的12–16页HTML/PDF。实体印刷、支付、订单、地址、物流均不在本轮。

Book action/API/state/CAS与20-action/180-phase/15-mutation闭集由`l3-book-lab/*` addendum独立冻结。Core R0可以独立PASS；只有Core R0 PASS与Book Lab MVE PASS同时成立，总控才可宣称本轮“全流程完成”。

## 11. Release前仍需

完整API/action coverage、隐私同意、对象report/appeal/support、photo/Space/account删除与ledger、export、owner transfer、恶意文件、限流、SLI/SLO/告警、backup restore、migration/canary/rollback/kill switch、许可、真机无障碍与法律复核，统一见`RELEASE-READINESS-CONTRACT.md`。
