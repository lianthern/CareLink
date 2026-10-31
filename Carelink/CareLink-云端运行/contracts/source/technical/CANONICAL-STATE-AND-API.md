# UNSEEN Canonical State、Authorization 与 API 合同

版本：2026-08-13 Runtime Contract + L3 Book Lab Addendum Candidate
地位：**唯一产品状态、授权、schema、read model 与 API 语义来源。** 其他技术文档只能引用；旧值只允许进入 importer mapping。  
当前性质：冻结候选，不是实现或发布回执。

## 0. 首发边界与入口

- 首发是 invitation-only、简体中文、不可索引的响应式 Web/H5；首页只有“打开空间”和“登录”。
- `view` / `upload` 是 external campaign admission + per-visitor invitation exchange 后的任务；用户不选角色。
- owner/member 登录后从“我的空间”进入。管理能力来自 Account + active Membership，不来自 bearer secret 或前端声明。
- 小程序仅在 Web/H5 R0 sign-off 后作为同一 API 薄客户端开工。
- 当前 Web 只接收成品 2:1 panorama；无多照片/28 帧/横扫生成全景入口、文案、route、job 或 API。

默认规则：任何 bearer secret 均不得进入 URL（含 path、query、fragment）、Referer、页面历史、剪贴板遥测、access/error/analytics log、截图名、metric label、cache key 或第三方脚本；只允许在 TLS POST body 或 HttpOnly+Secure+SameSite Cookie 中短暂出现，并须返回 `Cache-Control: no-store, private`。**唯一URL bearer例外闭集是 per-visitor/member invitation bootstrap 与 batch-receipt bootstrap**：两者都必须是≥128-bit CSPRNG、一次性secret，分别只放在精确fragment键`#invite=<base64url-secret>`或`#receipt=<base64url-secret>`，绝不进入path/query，也不能交换key或exchange端点。External campaign URL `/open/{publicCampaignId}`是可多人分享的非敏感定位符，绝不携带secret、grant、session或直接API权限；它不在bearer例外内，必须先经过服务端admission才会为该访客生成独立一次性`#invite` bootstrap。例外只负责把secret从最早同源bootstrap送入对应一次POST exchange；session、OTP、reauth、signed URL及其他credential family仍禁止进入任意URL。

### 0.1 CredentialCryptoProfile（唯一凭据加密配置）

1. Bearer secret 由系统 CSPRNG 生成，熵至少128 bit；v1 固定生成32 random bytes并以 unpadded base64url 编码。canonical credential row只存 `credentialMac=HMAC-SHA-256(k_credential[keyId], domain || 0x00 || rawSecret)` 与 `credentialKeyId`，不存明文、一般可逆密文或无 key hash。唯一例外是§4.5 `secret_once_envelope`的独立、同principal、短TTL KMS-AEAD envelope；它不得回写credential row且到期物理销毁。不同credential family使用固定domain label；比较先解码并做长度上限检查，再对32-byte MAC constant-time compare。
2. 账号标识先按purpose对应的确定性规范化（v1 email：Unicode NFC、trim、域名ASCII小写；local-part仅ASCII大小写折叠，非ASCII local-part首发拒绝）。身份唯一性由rotation-invariant `identifier_equivalences`承担：`equivalenceId`为不透明随机ID，`normalizedCollisionKey=HMAC-SHA-256(k_equivalence, "email-equivalence-v1" || 0x00 || normalizedIdentifier)`且数据库全局唯一；不得存明文。为使collision key可安全轮换，每个新equivalence还必须保存normalized identifier的随机nonce KMS-AEAD envelope：`normalizedIdentifierCiphertext + normalizedIdentifierEnvelopeKeyId + normalizedIdentifierEnvelopeFormat`。它使用独立`k_identity_envelope`，AAD精确绑定`identifier-equivalence-rekey-v1 + equivalenceId + identityType + envelopeFormat`；明文只可在OTP验证、旧行经provider重新验证后的backfill和内部全表重键的受限内存中出现，禁止进入日志、trace、DTO、export或fixture。`k_equivalence`、`k_identity_envelope`与在线identifier alias key三者分离；轮换必须在identity namespace排他锁内做全表stage、行数/唯一性校验、原子切换与回滚，不能让同一normalized identity生成第二个equivalence。可轮换lookup alias另存`identifierMac=HMAC-SHA-256(k_identifier[keyId], "email-v1" || 0x00 || normalizedIdentifier)`并FK到equivalence；`(keyId,identifierMac)`只用于查找/轮换，不承担账号唯一性。
3. Email OTP v1 固定为CSPRNG均匀生成的6位十进制码，TTL 10分钟、最多5次验证；库中存 `otpMac=HMAC-SHA-256(k_otp[keyId], challengeId || 0x00 || identifierEquivalenceId || 0x00 || purpose || 0x00 || code)`、`otpKeyId`，即challenge+rotation-invariant identity equivalence+purpose绑定的peppered HMAC。校验必须constant-time；成功、第五次失败、过期或撤销均使challenge终态且递增其version。
4. 密钥只能来自受审计KMS/secret manager。轮换采用双读单写：签发只用current keyId，验证可在明确的grace window内读current+previous，row自带keyId且禁止遍历猜key；grace到期后previous material撤销，未过期credential以后台原子re-MAC或强制失效处理。key material、明文secret/OTP禁止进入应用配置、备份导出、trace、崩溃报告和测试fixture。
5. 所有credential response与Set-Cookie response均 `no-store`；analytics/service worker/CDN/browser cache不得缓存。签名URL是短期资源能力而非登录credential，仍须redact、绑定resource/actor/expiry且不得进持久日志。

### 0.2 Campaign locator、invitation / receipt bootstrap URL 闭集

1. External campaign分享链接唯一形态为同源`/open/{publicCampaignId}`；`publicCampaignId`是随机、不透明、可轮换的非敏感定位符，但**不授予任何viewer/upload/API能力**，不得带query、fragment、UTM、短链跳转或第三方redirect。Per-visitor/member invitation与batch receipt才生成v1固定32-byte CSPRNG secret；bootstrap链接分别只允许`/open#invite=<base64url-secret>`、`/member-invitations/accept#invite=<base64url-secret>`和`/uploads/open#receipt=<base64url-secret>`。secret不得出现在query/path，fragment键不得使用`secret`、`token`等别名；`invite`值只能提交external/member invitation exchange，`receipt`值只能提交batch-receipt exchange，family/key不匹配按对应统一不可用码失败。
2. 两类Bootstrap响应都必须是同源、`Cache-Control: no-store, private`、`Referrer-Policy: no-referrer`的最小HTML；在secret清除前不得含任何外部subresource、preload/prefetch、favicon、analytics、字体、图片、CSS、API调用或第三方脚本。首段nonce inline bootstrap同步读取fragment至仅内存变量，严格解析该route唯一允许的`invite`或`receipt`键后立即`history.replaceState(null, "", pathname + search)`，再允许后续同源代码/API运行。
3. Bootstrap页不得注册或被service worker控制；`worker-src 'none'`。专用严格CSP至少为：`default-src 'none'; script-src 'nonce-<request-nonce>'; connect-src 'self'; style-src 'none'; img-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; worker-src 'none'; manifest-src 'none'; require-trusted-types-for 'script'`。`connect-src`只在fragment已清除后用于同源exchange。
4. Campaign locator页面只可请求同源`POST /v1/external-campaign-admission-challenges`并取得固定`__Host-unseen_campaign_challenge` Cookie（Secure、HttpOnly、SameSite=Strict、Path=/、无Domain）、短TTL、非业务授权challenge；服务端同时校验Origin、Host与Fetch-Metadata=`Sec-Fetch-Site: same-origin`。随后`POST /v1/external-campaign-admissions`在同一transaction锁challenge+campaign，constant-time校验challenge的campaignId、clientNonceMac/keyId、TTL、consumed/revoked与请求publicCampaignId/nonce，再复验Space任务状态/expiry/总量/速率/滥用策略并为**这次兑换/browser principal**生成独立grant与一次性`/open#invite=...`。A challenge配B publicCampaignId/nonce统一`campaign_unavailable`。内存secret只可作为对应TLS POST body字段：`invite`→`POST /v1/external-invitation-exchanges`或`POST /v1/member-invitation-acceptances`；`receipt`→`POST /v1/batch-receipt-exchanges`。DOM attribute/text、console、error payload、telemetry、analytics、local/session storage、IndexedDB、Cache API、clipboard history与后续browser history均禁止。
5. Exchange按CredentialCryptoProfile计算family-separated keyed HMAC并constant-time比较；数据库只存MAC+keyId、expiry、revokedAt与consume状态。External exchange必须同时锁per-visitor grant与其campaign，成功才分配唯一campaign use ordinal并签发隔离的viewer/contributor principal/session；member/receipt按各自合同签发。Secret本身不成为session。Campaign entry/admission无效统一`campaign_unavailable`，external bootstrap无效统一`invite_unavailable`，member为`member_invite_unavailable`，receipt为`receipt_unavailable`，Space archived receipt仍用`batch_access_unavailable`；每个family内部原因保持同status/body等级与等价时延。
6. 已成功兑换的per-visitor原链接刷新或转发不得再兑换：清理后的当前页仅凭新session继续；保留旧fragment的副本因原secret已消费而统一失败。External campaign URL则被设计为可反复打开/分享：同浏览器已有该campaign live session时只做re-entry且不新增use；无live session的新浏览器经过新challenge/admission并获得新的principal/use ordinal。Owner/canInvite可从管理read model再次取得同一个非敏感campaign URL并本地重画二维码；任何API都不得取回某位访客的bootstrap secret。

## 1. 唯一产品状态

| 维度 | 字段 | 唯一值 |
|---|---|---|
| Space lifecycle | `spaceLifecycle` | `active \| archived` |
| Collection | `collectionState` | `open \| paused` |
| Sharing | `sharingState` | `private \| shared` |
| Scene readiness | `sceneReadiness` | `unavailable \| processing \| ready \| failed` |
| Photo content | `photoContentState` | `pending \| visible \| hidden \| rejected` |
| Placement | `placementState` | `unavailable \| processing \| needs_confirmation \| confirmed \| outside_scene \| stale \| failed` |
| Confirmation | `confirmationMode` | `auto \| manual`；仅 confirmed 时非空 |
| Scene mode | `sceneMode` | `rotation360 \| depth_limited_parallax \| walkable3d` |

正交规则：

1. 相册分享不依赖 panorama；有效 account member 或 external viewer 可在无 Scene 时读 visible album。
2. “回到现场”仅当 photo visible、placement confirmed、placement 指向 currentPanoramaRevisionId 且 scene ready。
3. shared 不等于公开互联网；external view 每次读取仍需有效 viewer session。
4. collection 只控制新 upload，不改变历史 viewer projection。
5. L2字段不属于v1 viewing projection，见 §12。

## 2. Membership、tasks 与管理 scopes

### 2.1 Membership 唯一结构

```text
Membership {
  accountId
  spaceId
  tasks: subset { view, upload }
  managementScopes: subset {
    canReview,
    canEditPlacement,
    canManageScene,
    canInvite,
    canPublish
  }
  status: active | revoked
  version
}
```

owner 由 `spaces.ownerAccountId` 唯一确定，隐式拥有 `tasks={view,upload}` 与全部 managementScopes。`effectiveCanView`、`effectiveCanUpload` 是按当前 Account Membership 或 external grant 派生的 read-model 布尔，不是 management scope，也不得持久化为另一套权限真值。

### 2.2 managementScopes 最小权限

| Scope | 唯一允许动作 | 明确不允许 |
|---|---|---|
| `canReview` | content review 与对象 case 处置 | placement、成员、外部邀请、Scene、分享、收集 |
| `canEditPlacement` | 本 Space 任意 photo placement、outside、restore | content、成员、receipt item reopen、Scene、分享 |
| `canManageScene` | panorama candidate、switch、rollback、history、Scene derived assets | 删除 current panorama、分享、收集、成员、邀请 |
| `canInvite` | 创建/撤销 external campaign、读取其脱敏share/audit摘要 | 访客bootstrap、账号成员接纳、accepted Membership、owner transfer |
| `canPublish` | 仅切换 `sharingState` private/shared | 其他状态、成员、邀请、Scene |

以下始终 owner-only：MemberInvitation create/revoke；accepted Membership create/update/revoke；collection open/paused；archive/unarchive/delete Space；owner transfer；batch item placement reopen；管理侧 batch receipt revoke；Space/account disposition。

### 2.3 Account owner/member 服务端谓词

```text
accountSession is active and revalidated
AND accountSession.issuedSessionEpoch == account.sessionEpoch
AND accountSession.family.issuedSessionEpoch == account.sessionEpoch
AND space exists
AND (
  accountId == space.ownerAccountId
  OR active Membership(accountId, spaceId)
)
AND requested task is in effective tasks
AND, for a management mutation, required managementScope is present
AND archived allowlist permits the exact operation
AND current resource/version predicates pass
```

- Account read album：`authBranch=account`，Space active；session与family active且两者`issuedSessionEpoch == accounts.sessionEpoch`；然后满足 owner 或 active Membership tasks 含 view。该分支**不要求** sharing=shared，也不得再叠加external grant/viewer session。授权快照精确读取`accounts.sessionEpoch`、`account_session_families.version`、`account_sessions.version`、`spaces.version`，member分支另读`space_memberships.version`。
- Account upload：Space active + collection open + owner 或 active Membership tasks 含 upload。
- Account management：Space active + owner 或 required managementScope；owner-only 动作不能由 scope 代替。
- 非 owner archived Membership 不在 `GET /v1/me/spaces` 返回。owner 只见 archived 摘要、恢复、导出、删除/必要 disposition；其他 mutation fail closed。

### 2.4 External viewer 服务端谓词

```text
spaceLifecycle == active
AND sharingState == shared
AND viewerSession.revokedAt IS NULL AND current time < viewerSession.accessExpiresAt
AND viewerSession.tasks contains view
AND viewerSession.spaceId == target.spaceId
AND current space/campaign/per-visitor grant/viewer principal/session rows are loaded and their live fields pass
AND campaign.campaignStatus in {active, exhausted}; exhausted permits only already-issued principal/session and never a new admission/exchange
AND campaign.revokedAt IS NULL AND current time < campaign.expiresAt
AND viewerPrincipal.revokedAt IS NULL
AND grant.revokedAt IS NULL AND current time < grant.accessExpiresAt
AND authorization MUST NOT read or compare grant.bootstrapExpiresAt after exchange
AND viewerSession.campaignUseOrdinal == viewerPrincipal.campaignUseOrdinal == grant.campaignUseOrdinal
AND grant.tasks contains view
AND photoContentState == visible (for photo/media reads)
```

此谓词是互斥的`authBranch=external`：不得用account Membership补足external campaign/grant缺陷，也不得要求/读取account session。精确读取`spaces.version`、`external_invitation_campaigns.version`、`external_invitation_grants.version`、`viewer_principals.version`与`viewer_sessions.version`；每次授权重载live字段，issue snapshot只供审计。API只选一个分支并将`authBranch`写入access audit，不能把两分支拼成“account且shared且external session”的第三种条件。

### 2.5 External contributor 服务端谓词

```text
spaceLifecycle == active
AND collectionState == open
AND contributorSession.revokedAt IS NULL AND current time < contributorSession.accessExpiresAt
AND contributorSession.tasks contains upload
AND contributorSession.spaceId == target.spaceId
AND current space/campaign/per-visitor grant/principal/session rows are loaded and their live fields pass
AND campaign.campaignStatus in {active, exhausted}; exhausted permits only already-issued principal/session and never a new admission/exchange
AND campaign.revokedAt IS NULL AND current time < campaign.expiresAt
AND contributorPrincipal.revokedAt IS NULL
AND grant.revokedAt IS NULL AND current time < grant.accessExpiresAt
AND authorization MUST NOT read or compare grant.bootstrapExpiresAt after exchange
AND contributorSession.campaignUseOrdinal == contributorPrincipal.campaignUseOrdinal == grant.campaignUseOrdinal
AND grant.tasks contains upload
AND batch.contributorPrincipalId == contributorSession.contributorPrincipalId
AND batch/item/uploadSession composite resource bindings pass
```

External contributor 不能因 upload 获得 album view；external viewer 不能因 view 获得 upload。组合 grant 可在同一次 exchange 创建两个彼此受限的 session。

## 3. External invitation 与 MemberInvitation

### 3.1 External invitation campaign（“一链多人”唯一合同）

P16创建的是`external_invitation_campaigns`，不是可多人重放的bearer grant。唯一任务字段：

```text
taskMode: view | upload | combo
tasks mapping: view->{view}; upload->{upload}; combo->{view,upload}
entryTask: view | upload
constraint: entryTask must belong to mapped tasks
default: combo 时 entryTask=view；单 task 时 entryTask=该 task
campaignStatus: active | paused | revoked | expired | exhausted
```

`taskMode`只用于campaign管理/展示，session授权仍只看映射后的`tasks`；禁止`intent/entryIntent`等别名。Create前Space必须active；view/combo要求shared；upload/combo要求open；actor为owner或active Membership含canInvite。Campaign存`expiresAt`、`maxSuccessfulUses`、`successfulUseCount`、`pendingAdmissionCount`、`maxPendingAdmissions`、`ratePolicyVersion`、`abusePolicyVersion`；`expired/exhausted`由事务或有审计的sweeper落成终态，paused只可由server abuse/kill-switch policy进入，owner/canInvite可revoke但v1不新增pause按钮。

Campaign分享URL唯一为`/open/{publicCampaignId}`。`publicCampaignId`由CSPRNG生成至少128 bit随机不透明ID，数据库唯一，可进入owner read model/本地二维码/剪贴板；它**不是credential**，不能读取Space、创建batch或调用viewer API。该URL不含secret/query/tracking参数，不使用第三方短链/二维码服务。P16 create成功和之后管理重开都可返回`ExternalCampaignShareDTO{campaignId,publicCampaignUrl,qrPayload=publicCampaignUrl,taskMode,entryTask,campaignStatus,expiresAt,successfulUseCount,maxSuccessfulUses}`；二维码必须由已锁依赖的本地renderer离线生成，`qrPayload`逐字节等于campaign URL，渲染/复制不发analytics或网络请求。

每个无live session的访客执行唯一链：

```text
GET /open/{publicCampaignId} (locator only)
→ POST /v1/external-campaign-admission-challenges
→ POST /v1/external-campaign-admissions
   (atomic policy/rate/concurrency check; create one per-visitor grant + one-time #invite bootstrap)
→ /open#invite=<one-time-secret> earliest bootstrap clear
→ POST /v1/external-invitation-exchanges
→ isolated viewer principal/session and/or contributor principal/session
```

Challenge只证明同源流程/承载rate scope，不授业务能力。Challenge create把canonical publicCampaignId与client nonce做domain-separated keyed HMAC后保存；Admission以`secret_once_envelope`幂等：scope固定challenge credential family + canonical endpoint + requestHash，同challenge+key/body在短TTL内最多重放同一个bootstrap；不同body 409；challenge已消费且无匹配幂等记录时统一`campaign_unavailable`。Admission先锁challenge+Campaign并按§0.2.4逐字段constant-time校验，再原子检查Campaign active/not-expired/not-revoked、对应Space active/shared/open、pending上限、总成功上限、campaign/网络风险HMAC/匿名client-risk bucket速率与server abuse policy，创建`external_invitation_grants(version=1,campaignUseOrdinal=null,maxUses=1,bootstrapExpiresAt)`并递增campaign pending计数/version。不得存raw IP、完整UA或设备指纹；rate key只存短TTL、domain-separated keyed HMAC与policy version。

External exchange按全局`grant→parent campaign`顺序锁per-visitor grant与Campaign：在`bootstrapExpiresAt`前复验live状态、grant未消费、`successfulUseCount < maxSuccessfulUses`，原子分配严格单调且不复用的`campaignUseOrdinal`、递增successful count、递减pending、消费grant credential，并按taskMode创建隔离的`viewer_principals`/`contributor_principals`与sessions。Session `accessExpiresAt <= campaign.expiresAt`，成功exchange后bootstrap TTL/credential只用于清理，不得截断已签session；session可访问到access expiry，但campaign expiry/paused/revoke仍立即fail closed。并发exchange只能一个成功；组合模式的viewer/contributor principal彼此是不同ID但共享同一campaignId/useOrdinal以供审计，任何一个都不能读取另一兑换principal的batch。达到上限时campaign转exhausted；未兑换grant过bootstrap TTL由sweeper递减pending但不分配/复用ordinal。

首次exchange仍消费campaign存储的canonical `entryTask`并返回原样`taskMode/tasks/entryTask`与唯一`destinationRoute`：view→`/s/{spaceId}/album`，upload→`/s/{spaceId}/upload`；客户端不得重算。`/s/{spaceId}`仅供已有account/viewer/contributor session re-entry。相同浏览器重新打开campaign URL且已有该campaign live session时只走re-entry，不创建新admission/use；新浏览器/已清session视为新访客并占新ordinal。分享campaign URL符合产品意图；分享某访客的派生`#invite`无效，因为它只可单次消费且不得持久化/回显。

Campaign revoke原子递增campaign version并立即使其全部未消费grant与现有external sessions在下一次请求因live campaign check失败；实现可异步标记子行revoked作清理，但授权不得依赖fanout完成。Space切private/open→paused/archive仍按当前Space状态fail closed，重新开放不会复活revoked/expired/exhausted campaign或旧session。

反枚举分两层：locator/challenge/admission的missing/paused/revoked/expired/exhausted/rate/abuse/wrong Space task state/cross-campaign challenge统一`campaign_unavailable`与同status/body等级/等价时延；per-visitor bootstrap的invalid/expired/revoked/consumed/wrong family统一`invite_unavailable`。精确原因、use ordinal、risk decision只追加`external_campaign_audit_events`并在owner/canInvite read model中以聚合/脱敏原因展示；绝不写secret、raw bootstrap URL、raw IP、full UA或可跨campaign稳定关联的访客键。

“逐访客”在v1的精确定义是**每次成功兑换/browser principal隔离**，不是自然人去重：同一人清Cookie/换浏览器可占多个ordinal，多人共用同一浏览器live session也无法区分。产品、DTO、审计和验收不得声称“一人一位”；若活动必须证明实名与会者唯一，必须另走Account+verified email OTP/member流程，不得借设备指纹或campaign rate key暗中推断身份。

#### 3.1.1 Campaign expiry sweeper（内部技术操作）

`CAMPAIGN.SWEEP_EXPIRATIONS`是既有campaign生命周期的内部scheduler transaction，不是产品action、HTTP API或新的用户能力。Scheduler以固定`service_job`身份提交`CampaignExpirationSweepInput{cutoffAt,batchLimit,leaseId}`，按`expiresAt,id`稳定排序取有界批次；每一行只在短事务内处理，失败可由at-least-once调度重试。

三类处理必须使用与exchange一致的全局锁序（grant/challenge行先锁，随后锁parent campaign），并分别原子执行：

1. **Campaign到期**：锁campaign；仅当`expiresAt<=cutoffAt`、`expiredAt IS NULL`、`revokedAt IS NULL`且状态为active/paused/exhausted时，写`campaignStatus=expired`、`expiredAt=cutoffAt`、`external_invitation_campaigns.version += 1`并追加唯一`expired`审计事件。既有external session随后因live campaign check fail closed。
2. **未消费challenge到期**：锁challenge+campaign；仅当`expiresAt<=cutoffAt`且`consumedAt/revokedAt/expiryProcessedAt`全空时，写`expiryProcessedAt=cutoffAt`、`external_campaign_admission_challenges.version += 1`并追加唯一`challenge_expired`。Challenge不占pending，禁止修改campaign counters。
3. **未消费grant bootstrap到期**：锁grant+campaign；仅当`bootstrapExpiresAt<=cutoffAt`且`consumedAt/revokedAt/bootstrapExpiredAt`全空时，先断言`pendingAdmissionCount>0`，再写`bootstrapExpiredAt=cutoffAt`、`external_invitation_grants.version += 1`、`pendingAdmissionCount -= 1`、`external_invitation_campaigns.version += 1`，并在同一transaction追加唯一`grant_bootstrap_expired`与`pending_released`。Counter为0或审计append失败必须整笔rollback并触发`campaign_pending_invariant`告警，禁止夹到0或静默跳过。

终态字段与`external_campaign_audit_events`的partial unique约束构成幂等键；重复sweep只返回当前完成态，不再次递减counter，也不依赖HTTP `idempotency_records`。若exchange先获得锁并完成consume/pending decrement，sweeper看到`consumedAt`后跳过；若sweeper先完成，exchange看到`bootstrapExpiredAt`后统一返回`invite_unavailable`。成功exchange产生的session不由此操作撤销，且在`bootstrapExpiresAt < now < accessExpiresAt`仍按live campaign/grant/principal/session访问。

### 3.2 MemberInvitation target binding

MemberInvitation create/revoke 都是 owner-only。Create 必须提供已验证账号标识，由服务端按§0.1规范化、锁定/解析`identifier_equivalences`并保存`targetIdentifierEquivalenceId`；不得存裸 email，也不得把某个可轮换MAC/keyId或无key低熵hash当target identity。

Accept 必须满足：

```text
active authenticated account session
AND account has an active server-verified identifier
AND account_verified_identifiers.identifierEquivalenceId == memberInvitation.targetIdentifierEquivalenceId
AND invitation active/not expired/not revoked/not accepted
AND Space active
```

匹配、Membership唯一性检查、创建Membership、标记invitation accepted必须同一transaction；成功时`member_invitations.version += 1`，新Membership从`version=1`开始，Space无业务字段改变则不递增。

持链者遇到invitation missing、target mismatch、expired、revoked、already accepted或Space非active，全部返回相同HTTP status/body大小等级/稳定码`member_invite_unavailable`与等价时延策略；不得返回`account_target_mismatch`等细分码。精确原因只写owner可见的脱敏audit，不含secret或目标标识原文。

## 4. Canonical schema 与 Version/CAS Dictionary

所有业务表带 `spaceId`（全局账号/notice表除外）；跨对象 FK 使用 `(spaceId,id)`。涉及 batch 的关键链同时约束 `spaceId + batchId + itemId + contributorPrincipalId`，禁止仅凭可枚举 ID 关联。

### 4.1 唯一 Version/CAS Dictionary

`ifMatchOrVersion`、OpenAPI、schema、日志与测试只能引用下表**精确字段名**。禁止创造 `ownerVersion`、`collectionRevision`、`sharingRevision`、`familyVersion`、`grantVersion`、`secretVersion`、`revokeVersion`、`bindingVersion` 或其他同义别名。

通用规则：

1. 每个 mutable aggregate 只有一个 `version`，从1开始；状态真实改变时在同一transaction `version += 1`。幂等重放不递增。
2. HTTP资源mutation使用 `If-Match` 对应行的 `version`；明确要求body CAS时，`ifMatchVersion`也只能指向该行 `version`。多行transaction先比对全部相关行，再原子更新并分别递增被改变行的 `version`。
3. 两个例外字段：`accounts.sessionEpoch` 是全账号session总撤销epoch；`contribution_batch_items.placementAuthorizationVersion` 是上传者位置写权限epoch。除此之外不得新造epoch/revision计数器。
4. immutable event/revision行不做CAS；其ID/hash可作请求前置条件，但不得冒充version字段。算法/notice/legal发布物的`version`是发布版本，冻结后不可原地更新。
5. 任何coverage值只能写“表.字段 + 递增transaction”；泛称“authorization versions / policy version / current revision”不合格。

| Aggregate | 唯一CAS字段 | 明确递增点 |
|---|---|---|
| Account | `accounts.version` | locale/status/identifier关系/delete状态改变；logout-all同事务也递增 |
| Account全局session撤销 | `accounts.sessionEpoch` | logout-all、账号安全重置、账号删除撤权 |
| Identifier equivalence | `identifier_equivalences.version` | canonical collision key/envelope重键、status/owner binding改变 |
| Verified identifier | `account_verified_identifiers.version` | verify/replace/revoke |
| Identifier MAC alias | `account_verified_identifier_aliases.version` | current/previous/retired与grace状态改变 |
| OTP challenge | `email_otp_challenges.version` | attempt、consume、expire/revoke |
| Session family | `account_session_families.version` | rotate、reauth marker、revoke |
| Account session | `account_sessions.version` | rotate/revoke/expire状态落库 |
| Reauth grant | `reauth_grants.version` | consume/revoke/expire状态落库 |
| Idempotency record | `idempotency_records.version` | in_progress→completed/failed或one-time envelope销毁 |
| Space | `spaces.version` | owner/lifecycle/collection/sharing/current panorama/scene binding任一改变 |
| Membership | `space_memberships.version` | tasks/scopes/status/accept/revoke |
| External campaign | `external_invitation_campaigns.version` | status/tasks/entryTask/expiry/cap/rate policy、pending/success counters、revoke或expiry sweep改变 |
| Campaign admission challenge | `external_campaign_admission_challenges.version` | consume/expire/revoke状态落库 |
| Campaign rate counter | `external_campaign_rate_counters.version` | bucket count/expiry改变；仅admission事务内部使用 |
| Per-visitor external grant | `external_invitation_grants.version` | bootstrap consume、campaignUseOrdinal分配、expiry/revoke状态改变 |
| Member invitation | `member_invitations.version` | accept/revoke/expire状态改变 |
| Viewer principal | `viewer_principals.version` | revoke/status改变 |
| Viewer session | `viewer_sessions.version` | rotate/revoke/expire状态落库 |
| Contributor principal/session | `contributor_principals.version` / `contributor_sessions.version` | revoke或session rotate/revoke/expire |
| Contribution batch/item | `contribution_batches.version` / `contribution_batch_items.version` | item集合/计数/finalize；item upload/commit/fail/remove/revoke/delete |
| Item位置写授权 | `contribution_batch_items.placementAuthorizationVersion` | manager lock或owner reopen，与authorization event同事务 |
| Photo upload session/asset | `upload_sessions.version` / `assets.version` | ticket/commit/expire；validation/retention/delete |
| Batch receipt/session/binding | `batch_receipts.version` / `receipt_sessions.version` / `receipt_account_bindings.version` | receipt consume/recover/revoke；session rotate/revoke；binding create/revoke |
| Photo | `photos.version` | content/placement current pointer/asset/delete状态改变 |
| Scene | `scenes.version` | readiness/mode/current derived asset改变 |
| Panorama candidate/upload/revision | `panorama_candidates.version` / `panorama_upload_sessions.version` / `panorama_revisions.version` | candidate状态；ticket/commit/expire；revision activate/retire |
| Placement suggestion/job | `placement_suggestions.version` / `jobs.version` | suggestion invalidate；job status/attempt/result |
| Content case | `content_cases.version` | report/appeal/support case status/decision改变 |
| Case access session | `case_access_sessions.version` | rotate/revoke/expire状态落库 |
| Export/Deletion/OwnerTransfer | `export_jobs.version` / `deletion_requests.version` / `deletion_status_sessions.version` / `owner_transfers.version` | job/request/status-session/transfer状态或结果改变 |
| SceneNote实验 | `scene_note_jobs.version` / `scene_notes.version` | job status；confirm/edit/withdraw |
| L3个人记忆 | `memory_interviews.version` / `memory_question_jobs.version` / `personal_memories.version` | 问题job、回答草稿、确认或撤回改变 |
| L3书与授权 | `memory_books.version` / `book_contribution_grants.version` / `book_draft_versions.version` / `book_render_jobs.version` / `book_version_access_controls.version` | 逐书授权、书稿、渲染、冻结或受影响状态改变 |
| Published notice/release | `consent_notices.version` / `media_notices.version` / `algorithm_releases.version` | 只创建新发布版本；冻结行不原地改 |

### 4.2 集合字段

| 集合 | 必要字段/约束 |
|---|---|
| `accounts` | id、locale、status、sessionEpoch、version、timestamps、deletedAt |
| `identifier_equivalences` | id(opaque stable equivalenceId)、identityType(email_v1)、normalizedCollisionKey、collisionKeyEpoch、normalizedIdentifierCiphertext、normalizedIdentifierEnvelopeKeyId、normalizedIdentifierEnvelopeFormat、status(active/merged/retired)、version、createdAt；unique(identityType,normalizedCollisionKey) WHERE status=active；不得存normalized identifier明文；新行envelope必填，旧行仅能经provider/OTP重新验证后backfill |
| `account_verified_identifiers` | id、accountId、identifierEquivalenceId、status(active/revoked)、version、verifiedAt、revokedAt；FK(identifierEquivalenceId)；partial unique(identifierEquivalenceId) WHERE status=active，保证一个canonical identity最多绑定一个active Account |
| `account_verified_identifier_aliases` | id、identifierEquivalenceId、identifierMac、identifierKeyId、status(current/previous/retired)、graceExpiresAt、version、createdAt；FK(identifierEquivalenceId)；unique(identifierKeyId,identifierMac)；alias只作轮换查找，不能承担identity唯一性 |
| `email_otp_challenges` | id、purpose、identifierEquivalenceId、identifierAliasId、otpMac/otpKeyId、attempts、expiresAt、consumedAt、rateLimitMac/rateLimitKeyId、version；FK到equivalence/alias，alias轮换不改变challenge绑定身份 |
| `account_session_families` | id、accountId、issuedSessionEpoch、version、createdAt、revokedAt、lastReauthenticatedAt |
| `account_sessions` | id、accountId、familyId、issuedSessionEpoch、credentialMac/credentialKeyId、version、expiresAt、rotatedFrom、revokedAt |
| `reauth_grants` | id、accountId、purpose、issuedSessionEpoch、credentialMac/credentialKeyId、boundActionId、version、expiresAt、consumedAt、revokedAt |
| `idempotency_records` | id、scopePrincipalOrChallengeOrCredentialFamily、method、canonicalEndpoint、idempotencyKeyMac/keyId、requestHash、replayClass(ordinary_dto/credential_reissue/secret_once_envelope/completed_state)、state(in_progress/completed/failed)、responseRef nullable、oneTimeEnvelopeCiphertext/keyId/expiresAt nullable、createdAt、expiresAt、version；unique(scope,method,canonicalEndpoint,idempotencyKeyMac) |
| `spaces` | id、ownerAccountId、spaceLifecycle、collectionState、sharingState、currentPanoramaRevisionId、sceneId、version、timestamps；ownerAccountId为唯一owner真值 |
| `space_memberships` | id、spaceId、accountId、tasks[]、managementScopes[]、status、version、createdBy、acceptedAt、revokedAt；unique(spaceId,accountId) |
| `member_invitations` | id、spaceId、targetIdentifierEquivalenceId、tasks[]、managementScopes[]、credentialMac/credentialKeyId、expiresAt、acceptedAt、revokedAt、createdBy(owner)、version；target FK到rotation-invariant equivalence，不绑定某个MAC keyId |
| `owner_transfers` | id、spaceId、fromOwnerAccountId、targetAccountId、targetMembershipId、status(pending/accepted/revoked/expired)、spaceVersionAtCreate、expiresAt、acceptedAt、revokedAt、createdAt、version；partial unique(spaceId) WHERE status=pending；无secret/link字段 |
| `external_invitation_campaigns` | id、spaceId、publicCampaignId(random opaque; unique)、taskMode(view/upload/combo)、tasks[]、entryTask、campaignStatus(active/paused/revoked/expired/exhausted)、expiresAt、expiredAt、maxSuccessfulUses、successfulUseCount、pendingAdmissionCount CHECK ≥0、maxPendingAdmissions、ratePolicyVersion、abusePolicyVersion、createdBy、revokedAt、version；publicCampaignId非credential且不产生API权限 |
| `external_campaign_admission_challenges` | id、campaignId、clientNonceMac/clientNonceKeyId、credentialMac/credentialKeyId、riskKeyMac/riskKeyId、policyVersion、expiresAt、expiryProcessedAt、consumedAt、revokedAt、version；campaignId+clientNonce+credential family绑定并constant-time验证；credential只进固定`__Host-` Secure/HttpOnly/SameSite=Strict/Path=/短TTL cookie，raw IP/UA/device fingerprint禁止持久化 |
| `external_campaign_rate_counters` | campaignId、riskKeyMac/riskKeyId、bucketStart、policyVersion、count、expiresAt、version；短TTL；unique(campaignId,riskKeyId,riskKeyMac,bucketStart,policyVersion)，不得跨campaign复用risk key domain |
| `external_invitation_grants` | id、spaceId、campaignId、admissionChallengeId、credentialMac/credentialKeyId、displayMask、tasks[]、entryTask、campaignUseOrdinal nullable、bootstrapExpiresAt、bootstrapExpiredAt nullable、accessExpiresAt、maxUses(fixed 1)、consumedAt、revokedAt、version；`bootstrapExpiresAt < accessExpiresAt <= campaign.expiresAt`；unique(campaignId,campaignUseOrdinal) WHERE campaignUseOrdinal IS NOT NULL |
| `viewer_principals` | id、spaceId、campaignId、grantId、campaignUseOrdinal、createdAt、revokedAt、version；unique(campaignId,campaignUseOrdinal) |
| `viewer_sessions` | id、spaceId、campaignId、grantId、viewerPrincipalId、campaignUseOrdinal、credentialMac/credentialKeyId、tasks[]、spaceVersionAtIssue、campaignVersionAtIssue、grantVersionAtIssue、accessExpiresAt、revokedAt、version |
| `contributor_principals` | id、spaceId、campaignId、sourceGrantId、campaignUseOrdinal、createdAt、revokedAt、version；unique(campaignId,campaignUseOrdinal) |
| `contributor_sessions` | id、spaceId、campaignId、contributorPrincipalId、sourceGrantId、campaignUseOrdinal、credentialMac/credentialKeyId、tasks[]、spaceVersionAtIssue、campaignVersionAtIssue、grantVersionAtIssue、accessExpiresAt、revokedAt、version |
| `external_campaign_audit_events` | immutable append-only；id、spaceId、campaignId、eventType(created/challenge_issued/admission_allowed/admission_denied/exchanged/paused/revoked/expired/exhausted/challenge_expired/grant_bootstrap_expired/pending_released)、subjectKind(campaign/challenge/grant) nullable、subjectId nullable（internal opaque、owner DTO不返回）、campaignUseOrdinal nullable、reasonClass nullable、policyVersion、actorAuthKind/authorizationId nullable、requestId、createdAt；终态事件 partial unique(campaignId,eventType,subjectKind,subjectId)；禁止secret、raw/bootstrap URL、raw IP、full UA、risk MAC原值与跨campaign稳定访客键 |
| `contribution_batches` | id、spaceId、contributorPrincipalId、status、itemCount、committedCount、failedCount、version、createdAt、finalizedAt |
| `contribution_batch_items` | id、spaceId、batchId、contributorPrincipalId、assetId、photoId nullable、status、failureCode、uploaderPlacementWriteEnabled、placementAuthorizationVersion、revokedAt、deletedAt、version |
| `upload_sessions` | id、spaceId、batchId、itemId、contributorPrincipalId、assetId、exactPrivateObjectKey、declaredMetadata、expiresAt、status、requestHash、version |
| `assets` | id、spaceId、kind、privateObjectKey、rawSha256、observedBytes/Mime、dimensions、frameCount、orientation/color/metadataPolicyResult、validationState/code、version |
| `batch_receipts` | id、spaceId、batchId、contributorPrincipalId、credentialMac/credentialKeyId、consumedAt、accessExpiresAt、recoveryUntil、revokedAt、createdAt、version |
| `receipt_sessions` | id、spaceId、batchReceiptId、batchId、contributorPrincipalId、credentialMac/credentialKeyId、receiptVersionAtIssue、accessExpiresAt、revokedAt、version |
| `receipt_account_bindings` | id、spaceId、batchReceiptId、accountId、verifiedIdentifierId、verifiedByOtpChallengeId、boundAt、revokedAt、version；unique(batchReceiptId,accountId) |
| `photos` | id、spaceId、batchId、batchItemId、contributorPrincipalId、assetId、viewerSafeAssetId、photoContentState、placementState、confirmationMode nullable、currentPlacementRevisionId、version、deletedAt；viewerSafeAssetId必须指向同一photo的EXIF/GPS-stripped可展示derivative，变更由photos.version并发保护 |
| `scenes` | id、spaceId、sceneReadiness、sceneMode、currentDerivedAssetId nullable、version、timestamps；unique(spaceId) |
| `panorama_candidates` | id、spaceId、assetId、panoramaRevisionId nullable、status、validationJobId nullable、validationCode nullable、createdBy、expiresAt、committedAt、readyAt、failedAt、version |
| `panorama_upload_sessions` | id、spaceId、candidateId、assetId、exactPrivateObjectKey、requestHash、expiresAt、committedAt、status、version |
| `panorama_revisions` | id、spaceId、candidateId、assetId、validationReport、createdBy、readyAt、activatedAt、retiredAt、version |
| `placement_suggestions` | id、spaceId、photoId、panoramaRevisionId、jobId、algorithmReleaseId、status、candidates、calibratedProbabilities、OOD/ambiguity、invalidatedAt、version |
| `placement_revisions` | immutable；id、spaceId、photoId、panoramaRevisionId nullable、seq、parentRevisionId、placementState、confirmationMode nullable、yaw/pitch/region/fovDeg nullable、suggestionId nullable、authKind(service_job/membership/receipt_session/space_owner)、authSnapshot、restoredFrom、createdAt；v1没有独立scene node表，nodeId不得出现在DTO |
| `placement_authorization_events` | immutable；id、spaceId、batchId、itemId、photoId、beforeEnabled、afterEnabled、beforePlacementAuthorizationVersion、afterPlacementAuthorizationVersion、actor/authSnapshot、reasonCode、note nullable、requestId、createdAt |
| `photo_content_events` | immutable；id、spaceId、photoId、before/after、transitionReasonCode、decisionReasonCode nullable、note nullable、actor/authSnapshot、requestId、createdAt |
| `consent_notices` | id、purpose、locale、version、contentHash、effectiveAt、retiredAt；发布后immutable |
| `media_notices` | id、locale、version、acceptedFormats/limits/metadataPolicy、contentHash、effectiveAt；发布后immutable |
| `consent_events` | immutable；id、spaceId nullable、actorAuthKind/authorizationId、noticeId/version/hash、noticePurpose、acceptedAt；不原地写withdrawal |
| `notice_ack_events` | immutable；id、spaceId nullable、actorAuthKind/authorizationId、noticeId/version/hash、noticePurpose、targetMutationId、acknowledgedAt |
| `consent_withdrawal_events` | immutable；id、consentEventId、actorAuthKind/authorizationId、withdrawnAt、requestId；原consent event保持不变 |
| `content_cases` | id、spaceId nullable、caseId、caseType(report/appeal/support)、parentCaseId nullable、targetType(none/photo/space/account)、targetPhotoId/targetSpaceId/targetAccountId nullable、targetVersion nullable、actorRelationKind(account/viewer/receipt/case_access)；account列：actorAccountId/actorAccountSessionId/actorAccountMembershipId/actorOwnerSpaceId、actorAccountSessionVersion/actorAccountSessionEpoch/actorMembershipVersion/actorOwnerSpaceVersion；viewer列：actorViewerSessionId/actorViewerPrincipalId/actorExternalCampaignId/actorExternalGrantId/actorViewerSpaceId、actorViewerSessionVersion/actorViewerPrincipalVersion/actorExternalCampaignVersion/actorExternalGrantVersion/actorViewerSpaceVersion；receipt列：actorReceiptSessionId/actorBatchReceiptId/actorReceiptContributionBatchId/actorReceiptItemId/actorReceiptSpaceId、actorReceiptSessionVersion/actorBatchReceiptVersion/actorReceiptItemVersion/actorReceiptSpaceVersion；case_access列：actorCaseAccessSessionId/actorParentCaseId、actorCaseAccessSessionVersion/actorParentCaseVersion；以上actor列均nullable但受§4.7全列XOR/CHECK；另有category、decisionReasonCode nullable、status(open/in_review/resolved/rejected)、createdAt、version。target判别字段不能代替任何actor snapshot列；v1 report/appeal无附件/asset/upload字段 |
| `case_access_sessions` | id、caseId、accountId nullable、credentialMac/credentialKeyId、relationKind(reporter/appellant/support_requester)、relationVersion、expiresAt、revokedAt、version；caseId+relation组合FK且secret高熵；viewer/receipt创建case时必须签发独立case_access branch，以便原资源session撤销后仍按case规则申诉 |
| `case_decision_events` | immutable；id、spaceId nullable、caseId、beforeStatus/afterStatus、decisionReasonCode、note nullable、caseActorRelationKind、exactAuthorizationSnapshot、requestId、createdAt；snapshot只允许§4.7精确表字段 |
| `deletion_requests` | id、scopeType/scopeId、requester、status、ledgerId、requestedAt、completedAt、version |
| `deletion_status_sessions` | id、deletionRequestId(unique FK)、createdByIdempotencyRecordId、credentialMac/credentialKeyId、accessExpiresAt、revokedAt、createdAt、version；不得存accountId；只授权exact deletion request粗粒度status |
| `deletion_attempt_events` | immutable append-only；id、requestId、seq、previousEventId nullable、resourceType/resourceHash、attemptNo、action、startedAt、requestIdempotencyId |
| `deletion_status_events` | immutable append-only；id、requestId、seq、previousEventId、status、stableErrorCode nullable、completedAt nullable；旧event永不更新 |
| `export_jobs` | id、accountId、spaceId nullable、scope、status、objectKey、expiresAt、createdAt、version |
| `jobs` | id、spaceId、type、inputRefs/hashes、status、attempts、algorithmReleaseId、stableError、timestamps、version |
| `algorithm_releases` | id、code/model/weight/preprocess/calibrator/dataset/policy hashes、licenseStatus、frozenAt、version；frozen后immutable |
| `scene_note_jobs` | id、spaceId、photoId、batchItemId、status、consentEventId、model/prompt/policy hashes、version、timestamps |
| `scene_notes` | id、spaceId、photoId、batchItemId、status、textCiphertext nullable、confirmedAt、withdrawnAt、version |
| `memory_interviews` | id、spaceId、photoId、batchItemId、contributorPrincipalId、status(eligible/question_queued/question_ready/question_failed/draft/followup_queued/followup_ready/confirmed/skipped/withdrawal_pending/withdrawn)、followupCount(0..1)、currentAnswerSubmissionId nullable、version、timestamps；unique(spaceId,photoId,contributorPrincipalId)；这是`memoryInterview`十一态的唯一持久状态真值 |
| `memory_question_jobs` | id、memoryInterviewId、photoId、photoRawSha256、placementRevisionId、panoramaRevisionId、consentEventId、modelReleaseId、promptHash、policyHash、status、stableError nullable、version、timestamps |
| `memory_questions` | immutable；id、memoryInterviewId、questionOrdinal(1/2)、visibleFacts[1..2]、questionText、modelVersion、promptHash、policyHash、photoRawSha256、placementRevisionId、generatedAt |
| `memory_answer_submission_events` | immutable；id、memoryInterviewId、submissionKind(draft/edit/confirm)、textCiphertext、textHash、actorAuthKind/authorizationId、createdAt |
| `personal_memories` | id、spaceId、photoId、contributorPrincipalId、memoryInterviewId(unique FK)、headSubmissionId nullable、confirmedSubmissionId/hash nullable、currentRevisionId nullable、完整SourceProvenance snapshot、version、timestamps；不另存第二套status，`PersonalMemory.status/interviewVersion`逐字投影同一snapshot的`memory_interviews.status/version`，`PersonalMemory.version`投影`personal_memories.version`；workspace absent分支的START必须在一个serializable事务创建`memory_interviews(status=question_queued,version=1) + personal_memories(version=1, head/confirmed/currentRevision均null) + memory_question_jobs(version=1)`；SKIP必须在一个serializable事务创建`memory_interviews(status=skipped,version=1) + personal_memories(version=1, head/confirmed/currentRevision均null)`且不建question job；两者因此都能立即返回真实行标识/有效ETag；此后凡动作或worker改变唯一interview状态，都必须在同一serializable事务比较并推进`memory_interviews.version`，同时改变memory head/确认/撤回字段时还须比较并推进`personal_memories.version`，任一旧值均零部分写 |
| `personal_memory_revisions` | immutable；id、personalMemoryId、spaceId、photoId、photoAssetId/version/rawSha256、sceneId/nodeId nullable、panoramaRevisionId、placementRevisionId、yaw/pitch/capturedAt nullable、authorAccountId nullable、contributorPrincipalId、batchReceiptId、batchItemId、initial/followupQuestionId、original/confirmedAnswerSubmissionId、confirmedTextHash、confirmedAt |
| `memory_books` | id、spaceId、ownerAccountId、title、currentDraftVersionId nullable、currentFrozenVersionId nullable、version、timestamps；书的可变头/标题与当前指针真值，不另存会与draft/version机器竞争的概念status |
| `book_contribution_grants` | id、bookId、personalMemoryId、memoryRevisionId、creditLabel、audienceScope(current_live_space_viewers only)、noticeId/version/hash、consentEventId、grantedBy authKind/authorizationId、grantedAt、withdrawnAt nullable、version；Book与memory同Space；旧grant不复活；owner访问走current owner管理分支，不以隐式owner-only grant代替贡献者授权 |
| `book_draft_versions` | id、bookId、parentVersionId nullable、status(empty/editing/preview_queued/preview_ready/preview_failed/stale/freeze_checking/frozen)、grantSetHash、sourceSnapshotHash nullable、accessControlSnapshotHash nullable、staleReason nullable、title、pagesProjection、version、timestamps；status逐字等于`bookDraft`八态；每次编辑/授权/撤回追加不可变draft revision并以该行version作current draft CAS |
| `book_versions` | immutable version identity与状态行；id、bookId、ordinal、draftVersionId、status(rendering/available/render_failed/withdrawal_affected/superseded)、manifestId/hash、authorizationSnapshotHash、authorizedMemoryTextSnapshotHash、assetSnapshotHash、pageCount、createdAt/frozenAt；status逐字等于`bookVersion`五态，状态推进用append-only event/服务端原子投影，不增加Book CAS字典别名 |
| `book_render_jobs` | id、bookId、draftVersionId nullable、bookVersionId nullable、sourceManifestHash、templateVersion、rendererBuildHash、status、inputHash、htmlSha256/pdfSha256 nullable、stableError nullable、version、timestamps；preview与frozen render均可恢复，唯一CAS为`book_render_jobs.version` |
| `render_artifacts` | id、bookVersionId、renderJobId、format(html/pdf)、status(queued/rendering_html/html_ready/rendering_pdf/verifying/available/failed/revoked/purged)、contentHash nullable、pageCount nullable、createdAt、revokedAt/purgedAt nullable；unique(bookVersionId,format)；status逐字等于`renderArtifact`九态；不另加version/CAS，所有推进在`book_render_jobs.version + book_version_access_controls.version`保护下并写append-only artifact event |
| `book_version_access_controls` | id、bookId、versionId(unique FK)、draftVersionId nullable provenance、status(active/affected/revoked)、version、createdAt、affectedAt nullable；每行只绑定一个exact BookVersion，读取阻断/撤回overlay不得跨version复用 |
| `book_version_source_entries` | immutable；id、bookId、draftVersionId、grantId、memoryRevisionId、sourcePhotoId、displayPhotoId、spatial/time provenance、creditLabel、page/slot、sourceManifestHash |
| `immutable_frozen_book_manifests` | immutable；id、bookId、bookVersionId(unique FK)、title、manifestHash、authorizationSnapshotHash、authorizedMemoryTextSnapshotHash、assetSnapshotHash、pages、frozenAt；title精确复制freeze事务内已锁定且相等的`memory_books.title/current book_draft_versions.title`；manifestHash为省略自身manifestHash字段后的canonical manifest SHA-256并覆盖title、pages及全部文本/资产快照；renderer完整输入的唯一manifest，禁止回读live Memory、BookDraft或当前书名 |
| `immutable_authorized_memory_text_snapshots` | immutable；id、bookId、bookVersionId、personalMemoryId、memoryRevisionId、confirmedSubmissionId/hash、originalUserTextCiphertext、authorCredit、questionProvenance、grantId、audienceScope(current_live_space_viewers)、sourceProvenance、snapshotHash、frozenAt；原话/署名不得生成或改写 |
| `immutable_frozen_book_assets` | immutable；id、bookVersionId、kind(source_photo/display_photo)、photoId、sourcePhotosVersion、contentHash、mimeType、byteLength、localAssetRef；只允许renderer本地、已冻结字节，不含remote URL |
| `book_contribution_withdrawal_events` / `book_edit_events` / `book_freeze_events` | immutable append-only provenance；不得改写frozen source manifest或用户确认原文 |

Private object key、identifier HMAC、session/secret hash、provider subject、GPS、hidden/rejected/pending raw media 和内部模型字段不得出现在 viewer DTO。

### 4.3 Identifier 唯一性与 OTP 原子建号

身份唯一性只由`identifier_equivalences`的active `(identityType,normalizedCollisionKey)`唯一约束与`account_verified_identifiers`的active `identifierEquivalenceId`唯一约束承担；`(identifierKeyId,identifierMac)`alias绝不承担账号唯一性。OTP create/verify transaction先以canonical normalized identity计算collision key，锁定或upsert唯一equivalence row，再锁challenge、equivalence与active verified identifier，原子写入/验证§0.1的normalized-identity envelope，解析/补齐current+previous MAC aliases，按§0.1重算并constant-time比较OTP MAC。已绑定equivalence→登录其唯一Account；未绑定→创建Account(version=1,sessionEpoch=1)+verified identifier(version=1)。equivalence/envelope/alias upsert、challenge consume/version递增、Account选择/创建与session family/session签发必须同一transaction；任何unique冲突都回读胜出的equivalence/Account，绝不创建第二个Account。不得先查email或alias后异步建号。

内部操作`IDENTITY.REKEY_EQUIVALENCES`没有HTTP endpoint或产品action。它只接受`{fromCollisionKeyEpoch,toCollisionKeyEpoch,leaseId}`，要求fixed service-job identity、identity namespace排他lease与最小KMS decrypt/encrypt角色；逐行解密active envelope、重算并核对旧HMAC，stage新collision key，验证全表行数/唯一性/active equivalence→Account绑定后一次性switch，并递增每个改变的`identifier_equivalences.version`。任一缺envelope、AAD/key错误、碰撞、计数不符、lease丢失或存储失败均零部分写；重复已完成输入返回completed state且零写。旧行无envelope只能在该标识经provider/OTP重新验证后原子backfill；全部active行补齐前禁止退休旧equivalence key，不得以“永不退休”或“只在登录时懒重键”冒充完成。

### 4.4 ReauthPurpose 与绑定/消费

闭集 `ReauthPurpose`：

`logout_all | space_archive | space_restore | space_delete | account_delete | owner_transfer_create | owner_transfer_accept | photo_delete`

| Action | 精确purpose |
|---|---|
| `AUTH.LOGOUT_ALL` | `logout_all` |
| `SPACE.ARCHIVE` | `space_archive` |
| `SPACE.RESTORE` | `space_restore` |
| `SPACE.DELETE_REQUEST` | `space_delete` |
| `ACCOUNT.DELETE_REQUEST` | `account_delete` |
| `OWNER_TRANSFER.CREATE` | `owner_transfer_create` |
| `OWNER_TRANSFER.ACCEPT` | `owner_transfer_accept` |
| `BATCH.DELETE_ITEM` | `photo_delete` |

challenge与grant同时绑定`accountId + accounts.sessionEpoch + actionId + purpose`；如action有target，challenge/grant还绑定target type/id的MAC。`BATCH.DELETE_ITEM`的`photo_delete`必须同时绑定精确`accountId + spaceId + photoId`，只供same-Space owner分支；receipt item owner无需Account reauth且不得提交该grant。签发grant前重新验证current account sessionEpoch。目标mutation在同一transaction锁grant与目标aggregate，复验purpose/action/target/account/sessionEpoch/expiry/revocation/consumedAt，然后标记consumed并递增`reauth_grants.version`；mutation失败则grant消费也回滚。其他action不得接受“相近purpose”、历史reauth时间或普通session代替。

### 4.5 Idempotency 全局合同

所有API mutation先创建/锁`idempotency_records`；唯一scope为`(principal-or-challenge-or-credential-family, method, canonical endpoint, idempotencyKeyMac)`，保存canonical body+relevant headers的`requestHash`。同scope/key不同requestHash固定409 `idempotency_conflict`；同hash按下表处理。记录TTL不得短于业务重试窗口；in-progress超时只能由恢复worker按业务transaction结果收敛，不能盲目重跑。唯一特例是`ACCOUNT.DELETE_REQUEST`：首次分支与丢失响应重放分支都必须以本次提交的exact-purpose reauth-grant credential family作为唯一idempotency principal/scope，禁止首次按Account或account-session principal建记录；因此账号session被同事务撤销后，原reauth family仍能精确命中同一completed record，但不恢复任何Account权限。

| replayClass | 首次成功保存 | 同key/同body replay | 禁止行为 |
|---|---|---|---|
| `ordinary_dto` | `responseRef`或非敏感DTO摘要 | 重新加载当前授权；仍有权时返回相同业务结果/等价当前DTO | 不缓存Cookie、Authorization、signed URL |
| `credential_reissue` | 完成状态+session family/ref，不保存credential响应 | 重新加载current授权/epoch；已有current session时签发安全的新Set-Cookie响应或返回completed/current-session状态 | 不复活旧Cookie/OTP/credential；无current授权统一unavailable |
| `secret_once_envelope` | secret只置于短TTL、同principal绑定、AEAD envelope（KMS data key、AAD含record/scope/requestHash/expiry） | envelope未过期且同principal/current授权时最多重放同一secret；过期后只返回completed-without-secret，须显式撤销/新建 | 不把secret写responseRef/log；不延长envelope TTL |
| `completed_state` | resource/result ref | 重新授权后返回already-completed/current状态 | 不重复执行one-time消费或不可逆副作用 |

credential/Set-Cookie响应一律`Cache-Control: no-store, private`，不得由idempotency store保存原header/body。One-time exchange首次成功后：相同key/同body只能返回current session或completed状态，不再次消费secret；不同key、无current session或不同body统一返回该credential family的不可用稳定码。`idempotency_records.version`只在state/envelope销毁改变时递增；业务aggregate照常按§4.1递增。

Campaign链使用两个互不混用的scope：challenge create是`credential_reissue`，只保存challenge resource ref，不缓存Set-Cookie；admission是绑定challenge credential family的`secret_once_envelope`，只在短TTL/同challenge/同requestHash下重放同一per-visitor bootstrap。External exchange是`credential_reissue`，只保存grant/principal/session ref，不能缓存或复活`#invite`。同一个campaign URL在不同challenge下会产生不同idempotency scope、grant与principal；同challenge并发或相同key重试不会多占pending/ordinal。Campaign create/revoke是`ordinary_dto/completed_state`，create返回的public URL不是credential，可安全通过resource ref重建，但每次仍复验管理授权与campaign状态。

### 4.6 NoticePurpose 与 acknowledgement

闭集 `NoticePurpose`：`photo_upload | panorama_upload | receipt_account_binding | object_report | appeal | space_create | scene_note_l2 | memory_interview_l3 | book_contribution_l3`。只有`photo_upload`有独立产品动作`MEDIA_NOTICE.OPEN + UPLOAD.ACCEPT_NOTICE`并写`consent_events`；其余v1 purpose不新增按钮/action，而由目标页面展示current version/hash，目标mutation以受保护transport header `Notice-Acknowledgement: purpose;version;contentHash`确认，服务端同transaction验证current notice并追加`notice_ack_events`。`scene_note_l2`仍走L2独立consent。L3问答的`memory_interview_l3`只授权照片语义提问；逐条汇入某一本书必须另用`book_contribution_l3`并绑定`bookId + personalMemoryId + memoryRevisionId`，二者不得复用。缺失/过期/不匹配统一`notice_acknowledgement_required`，不能把一个purpose的ack复用于另一个。法律文案需正式复核；这里仅冻结技术记录，不冒充同意有效性的法律结论。

### 4.7 CaseActorRelationKind 与撤权后访问

闭集`CaseActorRelationKind = account | viewer | receipt | case_access`。创建`content_cases`时必须写入且只写入一个branch；数据库XOR CHECK要求其他三个branch的全部ID/version列为NULL：

| Branch | Exact FK / version snapshot | 创建时授权谓词 |
|---|---|---|
| `account` | `actorAccountSessionId→account_sessions.id`、`actorAccountId→accounts.id`；member子支为`actorAccountMembershipId→space_memberships.id`，owner子支为`actorOwnerSpaceId→spaces.id`，二者XOR；必存`actorAccountSessionVersion + actorAccountSessionEpoch`，并必存`actorMembershipVersion`或`actorOwnerSpaceVersion` | current session/family epoch有效；same-Space owner或active Membership拥有目标所需task/scope |
| `viewer` | 组合FK `(actorViewerSessionId,actorViewerPrincipalId,actorExternalCampaignId,actorExternalGrantId,actorViewerSpaceId)→viewer_sessions(id,viewerPrincipalId,campaignId,grantId,spaceId)`、`(actorViewerPrincipalId,actorExternalCampaignId,actorExternalGrantId,actorViewerSpaceId)→viewer_principals(id,campaignId,grantId,spaceId)`、`(actorExternalGrantId,actorExternalCampaignId,actorViewerSpaceId)→external_invitation_grants(id,campaignId,spaceId)`、`(actorExternalCampaignId,actorViewerSpaceId)→external_invitation_campaigns(id,spaceId)`，且`actorViewerSpaceId→spaces.id`；必存`actorViewerSessionVersion + actorViewerPrincipalVersion + actorExternalCampaignVersion + actorExternalGrantVersion + actorViewerSpaceVersion` | viewer session/principal/grant/campaign live，Space active+shared，target在其visible projection；transaction锁五行后写snapshot |
| `receipt` | 组合FK `(actorReceiptSessionId,actorBatchReceiptId,actorReceiptContributionBatchId,actorReceiptSpaceId)→receipt_sessions(id,batchReceiptId,batchId,spaceId)`、`(actorBatchReceiptId,actorReceiptContributionBatchId,actorReceiptSpaceId)→batch_receipts(id,batchId,spaceId)`、`(actorReceiptItemId,actorReceiptContributionBatchId,actorReceiptSpaceId)→contribution_batch_items(id,batchId,spaceId)`，并`actorReceiptSpaceId→spaces.id`；必存`actorReceiptSessionVersion + actorBatchReceiptVersion + actorReceiptItemVersion + actorReceiptSpaceVersion` | receipt/session live、Space active，target属于同一receipt→batch→item→photo组合；transaction锁session/receipt/item/Space后写snapshot |
| `case_access` | 组合FK `(actorCaseAccessSessionId,actorParentCaseId)→case_access_sessions(id,caseId)`，`actorParentCaseId→content_cases.id`；必存`actorCaseAccessSessionVersion + actorParentCaseVersion` | 高熵case access session live且relationKind允许该status read/appeal；transaction锁session+parent case后写snapshot，不能扩展到原对象访问 |

XOR/CHECK逐列冻结：选中branch的上述全部ID/version列必须非NULL，其他三branch全部ID/version列必须NULL；account branch内部再对Membership/owner两组做XOR。`target*`、顶层`spaceId`与`parentCaseId`业务字段不能填补actor列。任何未指明真实table.field与FK的旧授权三元组或聚合version占位都禁止进入schema、coverage或OpenAPI。Viewer/receipt创建case成功时必须同时签发独立`case_access_sessions`，且credential遵守CredentialCryptoProfile；原viewer/grant/receipt session随后撤销或过期，不自动删除已提交case，也不自动撤销case-access。只要case-access本身live且case在保留期内，actor仍可读取最小`caseId/status/decision/appealDeadline`并提交允许的appeal；不得读取target对象、media、Space metadata或重新获得viewer/receipt能力。Account branch在Membership/owner撤权后仍可由同一active Account读取自己的最小case envelope，但不能读取target；appeal资格只看case规则/期限。`case_access_sessions`可因滥用、安全、删除或保留期独立撤销；撤销后统一`case_unavailable`，不退回已撤销的原资源session。Case decision workflow的actor也必须使用同一closed enum与exact snapshot。

## 5. Batch upload 与 batch receipt

### 5.1 一次多选、逐项提交、一次 finalize

```text
create batch
→ add one item per selected file
→ each item independently creates upload session
→ upload + commit + validation per item
→ failed item may retry/remove before finalize
→ finalize batch exactly once
→ issue one batch receipt containing committed/failed item results
```

- Batch internal status：`open | finalizing | finalized | abandoned`。
- Item internal status：`selected | uploading | validating | committed | failed | removed | deleted`。
- `UPLOAD.REMOVE_ITEM`唯一合法转移是`batch.status=open AND item.status=failed`时的`failed→removed`。`selected/uploading/validating/committed/removed/deleted`或`finalizing/finalized/abandoned`一律`item_state_conflict`，不得用“uncommitted”这种更宽条件。相同Idempotency-Key/body可回放原成功；新key对已removed item仍拒绝。
- Partial success 是一等结果：finalized batch 可同时含 committed 与 failed/removed items；只为 committed item 创建 photo。
- `POST .../finalize` 要求 If-Match + Idempotency-Key；CAS 从 open→finalizing→finalized。相同 key/body 返回原 batch result；不同 body 409。
- Finalize 在同一 transaction 冻结 item terminal snapshot、统计计数、签发一个 batch receipt；第二次 finalize 不签发第二份。

### 5.2 Receipt 首次交换与 session

batch receipt finalize只返回一次同源`/uploads/open#receipt=<base64url-secret>`结果链接；secret至少128-bit（v1 32 random bytes），只存在fragment和内存，必须先按§0.2最小bootstrap同步清URL，再以TLS POST body调用`POST /v1/batch-receipt-exchanges`。`receipt` key/credential domain不得交给invitation exchange，`invite`也不得交给receipt exchange。首次exchange必须 CAS：

```text
server computes credentialMac and locks the matching batch_receipts row
AND loaded batch_receipts.version remains the UPDATE predicate
AND consumedAt is null
AND presented secret constant-time matches current credentialMac/keyId
AND current time < accessExpiresAt
AND revokedAt is null
AND receipt→batch→Space composite FK resolves
AND Space.spaceLifecycle == active
→ UPDATE ... WHERE id=:loadedId AND version=:loadedVersion AND consumedAt IS NULL
→ set consumedAt, destroy credentialMac after idempotency envelope policy, increment batch_receipts.version, issue HttpOnly receipt session(version=1, receiptVersionAtIssue=current receipt.version)
```

客户端**不发送**If-Match或receipt version：它在首次exchange前不知道可信version。并发由服务端锁+loaded version UPDATE裁决。相同Idempotency-Key/body按`credential_reissue`返回current session或completed状态，不再次消费secret；不同Idempotency-Key/无current session、错误、过期、撤销、key family不匹配统一 `receipt_unavailable`，不细分原因。Space archived则统一`batch_access_unavailable`，不消费secret、不签receipt session、不返回batch/photo内容。首次成功后只靠 HttpOnly receipt session或账号绑定恢复，不复用secret；刷新/转发旧fragment不能重放。Receipt fragment/secret不得进入DOM持久化、console、error、analytics、storage、Cache API、service worker、server/CDN/WAF日志或后续history。

`accessExpiresAt` 控制当前访问；`recoveryUntil` 控制绑定账号可否恢复；`revokedAt` 是显式终止。三者不得合并成单一 expires 字段。

### 5.3 每 item 的撤销、删除、锁与 reopen

- batch receipt session 只能读该 batch 的 items/photos；每个 mutation 复查 batchReceiptId + batchId + itemId + contributorPrincipalId 组合 FK。
- 每个item独立保存`uploaderPlacementWriteEnabled`、`placementAuthorizationVersion`、`version`、`revokedAt`、`deletedAt`。
- manager（owner 或 canEditPlacement member）执行SAVE、CONFIRM、UNDO、RETRY、MARK_OUTSIDE或任何placement write时，统一复用“manager item-lock transaction”：锁`photos + contribution_batch_items`及所需job/suggestion/revision；复验Space与授权/CAS；写photo/job/revision；设置该item `uploaderPlacementWriteEnabled=false`；同时递增`contribution_batch_items.version`与`placementAuthorizationVersion`并追加`placement_authorization_events`。任一步失败全部回滚，只锁该item，不锁同batch其他items。
- receipt item writer执行自己的SAVE/CONFIRM/UNDO/RETRY/MARK_OUTSIDE时只复验`uploaderPlacementWriteEnabled=true`、item/authorization版本与组合FK，**不得把自己的写入当manager write而锁自己**；成功仅更新真实改变的photo/job/revision/item业务字段，除非另有权限变更，不递增`placementAuthorizationVersion`。
- owner-only reopen 只重开指定 item；enabled/version 更新与 authorization event 同事务。旧 receipt session 的 item version 不匹配返回 423 `placement_locked_by_manager`；其他 items 仍可写。
- receipt holder 删除/撤销一个 item 不影响 batch 其他 items；整个 receipt revoke 才撤销所有 receipt sessions。

### 5.4 账号绑定与跨设备恢复

只有以下流程可创建 `receipt_account_bindings`：已登录且 Account 标识已由服务端验证，或在 receipt session 内完成邮箱 OTP 后创建/登录 verified Account；binding 写入必须引用已消费 OTP challenge。

恢复API只按**当前authenticated Account**查询active bindings：request schema不得接收任何客户端提供的回执标识作为恢复凭证。恢复transaction必须先按binding→receipt→batch→Space组合FK锁定并复验`spaceLifecycle=active`；只有通过后才可递增`batch_receipts.version`与相关`receipt_account_bindings.version`、逐个撤销旧receipt sessions并递增其`version`、签发新HttpOnly session。超过recoveryUntil、binding revoked、receipt revoked统一`receipt_recovery_unavailable`；Space archived统一`batch_access_unavailable`且零状态变化、零session、零内容DTO。

### 5.5 Receipt链的Space-active统一门

所有batch mutation、receipt exchange、账号恢复、内部session refresh/rotation、item delete/revoke以及`batchResult`、`batchReceiptView`、`batchItemResult`、`batchItemPlacementEditView`读取，都必须在同一授权快照/transaction内由batch/receipt/session/binding沿组合FK重新加载`spaces.version`并要求`spaceLifecycle=active`。不得只相信session签发时快照、cookie或binding状态。Space archived时统一`batch_access_unavailable`：不改batch/item/photo，不签/刷新session，不返回batch、item、photo、placement或签名媒体URL。Archive transaction必须设置所有该Space现有`receipt_sessions.revokedAt`并逐行递增`receipt_sessions.version`；即使撤销写漏，后续Space-active门仍fail closed。

## 6. Photo content、Placement 与算法映射

### 6.1 Content转移与两个不重叠reason enum

唯一请求字段是`transitionReasonCode + decisionReasonCode + optional note`。两个enum不得重叠；不得保留泛化`reasonCode`别名。

`transitionReasonCode`只表达状态机动作，固定为：

`manual_approved | manual_hidden | manual_rejected | manual_restored | manual_reopened`

`decisionReasonCode`只表达人工判断，固定为：

`safety_hold | privacy_request | rights_concern | quality_or_duplicate | abusive_or_illegal | rights_violation | unrelated_content | repeated_violation | appeal_upheld | review_corrected | issue_resolved | new_evidence | uploader_appeal | reviewer_correction | other`

| From → To | 服务端固定`transitionReasonCode` | `decisionReasonCode` applicability | actor |
|---|---|---|---|
| pending → visible | `manual_approved` | 必须`null` | owner / canReview |
| pending/visible → hidden | `manual_hidden` | safety_hold / privacy_request / rights_concern / quality_or_duplicate / abusive_or_illegal / rights_violation / other | owner / canReview |
| pending/visible/hidden → rejected | `manual_rejected` | abusive_or_illegal / rights_violation / unrelated_content / repeated_violation / rights_concern / quality_or_duplicate / other | owner / canReview |
| hidden → visible | `manual_restored` | appeal_upheld / review_corrected / issue_resolved / new_evidence / other | owner / canReview |
| rejected → pending | `manual_reopened` | uploader_appeal / reviewer_correction / new_evidence / other | owner / canReview |

客户端选择action与允许的`decisionReasonCode`；服务端逐action加载产品registry冻结的`allowedDecisionReasonCodes`，不得加载分组并集。服务端由action/From/To写入固定`transitionReasonCode`，不信客户端自报转移动作。`decisionReasonCode=other`时trim后非空`note`必填，其余decision的`note`可选；Approve的decision固定null。非法组合返回`invalid_content_transition | decision_reason_required | decision_reason_not_allowed | decision_note_required`之一。Photo与`photo_content_events`同transaction更新并递增`photos.version`，event immutable。

Report/appeal/support case保留自己的`category`，处置结果只引用`decisionReasonCode`；它们永不写`transitionReasonCode`。若处置同时改变Photo，另创建合法photo content event并用caseId关联，不能宣称case与transition共用一个enum。

### 6.2 Placement 唯一映射

| 算法/人工结果 | Canonical placement |
|---|---|
| active frozen policy 的 same-scene high 通过 | confirmed + auto |
| uncertain / OOD / ambiguous / abstained / no active policy | needs_confirmation |
| job failed / timed_out / decoder failure / retry exhausted | failed |
| 人工确认/移动 | confirmed + manual |
| 有权用户显式判异场 | outside_scene，pose/panoramaRevisionId=null |
| current panorama switch | 指向旧 revision 的 placement 新建 stale revision |

failed 允许 retry、manual placement 或 outside_scene；没有 ready suggestion 时 manual placement 不得伪造 suggestionId/candidate/probability。Timeout 永远不映射 needs_confirmation。

### 6.3 Auth snapshot 与 placement authorization event

`authKind` 唯一允许：`service_job | membership | receipt_session | space_owner`。owner写入必须使用`space_owner`，`authorizationId=spaceId`并保存`spaces.version` snapshot；不得创建或引用影子owner Membership。

每个placement revision必存：authKind、authorizationId、actor account/contributor/service ID、spaceId、membershipVersionSnapshot nullable、tasksSnapshot、managementScopesSnapshot、batchReceiptId/itemId nullable、receiptVersionSnapshot nullable、receiptSessionVersionSnapshot nullable、itemVersionSnapshot nullable、placementAuthorizationVersion、panoramaRevisionId、algorithmReleaseId/suggestionId nullable、requestId、reasonCode、createdAt。Snapshot字段必须来自§4.1真实字段，不能自造CAS名。这里及`placement_authorization_events.reasonCode`是**placement审计域**的独立原因分类，仅解释位置修改、锁定、重开或撤回；它既不是`photo_content_events.transitionReasonCode`，也不是`content_cases.decisionReasonCode`，API/OpenAPI不得跨域复用或互相映射。

manager lock 与 owner reopen 必须在 placement/item transaction 内追加 `placement_authorization_events`，保存 before/after enabled、before/after authorization version、actor完整 auth snapshot、稳定 reason、可选 note、requestId；失败则 placement 与 lock/reopen 全部回滚。所有manager placement endpoint必须调用同一原子模板，不得为CONFIRM/UNDO/RETRY保留旁路；receipt writer自己的合法操作显式选择receipt模板，不能触发manager lock。

## 7. Panorama candidate→upload→commit→validate→status→switch

UI仍只有一个`PANORAMA.UPLOAD_CANDIDATE`用户动作，但transport必须显式执行以下多步workflow；对象存储PUT不是业务API成功证明。

Internal status固定：candidate=`created | uploading | validating | ready | failed | expired`；upload session=`issued | committed | expired | revoked`；validation job=`queued | running | succeeded | failed | timed_out`。这些是内部job状态，不新增产品scene readiness。

1. **Create candidate/ticket**：`POST /v1/spaces/{sid}/panorama-candidates`，owner/canManageScene，`If-Match: spaces.version` + Idempotency-Key。transaction创建`panorama_candidates(version=1)`、`assets(version=1)`、`panorama_upload_sessions(version=1)`，并签发只允许PUT到该`spaceId+candidateId+assetId+exactPrivateObjectKey`、固定bytes/MIME上限、短期一次性的上传票据。返回candidateId/assetId/uploadSessionId/ticket/expiry；stable errors：`scene_management_unavailable | panorama_media_policy_invalid | version_conflict | idempotency_conflict`。
2. **Direct upload**：客户端按票据直传exact private key；禁止覆盖current对象、任意key、list/read权限。成功PUT只代表provider收字节，不改变candidate为ready。
3. **Commit/validate**：`POST /v1/panorama-upload-sessions/{uid}/commits`，同一管理授权与四对象组合FK，`If-Match: panorama_upload_sessions.version` + Idempotency-Key。服务端HEAD后GET真实bytes，在隔离decoder验证magic/MIME、observed bytes、width/height、严格2:1、pixel/decode limits、hash；commit返回202并创建/关联`jobs(version=1)`。stable errors：`panorama_upload_unavailable | panorama_object_missing | panorama_object_mismatch | panorama_decode_rejected | version_conflict | idempotency_conflict`。
4. **Atomic validation result**：成功transaction更新`assets.version`、`panorama_candidates.version`并创建`panorama_revisions(version=1, readyAt)`；失败更新candidate/asset/job各自`version`与稳定validationCode，绝不改`spaces.currentPanoramaRevisionId`、Scene或旧placement。
5. **Status**：`GET /v1/spaces/{sid}/panorama-candidates/{cid}`，owner/canManageScene + same-Space FK，返回candidate/job/revision状态与可重试动作；stable errors：`panorama_candidate_unavailable | scene_management_unavailable`，不暴露object key/provider error。
6. **Retry**：owner/canManageScene + same-Space FK。票据过期/未commit时，`POST /v1/spaces/{sid}/panorama-candidates/{cid}/upload-sessions`以`If-Match: panorama_candidates.version`签发同candidate的新一次性session；可重试基础设施/timeout失败用`POST /v1/spaces/{sid}/panorama-candidates/{cid}/retries`。二者均需Idempotency-Key，不覆盖ready/current revision；stable errors：`panorama_candidate_unavailable | panorama_retry_not_allowed | scene_management_unavailable | version_conflict | idempotency_conflict`。MIME/比例/decode等内容错误不可重试，必须新candidate。
7. **Switch/rollback**：`POST /v1/spaces/{sid}/panorama-switches`，owner/canManageScene，`If-Match: spaces.version`并同时提交`sceneIfMatchVersion=scenes.version` + Idempotency-Key。只接受same-Space ready `panorama_revisions.version`；同transaction切`spaces.currentPanoramaRevisionId`、更新`scenes.sceneReadiness=ready`、`scenes.sceneMode=rotation360`与current derived asset，分别递增`spaces.version`和`scenes.version`，把旧suggestions失效并为旧placements追加stale revision。首次switch与rollback复用同一transaction；rollback不恢复旧placement pointer。stable errors：`panorama_revision_unavailable | panorama_not_ready | scene_version_conflict | version_conflict | idempotency_conflict`。
8. **Orphan cleanup**：未commit ticket到期即撤销session并递增其`version`；private orphan object按版本化TTL job删除并递增asset/candidate/job的`version`。失败candidate只保留脱敏validation audit；不得让orphan对象进入viewer/CDN。

首发没有clear/delete-current或前台直接移除current的API。Panorama asset只随受控Photo/Space/Account retention/deletion cascade清理；历史只对owner/canManageScene可见。

## 8. V1 API

所有 mutation 使用 Idempotency-Key并声明§4.5 replayClass；版本 mutation使用 If-Match。相同key不同request hash为409；相同key/hash按replayClass重放，**不是**一概缓存原响应。Secret/OTP exchange一律POST body + `Cache-Control: no-store, private`，credential/Set-Cookie永不从缓存复活。

### 8.1 Account、OTP、session 与 re-auth

| API | Authorization | 语义 |
|---|---|---|
| `POST /v1/auth/email-otp-challenges` | none/rate-limited | body email+purpose；统一 accepted 响应，防账号枚举 |
| `POST /v1/auth/email-otp-verifications` | challenge+OTP | verify/create Account；新family/session均保存当前`accounts.sessionEpoch`到`issuedSessionEpoch`；稳定错误不泄露账号存在性 |
| `GET /v1/me` | account session | accountSettingsView、verified identifiers、session summary |
| `POST /v1/auth/reauth-challenges` | account session | 敏感 purpose 的 OTP challenge |
| `POST /v1/auth/reauth-verifications` | account session+OTP | fresh、短期、单 purpose、一次性 reauth grant；保存当前`accounts.sessionEpoch` |
| `POST /v1/auth/logout` | account session | 撤销当前`account_sessions`行并递增其`version`；不影响其他family |
| `POST /v1/auth/logout-all` | account+reauth | 单transaction递增`accounts.sessionEpoch`与`accounts.version`，撤销该account全部families/sessions并分别递增其`version`；不是只撤当前family |

每次account鉴权必须加载`accounts.sessionEpoch`，同时验证session和family的`issuedSessionEpoch`都相等、两行未撤销且未过期；只验cookie签名或family状态不合格。Reauth grant也绑定`issuedSessionEpoch`，epoch变化立即失效。`AUTH.LOGOUT_ALL`、`SPACE.ARCHIVE`、`SPACE.RESTORE`、`SPACE.DELETE_REQUEST`、`ACCOUNT.DELETE_REQUEST`、`OWNER_TRANSFER.CREATE`与`OWNER_TRANSFER.ACCEPT`必须按§4.4 exact map在mutation transaction内消费fresh、未过期、未撤销、未使用且purpose/action/target精确匹配的reauth grant；普通登录session或历史`lastReauthenticatedAt`不能替代。

### 8.2 Space、Membership 与 owner transfer

`SPACE.OPEN_CREATE`只是authenticated client navigation到`/spaces/new`，不创建业务数据。`SPACE.CREATE`才对应`POST /v1/spaces`，且请求DTO唯一业务字段为`{name}`；locale、client request ID及`space_create` Notice-Acknowledgement属于header/session transport metadata，不进入Create DTO。服务端同transaction创建`active/private/paused` Space(version=1)、`scenes(version=1, sceneReadiness=unavailable, sceneMode=rotation360)`并把`spaces.sceneId`绑定该Scene；`spaces.ownerAccountId`是唯一owner真值，**不创建owner Membership**。返回`CreateSpaceDTO{spaceId,sceneId,name,...,destinationRoute=/manage/{spaceId}?tab=setup}`，客户端成功后只按该route进入P04 setup。

`SPACE.OPEN /s/{spaceId}`只作account/session re-entry capability projection，按固定优先级选择一个destination：`effectiveCanView→album`，否则`effectiveCanUpload→upload`，否则`owner或任一active managementScope→manage`，否则`/spaces`。Management predicate不得要求某个特定scope，也不得把scope派生成view/upload。

| API | Authorization | 语义 |
|---|---|---|
| `GET /v1/me/spaces` | account | active owner/Membership rows；archived 只返回 owner 摘要/恢复/导出/删除动作 |
| `POST /v1/spaces` | account | body仅`{name}`；同事务创建Space+Scene并以ownerAccountId授权，不创建owner Membership；返回setup destination |
| `GET /v1/spaces/{sid}/management` | owner/任一managementScope | managementView，按 scope 裁剪 |
| `POST /v1/spaces/{sid}/collection-transitions` | owner-only | open/paused |
| `POST /v1/spaces/{sid}/sharing-transitions` | owner/canPublish | private/shared；递增`spaces.version`；切private同事务撤销viewer sessions并递增其`version`，重开不复活旧session |
| `POST /v1/spaces/{sid}/archive` | owner+reauth | archived + fail closed |
| `POST /v1/spaces/{sid}/unarchive` | owner+reauth | archived allowlist mutation |
| `POST /v1/spaces/{sid}/member-invitations` | owner-only | targetIdentifierEquivalenceId binding；secret once；MAC alias只作lookup |
| `POST /v1/member-invitation-acceptances` | account + `#invite` bootstrap→body secret | 原子equivalence target match + Membership create；所有不可用原因统一`member_invite_unavailable` |
| `POST /v1/member-invitations/{iid}/revocations` | owner-only | iid非secret；审计 |
| `PATCH /v1/spaces/{sid}/memberships/{mid}` | owner-only | tasks/managementScopes/version |
| `DELETE /v1/spaces/{sid}/memberships/{mid}` | owner-only | revoke accepted Membership |
| `GET /v1/me/owner-transfers` | account | 只返回`targetAccountId=current account`且pending/unexpired的transfer；不返回他人/已终态记录 |
| `POST /v1/spaces/{sid}/owner-transfers` | owner+reauth | body `{targetMembershipId,reauthGrant,ifMatchVersion}`；创建账号绑定transfer，返回`transferId`，不生成secret/link |
| `POST /v1/owner-transfer-acceptances` | target account+reauth | body `{transferId,reauthGrant,ifMatchVersion}`；`ifMatchVersion`精确指`owner_transfers.version` |
| `POST /v1/owner-transfers/{tid}/revocations` | current owner | body含`ifMatchVersion=owner_transfers.version`；撤销未接受transfer |

Create transaction锁Space并要求不存在另一条pending transfer，记录`fromOwnerAccountId=current owner`、`spaceVersionAtCreate=current spaces.version`、`status=pending`；每Space partial unique pending约束抵挡并发create。Accept同transaction锁`owner_transfers`与`spaces`两行，复验`status=pending`、未过期、`spaces.ownerAccountId=fromOwnerAccountId`、`spaces.version=spaceVersionAtCreate`、targetAccount/targetMembership仍是该Space active Membership、reauth grant绑定当前`accounts.sessionEpoch`；随后原子切owner、status=accepted，并分别递增`owner_transfers.version`与`spaces.version`，不存在双owner中间态。Owner transfer不包含bearer credential，也不生成可复制链接。

### 8.3 External campaign、per-visitor invitation 与 viewer

| API | Authorization | 语义 |
|---|---|---|
| `POST /v1/spaces/{sid}/external-invitation-campaigns` | owner/canInvite | body `{taskMode,entryTask,expiresAt,maxSuccessfulUses}`；强制active/shared/open；创建campaign并返回非敏感public URL/qrPayload，`ordinary_dto` |
| `GET /v1/spaces/{sid}/external-invitation-campaigns/{cid}` | owner/canInvite | `ExternalCampaignShareDTO`；可重开/重画本地二维码；只给public URL、状态/任务/expiry/聚合计数与审计摘要，不给访客bootstrap/risk key |
| `POST /v1/external-campaign-admission-challenges` | anonymous same-origin | body `{publicCampaignId,clientNonce}`；Origin/Host/Fetch-Metadata same-origin与campaign coarse availability/rate gate；保存campaignId+clientNonceMac/keyId并签固定`__Host-` Strict短TTL cookie，不授业务能力，`credential_reissue` |
| `POST /v1/external-campaign-admissions` | live challenge cookie | body `{publicCampaignId,clientNonce}`；同transaction锁challenge+campaign，constant-time复验campaign/nonce/TTL/consume/revoke后检查Space/caps/rate/abuse；cross-campaign统一失败；创建per-visitor grant并返回一次性`/open#invite=...`，`secret_once_envelope` |
| `POST /v1/external-invitation-exchanges` | body per-visitor secret | 锁campaign+grant，分配唯一use ordinal，创建隔离principal/session；返回原样taskMode/tasks/entryTask与canonical direct destination；授权始终重载live rows |
| `POST /v1/external-invitation-campaigns/{cid}/revocations` | owner/canInvite | If-Match campaign version；立即阻断新admission/exchange与既有external session live check，追加脱敏audit |
| `GET /v1/viewer/spaces/{sid}` | account view task / external viewer predicate | viewerSpace；无 session public route不存在 |
| `GET /v1/viewer/spaces/{sid}/photos/{pid}` | 同上 + visible | viewerPhotoDetail；无 SceneNote |
| `GET /v1/viewer/spaces/{sid}/photos/{pid}/scene-context` | 同上 + visible + confirmed/current/ready | 返回下述`ViewerPhotoSceneContextDTO`；资源URL只定位同源资源，不携带权限；否则稳定 no-scene reason |
| `GET /v1/viewer/spaces/{sid}/panorama-revisions/{rid}/media` | exact account/external effective-view session + current scene/revision | 可重复的session-auth panorama byte GET/单Range；每次必须同时复验`sceneReadiness=ready`、`sceneMode=rotation360`、`spaces.currentPanoramaRevisionId=rid`以及该revision为ready且未retired，再重验live授权；零业务写 |
| `GET /v1/viewer/spaces/{sid}/photos/{pid}/media` | exact account/external effective-view session + visible photo + confirmed/current placement | 可重复的viewer-safe photo derivative GET/单Range；每次重验live授权，零业务写 |

`ViewerPhotoSceneContextDTO`唯一结构：

```text
{
  photoId,
  photoAssetId,
  photoAssetVersion,
  photoRawSha256,
  sceneReadiness: ready,
  sceneMode: rotation360,
  scene: { sceneId, panoramaRevisionId },
  panorama: {
    url: /v1/viewer/spaces/{sid}/panorama-revisions/{rid}/media,
    revisionId, assetId, assetVersion, sha256, bytes, contentType
  },
  photoMedia: {
    url: /v1/viewer/spaces/{sid}/photos/{pid}/media,
    assetId, assetVersion, sha256, bytes, contentType
  },
  placement: {
    revisionId, status: confirmed, confirmationMode,
    yawDeg, pitchDeg, fovDeg, placementSeq, photoVersion
  }
}
```

`photoAssetId/photoAssetVersion/photoRawSha256`来自原始asset；`photoMedia.assetId/assetVersion`来自`photos.viewerSafeAssetId`指向的viewer-safe derivative；`panorama.assetId/assetVersion`来自current panorama revision绑定的exact asset。两者的hash/bytes/type必须来自同一asset version，客户端把媒体响应ETag与DTO中对应SHA-256逐字比对后才可解码。DTO与两个URL明确禁止`nodeId`、`placement.version`、`capabilityId`、secret、oneTime、signed query/fragment、自定义鉴权header与private object key。浏览器只用`credentials: include`；URL本身不是bearer。Panorama媒体GET每次只重载current account/viewer authorization、Space、Scene、current panorama revision及其asset version，并同时要求`sceneReadiness=ready`、`sceneMode=rotation360`、`spaces.currentPanoramaRevisionId=rid`、revision ready且未retired；photo媒体GET另重载photo content、viewer-safe asset与confirmed/current placement。logout、revoke、private/archive、hidden/rejected、revision/placement漂移必须令对应旧URL下一次读取立即失败。读取不得消费或创建capability、ticket、session、idempotency或业务audit行。

两个媒体响应固定`Cache-Control: private, no-store`、`Cross-Origin-Resource-Policy: same-origin`、`X-Content-Type-Options: nosniff`、`Accept-Ranges: bytes`，ETag等于冻结SHA-256；只接受完整GET或一个合法byte range，多range/非法/越界返回416 `range_not_satisfiable`。photoMedia只能是已去EXIF/GPS的viewer-safe derivative。v1 panorama server-observed硬上限是**33,554,432 bytes（32 MiB）**：整值可通过，+1在create/commit/read任一边界fail closed；不得残留50 MiB口径。

内部操作`CAMPAIGN.SWEEP_EXPIRATIONS`没有endpoint；它只接受scheduler输入，按§3.1.1锁定并递增`external_invitation_campaigns.version`、`external_campaign_admission_challenges.version`或`external_invitation_grants.version`，输出`CampaignExpirationSweepResult{campaignsExpired,challengesExpired,grantsExpired,pendingReleased,auditEventsAppended}`。稳定失败类仅为`campaign_pending_invariant`、`campaign_sweep_lease_lost`与`campaign_sweep_storage_unavailable`；重放语义为终态字段驱动的`completed_state`，不得产生第二次状态转换。

`INVITATION.COPY_LINK`是客户端static clipboard action、不发API。External campaign分支复制的是read model中的同源`/open/{publicCampaignId}`，允许之后管理重开再次复制/分享；MemberInvitation分支仍只在create一次性内存态复制`#invite=` bootstrap。`INVITATION.SCAN_AGAIN`只接受campaign locator二维码，不把per-visitor/member bearer编码进多人活动二维码。二维码由客户端本地renderer生成，payload逐字节等于public URL；不得调用网络二维码服务、添加tracking query、上报payload或把campaign URL当authorization header。Campaign页面取得的派生bootstrap仍遵守single consume，刷新/转发失败。

### 8.4 Upload batch、receipt 与 read models

`UPLOAD.OPEN`只是live effective-upload navigation到`/s/{spaceId}/upload`并加载uploadContext，不创建batch。`UPLOAD.SELECT_FILES`只属于P07：POST创建batch前必须同时复验current media consent与live effective upload；P06/P08的CTA只能先执行`UPLOAD.OPEN`，历史batch/receipt/binding不能代替当前能力或consent。

| API | Authorization | 语义 |
|---|---|---|
| `GET /v1/spaces/{sid}/upload-context` | account upload task / external contributor predicate | uploadContext：limits、mediaNotice、consent requirements、batch capability |
| `POST /v1/spaces/{sid}/contribution-batches` | 同上 | create open batch；每次新建都复验live effective upload。P08历史页、旧batch/receipt/binding本身绝不授予新batch能力 |
| `POST /v1/contribution-batches/{bid}/items` | batch actor | 每文件一个 item |
| `DELETE /v1/contribution-batches/{bid}/items/{iid}` | batch actor + open + item failed | 唯一`failed→removed`；其他item状态或非open batch均`item_state_conflict` |
| `POST /v1/contribution-batches/{bid}/items/{iid}/upload-sessions` | batch actor | exact private ticket |
| `POST /v1/upload-sessions/{uid}/commits` | bound batch actor | server GET bytes；item validating/committed/failed |
| `POST /v1/contribution-batches/{bid}/items/{iid}/retries` | batch actor + batch open | finalize 前只重试该 failed item；finalized 后必须新建 batch |
| `POST /v1/contribution-batches/{bid}/finalizations` | batch actor | CAS finalize；冻结全部 item 结果并一次签发 batch receipt；之后不可增删/重试 |
| `GET /v1/contribution-batches/{bid}/result` | batch actor before finalize/session after | batchResult，逐 item partial success |
| `POST /v1/batch-receipt-exchanges` | `/uploads/open#receipt=:secret` bootstrap→body receiptSecret + composite Space active | §0.2先清fragment；首次loaded-version CAS consume；key family不匹配统一`receipt_unavailable`，archived返回`batch_access_unavailable`且不签session |
| `GET /v1/batch-receipt` | receipt session + composite Space active | batchReceiptView；archived不返回batch/photo内容 |
| `GET /v1/batch-receipt/items/{iid}` | receipt session + composite FK + Space active | batchItemResult；archived统一`batch_access_unavailable` |
| `GET /v1/batch-receipt/items/{iid}/placement-edit` | receipt session + item predicate + Space active | batchItemPlacementEditView；锁定423；archived不返回内容 |
| `POST /v1/batch-receipt/account-binding-otp-challenges` | receipt session | verified-email binding challenge |
| `POST /v1/batch-receipt/account-bindings` | receipt session + OTP | create verified Account binding |
| `GET /v1/me/batch-receipt-bindings` | current account session/epoch | `BATCH.OPEN_ACCOUNT_UPLOADS`只列当前Account拥有、binding/receipt仍active、未过recoveryUntil且组合Space仍active的脱敏batch摘要；不签receipt session、不返回batch/photo/media内容。用户必须先选择binding，才可调用`BATCH.RECOVER_FROM_ACCOUNT` |
| `POST /v1/me/batch-receipt-recoveries` | account；body `{bindingId}` | binding必须属于当前Account；按binding定位batch receipt并旋转sessions；不接收receipt对象ID |
| `POST /v1/batch-receipt/revocations` | receipt session | revoke整个 receipt/session family |
| `POST /v1/batch-receipt/items/{iid}/revocations` | receipt session | revoke一个 item |
| `POST /v1/batch-receipts/{rid}/items/{iid}/placement-reopens` | owner-only | 重开单 item |
| `POST /v1/photos/{pid}/deletion-requests` | exact receipt item / owner+`photo_delete` reauth；Space active | owner grant绑定account+space+photo并在同transaction消费；两个分支都复验receipt/batch/item/photo/Space组合FK；archived统一`batch_access_unavailable` |

`BATCH.OPEN_ITEM`唯一映射`GET /v1/batch-receipt/items/{iid}`；它不是导航占位，也不得以裸photo/item ID绕过receipt session与组合FK。

### 8.5 Photo、review、placement 与 Scene

| API | Authorization | 语义 |
|---|---|---|
| `POST /v1/photos/{pid}/content-transitions` | owner/canReview | exact`transitionReasonCode + decisionReasonCode + optional note`；applicability见§6.1 |
| `POST /v1/photos/{pid}/placement-revisions` | membership/receipt item predicate | manual/candidate placement；manager按item锁 |
| `POST /v1/photos/{pid}/placement-actions` | exact receipt item writer或owner/canEditPlacement | mark_outside_scene/retry/restore；receipt必须匹配contributor+batch+item+photo组合FK，item未revoke/delete/manager-lock、writeEnabled=true且authorization version匹配；manager写同事务只锁该item。failed manual不造suggestion |
| `GET /v1/photos/{pid}/placement-revisions` | resource-scoped member/receipt | 裁剪 immutable history |
| `GET /v1/photos/{pid}/placement-edit` | own writable receipt item / owner / canEditPlacement | batchItemPlacementEditView；跨Space、被锁item fail closed |
| `GET /v1/spaces/{sid}/placement-queue` | owner/canEditPlacement | managementPlacementQueue |
| `GET /v1/spaces/{sid}/review-queue` | owner/canReview | managementReviewQueue |
| `GET /v1/spaces/{sid}/management/next-target` | owner/任一active managementScope | `MANAGE.OPEN_NEXT`从当前服务端management read-model选择仍可处理的下一目标；每次读取重新校验scope与target actionability，成功只返回`target | empty`。候选在并发中失效时先跳过并有界重选；窗口耗尽则返回产品冻结的稳定错误`concurrent_change`（进入`stable_error` phase），绝不把它伪装成success outcome或返回已失权/已处理target |
| `POST /v1/spaces/{sid}/panorama-candidates` | owner/canManageScene | 验证`panorama_upload` notice acknowledgement；原子建candidate/asset/upload session并返回绑定exact key的一次性票据 |
| `POST /v1/panorama-upload-sessions/{uid}/commits` | owner/canManageScene + composite FK | 幂等commit；HEAD/GET真实bytes并启动validation，返回202 |
| `GET /v1/spaces/{sid}/panorama-candidates/{cid}` | owner/canManageScene | candidate/job/revision状态；不返回private key/provider详情 |
| `POST /v1/spaces/{sid}/panorama-candidates/{cid}/upload-sessions` | owner/canManageScene | 仅未commit/票据过期candidate；幂等签发replacement ticket |
| `POST /v1/spaces/{sid}/panorama-candidates/{cid}/retries` | owner/canManageScene | 只重试标为retriable的validation failure |
| `POST /v1/spaces/{sid}/panorama-switches` | owner/canManageScene | 只切same-Space ready revision；atomic switch/rollback/stale fanout |
| `GET /v1/spaces/{sid}/panorama-history` | owner/canManageScene | candidate/current/history；无clear/delete action |
| `GET /v1/jobs/{jid}` | resource-related actor/member | status/stable error；不泄露内部路径 |

### 8.6 Consent、举报、申诉、支持、删除与导出

| API | Authorization | 语义 |
|---|---|---|
| `GET /v1/notices/current?purpose=photo_upload` | effective upload session | versioned media notice DTO；其他purpose必须走显式allowlist，不能由客户端任意拼接 |
| `POST /v1/consent-events` | valid account/viewer/contributor/receipt session | notice version/hash + purpose flags |
| `POST /v1/reports` | valid account/viewer/receipt branch | 验证`object_report` notice acknowledgement；按§4.7写exact actor FK/version snapshot与target组合FK，返回 caseId/status；viewer/receipt同时签高熵case access session；v1 body只允许category+description，不接受attachment/asset/uploadSession字段 |
| `GET /v1/reports/{caseId}` | same active Account或live case_access；原资源session仅在仍live时可用 | reportCaseStatus，反枚举；撤权后只返回最小case envelope，不返回target |
| `POST /v1/appeals` | same active Account、live case_access，或仍live的affected receipt branch | 验证`appeal` notice acknowledgement；按§4.7写exact actor branch；body固定`{targetCaseId,category,statement?,clientRequestId}`；`category`仅可为`decision_error | context_missing | ownership_or_consent | privacy_or_safety | other`；`statement`trim后为1..2000 Unicode code points，`other`时必填；attachment/asset/uploadSession字段一律`unsupported_field`；返回appeal caseId/status。申诉输入不接受`reasonCode`/`transitionReasonCode`/`decisionReasonCode`，后台处置结果才可写`content_cases.decisionReasonCode` |
| `GET /v1/appeals/{caseId}` | same active Account或live case_access | appealStatus，反枚举；撤权不恢复target访问 |
| `POST /v1/support-cases` | any/rate-limited | 在任何idempotency/case/credential写之前先做exact-key allowlist；body严格为`CreateSupportCaseRequest{category,description}`，`contact`、targetObjectId及其他任意未知字段统一`unsupported_field`且零写；只有合法匿名请求才在一个事务内创建case与case-access session |
| `GET /v1/support-cases/{caseId}` | case access session/account | status；case ID高熵且限流 |
| `POST /v1/photos/{pid}/deletion-requests` | owning receipt item / owner | revoke-first，创建 deletion ledger |
| `POST /v1/spaces/{sid}/deletion-requests` | owner+reauth | archived allowlist；级联 ledger |
| `POST /v1/me/deletion-requests` | account+reauth | owner disposition未完成则409；同事务创建exact deletion-status session、签`__Host-unseen_deletion_status`并清account cookie；credential创建失败则整笔回滚；replay=`credential_reissue` |
| `GET /v1/deletion-requests/{did}` | exact deletion-status session或仍live的合法space/photo requester | account deletion优先验证exact deletion-status cookie；只返回粗粒度status/ledger summary；wrong/expired/revoked/cross-did统一`deletion_request_unavailable` |
| `POST /v1/exports` | account；Space export owner-only | async export job；archived owner可用 |
| `GET /v1/exports/{eid}` | requester | exportStatus；不返回可长期复用的对象URL |
| `POST /v1/exports/{eid}/download-authorizations` | requester + export ready | 一次性、短期、同源下载授权；`credential_reissue`只缓存resource/authorization ref与完成态，不缓存signed URL/token；同key replay复验live requester/export并为同一完成态签当前session绑定的新凭据；URL/token全程redact/no-store |

Case管理不新增产品action：`GET /v1/spaces/{sid}/management`的P13 read model在owner/canReview分支内可从属调用`GET /v1/spaces/{sid}/content-cases`与`GET /v1/spaces/{sid}/content-cases/{caseId}`；两者读取`spaces.version + content_cases.version + space_memberships.version`（owner branch无Membership，只读`spaces.version`）并按target裁剪。处置由从属workflow `POST /v1/spaces/{sid}/content-cases/{caseId}/transitions`完成，授权branch只能是current `space_owner`或active `space_memberships.canReview`，按§4.7保存精确`spaces.version`或`space_memberships.version`；If-Match=`content_cases.version`、Idempotency-Key；同transaction追加immutable `case_decision_events`并递增case version。它本身只改变case；只有当现有五个CONTENT action且targetType=photo时，才可另外执行合法Photo content transition并写photo event，不能借case endpoint偷改Photo或造新按钮。稳定错误统一`case_unavailable | case_transition_not_allowed | authorization_changed | version_conflict | idempotency_conflict`；外部case status只凭same active Account或live高熵`case_access_sessions`，不可枚举，撤权后遵守§4.7最小case envelope。

所有consent撤回只追加`consent_withdrawal_events`；原`consent_events`不可变。所有删除worker尝试/状态变化分别追加`deletion_attempt_events`、`deletion_status_events`，seq单调且`previousEventId`成链；不得原地递增attempts、覆盖lastError或把旧event改completed。

对象 report 只接受 valid viewer/receipt/account session；无 session 的通用 support 不得绑定 photo/Space。所有 case create 按 authorizationId + target + category + time window限流/去重，外部只回高熵 caseId与粗粒度status，不暴露对象存在性或处置者。

`ACCOUNT.DELETE_REQUEST`的`credential_reissue`有且只有两个鉴权分支。首次分支使用current Account + fresh exact-purpose reauth，并且在任何账号撤权前就以本次presented reauth-grant credential family作为唯一idempotency scope；同一事务创建`deletion_requests`、`deletion_status_sessions(createdByIdempotencyRecordId)`与completed idempotency ref。禁止按Account或account-session principal创建该action的首次记录。丢失响应后的重放分支不要求已被撤销的account session，但必须同时持有原始已消费reauth credential family、相同Idempotency-Key与相同requestHash；服务端锁定`idempotency_records → deletion_requests → deletion_status_sessions`，复验responseRef、createdByIdempotencyRecordId与exact deletionId三向一致后，只递增同一status session version、轮换credential并重签status cookie。该分支不得再次执行删除、递增account epoch、创建第二个request/session或恢复任何账号权限；任一证明不匹配只返回completed-without-credential，同key不同body固定409。

### 8.7 无独立产品 action 的 subordinate mutations

这些端点必须由`ACTION-API-COVERAGE.json.technicalOperationCoverage`逐项覆盖，不新增产品action；与顶层action/workflow一起进入同一mutation set equality、idempotency/replay/CAS构建门禁：

| API | Authorization | 语义 |
|---|---|---|
| `POST /v1/contribution-batches/{bid}/items` | exact batch actor | `UPLOAD.SELECT_FILES`下属逐file建item |
| `POST /v1/contribution-batches/{bid}/items/{iid}/upload-sessions` | exact batch/item actor | 签exact-key one-time upload ticket |
| `POST /v1/upload-sessions/{uid}/commits` | bound upload actor | 真对象HEAD/GET、commit并启动validation |
| `POST /v1/contribution-batches/{bid}/items/{iid}/retries` | batch actor + open + failed/retriable | 已由顶层`UPLOAD.RETRY_ITEM`覆盖；`BATCH.ITEM.RETRY`只作一一对照，不重复计副作用，其endpoint/method/auth/request/success/errors/idempotency/replay/CAS必须与顶层逐字段全等 |
| `POST /v1/batch-receipt/items/{iid}/revocations` | exact receipt item / owner disposition | 单item撤权，不等于删除其他item |
| `POST /v1/spaces/{sid}/content-cases/{caseId}/transitions` | exact space_owner或active canReview Membership | P13 management从属case workflow；只改case，Photo变更仍须现有CONTENT action |

任何`technicalOperationCoverage`行若与顶层action共享method+endpoint，必须声明`coverageKind=top_level_action_reference`并以`parentActionOrWorkflow`精确指向唯一顶层action；gate对九个语义字段逐值全等，不能再依赖mutation set去重掩盖冲突。

## 9. V1 read models

| DTO | Authorization | 最小字段/约束 |
|---|---|---|
| `homeConfig` | none | 打开空间/登录、locale/build；无任务能力 |
| `accountSettingsView` | account | verified identifier mask、session summary、delete/export actions |
| `mySpacesView` | account | active owner/Membership；archived仅owner摘要；tasks/managementScopes与派生effective booleans |
| `viewerSpace` | account view/external viewer | visible album、scene readiness/mode、effectiveCanUpload；无管理/SceneNote |
| `viewerPhotoDetail` | account view/external viewer | visible photo、placement label、可用scene CTA、report capability；无SceneNote/hidden raw |
| `uploadContext` | account upload/external contributor | limits、formats、mediaNotice version/hash、consent、new batch capability；无album数据 |
| `batchResult` | batch actor/receipt session | batch counts、每item status/failure/action、receipt access/recovery状态 |
| `batchReceiptView` | receipt session | 仅该batch items、accessExpiresAt/recoveryUntil、binding summary、逐item capability |
| `batchItemResult` | receipt session | 单item photo/content/placement、canEditPlacement、lock/delete/revoke reason |
| `batchItemPlacementEditView` | receipt session+item predicate / management member | current pano minimal asset、placement version、candidate/manual controls；无其他投稿者数据 |
| `managementView` | owner/management member | 只按 managementScopes 返回队列/动作 |
| `externalCampaignShare` | owner/canInvite | publicCampaignUrl/qrPayload、taskMode/entryTask、status/expiry、successful/pending/cap聚合、脱敏audit reason counts、可撤销；无bootstrap secret、raw URL/IP/UA/risk key或可跨campaign访客标识 |
| `reportCaseStatus` / `appealStatus` / `supportCaseStatus` | original actor access | high-entropy caseId、coarse status、next action；无内部审计身份 |
| `deletionStatus` / `exportStatus` | requester | progress、stable errors、completion/expiry；无内部 object key |

## 10. Archived allowlist

`spaceLifecycle=archived` 时：

- `GET /v1/me/spaces` 只向 owner 返回摘要；非 owner完全不返回。
- viewer、upload、management、external campaign admission/exchange、member invitation exchange、content/placement/panorama mutation全部 fail closed。
- 唯一 mutation/read allowlist：owner re-auth 后 unarchive、owner export、owner deletion request、owner/account deletion所需 disposition、对应 status read。
- Archive mutation与Space状态切换同transaction将该Space所有active campaign置revoked并递增`external_invitation_campaigns.version`，同时撤销所有现有viewer/contributor/receipt sessions并递增各自真实version；不得留下可用external/receipt session。
- 旧 viewer/contributor/receipt session不能据此读取 Space 对象；receipt exchange/refresh/read、receipt account recovery均原子复验组合Space active，archived统一`batch_access_unavailable`且不签session、不返回batch/photo内容。

## 11. R2-A 预注册统计门禁

### 11.1 数据与 primary unit

- 最少10个独立test Spaces、300 evaluable ID、300 OOD；每Space至少20 ID。
- 两名标注者独立标 same-scene、circular yaw、evaluable、模糊、多解；第三人/预定规则裁决。
- burst/near-duplicate family先聚成cluster；cluster是primary sampling/analysis unit，同cluster不跨split。图片级结果只作敏感性分析，不能膨胀n。
- train/calibration/test按Space/panorama分组；test按Space分层报告，不能让单一大Space主导。

### 11.2 Endpoint denominator

- high correctness denominator：`high ∩ evaluable ID`，numerator为same-scene且|yaw error|≤45°。
- catastrophic denominator：`high ∩ evaluable ID`，numerator为|yaw error|>90°。
- OOD false confirm denominator：全部预注册OOD clusters，numerator为high。
- high coverage denominator：全部evaluable ID clusters，numerator为high。

Ambiguous/multi-solution/blur必须按预注册evaluable规则归类，不能看结果后移出denominator。

### 11.3 联合置信与四项门槛

四项是一个family，必须预注册控制 family-wise one-sided error≤0.05。默认Bonferroni：每项one-sided alpha=0.0125，即使用98.75%单侧bound；若用cluster bootstrap/GEE或其他同时置信方法，必须预先冻结并证明Space stratification与cluster dependence被保留，禁止事后挑方法。

| Endpoint | 调整后单侧bound通过条件 |
|---|---|
| high confirmed correctness | lower bound ≥95% |
| catastrophic direction | upper bound ≤1% |
| OOD high false confirm | upper bound ≤1% |
| high coverage | lower bound ≥30% |

样本动态增加直到四项联合通过或预注册no-go预算耗尽。300/300只是最低入场；实际high clusters不足时不能放行。按Space报告point/bound、macro、worst-Space与cluster-aware sensitivity。

## 12. L2 SceneNote

L2依赖L1且不进v1 release gate。首阶段visibility固定为 `contributor_only`：仅创建该photo的batch receipt session或已绑定Account能读写。v1 viewing DTO采用显式字段allowlist，L2草稿、正文与状态均不在其中；未来扩大可见范围必须另立版本合同。

- Feature flag默认off；独立versioned consent后才能创建async job。
- Job输出只是draft；contributor confirm后形成SceneNote，仍contributor_only。
- skip/close/failure不改photo content/placement/upload/viewer。
- withdraw立即删除当前正文、模型/用户草稿与private derivatives，并从contributor projection移除。
- 只保留最小audit provenance：event ID、photo/content hash、model/prompt/policy版本hash、consent/confirm/withdraw actor authKind/authorizationId和时间、deletion completion；不保留可还原正文的文本/embedding。
- `POST /v2-experiments/batch-receipt/items/{iid}/scene-note-jobs`：版本化consent后创建async job。
- `POST /v2-experiments/batch-receipt/items/{iid}/scene-note-confirmations`：确认同item已完成draft；仍仅贡献者可见。
- `POST /v2-experiments/batch-receipt/items/{iid}/scene-note-withdrawals`：删除正文、draft与private derivatives并保留最小audit。
- 三个API均标 `releaseLane=L2`，不会挂在v1 viewing path下。

## 12A. L3 Book Lab：照片问答成书

L3是Core上传、定位、审核和Viewer之后的独立后置能力。Feature flag默认off；任何问题生成、追问、跳过、失败或超时都不得写Photo/content/placement/Scene/Viewer aggregate，也不得延迟照片上传成功。Core Web/H5 R0可独立验收，但本轮“全流程完成”必须同时满足`Core R0 PASS AND Book Lab MVE PASS`。

### 12A.1 产品与AI边界

1. 每张eligible、confirmed/current照片只先生成**一个**初始问题；用户回答后最多请求**一次**追问。页面不是聊天机器人，也不自动生成长篇日记。
2. QuestionProvider只输出`visibleFacts[1..2] + questionText`或abstain/failure。问题必须锚定当前照片可见事实，只问上传者可能知道的语境；禁止人脸身份识别，禁止把表情推断成感动、悲伤、关系、年龄或健康事实；看不清则abstain。
3. AI问题和用户回答分开存。首版不做AI answer rewrite；入书正文逐字来自用户确认的submission。模型文字不得标成用户原话。
4. 回答可保存草稿、编辑、确认；确认创建immutable personal memory revision。问题job失败可重试或跳过，均不阻断主链。
5. 现有`scene_notes`始终`contributor_only`，不能复制、迁移或默认汇总进Book Lab。L3只消费新建的`personal_memory_revisions`。

### 12A.2 权限、逐书授权与撤回

- 问答只允许exact batch-receipt item contributor或该receipt经OTP绑定的current Account。Owner/reviewer不能读未授权个人记忆、代答或改写正文。
- Book创建、改标题、删页、换展示图、冻结首版owner-only；owner只能看到明确授权给该Book的memory revision。
- 每个`book_contribution_grants`精确绑定`bookId + personalMemoryId + memoryRevisionId + audienceScope`；首轮闭集唯一值是`current_live_space_viewers`。owner访问通过current owner管理分支复验，但仍必须存在贡献者对该Book/revision的明确grant，不能制造`owner_only`隐式授权。AI分析同意不等于入书授权，照片可见不等于回答可入书；Book A的grant不能给Book B。重新授权必须创建新consent event/grant，旧grant永不复活。
- `MEMORY.WITHDRAW`删除当前个人记忆正文、草稿、私有衍生物并级联withdraw所有Book grants；只留不可还原正文的最小audit。`BOOK_MEMORY.WITHDRAW`只撤出指定一本书，不删除个人记忆。两者不能合并。
- 冻结前withdraw立即从draft移除，已有preview标`stale`并撤销共享artifact；冻结后withdraw使旧version `affected`，HTML/PDF分发立即失败，新version必须排除该内容后重新冻结。已经下载到用户设备的PDF无法召回，UI必须明确说明。
- 冲突回答永不自动合并成单一真相；按creditLabel分别署名。主人不能编辑用户正文或把`sourcePhotoId`换成别的来源；“换图”只改变`displayPhotoId`。

### 12A.3 状态机与API权威

五台状态机（memory interview、book authorization、book draft、book version、render artifact）、20个action、9 phase文案、API/CAS与稳定错误的机器真源分别是：

- `l3-book-lab/ACTION-REGISTRY.book-lab.json`
- `l3-book-lab/STRING-CATALOG.book-lab.zh-CN.json`
- `l3-book-lab/ACTION-API-COVERAGE.book-lab.json`
- `l3-book-lab/STATE-MACHINES.book-lab.json`

Book namespace与Core 90 action ID交集必须为0。Book mutation为独立`/v2-labs/**`闭集，全部要求Idempotency-Key；编辑、授权、withdraw与freeze使用exact If-Match。HTML/PDF为same-origin session-auth GET，不签持久URL，不进入公开projection。

Question job冻结输入`spaceId/photoId/photoRawSha256/placementRevisionId/panoramaRevisionId/nodeId/yaw/pitch/modelReleaseId/promptHash/policyHash/consentEventId`。Book render只接受active grants组成的frozen source manifest，按时间×空间节点×方向组织，但不合并冲突；HTML是canonical preview，PDF从同一manifest/render tree生成并保存template/renderer/hash。首版210×210mm数字方形页，无bleed、印刷、支付、订单、地址、物流或履约承诺。正文放不下时稳定`book_content_requires_edit`，不得静默裁字、截断或缩到不可读。

Book HTML/PDF read的唯一谓词是：same-Space owner，或同时满足current canonical Account/external view predicate、access control active、version frozen/available、该frozen version的**全部**source grants仍active且每条`audienceScope=current_live_space_viewers`。任一失败在artifact/body lookup前统一`book_version_unavailable`，不得通过状态码、错误文案或时延区分owner-only、withdrawal、revoke、missing或not-ready。用户文本必须转义；HTML/Markdown/SVG/RTL/超长中文不得执行脚本、请求远程资源或越出PDF页面。

### 12A.4 Book Lab MVE

固定最小样本：1个Space/事件、1个ready panorama、12–20张confirmed/current照片、3–5位真实或明确授权测试参与者、每张1个初始问题、至少一组同一时刻不同方向、至少一对互相冲突但均合理的署名回答，生成12–16页HTML/PDF。未选择正式模型或未获真实数据许可时只能跑确定性fixture，不得声称真实问题质量已验证。

MVE至少证明：flag off/AI失败主链零Book读写；问题可回源且越界推断为0；answer/edit/confirm provenance；跨receipt/Space/Book BOLA；未授权正文对owner DTO/log/render为0；冲突分视角；HTML/PDF同manifest逐页对账；主人不能改原文/sourcePhoto；冻结前后withdraw；XSS/远程请求/PDF overflow为0；320/390/1247/1248/1440、200% zoom、键盘/读屏；并发freeze/withdraw、幂等、旧version、session revoke与清本机缓存恢复。

## 13. 媒体、panorama 与恶意文件

- 普通照片：JPEG、PNG、static WebP、HEIC、HEIF；magic bytes+真实decoder，不信扩展名/MIME。
- 应用EXIF orientation后再计算尺寸/thumbnail/locator input；ICC/NCLX受控转sRGB。
- animated GIF/APNG/WebP/HEIF sequence拒绝，不静默取首帧。
- raw bytes、dimensions、decoded pixels、frame/metadata bytes、CPU/wall time、RAM限额版本化；隔离decoder，失败fail closed。
- GPS/精确位置、序列号等默认不持久化、不进locator/log/DTO；capturedAt按notice用途最小化。
- 成品panorama按server-observed bytes验证2:1、尺寸/decoder/hash；candidate失败保旧current。
- 成品panorama v1 server-observed bytes硬上限固定33,554,432；32 MiB+1拒绝。viewer session-auth媒体GET仍必须执行当前授权与该上限的fail-closed核对。

## 14. 必测反例

1. Membership tasks={upload}且canReview存在：effectiveCanView仍false；management scope不自动授view/upload。
2. management scope持有者尝试账号成员邀请或暂停收集都必须403；仅owner可做。
3. campaign taskMode=combo但entryTask=delete或客户端改成upload：服务端拒绝/返回冻结entryTask=view；public URL不得由客户端派生tasks。
4. campaign missing/paused/revoked/expired/exhausted/rate/abuse/wrong Space state只返回`campaign_unavailable`；per-visitor grant invalid/expired/revoked/consumed/wrong secret只返回`invite_unavailable`，两层均不可通过status/body/timing枚举。
5. MemberInvitation missing/发给A登录B/expired/revoked/accepted/Space inactive：都不建Membership，HTTP/status/body/timing只见`member_invite_unavailable`；owner audit才分因。
6. 一批3图：2 committed、1 failed；finalize只签一份batch receipt，结果逐item表达；失败项不造photo。
7. 两个并发receipt exchange：只有一个CAS成功；另一个receipt_unavailable；secret不可重放。
8. 账号恢复请求传入任意回执标识：schema拒绝；只能按当前Account bindings恢复并旋转旧sessions。
9. manager改item A只锁A；同batch item B仍可写；owner reopen A后version变化；authorization event与lock同事务。
10. `timed_out`映射`failed`；failed manual placement的suggestionId必须null。
11. no active policy映射needs_confirmation，不得伪造active policy或high candidate。
12. APPROVE携带非null decision、HIDE缺decision或提交跨action decision都400/409；rejected→visible直接409，只允许manual_reopened到pending再manual_approved到visible。
13. archived Space：非owner从mySpaces消失；旧viewer/receipt都读不到；owner只可summary/export/unarchive/delete/disposition。
14. 无session support body携带photoId：不得创建对象report；valid viewer创建report返回高熵caseId且受限流。
15. `viewerPhotoDetail`字段allowlist不含任何L2字段；withdraw后正文/derivative删除，仅最小audit在。
16. panorama票据不能PUT任意key/current；PUT 200但未commit仍不是ready；伪MIME/非2:1/bytes mismatch失败保旧current并进入orphan cleanup；只有ready revision可switch，switch/rollback都stale旧placement。
17. 300 ID/OOD点估计通过但cluster-aware、Space-stratified、multiplicity-adjusted任一bound未过：仍no-go。
18. 账号有三个session family；logout-all后`accounts.sessionEpoch`递增，所有旧session/family即使未逐条读到revoked也因issuedSessionEpoch不匹配失败，新登录使用新epoch。
19. owner transfer create只返回transferId且无链接；非target账号看不到pending/不能accept；target membership被撤或version漂移时accept原子失败且owner不变；并发accept/revoke只有一个成功。
20. schema/OpenAPI/coverage出现ownerVersion、collectionRevision、familyVersion等词典外CAS字段时build直接失败；合法mutation只递增§4.1实际改变的aggregate version。
21. 非bootstrap bearer出现在任意URL/QR，或invitation secret出现在path/query、非`#invite=`键、analytics/cache/log/storage/DOM，或数据库只有裸SHA-256无keyId：security build/test失败；唯一允许进入多人二维码的是无query/fragment的同源campaign public URL，它对viewer/upload API单独调用必须401/403。
22. OTP在同一verified email上并发verify：唯一约束+transaction只产生一个Account；challenge/purpose/identifier任一不匹配都统一失败且不建号。
23. 同Idempotency-Key不同body必409；credential replay不得返回旧Cookie；secret-once envelope过期后不得恢复secret；普通DTO replay仍先重验当前授权。
24. account member在private Space有task=view可读；external viewer在private Space不可读。任一实现要求account也shared或用Membership补失效external grant都失败。
25. receipt exchange客户端携带伪If-Match不能影响结果；两个线程对同credentialMac锁行，仅loaded-version UPDATE一个成功，同key重放只见current/completed。
26. manager依次用CONFIRM/UNDO/RETRY写item均触发同一item-lock/event；receipt writer对自己的合法CONFIRM不改变placementAuthorizationVersion；锁后receipt写返回明确locked。
27. owner transfer并发create只有一条pending；Space version在create后漂移、current owner改变或target Membership撤销时accept原子失败。
28. case target跨Space、CaseActorRelationKind分支XOR失败、任一精确session/grant/receipt/Membership/Space version过期、枚举caseId都失败；资源授权撤销后只能由same active Account或live case_access读最小case envelope，不能读target。纯case transition只写case decision event，不改变Photo；只有合法CONTENT action可联动Photo。
29. consent withdrawal只追加withdrawal event；删除重试只追加seq/previousEventId attempt/status events，历史event字节不变。
30. Space create在Scene写失败时Space也不存在；成功必有Scene version=1/unavailable/rotation360且无owner Membership。switch/rollback任一Space/Scene CAS失败时两者及stale fanout均零变化。
31. Bootstrap初始HTML在fragment清除前请求favicon/CSS/font/script/API/analytics任一资源、被service worker控制、缺no-referrer/CSP/no-store，或replaceState后history/DOM/storage仍可恢复secret：security test失败。
32. 两个客户端并发兑换同一per-visitor`#invite=`：仅一个原子consume并得到新session；另一个及刷新/转发旧bootstrap统一不可用。Campaign public URL可重开/分享，但任何访客bootstrap取回API必须不存在。
33. B、D从同一combo campaign public URL并发进入，C从独立view-only campaign进入：三者challenge/grant/principal/session分别隔离，成功use ordinal只在各自campaign内唯一递增；B的viewer/contributor、D的batch与C的viewer不可交叉读写，C没有upload task。相同challenge+Idempotency-Key不重复占pending/use；不同body固定409；任一campaign的challenge、grant、principal、session或资源ID用于另一campaign只得统一不可用响应且两边计数不变。
34. 创建两个未消费grant并让其中一个在bootstrap TTL内exchange成功、另一个遗弃：推进时钟后执行`CAMPAIGN.SWEEP_EXPIRATIONS`，只为遗弃grant写`bootstrapExpiredAt`、grant/campaign version各递增一次、pending只减一次，并同transaction追加`grant_bootstrap_expired`与`pending_released`；相同cutoff重跑零状态变化。已成功session在`bootstrapExpiresAt < now < accessExpiresAt`仍可访问。
35. Exchange与sweeper并发争抢同一grant：无论谁先锁，只允许一次pending decrement；exchange胜出则无grant-expiry审计，sweeper胜出则exchange只得`invite_unavailable`。构造pending=0异常时整笔rollback并告警，不允许负数或漏审计。
36. 未admit的challenge到期：sweeper只写`expiryProcessedAt`、递增challenge version并追加`challenge_expired`；campaign pending/success计数不变。Owner read model只见campaign内聚合/脱敏reason，不得返回subjectId、secret、raw URL/IP/full UA或跨campaign稳定访客键。
37. 恶意客户端仅拿publicCampaignId直接请求viewer/upload/batch或伪造use ordinal：全部拒绝；耗尽pending/rate/total只能得到`campaign_unavailable`，不得看到campaign是否存在或剩余精确额度。
38. Campaign revoke后新admission、未消费grant exchange、现有viewer/contributor下一次请求均失败；到达exhausted只阻止新admission/exchange，已成功ordinal的live session在未过期且Space状态允许时仍可用。
39. P16 campaign create/read返回`qrPayload == publicCampaignUrl`且URL无query/fragment；本地QR renderer网络请求/analytics为0。Owner重开可重画同一QR；扫码者不得直接取得业务数据，必须走独立admission链。
40. REPORT/APPEAL body加入`attachmentId`、`assetId`、`uploadSessionId`或multipart：固定`unsupported_field`且不创建asset/case；v1不存在第三条case媒体上传链。
41. `MANAGE.OPEN_NEXT`候选在有界重选后仍发生并发漂移：返回stable error `concurrent_change`且无target；不得以HTTP success返回`outcome=concurrent_change`。
42. Campaign A签发的challenge cookie与nonce提交Campaign B admission：campaignId/nonce MAC constant-time校验失败，统一`campaign_unavailable`，A/B pending/success/version均不变且不生成grant。
43. Grant在bootstrapExpiresAt前exchange成功；随后超过bootstrap TTL但未到accessExpiresAt，live session仍可访问。Campaign expiry/revoke或accessExpiresAt到达时立即失败；不得把两个TTL混成一个字段。
44. Audit读取只能看campaign内聚合/脱敏reason class；任何event/DTO/log含secret、raw bootstrap URL、raw IP、full UA、risk MAC或跨campaign稳定访客键均build失败。
45. 同一自然人清Cookie后可得到第二ordinal、两人共用一浏览器live session也只有一个principal；UI/API不得显示“一人一号/已识别宾客”。需要唯一自然人时campaign接口拒绝承担，必须转Account+OTP流程。

## 15. Legacy importer mapping

旧状态只在offline importer逐值映射并记录source/hash/reason；在线API收到旧值一律400。旧Space draft/published/closed映射到active/private|shared/paused|open/archived；旧review映射到pending/visible/hidden/rejected；旧pose映射到processing/needs_confirmation/confirmed/stale/failed。Importer不得把旧published变成无session access、不得把missing review当visible、不得把旧单照片回执直接升级为batch receipt；旧数据必须先组成显式单item batch并经过迁移审计。
