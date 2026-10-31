# AI 实时语音接口与聊天入口

**2026-09-24 状态补充**：`0.5.5` 第 07 轮已通过真实供应商的合成语音短通话：SDK 入房/推流、机器人非零音轨、受限 hy3 桥接、回答语义、最终 Stop 与测试 session 撤销均有证据。合成问题的机器人实收音频另行转写为“3+4=7。”；这不是实体麦克风、扬声器、真人听说或插话验收。独立清理 Event 和每分钟 Timer 已部署且手动 Invoke 成功，Timer 自然触发和真实过期任务 Stop 仍待验证。详细证据见 [短通话实测](TRTC-SHORT-CALL-PROBE.md)，各轮发布与历史结果见 [接手与验收记录](TAKEOVER-20260924.md)。

历史记录（2026-09-23）：用户当时明确选择“先做好腾讯 TRTC 接口，开通和费用稍后确认”。当次提交完成默认关闭的 TRTC 接入代码与聊天入口，没有开通服务、购买资源、部署新版或调用真实语音供应商。

同日后续的公网 CloudBase 鉴权核对、Flow 02 配置、离线预检与独立清理入口见 [TRTC-READINESS.md](TRTC-READINESS.md)。该补充在 2026-09-23 尚未开通或部署；下方原97项仍是此前证据，不能用于判断当前部署状态。

## 在哪里聊天

登录家人端后，首页家庭名称下方有“有话想说，和 AI 聊聊”卡片；点击 **和 AI 聊天** 可直接打字、选择家庭照片、录音转成文字。顶部 **AI 聊天** 也可打开同一窗口。相框端在家庭名称下方提供同样的卡片。底部仍为“首页 / 中央加号 / 我的”，没有改变原始 Demo 顺序。

卡片的 **实时语音** 和文字聊天窗口的 **想直接说话？打开实时语音** 可进入独立语音窗口。代码默认关闭；配置未启用时，窗口会说明状态，开始按钮不可用，麦克风不请求权限。2026-09-24 原环境已开启实时配置，但配置可用不代表真实通话验收通过；可以点 **先用文字和 AI 聊聊** 返回已经可用的聊天。

实时路径的设计行为（真人完整通话仍待验）：用户点击 **开始实时对话** 并允许麦克风，即可边听边说；服务端采用自动 VAD 打断。**麦克风静音** 停止发送麦克风输入，**挂断** 立即停用本机音轨并结束会话。关闭、切后台、离开、退出账号会停止。每次最多 10 分钟；不会自动重连或恢复开麦。该流程不会加载摄像头、发送家庭留言或执行联系家人操作。

## hy3 与 TRTC 的分工

既有普通聊天仍使用 CloudBase `AI_MODEL=hy3`，照片交流仍使用独立的 MiniMax-M3 配置，录音转写及设备朗读保持原有行为。没有把文字模型换成 TRTC，也没有把识图密钥用于语音。

TRTC 是实时音频传输、语音识别、打断与语音输出的一层，`LLMConfig` 指定其背后回答问题的模型。适配器使用官方 OpenAI 兼容配置结构；示例保留模型名 `hy3`，但必须另行核验该账户可供 TRTC 服务端访问的 CloudBase HTTPS 兼容接口及鉴权方式。现有 `store.app.ai()` 是内部 SDK 调用对象，不是可以直接交给 TRTC 的公网 URL 或 API Key。2026-09-23 准备阶段尚未验证 TRTC → CloudBase hy3 鉴权；`0.5.5` 第 07 轮已验证通过本服务受限桥接的链路，不代表 CloudBase 管理员 API Key 直连方案也已验证。

既有“录一段 → 转写 → 手动发送 → 设备朗读”仍属于分步输入输出。新增实时路径直接通过 TRTC Web SDK 上传麦克风音轨、接收机器人音频，不调用 `aiTranscribe` 或 `speechSynthesis.speak`。`InterruptSpeechDuration=300` 是服务端触发打断的持续人声阈值，不代表实测端到端延迟为 300 ms。真人延迟与打断质量仍待测试。

## 服务端配置（代码默认关闭，原环境已配置启用）

参考 [AI-REALTIME.env.example](AI-REALTIME.env.example)。模板不包含凭据，也不会被应用自动读取。

| 变量 | 用途 |
| --- | --- |
| `AI_REALTIME_ENABLED` | 默认 `0`；只有明确开通、费用确认、配置齐全后才设 `1` |
| `AI_REALTIME_PROVIDER` | 当前实现 `tencent-trtc` |
| `AI_REALTIME_TRTC_APP_ID` | 独立确认的 TRTC 应用 SDKAppID |
| `AI_REALTIME_TRTC_SDK_SECRET` | 服务端签发短期 UserSig / PrivateMapKey 的应用密钥 |
| `AI_REALTIME_TRTC_SECRET_ID` / `AI_REALTIME_TRTC_SECRET_KEY` | 调用 TRTC 云 API 的显式私有凭据；不继承 CloudBase 函数凭据 |
| `AI_REALTIME_TRTC_TOKEN` | 使用临时云凭据时的 token，可选 |
| `AI_REALTIME_TRTC_REGION` | 默认 `ap-shanghai`，只允许官方接口支持的地域 |
| `AI_REALTIME_TRTC_ROOM_AUTH` | 仅在该应用的房间权限密钥已启用并核验后设 `1`，避免普通 UserSig 跨房使用 |
| `AI_REALTIME_LLM_JSON` | 仅接收 `LLMType=openai`、`Model`、`APIKey`、公开 HTTPS `APIUrl`；服务端固定 streaming、上下文与安全提示词 |
| `AI_REALTIME_TTS_JSON` | 本实现只接 TRTC Flow：`TTSType=flow`，新配置使用 `Model=flow_02_turbo`，显式旧 `flow_01_turbo` 兼容，已确认音色 `VoiceId` |

服务端固定 `History=6`、`HistoryMode=1`，使供应商按已播放内容维护上下文；不把文字窗口、家庭图片或记忆记录自动带入语音。供应商端需要处理声音；本应用不保存录音/字幕，不能据此推断供应商的数据保留政策。

开通阶段需分别确认：TRTC 应用、AI 实时对话/STT 权限、Flow 音色、LLM 服务端调用权限、云 API 权限、房间权限密钥及实际预算。腾讯官方说明该能力涉及音频通话、AI 实时对话与语音转文字费用，LLM/TTS 还须按所选服务核验；不能当作现有 CloudBase 套餐自动包含。2026-09-23 准备阶段没有进行控制台开关操作；2026-09-24 已核对专用应用、体验权益和房间权限，并配置经用户确认的 API-only 控制账号，具体证据见 [接手记录](TAKEOVER-20260924.md)。

本机配置应放入忽略的 `.tools/ai-realtime.local.env` 或现有私有部署配置，不能提交、打入共享源码或在聊天中发送密钥。Node 20.19+/24 可使用 `node --env-file=.tools/ai-realtime.local.env server/server.js`，并给该本地服务使用独立数据目录。原环境已按本次授权更新私有变量并读回；旧 UNSEEN 服务不在修改范围。更换凭据后须重启进程，适配器不会热读新的密钥。

## 已实现的接口与保护

都使用现有 `POST /api` 与 `Authorization: Bearer <家庭会话>`。公共健康接口不返回凭据。

| action | 数据 | 行为 |
| --- | --- | --- |
| `aiRealtimeCapabilities` | `{}` | 返回 enabled/provider/reason、10 分钟上限、10 秒 heartbeat 与 configuration-only 证据等级，不开麦或调用供应商 |
| `aiRealtimeStart` | `{requestId}` | 在家庭持久记录中原子预留，然后调用 StartAIConversation；只有当前未取消会话返回临时连接参数 |
| `aiRealtimeStatus` | `{requestId}` | 仅该登录会话可读取/续租；超时、停止及旧租约按持久状态处理 |
| `aiRealtimeStop` | `{requestId}` | 可在 start 前先取消；仅操作所属登录会话，通过 StopAIConversation 清理，幂等 |

`requestId` 是每次手动开始时生成的稳定 UUID，客户端不能指定供应商模型、房间、用户或任务 ID。实际 TRTC 房间及人/机器人 ID 为服务端随机值；任务 ID 仅保存在私有服务端记录。浏览器仅收到 60 秒 UserSig 与仅可创建/进入指定房间、收发音频的 PrivateMapKey（权限位 15），不允许视频/屏幕共享。机器人签名含同一房间的权限 userbuf；第 07 轮已在现有高级房间权限配置下入房并收到指定机器人的音轨。

每个登录会话 24 小时窗口最多 20 个 requestId，家庭记录最多 60 个，取消 tombstone 同样计数；同家庭最多 2 段、同登录会话最多 1 段未结束。并发由现有存储 CAS 保证。重复 Start 不重新创建任务，也不重新下发连接凭据。

关闭或取消不会只 abort HTTP：它还发送同一个 requestId 的 Stop。迟到的 Start 成功先保存 TaskId，再检查取消、租约和重新鉴权，随后停止，不能重新激活。Start 超时按官方 SessionId 查询，若暂未查到则至少保留 60 秒 `stopping` 待确认，阻止同会话重新创建；停止失败不把“未确认”说成成功。租约每 10 秒由前端更新，45 秒未更新后下次房间操作会清理，包含其他 owner 的过期项。账号退出/移除也直接调用清理。

前端原生轨道在关闭/挂断时同步 stop，随后销毁 SDK，并取消超时及续租。麦克风授权、SDK 加载、进房、推流和服务端响应的每个 await 后都再次核对当前窗口/身份/前台状态；迟到资源被释放。仅订阅本次机器人音频；出错、断开、播放被浏览器阻止时结束，不偷偷重试或恢复。SDK 日志与 SDK 上传日志关闭。

### 仍须实机与运行环境验证的边界

- 专用 TRTC 应用、房间权限与控制凭据已核对配置；`enabled=true` 仍只说明私有配置通过校验，不保证额度、鉴权、网络或模型调用成功。
- 独立 `unseen-ai-realtime-cleanup` 已部署为私有 Event，入口 `ai-realtime-cleanup.main`，无公网 HTTP 触发器，每分钟 Timer 为 `OPEN`。`0.5.2` 更新读回确认 25 个源文件摘要匹配、角色/环境/触发器未变，该次更新未 Invoke（`.tools/cleanup-live-20260924/update-052-receipt.private.json`）。03:02:14Z 手动 Invoke 成功，`enabled=true / ok=true`，扫描 1 条、尝试及结束均为 0；这不证明实际停止过期任务（`.tools/cloud-cleanup-receipt.private.json`）。
- 历史准备版本使用 `MaxIdleTime=30`，真实 Start 后发现该参数被拒；当前默认已改为 `60` 秒，`0.5.5` 第 07 轮已以该配置成功启动并完成合成语音短通话。此次没有验证无流等待超时停止。正常网页离开会停止推流；前端 10 分钟上限、45 秒业务租约和供应商无流等待参数均不等于硬计费上限。Timer 自然触发与真实过期 Task Stop 仍未验证，CLS 未开启，旧 `GetFunctionLogs` 不可用；已部署配置和手动 Invoke 不能替代这些运行证据。详见 [清理状态](TRTC-READINESS.md)。
- 取消响应丢失时 UI 明确显示停止未确认，后续同家庭请求可继续核对持久状态。禁止把暂时查不到任务当作从未产生用量的证明。
- CSP 仅配置完整时增加 SDK 实际使用的腾讯连接域；本轮没有放宽到任意 `https:` 或 `wss:`。默认关闭仍只允许同源业务连接。第 07 轮真实隔离 Chrome 已完成生产语音链路；用户设备上的自动播放、扬声器与手机回声消除仍待验证。
- 本版没有实时字幕、相机自动开麦、后台推送或家庭真人通话；这些不影响本轮准备腾讯实时语音接入接口的范围。摄像头事件如需联动只能打开此面板，仍需用户手动开始麦克风。

## 验证与依赖

2026-09-24 `0.5.5` 第 07 轮：`.tools/realtime-probe-run-07/realtime-call-report.json` 的 `transportPassed=true`，一次 Start、SDK 入房/推流与机器人非零音轨成功，最终 Stop 确认、测试 session 已撤销，家庭内容未写入。`cloud-evidence.json` 的 `complete=true`：1 轮、15 输入字符、7 输出字符，active claim 已释放、记录 `ended`，供应商 Describe 确认 `TaskNotExist`。`semantic-evidence.private.json` 通过独立 ASR 对实收机器人测试音频转写，得到“3+4=7。”，`passed=true`。这是合成音轨输入下的真实供应商及回答语义验收；原报告 `uiButtonVerified=false`、未使用实体设备、录音没有标记为人工听审，不能写成真人硬件或插话通过。

2026-09-23 最终定向 **97 项通过，0 失败**：`ai-realtime.test.js`、`ai-realtime-ui.test.js`、`ai-conversation-ui.test.js`、`ai-conversation.test.js`、`ai-voice.test.js`。覆盖默认关闭/授权、短期签名参数、适配器请求结构、跨实例幂等、取消先于开始、迟到开始、撤权、启动超时核对、跨 owner 清理、媒体授权/进房/推流迟到释放、断网、到期、静音与既有聊天回归。UI 采用 DOM/SDK/media 替身测试；不等于浏览器点击或真人录音。总控的真实浏览器工具本轮连接超时；无浏览器点击、真人麦克风/扬声器、供应商真实通话或延迟测量证据。

服务端依赖固定 `tencentcloud-sdk-nodejs-trtc@4.1.315`、`tls-sig-api-v2@1.0.2`；锁文件保留。浏览器 SDK `trtc-sdk-v5@5.19.2` 与 `webrtc-adapter@9.0.4`、`sdp@3.2.2` 打成自包含 ESM，同源保存在 `public/vendor/trtc-5.19.2.mjs`，只有明确开始才 import。原始 ESM 有浏览器无法直接解析的裸依赖；0.5.1 已修复，并用真实 Chrome 在原 CSP 下验证导入/创建/销毁，零 Start。构建锁文件、完整依赖许可及重建方法见 [TRTC NOTICE](../server/public/vendor/trtc-NOTICE.md)。没有加载额外音视频增强插件。

- ESM 文件 SHA-256：`176355e53c7b10b8bf5e435d9f98dd98efd49309430bccc9d6183e447799a59e`
- npm 原 tarball SHA-256：`4b394e396cb4782414040db392d36bc868c0fdaed0b29feadfbcb916969364c6`
- 包声明 ISC，作者与原始 package.json、SDK 内原有 notices 均保留；上游 npm 包未提供单独 LICENSE，不另造上游版权正文。Git 对原 SDK 设置 `-text` 保持原字节。

## 官方依据

查阅日期：2026-09-23。实际 API 以当前接口文档和固定版本 SDK 类型声明为准，旧教程中 `APIBaseUrl` 与当前 API 的 `APIUrl` 不混用。

- [TRTC AI 功能与费用组成](https://cloud.tencent.com/document/product/647/110584)
- [StartAIConversation 接口](https://cloud.tencent.com/document/api/647/108514)
- [AgentConfig 自动打断与上下文参数](https://cloud.tencent.com/document/api/647/44055)
- [StopAIConversation 接口](https://cloud.tencent.com/document/api/647/108513)
- [实现 AI 对话、兼容 LLM 配置说明](https://cloud.tencent.com/document/product/647/108901)
- [TRTC Web SDK v5](https://web.sdk.qcloud.com/trtc/webrtc/v5/doc/zh-cn/index.html)
- [TRTC Web SDK API](https://web.sdk.qcloud.com/trtc/webrtc/doc/zh-cn/TRTC.html)
- [短期签名与房间权限官方实现](https://github.com/tencentyun/tls-sig-api-v2-node)
- [CloudBase hy3 与独立语音链路示例](https://docs.cloudbase.net/recipes/add-voice-chatbot-deepgram-cloudbase-ai)

调研过的 [腾讯 MPS WebSocket STS](https://cloud.tencent.com/document/product/862/135068) 文档只列 Finish 上行控制，未给出本场景所需的取消旧回复协议；本次未实现第二套 STS 适配器，也不把它当作已验证的打断通道。


最终清理同步：2026-09-24T03:14:03Z，Event 已同步 0.5.5 后端源码，25 个源文件摘要一致、角色/环境/Timer 不变；手动 Invoke 的 scanned=1，其余计数为 0，ok=true。固定回执 `.tools/cleanup-live-20260924/update-055-receipt.private.json`；自然 Timer 和过期 Stop 仍未验证。
