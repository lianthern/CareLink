# 最新：现场扫码上传 0.5.6（2026-09-24）

沿用原 CloudBase 家庭与相框配对，增加 `/contribute` 免账号照片上传及 owner 生成/关闭二维码。contributor 只有本人照片上传/发送/回执权限，不加入家庭成员、不开放旧相册；原 AI 和摄像头配置保持。详细行为、验证与私有交付位置见 [现场上传交接](memory-frame-demo/docs/ONSITE-UPLOAD-20260924.md)。以下版本与测试记录按日期作为历史保留。

# unseen 记忆相框：当前状态与接手顺序

## 最新：交给具备浏览器权限的 AI 的完整私有包（2026-09-24 09:10 后）

用户确认没有 TRTC 控制凭据，要求尽快打包全部源码、已有访问资料、摄像头程序与端到端流程，由其他 AI 继续完成并实现本机关机后云端可用。权威接手入口是包根目录 `00-START-HERE.md`、`01-NEXT-AI-PROMPT.md` 与 `02-END-TO-END.md`；不要把下面历史缺项或测试数量当成最新状态。

本分支已合并实际在线 0.4.9：SCF 代码压缩包 SHA-256 `18d2dcee5a412b40e2efc7dde72520ff3a92507678edadbae8bb925813ec9e5e`，115 个运行文件与 `ac785c4` 对应源码全部一致。整合 TRTC 桥接后完整 **578/578，零跳过**（并发 2；首次默认高并发遇 Windows 端口冲突失败，不能算通过）。摄像头 Calibration 与账号指南、常开 Windows 迁移文档已合并。

**本轮 TRTC 部署没有成功**：CloudBase CLI 3.8.3 在 `AI_REALTIME_TTS_JSON` 环境值处返回 `Environment.Variables.14.Value` 必须为 string。随后真实 SCF 读回确认原代码 hash、修改时间、原 7 项环境配置均未变，公网仍正常为 0.4.9、实时关闭。缺 TRTC 控制凭据、房间权限及实际免费额度确认；未新增 Timer、未调用 TRTC Start、未购买。交接者需修复 CLI 对 JSON 环境值的处理或用官方配置 API 写入字符串后再验证，不能把此次部署尝试当成功。

云网站/数据库不依赖用户本机常开；USB Link 2 所连 Windows 关机必然停止本地采集，需迁移到常开 Windows。Kevin 不是账户，`fixture01` 为管理员、`fixture02` 为普通家人，密码仅随私有包提供。详见 [Calibration 与账号](memory-frame-demo/docs/LINK2-CALIBRATION-AND-ACCOUNTS.md)。

## TRTC 免费接入继续推进，尚未开通/部署（2026-09-24）

用户现已要求优先免费接入，覆盖下文历史“费用稍后确认”。独立 `codex/trtc-free-integration` 补齐 hy3 受限 SSE 桥接：每通话短令牌、持久单并发/去重/预算、断线/撤权取消；独立传输 worktree 修补锁定 SDK 未传 abort 的缺口，直接持有同身份签名的 HTTPS 请求。独立复审发现并修复插话旧 claim 释放竞态，完整本地 **551/551、零跳过**。真实 TRTC/模型流、真人声音、独立云 Timer 未验；没有部署、开通、领取或付费。

当前账号仍是浏览器 `nodeRepl.fetch request failed`，只读 TRTC 查询 `AuthFailure.UnauthorizedOperation`；不能推断没有免费权益。私有草稿已准备，仍缺 AppID、签名密钥、控制凭据和房间权限确认，开关保持 0。详见 [免费接入与下一步](memory-frame-demo/docs/TRTC-FREE-ACTIVATION.md)、[本轮证据](memory-frame-demo/docs/TRTC-FREE-INTEGRATION-VERIFICATION.json)。上轮 Link 2 现场教程已通过 computer use 发至本人飞书 Max 会话。

## 最新：0.4.8 摄像头与影石时光舱整合已上线（2026-09-24）

Windows Link 2 文本源码/有界上报器、确认后固定照片 AI 首问、影石时光舱分享文字识别/自动导入/分层错误已整合，原0.4.7独立传感器安全边界保持；不覆盖旧MVP前后端。已部署运行代码 `1f65748`（业务 `6ae5e9c`），整合512/512、公开应用+设备536/536均零跳过。三个独立用户任务完成流程、3D及整体审查；无新发布阻塞，首问横屏选择区折叠已补。

真云8资源/驻足幂等与撤销通过；真实视觉模型对既有照片调用1次返回合规首问；两账号各读17条记忆和既有模型4段，内容未变、测试登录退出，无新家庭/媒体/云导入。Kevin绑定只读确认保留，页面离线，硬件未验。新私有 `Kevin-Link2-0.4.8-PRIVATE.zip` 已含原EXE/DLL/Node和启动器（未重编译/未打开摄像头），不能公开。TRTC七配置仍缺，保持关闭。

GitHub公开版已更新到 `9f1d687`，193文件、无私有历史/数据/完整UNSEEN/设备二进制，真实私有值比对零命中；公开ZIP已验证。详见 [最终验收](memory-frame-demo/docs/RELEASE-048-ACCEPTANCE.md)、[怎么用](memory-frame-demo/docs/FAMILY-QUICKSTART.md)、[整体审查](memory-frame-demo/docs/OVERALL-RELEASE-AUDIT.md)。下方“待整合/未部署”与旧测试数量均为对应历史阶段记录，不覆盖本节。

## 影石时光舱导入修复待整合（2026-09-24）

独立 `codex/family-spatial-import` 基于 `e245000` 修复分享文字识别、前后端 URL 规则不一致、寄出后自动导入与分层错误提示。真实授权样例的现有资源主机可用，未扩大白名单。完整本地 460/460 零跳过，真实 Node HTTP + 隔离 LocalStore + Chrome 软件渲染完成家人/相框双端导入观看；既有云 owner/family 各读取 17 条记忆与同一模型 4 段，摘要一致、内容未变，测试登录退出。没有部署/推公开仓库，公网仍为 0.4.7。具体未知失败链接尚待用户提供，不将本地软件渲染当作实体手机/GPU 验收。见 [修复与操作说明](memory-frame-demo/docs/SPATIAL-LINK-ACCEPTANCE.md)。

## 最新：MVP更新包审查（2026-09-24）

新到下载文件`unseen insta360/前后端项目包-MVP.rar`现在包含真实Windows Link 2采集/上报源码、编译程序及旧便携项目，之前“只有两份文档”的记录不再代表下载目录现状。独立`codex/mvp-update-review`审查确认其web/backend是0.4.5-presence-mvp旧基底，不合并、不覆盖当前0.4.7。原上报器6项测试及其连接当前服务的6组实际本地HTTP场景通过，包括双设备定向和轮换撤销；Kevin原绑定保持。前后端独立复审发现共享令牌/可选目标、FIFO32幂等、无短时清理及旧前端生命周期等倒退；唯一新增体验“确认后AI自动读图提问”仅记录可选，不从交付文档推断用户已要求启用。详见[更新包审查](memory-frame-demo/docs/MVP-UPDATE-REVIEW.md)。未运行摄像头二进制、云模型或重新部署；原RAR含私有资料，不能公开上传，现有GitHub包不变。

## 最新：0.4.7 Link 2云驻足邀请与GitHub比赛版（2026-09-23 22:37后）

原CloudBase已部署 **0.4.7，运行代码 `5772f48`**。独立后端/前端worktree经补丁等价检查、总控及独立复审后集成：`presenceReport`、家庭+指定frame会话的传感器令牌、CloudStore CAS幂等/seq/限流/短时清理、定向`state.presenceEvent`与持久去重/忙碌门禁的主动邀请。老人确认才打开固定照片的`MemoryAI.open(id)`，不自动开麦；家人设置可签发、轮换、停用。慢state TTL和迟到录音流清理已修。

整合源码与脱敏公开包各 **454/454通过、零跳过**。实际Node HTTP+隔离LocalStore+Chrome联调、横竖截图及真云7资源/并发幂等/15秒到期/轮换撤销/角色隔离通过。正式云验收前后既有12条记忆摘要一致，无新家庭/媒体/模型调用；临时传感器撤销、测试账号会话退出。实体Link 2、对方uploader与iPad/真人声音仍未本轮验收。15秒是下发期限，冻结期间物理清理限制见接口文档。

用户把发布目标更正为 **GitHub**。已公开 [unseen-memory-frame](https://github.com/maxi-max-dev/unseen-memory-frame)，远端main `3c3b808`，168文件树与本地脱敏快照一致，匿名网页可读。Git HTTPS两次重置后改官方API上传；只有README初始化和完整源码两个新提交，无原历史/私有配置/账号/家庭数据/完整UNSEEN，测试凭据与演示图已替换，真实私有值比对零命中。ZIP位于 `D:/CodexData-20260923/Projects/unseenframe-public-release/unseen-memory-frame-public-0.4.7.zip`。

**现场绑定已完成（2026-09-24）：用户指定 Kevin，并确认每台相框分别绑定外置摄像头。** 已签发`living-room-link2 → Kevin`，真实owner API读回active/targetAvailable有效；检查时Kevin页面离线。令牌最晚到北京时间2026-09-30 18:40:03，真实值仅存本机私有包；不可重复签发覆盖、不可交付已撤销的验收token。下载目录`unseen insta360/Kevin-Link2-PRIVATE-20260924.zip`只含私有连接配置/加载脚本/说明/读回记录，不含对方采集程序。当前每家庭支持8个不同传感器标识；其他摄像头型号或同Windows多摄像头选择仍需采集端适配。实际硬件链路未验收。集成worktree忽略目录保留`.tools/presence-binding.private.json`与`.tools/presence-kevin-verification.json`，不可打印token。详见[多相框连接](memory-frame-demo/docs/EXTERNAL-CAMERA-SETUP.md)、[本轮验收](memory-frame-demo/docs/PRESENCE-RELEASE-ACCEPTANCE.md)。现有公网页面需刷新，TRTC仍关闭，旧UNSEEN和3D安全边界未改。

## 最新：老人平板相框与 AI 语音可靠性0.4.6（2026-09-23 20:05后）

用户确认平板就是老人相框，手机供家人管理并增加预览。已以独立 `codex/voice-reliability`、`codex/elder-frame-ui` 和总控 `codex/elder-voice-integration` worktree 实施，核对补丁等价、独立复审后集成；主线和原公网为 **0.4.6，运行代码 `7e20cd3`**。

相框回到最早原稿的大照片主场景、文字对比叠层、下方中央绿“听原声”/红“说一说”圆按钮，管理收至更多。手机首页增加独立只读预览，不切换真实相框，不写观看或听取回执，原首页/中央加号/我的顺序不变。语音只有目标机器人音频就绪后显示接通，等待可静音/挂断，30秒超时释放；挂断未确认保留原请求，关闭重开可重试，不重复启动。

总控全量 **411/411通过，零跳过**，包含多尺寸真实Headless Chrome（业务/音频替身）和隔离LocalStore的实际Node HTTP+Chrome预览/presence验收；实际查看平板/手机截图。公网10静态文件字节一致、两个既有账号同家庭读取10条记忆、退出失效；无云内容写入/新家庭/模型调用。真人录音、实体平板/手机、供应商语音与GPU仍未验收。

本轮离线复查七项TRTC配置仍缺，实时语音仍关闭；未购买、开通、扩权或新增Timer。后续实际接通仍按TRTC准备文档处理。详见 [本轮验收](memory-frame-demo/docs/ELDER-FRAME-VOICE-ACCEPTANCE.md) 与 [公网证据](memory-frame-demo/docs/ELDER-FRAME-CLOUD-VERIFICATION.json)。之前便携交付包是不可变历史快照，不自动包含本轮代码，用户未要求重打包。

## 最新交付要求：完整打开与私有访问资料（2026-09-23 19:00 后）

用户明确改为本人上传云盘，并授权把现有内容、服务器访问方式和登录资料放入包，之后自行重置登录方式。新增私有可运行包，与前轮只有源码的开发包不同：源码/所有分支历史/完整UNSEEN参考、Windows x64 Node与独立生产依赖、本地内容快照、两个全新预览账号、当前两个线上演示账号及项目 `cloudbaserc.local.json`。私有值与内容只存仓库外交付目录，不进Git，不导出浏览器/CLI登录态或云session。原服务是CloudBase云函数，没有SSH服务器密码。详见 [便携交付](memory-frame-demo/docs/PORTABLE-DELIVERY.md)。

本次真实云导出时已为 **10条消息、2人物、6回执**；3照片/8音频媒体ID去重为10文件，另1个16,324,085字节3D模型。原账号双读一致、导出前后内容摘要一致；没有云内容写入或新建家庭，两个临时会话退出。新本地双账号逐项内容/媒体摘要/模型4段下载恢复通过，种子不含旧云授权记录；新增3项导出恢复测试总控复验通过。既有394项业务回归是上一轮，本轮不冒称重跑。见 [内容导出说明](memory-frame-demo/docs/PORTABLE-CONTENT.md) 及私有包内恢复JSON。

用户问腾讯是否一定要TRTC：**TRTC本身属于腾讯且非强制**。已核实MPS WebSocket STS和“独立ASR + hy3 + 流式TTS”两类路线，不能仅凭接口存在承诺同会话随时打断；当前只是方案说明，未替换provider、开通或购买。见 [腾讯语音方案](memory-frame-demo/docs/TENCENT-VOICE-OPTIONS.md)。公网仍为下方0.4.5，真实语音未启用。

包内 `START-WINDOWS.cmd` 从原始种子复制独立数据，仅绑定本机并清除继承的云/AI配置；本地浏览内容不自动调用线上模型。实际ZIP路径、摘要和解压启动验收结果以交付目录 `DELIVERY-VERIFICATION.json` 为准，收件人按根目录 `00-打开方式.txt` 操作。本次由用户自行上传，不能把本地打包写成已发网盘。

## 最新：0.4.5 聊天入口已上线（2026-09-23 18:46）

用户要求继续多任务完善聊天与 TRTC，并随后明确“稍后处理网盘”。新建两个独立任务/worktree：`codex/ai-chat-ux` 提交 `a36cac1`、`codex/trtc-readiness` 提交 `7508ca3`；经补丁等价核对、总控与独立复审后合入。原腾讯云环境现为 **0.4.5，运行代码 `561c6ec`**。首页家庭名下方有“和 AI 聊天 / 实时语音”，文字与语音界面切换保留临时草稿、照片、原声与最近六轮；未开通语音有明确提示和返回文字入口。

集成后完整回归 **394/394 通过，0 失败、0 跳过**，包含三档独立 headless Chrome 界面检查（API/音频替身）。公网复用既有两账号，8 个新相关静态资源字节一致，文字/识图配置可用、实时语音关闭、退出失效通过；两账号当时均读取9条记忆，本次没有内容写入或新建家庭。模型未重复调用；手机真人录音、TRTC 音频/打断和 Link 2 硬件仍未验收。详见 [0.4.5 验收](memory-frame-demo/docs/REALTIME-045-ACCEPTANCE.md) 和 [云端证据](memory-frame-demo/docs/REALTIME-CLOUD-VERIFICATION.json)。

TRTC 补齐 Flow 02 新模板、显式旧01兼容、关闭服务后旧任务仍可停止、崩溃/迟到任务核对、默认关闭的私有定时清理入口及离线脱敏预检。当前七项实时配置仍缺失；本机只读查 TRTC 应用返回 `AuthFailure.UnauthorizedOperation`，不能据此断言账户没有服务。hy3 是现有文字回答模型，CloudBase SDK 不能直接当 TRTC 公网流式地址；直连管理员 Key 权限和 Accept 请求头仍需核实，受限桥接只完成具体设计。未购买、扩权、开通或新建 Timer，保持实时服务关闭。见 [开通方案](memory-frame-demo/docs/TRTC-SETUP-PLAN.md)、[接入准备](memory-frame-demo/docs/TRTC-READINESS.md)。

夸克 computer-use 通道持续 `nodeRepl.fetch request failed`，没有成功上传；用户已暂缓网盘。本轮最终源码、所有分支历史、参考产品和脱敏证据重新打包，具体路径/校验以交付目录 `DELIVERY-VERIFICATION.json` 与本机忽略的 `.tools/latest-complete-delivery.json` 为准。下方“未部署”和0.4.4等记录均为历史，不覆盖本节。

## 本轮追加：摄像头感知与 AI 实时语音接口（2026-09-23）

用户要求为影石 Link 2 预留检测到人/注视后主动邀请聊天的接口，并另开 worktree 完善 AI 聊天入口与可打断的实时语音。用户已明确：先做好腾讯 TRTC 接口，服务开通与费用稍后确认。现有文字模型仍是 **CloudBase hy3**，识图仍是 MiniMax-M3；hy3 负责生成回答，实时音频是另一个接入层。家人之间的实时电话继续暂缓，不要混同这两项需求。

摄像头在 `codex/camera-presence` 独立 worktree 实施；官方 Link SDK 与人脸目标读取接口已核实，不能沿用“没有 Link SDK”的猜测。默认关闭的本地策略/适配器接口已合入主线，经独立复审并由总控复验 35/35 定向测试。保留人员在场与注视两种能力；没有注视证据不能当作正在看相框。拔线、隐私、后台及迟到启动清理已覆盖；无实际摄像头连接/眼动/录音验收。见 [官方调查](memory-frame-demo/docs/CAMERA-LINK2-RESEARCH.md) 与 [接口说明](memory-frame-demo/docs/CAMERA-INTERFACE.md)。

实时 AI 在 `codex/ai-live-dialogue` 独立 worktree 实施并合入，首页家庭名称下方增加“和 AI 聊天 / 实时语音”卡片；原底部顺序不变。腾讯 TRTC API、懒加载 SDK、会话隔离与取消清理已接入，未开通时禁用开始按钮且不申请麦克风。作者最终 97/97 定向测试，前端独立复审及总控 10 项实际本地 HTTP 检查通过。文字 hy3 可继续使用，但 TRTC 到该账户 hy3 的公网兼容鉴权仍须开通阶段另验。见 [实时 AI 接入说明](memory-frame-demo/docs/AI-REALTIME.md)。

本轮最终实现集成点 `7c531ef`，总控完整回归 **365/365 通过**。首次运行发现原有 3D 测试替身漏接已触发 abort，独立 worktree 仅修测试后完成全量重跑，业务与安全边界未改；完整证据见 [本轮交付验收](memory-frame-demo/docs/CAMERA-REALTIME-ACCEPTANCE.md)。本轮没有部署，下方公网 0.4.4 记录继续有效。打包脚本 `memory-frame-demo/scripts/package-handoff.py` 包含全部跟踪源码、项目所有分支 Git bundle、完整 UNSEEN 参考源码、测试证据和逐文件校验，并实际克隆恢复 Git；排除私有配置、密钥、认证会话、本地数据与依赖目录。

## 上一轮公网部署记录（2026-09-23 17:34）

原腾讯云环境 **0.4.4 已部署，运行代码 51686dc**。字体、日常多轮聊天、单张/最多4张照片交流、主动录音转写/朗读、文字/照片/原声共享留言与站内联系提醒已集成。文字使用 CloudBase hy3，识图已接入用户提供的 MiniMax-M3 API；无需升级云套餐，角色/环境/旧 UNSEEN 服务均未改动。用户暂缓真正的双向语音通话，页面仍不加载 RTC，服务默认关闭，不再开发中继。

MiniMax 修复提交 71f0232 → f7c164b → 473b862 已总控与独立复审、补丁等价核对并集成（9c9f801、ae1e2b9、bdea0f6）。最终相关本地 **28/28** 通过；原296项全回归属于前次集成，不伪称本次重跑。官方M3暂不支持json_object，现只接收唯一 unseen_reply 数据函数的完整严格参数，没有执行器或自然语言回退。真实单图、双图、普通看图 action:null 与明确照片留言候选都已有证据；初次格式及空候选问题和修复记录保留在 MINIMAX-CLOUD-VERIFICATION.json。

公网最终五次调用全部成功：hy3普通/多轮/留言候选，MiniMax单/双图。61个静态文件字节一致，既有双账号同家庭读取、退出后失效通过，原8条记忆不变，未上传/发送/确认/联系真人或创建家庭。公网现有照片是微小测试图，只证明通路；有内容的颜色形状图由真实供应商接口另测，真实家庭照片质量仍交用户验收。真人录音、扬声器、浏览器双方点击和GPU未验，不以HTTP或替身测试代替。

用户填写的 Key 仅在忽略的 .tools/minimax.local.env 与两个工作目录的 cloudbaserc.local.json 服务端私有配置中；不打印/提交，部署包仅取server目录。公网私有配置路径均404。AI_VISION三项已经配置，普通AI_MODEL=hy3保持。无须再次索取Key、旧服务器SSH或开新任务/worktree。main与总控同步，字体/AI两个实施任务已完成；本次报告后停止ai自动跟进，等待用户验收反馈。

完整勾选清单见 [Demo总验收清单](memory-frame-demo/docs/DEMO-ACCEPTANCE.md)，云证据见 [AI-CLOUD-VERIFICATION.json](memory-frame-demo/docs/AI-CLOUD-VERIFICATION.json) 和 [MINIMAX-CLOUD-VERIFICATION.json](memory-frame-demo/docs/MINIMAX-CLOUD-VERIFICATION.json)。

## 历史交付范围（2026-09-23，后续更新见顶部）

用户已明确暂缓实时语音通话，保留聊天、识图、录音转写与朗读、文字/照片/原声留言及站内提醒，优先跑通 Demo 供用户验收。Cloudflare/TURN 开发停止，作者未提交草稿已私存忽略目录并恢复干净 0f09271；无需用户提供账号、中继或费用决定。字体与 AI 固定 0f09271 正合并至总控，所有聊天 R1–R5 与 RTC 生命周期审查已闭环。当前页面不加载实时通话模块，AI 联系建议只提供由用户明确选择的站内提醒；原 RTC 代码休眠且服务默认关闭。集成全量本地 296 项通过，范围收敛独立 UI 20 项通过，联系 UI 6 项通过。实际云部署、模型与用户实机状态以 [总验收清单](memory-frame-demo/docs/DEMO-ACCEPTANCE.md) 为准；下方旧通话待办不再阻挡本次交付。


更新时间：2026-09-23 15:14 后（北京时间）。本文件包含打包后的历史分页续作结果；14:54 交付包仍是 `fc5f373` 的不可变历史快照，不包含本次新增代码。

## 用户目标与约定

产品名为 **unseen 记忆相框**；按照最早 Demo 的首页、中央加号发送、我的顺序继续完善，并结合完整 UNSEEN 产品理解。总控负责任务拆分、协议、审查、合并、部署和验收，实现分独立 worktree，3D 单独分工。本轮用户要求集中项目文件并开新任务继续，让其他 agent 能直接接手。

旧 UNSEEN 服务不在修改范围。原稿位于 `reference/memory-frame-v4.html`；产品映射见 `memory-frame-demo/docs/PRODUCT-REFERENCE.md`。

## 当前可用状态

- 家人端：https://memory-frame-demo-d7djiee0702b6c.service.tcloudbase.com/family
- 相框端：https://memory-frame-demo-d7djiee0702b6c.service.tcloudbase.com/frame
- 公网当前版本 **0.4.2**，运行代码提交 `65e08dd0640ef0fc85d6fc33471e062a31edf829`，已完成历史分页。2026-09-23 15:14 复用既有两账号完成公网 HTTP 复验；后续提交只更新交接文档。
- `package.json` 中的 `0.1.0` 是尚未同步的包元数据；不要据此判定公网版本回退。运行健康响应和最新部署记录为 0.4.2。
- 两个实际公网账号 `fixture01`（owner）和 `fixture02`（family），同属“unseen 双账号测试家庭”。账号使用清单与开通码放在本人私有包；现有单元测试含相同的简单演示账号密码样例，完整源码和历史会保留它，不能把测试凭据视为保密的生产凭据。部署开通码与认证会话不放共享包或 Git。部署码不是日常登录的必填项：它用于创建新家庭，登录已有账号不需要。
- 腾讯云 CLI 设备授权已由用户完成；本人部署配置在忽略的 `memory-frame-demo/cloudbaserc.local.json`。换电脑需要重新登录自己的 CLI，不能把认证目录当源码复制。
- **飞书说明已发送完成**：2026-09-23 14:33，通过 computer-use 操作本机飞书客户端，已在用户自己的 Max 会话发送“unseen 记忆相框｜使用说明（v0.4.1）”，包含入口、账号、步骤和边界。旧“未发送”的排障记录已过时；没有新要求不重复发。

## 已完成与证据边界

本次分页集成完整回归 **129 项通过，0 失败，0 跳过**（前次基线 114 项）。新增稳定服务端分页与首页/人物/时间轴历史加载，保留最近 150 条旧协议；已加载旧记录的编辑、删除和媒体地址随轮询刷新。两个独立实现 worktree 经总控及只读独立复审后集成，未发现可复现缺陷。

本次公网两账号各以每页 2 条、共 4 页遍历同一家庭的 8 条记忆，验证去重、共享历史、刷新、非法参数拒绝、退出后失效，以及 9 个静态资源与本地字节一致。超过 150 条的覆盖由本轮隔离本地 HTTP 测试验证；没有为云端凑测试数量新增记忆或家庭。详情见 [历史分页验收](memory-frame-demo/docs/HISTORY-ACCEPTANCE.md) 和脱敏 [云端核验记录](memory-frame-demo/docs/HISTORY-CLOUD-VERIFICATION.json)。

前次 0.4.1 真云验收涵盖两账号注册与登录、错误密码拒绝、退出失效、再次登录恢复家庭、照片和静音 WAV 原字节传输、相框配对回执回复、成员编辑、人物与权限限制；这些项目本轮没有全部重做。

3D 已在真云导入用户指定 Insta360 模型。owner / family / frame 三种身份分别完整下载，均为 4 段、16,324,085 字节，SHA-256 为 `93224a51c0385145c747f3d7033907678f20ac3f251f30f7c61a61f1ffb0a630`。实际查看器共用下载模块也验证了地址刷新一次、分段读取和整文件摘要。公网 9 个核心静态资源与本地字节一致。

云函数响应上限对应的解决方案已完成：服务端声明 4 MiB 段长，每段重新验证账号会话；查看器验证 206、Content-Range、长度和整文件摘要。不要退回一次获取大模型，也不要使用绕过会话撤销的 COS 直签地址。重复导入 ready 模型会复用，验收中的 292 ms 是复用结果，不是首次导入耗时。

上述主要是 HTTP、单元测试及在 Node 中运行实际下载模块的证据，**不是本轮新版浏览器完整点击、手机真人录音或移动 GPU 验收**。历史 Mac ASR+hy3 和前轮 Windows 3D 画面验证不能替代当前新版验收。

详细记录：

1. `memory-frame-demo/docs/WINDOWS-ACCEPTANCE.md`
2. `memory-frame-demo/DEPLOYMENT.md`
3. `memory-frame-demo/docs/ACCOUNTS.md`
4. 接手包 `evidence/` 中原始脱敏云验收结果、回归日志和 worktree 审计

## 用户最新追加的两个独立任务

2026-09-23 15:20 后，用户要求新开两个任务/worktree。两者已从 `180b4df` 开始，当前总控继续负责审查集成与统一部署：

1. **统一字体**：用户确认使用思源黑体等清晰规整的无衬线字体。实际任务 ID `01a0cd23-0cde-7862-b2bb-e17e9a8f4a68`，`codex/self-hosted-sans` 位于 `D:/ChatGPTData/Worktrees/cf13/unseenframe`。提交 `23be167` 已经总控和只读独立复审，无阻塞问题，补丁等价检查为新补丁后已合入总控分支。采用官方 Source Han Sans SC 的 OFL 衍生字体 Unseen Sans，保留完整许可与上游字符集，移除旧手写字体；45 个同源按需分片共 15.2 MiB，当前 UI 分片 240.7 KiB。子任务报告相关测试 28/28、本地 HTTP 检查 53 项通过；总控重验全部字节摘要、CSS 范围与 44,853 个字符，独立复审另核对官方许可原字节、字体内部名称及 33 个变体序列。浏览器连接仍失败，等待与 AI 统一部署。创建卡片 ID 不能当 threadId 使用；后续直接用上述实际 ID。
2. **扩展 AI 与家人联系**：任务“扩展 unseen AI语音识图与家人联系”，实际任务 ID `01a0cd23-0d3b-7653-9d78-e84a69062b4f`。`codex/ai-conversation` 位于 `D:/ChatGPTData/Worktrees/5f31/unseenframe`。用户明确要求 AI 对话回答复用之前 UNSEEN，再增加语音和识图；“呼叫”已澄清为呼叫/联系家庭成员，不是唤醒 AI。澄清已发至该任务。分别验证呼叫提醒、接听、真实通话，不主动替用户呼叫他人。

AI 初步源码审计找到 `services/book-lab/providers` 与 `infra/integration/minimax-private-worker` 的照片事实/追问流程；这不表示旧参考已完成真实 MiniMax 或实时语音验收。现阶段不得把配置接口、浏览器朗读、模拟信令称作实际云视觉/TTS/家人通话成功。新增权限或费用需求先给出可审查结果和具体差额，不自动购买或扩大权限。

2026-09-23 15:39 总控只读调用原环境 `DescribeAIModels`、`DescribeManagedAIModelList` 和 `DescribeBillingInfo`。统一 `cloudbase` 内置组状态为 1，托管目录包含 `hy3` 和多模态 `kimi-k2.6`；当前个人版预付费、资源点抵扣、状态正常、未开启超额按量。配置返回的 `Models=[]` 不能单独解释为模型已开通或未开通；目录也不等于真实调用成功或剩余额度。脱敏快照见 [AI-MODEL-PREFLIGHT.json](memory-frame-demo/docs/AI-MODEL-PREFLIGHT.json)。本次未修改模型开关、套餐、执行角色，真实调用及余量仍待核验；原始响应含敏感字段，仅保存在忽略的 `.tools/`，不可打印或提交。

用户随后明确：必须保留无照片的日常多轮聊天，也支持多张照片共同交流；AI 可理解给家人文字/原声/照片留言及呼叫的意图，补齐对象与内容，二次确认后才执行。该范围已发给 AI 任务，实施与验收约定见 [AI-CONVERSATION-SCOPE.md](memory-frame-demo/docs/AI-CONVERSATION-SCOPE.md)。当前倾向文字/意图用既有 CloudBase `hy3`，视觉优先核验 `kimi-k2.6`；不能拿不支持图片的 `hy3` 做识图，也不应把即将下线的 `glm-5v-turbo` 作为新增默认。模型支持、账号可用性和真实调用成功需分别核实。

AI 聊天阶段已提交 `6855234`，作者报告完整回归 202/202 通过。总控审查发现 5 项边界问题，尚未合入或部署；修复 `94377e1` 中原声改文字、同名确认卡已独立复验通过，错误后的编辑/幂等查询仍未闭环，已要求继续修。后端修复 `bb94ac8`（联系旧成员快照、部分多图重试）已独立复验通过，剩余媒体、账号、目标、过期与取消边界仍有效。详见 [AI-REVIEW.md](memory-frame-demo/docs/AI-REVIEW.md)，不能仅凭原回归通过忽略新增复现。旧 UNSEEN 源码没有可复用 WebRTC/拨号链路；同一 AI 任务继续用独立提交补实际音频通话（受控信令、媒体连接、权限与资源释放），配置不满足时关闭。中继/临时凭据与双设备跨网验收仍需单独核实，不能把提醒作为用户全部呼叫需求完成。原子任务不部署、不替真人呼叫、不购买中继或新建环境。

16:04 后只读补查计费周期、资源点用量与套餐目录：周期 2026-09-23 08:34:02 至 2026-10-23 23:59:59，个人版目录每周期 40,000 资源点；截至 09-23 接口报告套餐内消耗 4.04、资源包抵扣与按量用量均为 0。按返回值估算余量 39,995.96，可能有记账延迟，不承诺实时余额或免费模型额度。未改模型开关、未购买或启用超额；记录附在 `AI-MODEL-PREFLIGHT.json` 的 `creditCheck`。

总控准备了 `memory-frame-demo/scripts/check-ai-deployment.mjs`，目前仅语法检查，未运行公网核验。该脚本只接受原环境/既有双账号，动作白名单不含发送、上传、确认或联系；最多 5 次真实模型调用，覆盖普通多轮、留言候选及单/双图输入，比较部署资源字节，并撤销自身测试会话。仅在代码审查/必要测试/部署完成且模型配置核实后运行；真实回答与错误仅保存到忽略的 `.tools/ai-model-verification-private.json`，共享结果不含会话或照片地址。默认期望下一版 0.4.3，可显式提供版本参数；这不表示公网已更新。

16:16 续作：AI 已提交 R3 修复 `5fff171` 和独立通话实现 `d6e81b9`，作者回归 272 项。R3 主路径 46 项独立复验通过，但又复现 Get 返回未开始后迟到 Confirm 部分发送、Cancel 返回 started=true 仍被前端复制成新候选的 P1 竞态，已发作者继续修；详情见 `AI-REVIEW.md`。两位独立复审正分别审查固定 `d6e81b9` 的通话后端与前端；尚未集成/部署。公网核验脚本已补通话静态资源与默认关闭断言，仍未真实运行。部署配置的白名单读取确认仅有既有 `AI_MODEL=hy3`，无视觉模型或通话配置；后续只在原环境设置已选定视觉模型，不开启未知中继、不扩角色、不购买。

16:22 更新覆盖上段待修状态：`e4a76ef` 已修复迟到确认竞态，原复现、额外网络丢响应和恢复路径及相关 57 项独立复验通过，聊天阶段 R1–R5 均闭环。RTC 后端固定 25 项独立复验无阻塞；前端虽原 24 项通过，新增复现发现后台迟到 AI 确认重新建立开麦意图、接听提交但响应被 abort 后关闭遗留 accepted、AI 确认中关闭遗留服务器呼叫，共三项已发作者另提修复。详见 `AI-REVIEW.md` 通话阶段表。尚未合入 AI 或部署，真实模型、中继和设备证据仍未完成。

16:29 用户确认没有现成 TURN，并要求先给接入与费用方案；这不授权购买或新建资源。方案已写入 `docs/FAMILY-CALL-OPTIONS.md`，核对腾讯云官方目录的 35 元/月（100 GB）与 40 元/月（不限流量）中继服务器候选，实际库存、域名/证书和容量待核实。真实通话仍默认关闭；不因此阻止修复审查通过后的字体/AI 原环境统一部署。作者正在完善三项通话生命周期修复，报告真实业务模块联动测试已覆盖 abort 后无回包、提前取消及重试；尚待固定提交独立复验。

16:36 后用户明确优先可用的免费替代。已核验 Cloudflare 官方 TURN 每月 1,000 GB 免费（与 SFU 共用）、超出 0.05 美元/GB，产品页说明可不绑信用卡开始；国内连接到境外节点，仍须手机跨网实测。方案已改为免费托管优先，不购买服务器或启用付费。已安排原 AI 任务在新独立提交适配 Cloudflare 服务端短期凭据，保留既有家庭/设备权限与 relay 边界、不换信令、不新建任务；用户是否已有 Cloudflare 账号的文字问题待回复，不索取聊天密钥。当前 RTC 修复已交 `0f09271`（在 `e4a76ef` 后），作者相关 140 项通过；总控两位独立复审正核验原三个生命周期复现及 exact-device CAS/稳定请求 ID。AI 仍未集成，公网未部署，真实 Cloudflare/模型调用未验。

总控已启用当前任务的自动跟进（名称“跟进记忆相框字体与AI扩展”，ID `ai`），每 5 分钟检查一次，正常无变化保持安静，完成审查集成后停用。用户可直接在两个新任务继续补充需求。历史分页已经完成，不再作为待实现项。

## 仍待真实验收与后续项目

1. **真实浏览器双账号全流程**：登录切换、家庭邀请与相框配对、首页/加号/我的、照片发送、草稿恢复、错误提示、退出与重新进入，并补历史加载的真实点击。本任务已经读取旧排障状态并实际复验：浏览器枚举 `nodeRepl.fetch request failed`，IAB 打开家人端 30 秒超时；没有完成页面点击。连接恢复后优先继续，不重复安装或重建相同任务。
2. **真手机录音和 AI 整理**：录音授权、原声播放、ASR、hy3 整理、人工修订、相框回复闭环；静音 WAV 传输不能代替此项。
3. **移动端 3D**：手机与微信中的实际 SOG 渲染、旋转缩放、双指、关闭再开、释放资源、弱网和长时稳定性。独立 worktree 处理；不编造设备或真实用户证据。
4. **正式公测后续**：密码恢复/改密码、备份导出/彻底删除、监控和容量验证目前未实现；按真实产品约束另行设计，不把当前 Demo 称为生产完备。完整历史分页已完成并部署，不重复实现。

打包时的审计确认：原 10 个开发 worktree 全部干净；8 个分支无待合入补丁，另外 `cloud-spatial-fix` 的 4 个提交与 `spatial-cloud-stream` 的 1 个提交均已通过补丁等价核对。历史成果已纳入主线，不重复开发或合并。

本次另外使用 `codex/history-api`（`100ab06`）和 `codex/history-ui`（`53c6a0c`），均已合入 `codex/history-integration`；合并前 `git cherry` 确认是新补丁。原 3D 实现与安全边界未修改。原 `localhost:8787` 进程和数据目录未替换，本轮测试使用独立临时目录与端口；主目录代码同步后，本地旧进程仍需按开发入口重启才采用新版服务端。

## 接手资料的位置

主项目：`D:\CodexData-20260923\Projects\unseenframe`。原 worktree：相邻 `unseenframe-worktrees` 目录。新接手包放在相邻 `unseenframe-handoff` 目录中；每次交付使用独立日期目录，不移动或覆盖原仓库。

共享包包括当前 Git 跟踪的项目文件、所有本项目分支的可恢复 Git bundle、原始 Demo、完整 UNSEEN 参考源码、验收摘要、校验清单和恢复说明。依赖目录需根据锁文件重新安装，PlayCanvas 自托管资源和应用素材已包含。

完整参考源码来自本地 `D:\CodexData-20260923\Projects\UNSEEN2.0\unseen-github`，GitHub 为 https://github.com/maxi-max-dev/unseen 。快照 HEAD `43a0cda3ab1a3960b20d8b1d40729fe850fd7e45`，远端参考主线 `8d366ec22d82f49ea4da36b84a77c6bf15aa77a7`。共享包附该完整跟踪快照，不复制参考项目的私有配置、依赖或工作目录状态。

本人私有包单独保存部署配置、测试账号说明、本地 Demo 数据快照及未纳入 Git 的诊断脚本。它是普通 ZIP，不是加密保险箱；只交给受信任且确实需要账号/部署资料的 agent。共享源码中的单元测试样例与现有测试凭据相同，私有包隔离不表示这些演示凭据已保密。云数据库和云媒体未做全量导出，开发包不是云数据备份。

## 本机任务衔接

- 本轮总控任务：`01a0cbf5-bf4d-7f93-a396-644171a2c098`。
- 已有排障任务“排查浏览器连接并发送飞书使用入口”：`01a0cc9f-f418-7de3-9a06-79820ad39116`。只读取必要进展，飞书发送已在总控完成。
- 新任务从打包后的主线独立 worktree 开始，先验证接手信息，再按上面优先级继续。用户已有部署与测试授权无需仅因换任务重复确认；对新的真实破坏性动作按具体影响判断。

最新用户决定：接入已有视觉模型 API，保持云套餐不变。已用异步问题请求服务商/模型及这台电脑现有配置文件路径（若旧UNSEEN，说明哪份），不在聊天索取Key。信息未到前不猜服务商、不读无关凭据、不启用CloudBase升级；当前可验收Demo和清单已交付，识图继续作为未完成项。
