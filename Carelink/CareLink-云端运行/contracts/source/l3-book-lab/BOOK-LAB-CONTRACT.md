# UNSEEN L3 Book Lab 合同草案

> 状态：**DRAFT ONLY / 未合并 / 不代表已实现**
> 日期：2026-08-13
> 机器真源：`ACTION-REGISTRY.book-lab.json`、`STRING-CATALOG.book-lab.zh-CN.json`、`ACTION-API-COVERAGE.book-lab.json`、`STATE-MACHINES.book-lab.json`
> 本草案只描述 L3 Book Lab，不改动 core 90，也不允许直接读取 L2 SceneNote。

## 1. 产品合同

Book Lab 是主链之后的独立实验：照片先完成上传、空间归位与贡献者身份绑定；系统围绕一张照片提出最多一个主问题，贡献者可跳过、回答、请求追问、继续提交新版回答并确认其中一个版本。回答提交只追加、不覆盖；v0 的模型只负责提问，不生成、不润色、不重写用户回答。确认后的 PersonalMemory 仍是贡献者私密内容。只有贡献者对“这个 Memory revision × 这一本书 × 这个读者范围”另行明确授权，内容才进入该书的 grant 投影。空间主人可生成 12–16 页 HTML 预览、做三种编辑、冻结版本并下载同源 PDF。

本轮固定验证边界：

- 1 个事件、12–20 张已完成主链的照片、3–5 位真实贡献者；
- 每张照片最多 1 个主问题；允许有限追问，默认上限由运行配置给出，但不得变成无限聊天；
- 书为 12–16 页；编辑动作只有改标题、删页、换页内照片；
- 输出为可阅读 HTML 和可下载 PDF；
- 不含实体印刷、支付、订单、地址、物流、售后与履约；
- Book Lab 的失败、停用或撤回不得阻断上传、定位、相册、360 或 Viewer。

## 2. 真源与硬锁

### 2.1 动作集合

Book Lab **恰好 20 个动作**：

1. `MEMORY.OPEN`
2. `MEMORY.START_QUESTION`
3. `MEMORY.SKIP`
4. `MEMORY.SAVE_ANSWER_DRAFT`
5. `MEMORY.REQUEST_FOLLOWUP`
6. `MEMORY.CONFIRM`
7. `MEMORY.WITHDRAW`
8. `BOOK_MEMORY.AUTHORIZE`
9. `BOOK_MEMORY.WITHDRAW`
10. `BOOK.OPEN_LAB`
11. `BOOK.CREATE`
12. `BOOK.OPEN_DRAFT`
13. `BOOK.GENERATE_PREVIEW`
14. `BOOK.EDIT_TITLE`
15. `BOOK.REMOVE_PAGE`
16. `BOOK.REPLACE_PAGE_PHOTO`
17. `BOOK.FREEZE`
18. `BOOK.START_NEW_VERSION`
19. `BOOK.OPEN_PREVIEW`
20. `BOOK.DOWNLOAD_PDF`

每个动作必须恰好有 `initial / loading / success / stable_error / retry / session_or_permission_loss / empty / destructive_confirm / return` 九个非空中文 phase，合计 180 对。文案文件不得夹入 transport、并发控制、存储或渲染术语。

### 2.2 路由真源

| Entry | Route |
|---|---|
| BL01 | `/labs/memories/photos/:photoId` |
| BL02 | `/labs/memories/:memoryId` |
| BL03 | `/labs/books/:bookId/contributions/:memoryId` |
| BL04 | `/manage/:spaceId/book-lab` |
| BL05 | `/manage/:spaceId/book-lab/:bookId/draft` |
| BL06 | `/s/:spaceId/books/:bookId/versions/:versionId` |

Registry、catalog、coverage 与 state transition coverage 的动作 ID 集合必须完全相等。Coverage 的 `sourceEntry/sourceRoute/sourceReturnTarget/sourceActor` 必须逐字等于 registry 对应字段。Registry 的 `equalityLock.stateEnumEquality` 另固定五组 exact-set：`PersonalMemory.status ↔ memoryInterview.states`、`BookAuthorization.status ↔ bookAuthorization.states`、`BookDraft.status ↔ bookDraft.states`、`BookVersion.status ↔ bookVersion.states`、`RenderArtifact.status ↔ renderArtifact.states`；机器门必须逐集合比较，不能只检查“被引用状态存在”。

### 2.3 与 core 90 隔离

对比基线为 core registry SHA-256 `d1b2c04c7228b7d7ce91b70919eff68c5f048e0c01ccebdbbc354be51a5c1a01`，90 个 ID 与本合同 20 个 ID 的交集必须为空。Book Lab 不得复用 core action ID，不得把 L3 动作悄悄计入 core 90。

## 3. 数据边界

### 3.1 四种状态彼此独立

以下事实互不蕴含：

1. 照片可见；
2. 照片空间位置已确认；
3. Memory 已由贡献者确认；
4. Memory 获得收入某一本书的授权。

内容审核通过、空间主人身份、reviewer 权限、另一本文集的授权、以往同意或沉默都不能替代第 4 项。

### 3.2 L2 与 L3

- L2 SceneNote 保持 `contributor_only`，Book Lab owner、editor、reviewer、worker 和 renderer 均不得读取或聚合它。
- L3 使用独立 `Memory` aggregate。它只能从本合同的问答流程产生，不能把历史 SceneNote 当作已授权输入。
- 若未来迁移 L2 内容，必须让原贡献者看到明确目标书、准确文本和当时版本，并重新执行 `BOOK_MEMORY.AUTHORIZE`；本合同不提供批量迁移捷径。

### 3.3 核心实体

| 实体 | 关键字段 | 约束 |
|---|---|---|
| `PersonalMemory` | `memoryId/photoId/contributorId/status/version/headSubmissionId/confirmedSubmissionId/confirmedSubmissionHash/memoryRevisionId/provenance` | 每次保存新增 immutable `AnswerSubmission`；确认只绑定一个 submission id/hash |
| `AnswerSubmission` | `submissionId/memoryId/revisionId/previousSubmissionId/userText/submissionHash/submittedAt` | append-only；禁止 UPDATE 或模型生成用户回答 |
| `SourceProvenance` | `spaceId/photoId/sceneId/panoramaRevisionId/placementRevisionId/nodeId/sourcePhotosVersion/yawDegrees/capturedAt/authorId/photoContentHash/placementSnapshotHash` | 所列字段全部 required；`nodeId` 的值 nullable，Core 没有 node aggregate 时必须显式为 null，禁止省略 |
| `BookAuthorization` | `grantId/bookId/personalMemoryId/memoryRevisionId/confirmedSubmissionHash/contributorId/creditLabel/audienceScope/status/noticeVersion/noticeHash/titleAuditSnapshot/version` | `contributorId` 是当前贡献者 principal；`creditLabel` 是本人批准的精确署名；title snapshot 写 append-only audit event，但不是授权主键 |
| `BookDraft` | `bookId/spaceId/title/status/version/draftVersionId/pages/grantSetHash` | 可以是空书；可编辑；任意编辑使旧 preview 过期 |
| `AuthorizedMemoryText` | `authorizedMemoryTextId/bookId/versionId/personalMemoryId/memoryRevisionId/confirmedSubmissionId/confirmedSubmissionHash/originalUserText/authorCredit/questionProvenance/grantId/sourceProvenance/snapshotHash` | `authorCredit` 必须逐字复制 active grant 的 contributor-approved `creditLabel`；模型与 renderer 都不得生成、润色或改写原话/署名 |
| `BookPage` | `pageId/index/kind/sourcePhotoId/displayPhotoId/personalMemoryId/memoryRevisionId/confirmedSubmissionId/confirmedSubmissionHash/grantId/authorizedMemoryTextId/sourceProvenance` | Memory 页只能引用冻结的 `AuthorizedMemoryText`；换图不得换来源、原话快照或 grant |
| `BookVersion` | `versionId/ordinal/status/manifestHash/authorizationSnapshotHash/authorizedMemoryTextSnapshotHash/assetSnapshotHash/pageCount` | 冻结 manifest、文本快照与本地资产快照均不可原地修改 |
| `RenderArtifact` | `artifactId/versionId/format/status/contentHash/pageCount` | status 与九态 `renderArtifact` 机器完全相等，不存在概念态 `rendering`；HTML/PDF 独立 hash、同一 manifest |
| `WithdrawalReceipt` | `withdrawalId/scope/readBlockedAt/purgeStatus/affectedBookVersionIds/version` | success 返回前先阻断读取 |

完整字段要求见 coverage 的 `schemaDefinitions`。实现可以增加非敏感内部字段，但不得弱化 required、枚举、长度、页数或 provenance 条件。

## 4. 身份与权限

- `photo-contributor`：经账号或绑定该照片的 receipt session 证明照片所有权；仅能启动/跳过自己的照片访谈。
- `memory-contributor`：经账号或 receipt session 证明 Memory 所有权；仅本人可读草稿、确认、授权与撤回。
- `space-owner`：所有 `/owner/` 管理读取和写入只接受 `currentCoreOwnerBranch`：Account session 与 family 均 active/revalidated，二者 `issuedSessionEpoch == accounts.sessionEpoch`，Space 当前 `spaceLifecycle=active`，且 `accountId == spaces.ownerAccountId`。membership、reviewer、editor 或相邻管理能力均无分支。两个 owner read 每次读取当前 Core 行；七个 owner mutation 必须在同一 serializable 业务事务内 lock-read 并在 Book 写入前复验该分支，漂移时零部分写入并返回 `authorization_changed`。
- `owner-or-current-live-viewer`：读冻结版本时统一计算：`(currentCoreOwnerBranch OR 当前 canonical Core Account view predicate OR 当前 canonical Core external view predicate) AND access control active AND manifest frozen AND version available AND manifest 每条 source grant active 且 audienceScope=current_live_space_viewers AND 每个 frozen source 的当前 Core photos.version/content/deletion/placement eligibility 与 manifest snapshot 完全相符`。每个 source 都必须按 `sourcePhotoId` 重载：`photos.version == sourcePhotosVersion`、`photoContentState=visible`、`deletedAt=null`、content hash 未变、当前 `placementRevisionId` 未变。任何条件失败都在 projection、cache、signed URL 或 artifact lookup 之前统一返回 `book_version_unavailable`；不得泄露具体原因。
- renderer 只接收冻结且已授权的最小 manifest，不获得贡献者草稿、其他 Memory、账号联系方式或核心凭据。

上述 Account/session/family/Space/photo 字段都是 current Core read guards，不加入 Book Lab 八项 CAS，Book Lab 也不递增它们。所有对象查找都先按调用者可见范围约束；禁止用不同错误或响应时间枚举他人的 `photoId/memoryId/bookId/grantId/versionId`。

## 5. Memory 问答

### 5.1 启动条件

`MEMORY.START_QUESTION` 只可在以下条件同时成立时执行：照片主链完成、照片未删除/撤回、空间 L3 开关开启、调用者拥有照片、collection notice 的 version/hash 与服务端当前值一致、`photoContentHash` 未变化。

`MEMORY.OPEN` workspace 返回 `interviewPrecondition`。若 branch=`absent`，`MEMORY.START_QUESTION` 与 `MEMORY.SKIP` 必须提交 `If-None-Match:*`。START 成功时在同一 serializable 事务创建一对一的 `memory_interviews(status=question_queued,version=1) + personal_memories(version=1) + memory_question_jobs(version=1)`；SKIP 成功时创建 `memory_interviews(status=skipped,version=1) + personal_memories(version=1)`，不得创建 question job。两者的 personal memory 初始 `headSubmissionId/confirmedSubmissionId/currentRevisionId` 均为 null；`PersonalMemory.status`只投影`memory_interviews.status`，`personal_memories`不另存第二套状态。若 branch=`present`，必须提交该 workspace 返回的 `If-Match: memory_interviews.version`。发错 branch、重复创建或使用旧值均 `version_conflict` 且零部分写入。

模型只能依据可见事实提出一个问题；不得做人脸身份识别，不得从表情断言内心状态，不得把推断伪装成事实。无法形成合适问题时进入稳定失败或允许跳过，不影响照片的主链状态。

`skipped` 不是终态。贡献者之后可从同一 workspace 再执行 `MEMORY.START_QUESTION`；present branch 仍必须提交最新 `If-Match: memory_interviews.version`，服务端从 `skipped → question_queued`，不得另造第二条访谈。

### 5.2 草稿、追问、确认

- 草稿只对 Memory contributor 可见；空间主人和 reviewer 均不可见。
- `PersonalMemory` 每个读/写结果必须在同一 snapshot 返回 `version=personal_memories.version` 与 `interviewVersion=memory_interviews.version`。凡动作或 worker 改变唯一 `memory_interviews.status`，都必须在同一 serializable 事务比较并推进 `memory_interviews.version`；需要同时改答案 head/确认/撤回字段时还必须比较并推进 `personal_memories.version`，任一旧值均零部分写入。
- `MEMORY.SAVE_ANSWER_DRAFT` 每次执行都 append 一个 immutable `AnswerSubmission`，并通过上述双版本 CAS 同时推进 head 与唯一 interview 状态；历史提交不得 UPDATE。
- v0 的 question processor 只生成主问题或追问。它不得返回用户回答、回答润色或可冒充用户文字的字段。
- `MEMORY.REQUEST_FOLLOWUP`、`MEMORY.CONFIRM` 与 `MEMORY.WITHDRAW` 都必须提交最新 `interviewIfMatchVersion`；CONFIRM 还必须提交 `submissionId + submissionHash`，成功后产生 immutable `memoryRevisionId`。提交或任一版本已变、或不是当前贡献者的版本时返回稳定错误，不得确认旧内容。
- 确认仍不公开，也不授权入书。

## 6. 逐条逐书授权

`BOOK_MEMORY.AUTHORIZE` 必须使用独立、未预勾选、不可与其他同意捆绑的主动动作。确认页至少展示：

- 目标书的当前标题及可识别封面/事件；
- 将收入的精确回答版本、提交时间及其 hash；
- 贡献者本人批准的精确 `creditLabel` 署名、预期读者、对应照片；
- 该授权只覆盖这一段 Memory、这一本书、这个 Memory 版本；
- 冻结前撤回的效果；冻结后撤回会停止旧数字预览/下载并要求新版；
- 已被用户另存的文件与已经制成的纸质物无法远程收回；本轮不提供印刷。

请求绑定 `bookId + personalMemoryId + memoryRevisionId + confirmedSubmissionHash + creditLabel + audienceScope + noticeVersion + noticeHash`。`creditLabel` 由当前贡献者主动批准并冻结进 grant；renderer 的 `AuthorizedMemoryText.authorCredit` 必须逐字复制它，owner/renderer 不得凭空生成署名。其中任一值变化都要求重新展示并确认。viewer audience 只有一个合法 enum：`audienceScope=current_live_space_viewers`；它表示仅向当下仍通过空间查看 predicate 的人提供，不存在 owner-only、任意用户列表、永久链接或自定义范围。当前书名在授权页展示；`BookAuthorization.titleAuditSnapshot` 是 required，并随 grant 写入 append-only authorization event。之后只改书名会追加独立 title audit event，不修改旧 snapshot、不强制重新授权。授权证明以 append-only event 保存 `actor/time/bookId/personalMemoryId/memoryRevisionId/confirmedSubmissionHash/creditLabel/titleAuditSnapshot/audienceScope/noticeVersion/noticeHash/previousEventId`，并给贡献者可读回执。

withdrawn 是单个 `grantId` 的终态。若贡献者以后再次主动授权，必须按当时的 revision、scope 与 notice 新建不同 `grantId`；禁止把旧行从 withdrawn 更新回 active。

授权不得由下列事实推断：照片可见、Memory 已确认、内容审核通过、主人选择了这页、另一书已有 grant、用户曾经使用 Book Lab。

## 7. 撤回

### 7.1 `BOOK_MEMORY.WITHDRAW`

只撤回某 Memory 对某一本书的 grant，不删除 Memory 本身，也不影响其他书的独立 grant。

在 success 返回前，同一事务必须：

1. 写入 withdrawal denial overlay；
2. 将 grant 从 active projection 移除；
3. 推进 `book_contribution_grants.version` 与 `book_version_access_controls.version`，并重新计算 `grantSetHash`；
4. 找出所有包含该 grant 的 draft、preview、frozen version 与 artifact；
5. 将相关 frozen version 标成 `withdrawal_affected` 的外部状态，立即拒绝预览和下载；
6. 入队清理与重排工作。

### 7.2 `MEMORY.WITHDRAW`

撤回 Memory 本体，并原子撤回它对所有书的 grant。事务锁定 `personal_memories.version`、全部受影响 grant/access-control 以及**所有受影响 current `book_draft_versions.version`**；先阻断读取并推进每个 draft 为 stale，再取消问答/追问/预览/渲染作业，清理问题、回答提交、冻结 `AuthorizedMemoryText`、页面派生物、HTML/PDF 与 cache。仅可保留不能还原正文或图片的最小审计事件。

### 7.3 `SOURCE_REVOKED`

当前 Core photo 的 `photos.version`、`photoContentState`、`deletedAt`、content hash 或 current placement eligibility 不再匹配 frozen source snapshot 时，产生幂等 `SOURCE_REVOKED`：受影响 draft 的 `preview_queued/preview_ready/preview_failed → stale`；BookVersion 的 `rendering/available/render_failed → withdrawal_affected`；RenderArtifact 除 `purged` 外任一状态都转/保持 `revoked` 并进入清理。旧 manifest 不改但从此不可读；新版必须重载 Core 来源并排除已撤销 source。

### 7.4 冻结版本

冻结 manifest 不原地修改。撤回通过 denial overlay 让受影响版本立即不可读、不可下载；空间主人执行 `BOOK.START_NEW_VERSION`，只复制仍 active 的 grant，生成新 manifest。旧版本只留非内容历史元数据。清理异步失败时返回的 receipt 必须是 `retrying`，后台持续补偿；不得恢复已阻断的读取。

## 8. API、幂等与 CAS

API 的唯一动作覆盖真源是 `ACTION-API-COVERAGE.book-lab.json`：所有产品 endpoint 均为 canonical `/v2-labs/**`；5 个 query、15 个 mutation 恰好覆盖 20 个动作。`canonicalMutationInventory` 与 action coverage 按 `actionId + method + endpoint` 做 15↔15 双向相等。

另有且仅有两个不增加产品动作的内部 operation；每项必须在 coverage 固化 exact endpoint、request schema、success DTO、stable errors 与 replay class：

- `QUESTION_PROCESSOR`：`internal:book-lab-question-processor`，`QuestionProcessorRequest → QuestionProcessorResult`，处理主问题与追问；只写 job 与问题结果，禁止写用户回答、确认或 grant；
- `BOOK_RENDER_PROCESSOR`：`internal:book-lab-render-processor`，`BookRenderProcessorRequest → BookRenderProcessorResult`，处理 preview 与 frozen HTML/PDF；只读精确 `FrozenBookManifest + AuthorizedMemoryText + FrozenBookAsset`，不得回查 live PersonalMemory/AnswerSubmission/grant/draft，并受 access-control/source denial 约束。

`replayClass` 严格复用 Core §4.5 闭集，且只允许 `not_applicable | ordinary_dto | completed_state`：5 个产品 query 全部为 `not_applicable`，15 个产品 mutation 全部为 `ordinary_dto`，两个 internal processor 全部为 `completed_state`；从属 safe read 也为 `not_applicable`。出现闭集外值时合同门禁必须拒绝。

异步进度与结果必须可恢复：`MEMORY.OPEN` 和 subordinate Memory detail 返回 `(QuestionJobDTO | FollowupJobDTO)[]`，每项嵌套 `AsyncJobRecoveryDTO`。两种 question DTO 在 `ready` 时必须同时返回持久化的 `question + questionHash + modelVersion + AIQuestionProvenance`；`QuestionProcessorResult` 写入完全相同的结果，刷新、重新登录或 worker 重启后仍可读取问题及来源。`BOOK.OPEN_DRAFT` 返回 owner 的 `recoverableRenderJobs[]`。所有恢复项至少含 job id、kind、持久化 status、attempt、canonical status path、下次轮询时间、最后稳定错误和更新时间，不得退回只存在浏览器内的“处理中”。

`MEMORY.OPEN` 还从属一个不增加产品动作的 safe read：`GET /v2-labs/memories/{memoryId}`。它只按当前 contributor scope 返回 `PersonalMemory + submissions + grant receipts + recoverable question jobs + interviewPrecondition`；跨人、撤权、缺失与不可枚举对象统一 `memory_unavailable`。

### 8.1 Canonical 15 mutation inventory

| Canonical mutation | Action |
|---|---|
| `POST /v2-labs/memories/photos/{photoId}/question-jobs` | `MEMORY.START_QUESTION` |
| `POST /v2-labs/memories/photos/{photoId}/skip` | `MEMORY.SKIP` |
| `PUT /v2-labs/memories/{memoryId}/answer-submissions` | `MEMORY.SAVE_ANSWER_DRAFT` |
| `POST /v2-labs/memories/{memoryId}/followup-jobs` | `MEMORY.REQUEST_FOLLOWUP` |
| `POST /v2-labs/memories/{memoryId}/confirmations` | `MEMORY.CONFIRM` |
| `POST /v2-labs/memories/{memoryId}/withdrawals` | `MEMORY.WITHDRAW` |
| `POST /v2-labs/books/{bookId}/contribution-grants/{personalMemoryId}` | `BOOK_MEMORY.AUTHORIZE` |
| `POST /v2-labs/books/{bookId}/contribution-grants/{personalMemoryId}/withdrawals` | `BOOK_MEMORY.WITHDRAW` |
| `POST /v2-labs/owner/spaces/{spaceId}/books` | `BOOK.CREATE` |
| `POST /v2-labs/owner/spaces/{spaceId}/books/{bookId}/render-jobs` | `BOOK.GENERATE_PREVIEW` |
| `PATCH /v2-labs/owner/spaces/{spaceId}/books/{bookId}/title` | `BOOK.EDIT_TITLE` |
| `POST /v2-labs/owner/spaces/{spaceId}/books/{bookId}/draft/pages/{pageId}/removals` | `BOOK.REMOVE_PAGE` |
| `PUT /v2-labs/owner/spaces/{spaceId}/books/{bookId}/draft/pages/{pageId}/photo` | `BOOK.REPLACE_PAGE_PHOTO` |
| `POST /v2-labs/owner/spaces/{spaceId}/books/{bookId}/versions` | `BOOK.FREEZE` |
| `POST /v2-labs/owner/spaces/{spaceId}/books/{bookId}/draft-versions` | `BOOK.START_NEW_VERSION` |

此表必须与 coverage `canonicalMutationInventory` 和 action mutation coverage 按 `actionId+method+endpoint` 双向 15↔15 相等；subordinate read 与两个 internal operation 均不得混入。

所有 15 个 mutation：

- 必须带 `Idempotency-Key`；同 key 同 canonical body 返回第一次提交结果，同 key 不同 body 返回 `idempotency_key_reused`，且 15/15 mutation 的 `stableErrors` 都必须显式包含该值；
- 必须带 coverage 指定的精确条件写前提；已有 aggregate 用 `If-Match`，允许 fresh create 的 START/SKIP 按 workspace absent branch 用 `If-None-Match:*`；缺失、branch 错误或过期统一 `version_conflict` 且零部分写入；
- 涉及多 aggregate 时用同一 serializable transaction 或等价原子提交；
- idempotency receipt 与业务 event 同事务落库；
- worker event 也带唯一 key，重复投递不得重复生成 grant、版本或 artifact。

Book Lab CAS 字典**恰好八项**：`memory_interviews.version`、`memory_question_jobs.version`、`personal_memories.version`、`memory_books.version`、`book_contribution_grants.version`、`book_draft_versions.version`、`book_render_jobs.version`、`book_version_access_controls.version`。不得增加概念 token 或别名。

Core 的 `photos.version` 与 `placement_suggestions.version` 只作为 read-only references 单列；current owner branch 读取的 `accounts.sessionEpoch/account_session_families.version/account_sessions.version/spaces.version` 也只是 Core authorization guards。启动问题、成书、freeze 与成书读取会重读来源；Book Lab 不递增、不声称拥有这些 Core 字段，也不得把它们加入第九项 Book CAS。

## 9. 书稿与冻结

### 9.1 授权投影

书稿只消费以下全部成立的条目：PersonalMemory `confirmed`、grant `active` 且 `audienceScope=current_live_space_viewers`、grant 的 `memoryRevisionId + confirmedSubmissionHash` 与确认记录一致、照片主链仍可用、provenance 完整。实现对精确 grant id+version 集合计算 `grantSetHash`，但它不是 CAS version。

BookDraft DTO 与机器均固定 `empty/editing/preview_queued/preview_ready/preview_failed/stale/freeze_checking/frozen`。`BOOK_MEMORY.AUTHORIZE` 在 serializable 事务中锁定并推进目标 current `book_draft_versions.version`；`BOOK_MEMORY.WITHDRAW` 推进目标 current draft；`MEMORY.WITHDRAW` 推进全部受影响 current draft。对三者，普通 `editing → editing` 以及已有 `stale → stale` 都是显式合法自环，仍必须推进 draft CAS、过滤 projection 并 tombstone 旧 worker input；`freeze_checking` 由并发/CAS 检查拒绝，`frozen` 只能走新版。三者与 `SOURCE_REVOKED` 都让任何 `preview_queued/preview_ready/preview_failed` draft 原子转 stale：立即过滤 current projection，取消或 tombstone queued job，并以 `draftVersionId+grantSetHash+sourceSnapshotHash+accessControlVersion` 丢弃旧 worker 的成功或失败结果。`BOOK.GENERATE_PREVIEW` 可从 stale 重新排队；stale 不得 freeze。所有变更先比较全部 CAS 再提交，禁止并发更新把 stale 覆盖回 ready。

`BOOK.CREATE` 可由 owner 创建空书与空 draft，不要求先有 grant。贡献者的 `MEMORY.OPEN` workspace read model 返回当前 owner 已创建且可供该 Memory 选择的 `eligibleBooks[]`，其中包括尚为空白的书，从而避免“先授权才可建书、先建书才可授权”的死锁。空书不能通过 12–16 页 preview/freeze 条件，但创建本身合法。

### 9.2 编辑

- `BOOK.EDIT_TITLE`：同一 serializable 事务同时比较并推进 `memory_books.version + current book_draft_versions.version`，追加 immutable title audit event，tombstone 旧 preview/worker input；grant 保持有效，任何并发 stale 不得丢失。
- `BOOK.REMOVE_PAGE`：只从当前 draft 移页；不删除照片、Memory 或 grant；推进版本。
- `BOOK.REPLACE_PAGE_PHOTO`：只修改 `displayPhotoId`，目标必须是同一空间、主链仍有效的可展示照片；固定的 `sourcePhotoId/personalMemoryId/memoryRevisionId/confirmedSubmissionHash/grantId/sourceProvenance` 全部不变。页面必须清楚区分“回忆来自哪张照片”与“本页展示哪张照片”。

### 9.3 Freeze

`BOOK.FREEZE` 必须在 serializable 边界内重新验证 current owner branch、`memory_books.version`、`book_draft_versions.version`、`memory_books.title == current book_draft_versions.title`、preview hash、12–16 页、每页 source/display photo 分离、所有 grant active、所有 `personalMemoryId/memoryRevisionId/confirmedSubmissionHash` 未变、精确 grant-set hash 未变、`book_version_access_controls.version` 未变且没有 withdrawal in progress；另逐 source 重载 current Core `photos.version/content/deletion/placement` eligibility。通过后把当前 draft 的精确书名作为 required `FrozenBookManifest.title`，与 authorization snapshot、逐 Memory `AuthorizedMemoryText` 原话快照及 `FrozenBookAsset` 本地资产快照一次性冻结；`manifestHash` 是省略自身 `manifestHash` 字段后的 canonical manifest SHA-256，必须覆盖该书名及全部页面、文本与资产快照。冻结后再改书名只能影响新 draft/version，旧版本的 title 与 manifestHash 均不变。任一不符零创建并返回稳定错误。

Freeze 成功返回的 BookVersion 仍为 `rendering`；页面留在 BL05，并用 `BOOK.OPEN_DRAFT` 的可恢复 render job 展示进度。只有服务端完成 HTML/PDF 校验并将版本置为 `available` 后，才显示/执行 BL06 `BOOK.OPEN_PREVIEW`；不得在 Freeze response 后直接跳到不可读的 BL06。

## 10. HTML → PDF E2E

唯一允许标为“成书完成”的链路：

1. Freeze 写入不可变 `bookId/versionId/title/manifestHash/authorizationSnapshotHash/authorizedMemoryTextSnapshotHash/assetSnapshotHash`；`manifestHash` 覆盖精确冻结书名；每个 `AuthorizedMemoryText` 精确绑定 confirmed submission id/hash、用户原话、署名、AI question provenance、grant 与 Memory revision；
2. renderer 领取冻结 manifest，验证 worker 输入 hash，禁用外网，只读取 `FrozenBookManifest.title + AuthorizedMemoryText + FrozenBookAsset`；renderer 不具备回查 live PersonalMemory/AnswerSubmission/grant/draft 或当前书名的权限；
3. 生成 self-contained、打印样式确定、12–16 页的 canonical HTML；
4. HTML 每一页写入 `pageId`，每个 Memory 块分别写入 `sourcePhotoId/displayPhotoId/sceneId/panoramaRevisionId/placementRevisionId/nodeId(nullable)/yaw/capturedAt/authorId/personalMemoryId/memoryRevisionId/confirmedSubmissionId/confirmedSubmissionHash/grantId/authorizedMemoryTextId`；Core 没有 node aggregate 时 `nodeId` 必须为 null；
5. 对 HTML 运行结构检查、原话 snapshot hash 检查、缺图检查、字体检查与溢出检查；业务服务另在发布前重验 access-control 与 current Core source eligibility，renderer 本身不回查 Memory；
6. 用固定浏览器/字体/纸张/页边距配置打印**完全相同的 HTML bytes**为 PDF；
7. 提取 PDF 页数、顺序和 source markers，与 HTML 对比；
8. HTML/PDF 分别计算 content hash，写入 artifact；
9. 只有两者 `bookId/versionId/manifestHash/authorizationSnapshotHash/authorizedMemoryTextSnapshotHash/assetSnapshotHash/pageCount/orderedPageIds/orderedSourceIds/orderedDisplayPhotoIds` 全相等，且业务服务最终 access-control/source 复查仍通过，版本才进入 `available`；
10. `BOOK.OPEN_PREVIEW` 读取 canonical HTML，`BOOK.DOWNLOAD_PDF` 流式返回对应 PDF；不得用降级图片包或旧文件冒充。

渲染失败、资源缺失、页数不符、HTML/PDF 不一致、中途撤回或 `SOURCE_REVOKED` 均保持不可用。撤回/来源撤销覆盖并清理冻结原话与资产快照；重试仅沿用仍获授权且来源仍有效的冻结输入并创建新的 artifact attempt，不改 manifest。

## 11. 安全、隐私与运行

- HTML 对贡献者文本做上下文安全转义；禁止活动脚本、远程字体、远程图片和用户注入样式。
- PDF metadata 不写账号、手机号、receipt secret、内部路径或模型提示词。
- 预览/下载在服务端先重新计算 current Core owner/Account/external view predicate，再检查闭集 `audienceScope`、denial overlay 与每个 frozen source 的 current Core `photos.version/content/deletion/placement` eligibility，全部通过后才允许 artifact lookup/流式返回；不可把长期 bearer secret 放 URL。
- 预览/下载可在原子快照中读取 `memory_books.version` 以确认 book/space join 一致，但**绝不**将它与冻结时版本比较，也不因只改标题而使旧 frozen version 不可读。
- render worker 最小权限：只能读指定 `FrozenBookManifest/AuthorizedMemoryText/FrozenBookAsset`、render job 与 access-control，写指定 artifact attempt；不能读 live Memory、AnswerSubmission、grant 或 draft，不能改写用户原话。
- 日志、指标、trace 不记录正文、照片内容、grant notice 全文或凭据。
- kill switch 可分别停止新问题、新预览、新 freeze 与 artifact 下载；停止 L3 不影响 core flow。
- 清理作业有可观测重试、死信告警与人工补偿入口；产品 success 以“已阻断读取”为界，不假称后台清理已完成。

## 12. 最小验收叙事

真实样本必须跑通：12–20 张照片、3–5 人；有人跳过后再回来启动问题；模型一次失败后重试且刷新/重登录仍返回完整 question/hash/model/provenance；连续保存两个 append-only 回答提交并确认其中一个；owner 先建空书后 workspace 返回 eligible option；同一 PersonalMemory 对两本书的授权互不影响；withdrawn grant 不原地复活；换 `displayPhotoId` 不改变 `sourcePhotoId`；冻结 `AuthorizedMemoryText` 保留用户原话与署名；冻结前撤回即时重排；冻结后撤回或 source revoke 即时使旧 HTML/PDF 不可读并生成排除对应来源的新版；只改标题不使旧 frozen version 失效；任一书页可回到 source photo/scene/panorama revision/placement revision/yaw/time/author，Core 无 node aggregate 时 nodeId 为 null；最终 HTML/PDF 均为 12–16 页且结构同源。

正式机器门禁归属 `technical/EVIDENCE/c3_contract_gate.py`；正式修订验收归属未来的 `C3-CONTRACT-REVISION-ACCEPTANCE.md`。任何 `/tmp` `BOOK-LAB-ACCEPTANCE.md` 仅供红队审查，不进入本目录正式五文件 semantic source set。
