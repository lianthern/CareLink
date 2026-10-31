# AI 对话、多图、语音与确认行动：实现交接

最新交付范围：实时语音通话暂缓；当前 Demo 不加载 family-call.js/css，AI contact 候选须明确改用站内提醒。普通/多图聊天、语音输入朗读与共享留言继续交付。


2026-09-23，独立分支 `codex/ai-conversation`，起点 `180b4df`。本文件描述已实现代码及验证边界，不表示已部署或云模型已开通。用户完整范围以总控的 `AI-CONVERSATION-SCOPE.md` 为准。阶段一聊天/确认行动与阶段二 WebRTC 代码分开提交；真实家庭通话的网络、设备与可闻验收仍待完成。

## 最新补充：确认恢复与家庭音频通话

- 确认卡“修改 / 查询结果”先读取持久状态。尚未执行的候选先取消旧编号并刷新成员，再新建确认卡；已完成、处理中或失败后开始过执行的行动保留原编号查询/续发。后端返回 `started`，过期也不能把已开始的行动复制重发。目标移除、过期、响应丢失与查询失败由真实 `createActions` + `LocalStore` 联动前端 VM 测试覆盖，独立修复提交为 `5fff171`。
- 后续补齐 Get 与 Cancel 之间的迟到确认竞态：必须以 Cancel 返回的最新 `started/completed/results/status` 再判定；取消前曾开始执行，即使尚无持久结果，也不能清空原编号并重新发送。新增真实后端联动测试分别覆盖首图成功后第二图失败、首项失败尚无副作用两种交错；相关 UI 与行动模块 57 项定向测试通过。
- 已实现独立的 `callCapabilities/State/Start/CancelStart/Accept/Reject/End/Ice/Signal`、双方设备绑定、音频 WebRTC 前端、受控 TURN 短期凭据、候选边界与取消清理。管理员配置与完整验收边界见 [FAMILY-CALL.md](FAMILY-CALL.md)。默认关闭，无公共中继默认值。
- AI 联系候选必须明确选择“语音呼叫”或“站内联系提醒”；真实模式不可用会明确提示，不自动改发提醒。确认前不呼叫，确认后只加入返回的同一次呼叫；响铃/接听/信令成功均不显示为已接通。
- 关闭未决发起使用稳定请求编号取消，服务端取消记录阻止迟到发起。恢复旧通话必须再次明确继续，关闭窗口或后台刷新不会自动开麦。取消失败保留待确认状态；客户端释放不等于立即撤销已签发的 TURN 凭据。
- RTC 复审补充：原接听设备可终止“接听落库但响应丢失”的通话；AI 确认前保存服务端 `callRequestId`，关闭/隐藏后按原令牌取消，迟到结果不能在后台恢复开麦意图。结束队列有界重试、只认明确终态或经鉴权证实归属其他设备的拒接意图；有未确认结束时禁止新呼叫。相关 5 份测试共 140 项通过，包含真实持久后端与前端 VM 联动的永不返回响应/迟到发起/断网恢复场景；独立复验确认多设备旧拒接不会挂断另一设备或遗留阻塞队列，仍无真实设备音频证据。
- `d6e81b9` 完整本地回归 `node --test test/*.test.js`：**272 项通过、0 失败、0 跳过**。包含后端通话 23 项、通话前端 VM 24 项，以及本地 HTTP 的确认呼叫、信令隔离、未决取消接线。其后迟到确认修复只运行上述必要定向测试；下面 202 项是阶段一首次提交的历史结果。

## 参考审计与复用

只读旧源码：`D:/CodexData-20260923/Projects/unseenframe-handoff/20260923-145417/agent-pack/reference-product/unseen-full`，并核查旧项目目录。没有读私钥/环境文件，也未修改旧服务、资源或 DNS。

- `services/book-lab/src/providers/minimax-question-provider.mjs`：默认文字 `MiniMax-M2`、可选视觉 `MiniMax-M3`。已知照片事实用于温和追问；缺事实且无 `resolveImage` 时弃权。代码说明旧 Core 在这一层未接真实图片 resolver，不能把它视为已联通识图。
- `infra/integration/minimax-private-worker/minimax-vision-analyzer.mjs`：Base64 图片、可见事实、图中文字不当指令、有界追问、不猜人物身份/关系、看不清则弃权。其 README 明确 worker 测试没有调用真实 MiniMax 账号。
- `services/api/src/private-ai-job-queue.mjs`、`infra/integration/book-lab/private-ai-composition.mjs`、`apps/web/src/extensions/book-lab.js`：旧照片访谈的异步任务、上下文和入口组织。
- 本次复用上述对话策略、严格 JSON 校验、照片真实输入和有界历史的组织方式，适配相框的 Node HTTP/CAS 存储与原生 UI；没有复制旧队列、凭据或整套服务。普通聊天不要求选照片。
- 实际复用相框 `ai.js` 的腾讯 ASR/PCM WAV 校验、CloudBase SDK、`accounts.allowed`、家庭会话、私有媒体读取及稳定 ID 的共享消息发送。
- 旧项目未发现可复用的家庭 WebRTC/电话链路。站内联系实现详见 `FAMILY-CONTACT.md`；新建独立音频链路详见 `FAMILY-CALL.md`。

## 实际功能

家人端和相框端新增“和 AI 聊聊”“联系家人”，记忆详情可进入聊天。首页/中央加号/我的顺序未变；公共字体和 3D 未改。局部 CSS 继承全局字体。

聊天支持最近 6 轮历史；最多 4 张当前家庭记忆照片，可显示、增删并保留聊天。只有勾选读取照片才发送真实图片给视觉模型，未选或未勾选时明确是文字对话。每张仍受既有 3 MB 上限限制，合计 8 MB；这是应用预算，不是供应商最大值，真实云大图上限仍需验。客户端只提交记忆 ID；服务端重新查家庭、删除状态、文件类型、长度与摘要，再转 Base64。不接收外链/云签名 URL。

用户主动录音，独立捕获最长 60 秒并转换为 16 kHz 单声道 PCM16 WAV。ASR 转写先放到输入框供修订，不直接执行行动。原声仅在本次窗口预览，选择作为留言附件并准备卡片时才通过既有 upload 保存。朗读为浏览器/设备 `speechSynthesis`，不是已开通腾讯云 TTS。关闭、停止、后台、退出与晚权限回包均有释放/代际检查。

模型仅输出严格 JSON `{answer,action}`；候选含 `kind/targetHint/text/usePhotos/useVoice`，不接受 `confirmed` 或模型虚构 target ID。身份和亲属关系不会从人脸推断；仅引用用户材料中已确认的人物标签。JSON 是应用协议，不依赖原生 tools/function calling 自动执行。

留言候选须用户从真实家庭成员选择对象，检查完整文字、照片、原声试听及“家庭成员均可见”，再点击确认。准备与修改不发送；编辑前先查询执行状态，未执行旧确认先取消，再准备新确认卡；服务端绑定 session/账号/家庭/actionId/version，并逐项重验目标与媒体。多照片各生成一个共享记忆，文字与原声放第一项。固定发送 ID 与持久租约使重复确认/失败重试幂等，部分已发送不能由取消候选撤回。原相框普通 `send` 限制保留，只有模块内部确认适配器可发共享留言，HTTP 请求体无绕过标志。

模型提出“呼叫”时，先读取通话配置与浏览器支持，展示“语音呼叫”及可明确选择的“站内联系提醒”；再展示真实对象、联系方式和二次确认。通话默认不可用，管理员配置受控中继后才可发起。提醒的请求/确认收到/婉拒/结束闭环只在双方页面内展示，不表示音频接通。真实音频通话代码属于独立阶段二提交，实际双设备媒体仍待验收。

## API 与配置

所有 action 经现有 `/api` 鉴权。新增：

| action | 用途 |
| --- | --- |
| `aiCapabilities` | 仅配置检查；`verification=configuration-only`，不证明模型权限或额度 |
| `aiChat` | `{text,history,messageIds,readPhoto}`；返回 `{answer,action,imageUsed,imageCount,source:'ai',confirmed:false}` |
| `aiTranscribe` | 临时 WAV Base64 转写，返回 `{text}`，不创建记忆或原声文件 |
| `aiActionPrepare/Get/Confirm/Cancel` | 有版本的候选、复读、显式确认、取消；确认只接受 actionId/version |
| `contactState/Request/Respond/End` | 双方可见站内联系，详见 `FAMILY-CONTACT.md` |

最小模型配置：保持 `AI_MODEL=hy3`，独立设置 `AI_VISION_MODEL=kimi-k2.6`，均使用现有 `app.ai().createModel('cloudbase')`。这不会自动开启模型、购买资源或扩大执行角色权限。视觉配置缺失、权限错误、模型拒绝、额度不足、超时、无效输出均返回明确错误；禁止失败后假装以纯文字完成识图。可选兼容端点必须显式配置各自 `AI_BASE_URL/AI_API_KEY/AI_MODEL` 或 `AI_VISION_BASE_URL/AI_VISION_API_KEY/AI_VISION_MODEL`，不混用半份配置，不跟随重定向。

每家庭对话/临时 ASR 合计最多 8 请求/分钟、60 请求/UTC 日，CAS 持久化；请求失败或取消不返还预算。上游已接受的请求可能继续计费。55 秒服务端截止与65秒前端等待均有状态恢复。当前锁定 `@cloudbase/ai@2.30.0` 的 `ReactProps.abortSignal` 注释仍标 TODO，腾讯 ASR SDK 本次亦无可验证的取消能力：本地等待会停止并丢弃晚回包，不能承诺撤销供应商已接受的处理或费用。兼容 fetch 接口会实际传 AbortSignal。

## 官方文档核验与费用/权限

核验日 2026-09-23：

- [CloudBase 多模态与多图输入](https://docs.cloudbase.net/ai/model/multimodal)：`hy3` 为纯文字；`kimi-k2.6` 支持图片 URL/Base64，多张图片放同一 content 数组。本实现只用服务端合法图片字节。当前账号权限、真实输出、额度和大图请求限制仍须总控实际调用验证。
- [CloudBase 模型目录](https://docs.cloudbase.net/en/ai/available-models) 与总控只读环境核验：目录含 `hy3/kimi-k2.6`，不等于账号实际调用已成功。总控提供的计费预检在其 `AI-MODEL-PREFLIGHT.json`，本任务未操作云配置。
- [MiniMax 官方兼容接口](https://platform.minimax.cn/docs/api-reference/text-openai-api)：当前 M3 支持图片 content block，未支持音频输入；本次不采用或假定旧 MiniMax 账户已可用。
- [腾讯 ASR 计费](https://cloud.tencent.com/document/product/1093/35686)：一句话识别按调用次数，实时语音按对应时长产品计费。既有免费额度/资源包剩余未在本任务验证，不自动开后付费。
- [腾讯 TTS 购买方式](https://cloud.tencent.com/document/product/1073/78325)：云 TTS 要单独开通，免费包有有效期且用尽可能转后付费；本次没有开通或调用。浏览器朗读不经本应用的腾讯 TTS 接口，音色/联网行为由设备和浏览器实现决定。
- [MDN 麦克风权限](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia) 与 [SpeechSynthesis](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis)：安全上下文、用户授权和实际设备支持需要独立验收。不使用后台唤醒词或浏览器 SpeechRecognition 隐式常听。

## 验证与尚未完成

按两个锁文件安装依赖，无依赖版本变化。本地隔离数据目录运行服务/API 和 Node VM 测试，未复用公网家庭配额。新增覆盖模型消息格式/双图真实字节、无配置与摘要失败、跨家庭、退出/删除中途拒绝、限额持久化、ASR输入、确认与部分失败幂等、联系状态、UI上下文/过期回包、麦克风与音频释放。完整回归 `node --test test/*.test.js`：202 项通过、0 失败、0 跳过（原基线129项，本阶段新增73项）。

这些是本地 HTTP、单元与实际前端源码的 VM 控制器证据。没有真实云 hy3 新协议/kimi-k2.6 调用，没有真实浏览器点击、真人麦克风或设备朗读验收，没有向真人发起联系。没有部署或合入 main。

总控下一步需在现有授权范围验证 `hy3` JSON输出与 `kimi-k2.6` 单/多图实际结果、余额和模型开关，再进行浏览器/真手机验证。家庭通话的 SDP/ICE、受控 TURN 配置契约及短期凭据已实现；仍需管理员提供真实受控中继并核实网络、证书与费用，再由明确授权的双方做 Wi-Fi/蜂窝跨网与双向可闻验收。后台来电额外需要 Push/Service Worker 或目标平台能力。本次默认关闭，未启用公共中继、购买或扩大云权限。
