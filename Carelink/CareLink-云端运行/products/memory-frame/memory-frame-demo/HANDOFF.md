# 2026-09-24 最新私有交接说明

当前 `codex/trtc-free-integration` 已整合实际在线 **0.4.9** 和 TRTC 受限桥接，完整本地 **578/578、零跳过**。TRTC 部署尝试因 CloudBase CLI 的 `AI_REALTIME_TTS_JSON` 环境值类型错误失败；随后官方 SCF 和公网读回确认原 0.4.9 及原配置未变，实时仍关闭。AppID/签名密钥已在本地私有草稿；控制凭据、免费额度、房间权限、云 Timer 及真人通话未完成。以根目录 `AGENT-HANDOFF.md` 最新段和完整私有包 `00-START-HERE.md` 为准；下面的 551/0.4.8 与旧缺项为历史。用户现要求交给具有浏览器权限的 AI 接手，并实现云服务不依赖原电脑常开。

# unseen 记忆相框：总控交接

**2026-09-24 TRTC 免费接入准备，未部署**：用户现要求免费优先接入。独立 `codex/trtc-free-integration` 新增模型受限SSE桥接和可取消的hy3传输；551/551本地全回归零跳过，独立复审的插话竞态已修。凭据/免费权益/房间权限仍缺，真实云流、TRTC音频和Timer未验，实时开关仍关闭。当前浏览器枚举fetch失败、CLI只读查询无权限；不自动购买或声称已领取。见 [落地与剩余步骤](docs/TRTC-FREE-ACTIVATION.md)、[本轮证据](docs/TRTC-FREE-INTEGRATION-VERIFICATION.json)。

**最新0.4.8已整合部署（2026-09-24）**：Windows设备源码、确认后照片首问与影石作品自动导入已完成，独立流程/3D/整体审查完成。应用512/512、公开含设备536/536零跳过；真云8资源、事件鉴权与幂等、一次真实视觉首问及既有双账号17记忆/模型4段只读复核通过。Kevin绑定保留但现场硬件未验；TRTC仍关闭。GitHub更新9f1d687，193文件脱敏。详见 [最终验收](docs/RELEASE-048-ACCEPTANCE.md)。下方待整合/旧版本状态为历史。

**2026-09-24时光舱链接修复待整合**：独立 `codex/family-spatial-import` 从 `e245000` 修复链接规则一致性、复制文字识别、自动导入与错误分层。未新增域名/上传格式/视频重建，摄像头及AI模块未改。460/460回归；真实HTTP+独立LocalStore+Chrome软件渲染双端通过；原云两账号只读17条记忆和模型4段摘要一致。未部署或公开推送，待总控审查合入。见 [验收与操作](docs/SPATIAL-LINK-ACCEPTANCE.md)。

**2026-09-24更新包审查**：下载目录新增`前后端项目包-MVP.rar`，已包含Windows上报器源码/采集程序；不再是仅两份文档。独立worktree与前后端复审判定不合并旧0.4.5-presence-mvp网页/后端，保留0.4.7与Kevin绑定。原上报器6项测试+当前服务6组实际本地HTTP兼容场景通过，无云端/硬件/模型调用；原RAR含私有资料不公开。唯一增量“确认后AI自动读图提问”待产品选择，未启用。详见[更新包审查](docs/MVP-UPDATE-REVIEW.md)。

**最新0.4.7 / `5772f48`已在原环境部署（2026-09-23 22:37后）**。Link 2 presenceReport、家庭+指定相框令牌、CloudStore短时CAS事件及前端确认邀请完成，家人设置可管理令牌。整合和公开包各454/454零跳过，实际本地HTTP+Chrome/截图与真云并发/到期/撤销/隔离通过，原12条记忆未变。2026-09-24用户指定Kevin并确认每台相框分别绑定外置摄像头；已签发`living-room-link2`、云端读回绑定有效、私有包放下载目录，检查时Kevin页面离线。Windows/uploader/iPad现场未本轮验收；临时验收token已撤销。见[多相框连接](docs/EXTERNAL-CAMERA-SETUP.md)。已发布脱敏 [GitHub比赛版](https://github.com/maxi-max-dev/unseen-memory-frame)，168文件，无原历史/完整UNSEEN。详见 [本轮验收与后续](docs/PRESENCE-RELEASE-ACCEPTANCE.md) 和根目录最新交接。

**最新0.4.6 / `7e20cd3`已在原环境上线（2026-09-23 20:05后）**。用户确认平板就是老人相框：大照片、文字叠层、绿听原声/红说一说大圆按钮，管理入口收起；手机增加独立只读预览，原导航不变。语音等待真实机器人音频就绪、挂断未确认同请求重试已完善，TRTC配置仍缺并保持关闭。独立复审及总控411/411全量通过；公网10静态资源、双账号读取10条记忆及退出失效通过，无云内容写入/新家庭/模型调用。证据区分实际本地HTTP+Chrome、浏览器替身与公网HTTP，未完成真人声音/实体设备/GPU。见 [本轮验收](docs/ELDER-FRAME-VOICE-ACCEPTANCE.md)。

**最新私有交付（2026-09-23 19:00后）**：用户自行发云盘，明确授权包内附现有内容、服务器访问与登录资料，后续再重置。Windows便携包含运行时/生产依赖/本地预览入口；当前10条消息、2人物、6回执、照片/音频与1模型已真实导出及双账号本地恢复。新增导出工具3/3通过，原394全量为前轮证据。实际访问值与内容放仓库外包内，不复制CLI/browser会话。见 [便携交付](docs/PORTABLE-DELIVERY.md)、[内容范围](docs/PORTABLE-CONTENT.md)。TRTC非强制，腾讯MPS和独立ASR/TTS路线已核实成文，实际provider保持；见 [腾讯语音方案](docs/TENCENT-VOICE-OPTIONS.md)。

**最新状态（2026-09-23 18:46）：0.4.5 / `561c6ec` 已在原环境部署。** 两个新 worktree 的聊天体验与 TRTC 接入准备已完成独立复审并集成；全量394项全部通过，8静态资源与既有双账号公网HTTP通过。首页家庭名下方“和 AI 聊天”是普通聊天入口，“实时语音”当前显示尚未开通；hy3/MiniMax配置保留。TRTC清理/预检/Flow02接口已备好，真实权益、鉴权、流式链路、私有Timer与真人打断尚未验收，不自动购买或启用。夸克按用户要求稍后处理，未上传。见 [最新验收](docs/REALTIME-045-ACCEPTANCE.md)、[接入准备](docs/TRTC-READINESS.md)。下方0.4.4等记录为历史。

本轮追加 Link 2 摄像头感知接口与独立 worktree 的 AI 实时语音接入，最新进展见根目录 `AGENT-HANDOFF.md` 顶部及 [本轮验收](docs/CAMERA-REALTIME-ACCEPTANCE.md)。用户确认腾讯 TRTC 先留接口，服务开通/费用以后再定；继续使用 hy3 作为文字回答模型，家人实时电话仍暂缓。新接口默认关闭，下面 0.4.4 的云端与真人验收记录不自动覆盖本轮改动。

**当前公网 0.4.4 / 51686dc 已上线**。文字模型 CloudBase hy3，视觉模型用户自有 MiniMax-M3；真实普通/多轮/留言候选及单/双图五项全过，61静态文件和既有双账号HTTP通过，原8条记忆未变。MiniMax最终28项定向测试通过。字体、录音转写/朗读、共享文字/照片/原声留言与站内提醒保持；真正实时语音电话按用户要求暂缓。Key已配置于服务端忽略文件，无须再索取或寻找旧服务器；未升级套餐/扩角色/新建环境。完整[勾选验收清单](docs/DEMO-ACCEPTANCE.md)区分实现、真实接口与用户实机证据，以下旧状态只作历史。

更新：2026-09-23。主目录 `D:\CodexData-20260923\Projects\unseenframe`。

新任务先读根目录 [当前状态与接手顺序](../AGENT-HANDOFF.md)。2026-09-23 14:33 已通过本机飞书客户端将 v0.4.1 使用说明发给用户本人；浏览器连接排障与这次发送是否完成是两件事。

## 当前要求与状态

- 用户指定产品名 **unseen 记忆相框**。按最早 Demo 首页、中央＋、我的顺序完善，参考完整 UNSEEN 产品；不修改旧 UNSEEN 服务。
- 本对话负责监督调度、审查合并、验收部署；实现分独立 `codex/` worktree。3D、家庭状态、Demo 顺序、账号前后端已合入主线。
- 用户已在本机完成腾讯云授权；当前版本 `0.4.2` 已部署到既有公网链接，运行代码 `65e08dd`。无需再次要求同一次部署授权。
- 公网已创建 `fixture01`（owner）与 `fixture02`（family），同属“unseen 双账号测试家庭”。密码在交付消息；私有上下文位于忽略的 `.tools/`，不可打印或提交。
- 双账号注册登录、照片/静音 WAV 字节传输、相框回复/回执、人物年份修订、权限拒绝、退出和重新登录已通过真实公网 HTTP 验收。
- 本次完整历史分页已集成，129 项完整回归全过；公网复用两账号各 4 页遍历原有 8 条记忆，9 个静态资源字节一致。见 [分页验收](docs/HISTORY-ACCEPTANCE.md) 和 [协议](docs/MESSAGE-HISTORY.md)。
- 前次本机与真云 3D 导入、三个身份私有分段读取及查看器下载模块摘要验证成功；本轮未重做，既有安全边界保持不变。历史证据见 [部署记录](DEPLOYMENT.md)。
- 已复查浏览器：枚举 fetch 失败、IAB 30 秒超时；双账号真实点击仍待验。不能把接口验收表述为点击 UI 验收；手机真人录音、微信、触控/GPU、三网和长时稳定性未验收。

## 入口与部署

- [家人端](https://memory-frame-demo-d7djiee0702b6c.service.tcloudbase.com/family) / [相框端](https://memory-frame-demo-d7djiee0702b6c.service.tcloudbase.com/frame)
- 环境 `memory-frame-demo-d7djiee0702b6c`，上海 `ap-shanghai`；HTTP 函数 `memory-frame-demo`，Nodejs20.19 / 512MB / 150 秒 / 9000 端口 / `/` 网关。
- 数据库、存储保持 `ADMINONLY`，应用校验账号、家庭、角色与会话。保留 `MemoryFrameDemoRuntime`、`AI_MODEL=hy3`；不增加权限或购买资源。
- 本人配置已恢复到忽略文件 `cloudbaserc.local.json`。用 `node scripts/deploy.mjs --update` 更新固定环境；不泄露开通码、CLI 凭据、会话与签名 URL。
- 套餐与 ASR 免费额度在部署记录中是首次开通时证据，本轮没有重新核查实时账单。

## 协议与兼容

- 家人账号可重复登录，单账号绑定单家庭；新建需开通码，加入需有效 family 邀请，相框免密码配对。旧 create/join 会话和家庭数据保留。
- 密码随机盐异步 scrypt，持久 CAS 限流、用户名唯一、失败恢复；移除账号禁用其全部会话。没有密码恢复/改密码、重新启用或多家庭切换，详见 [ACCOUNTS.md](docs/ACCOUNTS.md)。
- 腾讯云首次提示页可能丢 fragment，该测试域名使用 24 小时 query 邀请，读取后清除；其他域名仍用 fragment。会话 7 天。
- 图片/音频单文件 3MB，WAV 16kHz/PCM16/单声道/最长 60 秒；每家庭 300 条消息/500 文件，初始最近 150 条，家人端可分页加载更早历史。总家庭配额 10，旧创建和注册共用；不要反复新建验收家庭。
- 照片/原声地址有效 15 分钟，撤销后已签发 URL 可能有效至到期；3D 每次另查会话/账号，撤销立即失效。
- 发送稳定 ID 保证重试不重复落库，回复绑定开始录音时的记忆，AI 有 5 分钟租约且不覆盖未保存人工修订。
- 草稿按家庭+账号隔离，旧免账号键保留。UI 不储存密码，服务端退出成功才清会话。
- 3D 独立通道有界下载、SOG 校验、每家庭最多 10 个/合计 256MB 模型、持久租约及清理。外链精确域名限制与 DNS 固定防 SSRF，不为兼容宽泛放行私网。
- 云函数响应限制 6MB；模型须按 `spatialAsset.chunkBytes`（4 MiB）分段 GET，每段校验权限。大模型直接 GET 返回 413，禁止退回单请求下载或绕过撤销的直签 URL。查看器共用 `spatial-download.mjs`，每段 206/范围/长度和整文件摘要均校验。
- 查看器 ready 后才报告正在观看，状态按期限本地衰减；关闭释放 WebGL、worker、对象 URL 和网络。

## 参考与历史

完整参考位于 `D:\CodexData-20260923\Projects\UNSEEN2.0\unseen-github`，来源 `https://github.com/maxi-max-dev/unseen`；分析与原稿顺序映射见 [PRODUCT-REFERENCE.md](docs/PRODUCT-REFERENCE.md)。原稿 `reference/memory-frame-v4.html` 不变。

Windows 包恢复基线 `3d8580f`，59 项文件已校验；Mac 早期基线 `a405ff4`。前后端与 AI 旧成果均已合并，不重复实施；独立 worktree 保留。

Mac 历史曾真实调用 ASR+hy3 并验证浏览器收发，Windows 前轮曾渲染实际 3D；不能替代本轮账号 UI/手机验收。最新测试数量、范围和真云结果见验收记录。
