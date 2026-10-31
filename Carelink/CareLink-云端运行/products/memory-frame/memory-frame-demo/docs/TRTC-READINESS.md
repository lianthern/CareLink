# TRTC → CloudBase hy3 接入准备

**2026-09-24 更新**：`0.5.5` 第 07 轮真实供应商合成语音短通话已通过：传输、受限 hy3 桥接、机器人回答语义、最终 Stop 和测试 session 撤销均有证据，详见 [短通话实测](TRTC-SHORT-CALL-PROBE.md)。独立清理 Event 与每分钟 Timer 已部署，并有手动 Invoke 成功证据。实体麦克风/扬声器、真人听说与插话、实体摄像头、Timer 自然触发和真实过期 Task Stop 仍待验证。各轮结果见 [接手与验收记录](TAKEOVER-20260924.md)。独立分支本地完整551项通过、尚未部署或开通，是本日接手前的历史阶段；[免费接入](TRTC-FREE-ACTIVATION.md)及下文“尚无该路由/待实现”也保留为原准备阶段记录。

历史核对日期：2026-09-23。基于主线 `d5f9d28` 的补充。当次只修改服务端、预检、测试与专用文档，没有开通、购买、扩权、创建云家庭、部署或启用实时通话，没有调用真实 LLM/TRTC。前端由另一任务处理。该历史范围不代表 2026-09-24 的当前云端状态。

## 已核实的兼容接口与鉴权

CloudBase 当前官方给出的 OpenAI Chat Completions 地址为：

```text
https://<既有环境ID>.api.tcloudbasegateway.com/v1/ai/cloudbase/chat/completions
Authorization: Bearer <CloudBase API Key>
Content-Type: application/json
Accept: text/event-stream
```

请求模型为 `hy3`、`stream:true`、文本 `messages`。这是完整请求地址；TRTC 的 `LLMConfig.APIUrl` 需要这个完整地址，不填旧教程的 `APIBaseUrl`。依据：[CloudBase cURL 调用](https://docs.cloudbase.net/ai/model/curl-access)、[TRTC 大模型配置](https://cloud.tencent.com/document/product/647/115413)。

现有 `store.app.ai().createModel('cloudbase')` 是进程内 SDK，通过云端运行身份取得调用凭据；它不是公网接口，也不能把 SDK 对象、家庭登录 token 或云 API SecretKey 填到 TRTC 的 `APIKey`。直接 HTTPS 是可选择的接法。2026-09-23 尚无该账户 TRTC → hy3 实际连通证据；`0.5.5` 第 07 轮已验证本服务的受限桥接，尚未验证把 CloudBase 管理员 API Key 直接交给 TRTC 的接法。

CloudBase 普通 API Key 具有开发者/管理员权限，不是只准调用 hy3 的凭据。选择直连意味着把这份服务端凭据交给 TRTC；本次不创建、不提取、不代填、不自动授权。公开 Publishable Key 或短期用户 AccessToken 的权限与续期不同，不能未经验证替换。[CloudBase API Key 说明](https://docs.cloudbase.net/en/http-api/basic/apikey)

直接 HTTPS 方案的另一个待验条件是 HTTP 请求头：CloudBase 明确要求流式请求携带 `Accept:text/event-stream`；TRTC 文档未提供本配置下设置任意请求头的参数，`ExtraBody` 只是请求正文。不能据 `Streaming:true` 推断 TRTC 实际头部。该直连条件仍未验证；当前已选择并实测受限桥接。[CloudBase 流式要求](https://docs.cloudbase.net/http-api/ai-model/call-llm)

## 新开通音色配置

`TTSType=flow` 现在显式允许 `flow_02_turbo` 与旧 `flow_01_turbo`，实际发送保留用户选择。新模板使用 `flow_02_turbo`；旧配置不自动迁移，也没有付费降级/换型号重试。`flow_01_ex` 与其他服务商不在本适配器范围内。

专门的 [StartAIConversation 文字转语音配置](https://cloud.tencent.cn/document/product/647/115414) 当前将 Flash 指向 `flow_02_turbo`；[语音合成介绍](https://cloud.tencent.com/document/product/647/131300) 同样推荐 02；[通用 Start 接口示例](https://cloud.tencent.com/document/product/647/108514) 仍列 01，因此保留显式旧值兼容，不据此承诺旧账户仍有该型号权益。开通、型号和具体 VoiceId 必须在实际账户确认。费用由总控核对当前 [AI 智能语音计费页](https://cloud.tencent.com/document/product/647/137853)，本代码不选择套餐或启动试听。

## 可运行的预检

在 `memory-frame-demo` 执行以下任一命令。第一种只读显式选中的部署函数配置，不与进程环境混合；第二种适合准备私有环境文件。

```powershell
node scripts/check-trtc-readiness.mjs --config cloudbaserc.local.json
node --env-file=.tools/ai-realtime.local.env scripts/check-trtc-readiness.mjs
```

默认完全离线：不加载供应商客户端、不读数据库、不申请麦克风、不创建资源、不调用模型。即使 `AI_REALTIME_ENABLED=0`，也检查未来启用所需字段。报告只含固定字段、存在性和布尔结果，不含密钥、环境地址、VoiceId、原始 JSON 或会话。配置不全退出非零；`configurationReady=true` 只是静态校验通过，所有云端/真人验证字段仍为 false。

2026-09-23 实际对主目录现有私有 `cloudbaserc.local.json` 离线运行：`serviceEnabled=false`、`configurationReady=false`，实时 provider、AppID、签名密钥、控制 SecretId/SecretKey、LLM JSON、TTS JSON 共七项缺失；`networkRequests=0`。这说明本地部署配置未准备好，不是腾讯账户未开通的证据。

`--probe-llm` 是**显式、有模型用量的选项，本次没有运行**：

```powershell
node scripts/check-trtc-readiness.mjs --config cloudbaserc.local.json --probe-llm
```

它只对配置中同一 CloudBase 环境的固定网关路径发送一次 hy3 文本请求（64 个输出 token 上限、30 秒超时、64 KiB 响应上限），禁止重定向和任意 URL，不重试。检查 SSE 内容分片和 `[DONE]`，只报告计数与状态，不输出回答正文/供应商错误。仅可证明调用机器 → CloudBase 的 HTTP 流；不能证明 TRTC 的请求头、机器人入房、音色输出或打断。模拟流通过不记录为真实供应商验证。

## 生命周期修复与独立清理入口

- Stop/Describe 只依赖显式 TRTC 控制凭据与 SDKAppID/地域。关闭新通话、移除 LLM/TTS 或签名密钥后仍可清理已有任务；不继承 CloudBase 执行角色凭据调用 TRTC。
- 通过 SessionId 查到 TaskId 后先持久保存，再 Stop；停止失败后可直接按 TaskId 重试。无 TaskId 的畸形查询成功不能当作 `TaskNotExist`。
- 迟到的空查询不能覆盖另一操作发现的任务；迟到 Start 成功即使遇到此前 ended，也重新进入停止流程。激活在 CAS 内重查租约与总时长。
- 已知道 TaskId 后数据库失败，仍尝试直接 Stop；错误与清理返回路径都被捕获，持久的启动预留保留给后续核对。
- `cleanupExpired()` 无需家庭请求，可从持久集合枚举所有家庭，按最近尝试时间安排最多 20 项，避免失败家庭长期占满一轮。每次停止 CAS 重新检查租约，正常心跳不会被旧快照误杀。25 秒是停止发起下一项的预算，不是强制取消已开始的存储/云 API 请求。
- 进程中断且没有任何 Start 结束证据的记录维持 `stopping`，持续查询，找到任务后停止；不能仅因等待时间到了就宣称结束。这种长期待确认状态需要运维处理，不能手工删记录来释放并发。

入口为 `server/ai-realtime-cleanup.js` 的 `main`，代码默认 `AI_REALTIME_CLEANUP_ENABLED=0`，导入/默认调用没有 I/O。2026-09-23 仅准备私有事件函数接线，尚未部署 Timer；2026-09-24 已在既有环境部署并启用独立私有 Event，仍没有新增 `/api` 管理 action 或公网清理路由。

已落地的云端配置：独立 Event 名称 `unseen-ai-realtime-cleanup`，运行时 `Nodejs20.19`，入口 `ai-realtime-cleanup.main`，使用私有 IAM 调用边界；同名 Timer 每分钟执行计划为 `0 * * * * * *`，读回状态 `OPEN`，无公网 HTTP 触发器。事件必须包含 `Type:Timer` 与匹配的 `TriggerName`；该字段检查不是身份认证。[腾讯 Timer 事件格式](https://cloud.tencent.com/document/product/583/9708)

此函数配置既有 `MEMORY_CLOUDBASE_ENV`、`AI_REALTIME_CLEANUP_ENABLED=1`、原任务 TRTC AppID/地域和有 Describe/Stop 权限的显式私有控制凭据（临时凭据还需 token）。不需要 LLM API Key、TTS JSON 或签名密钥。数据库访问复用既有 `MemoryFrameDemoRuntime` 角色。2026-09-23 准备子任务未修改部署脚本/私有配置；后续部署与读回见下面的独立证据。

- `2026-09-24T02:46:04Z`：`0.5.2` 两处后端修复同步到 Event，读回为 `Active`；25 个源文件摘要均匹配，角色、环境和触发器配置未变，HTTP 启动脚本未打包、后端共享模块仍存在。该次更新没有主动 Invoke，`actualInvocationVerified=false`（`.tools/cleanup-live-20260924/update-052-receipt.private.json`）。
- `2026-09-24T03:02:14Z`：手动 Invoke 返回 `enabled=true / ok=true`，扫描 1 条、尝试 0、结束 0、错误 0；每分钟 Timer 仍启用、无公开 HTTP 触发器（`.tools/cloud-cleanup-receipt.private.json`）。这是手动调用及扫描成功，不是过期任务 Stop 或定时器自然执行证明。
- 两份证据均未确认真实过期任务停止；当前 `scheduledInvocationVerified=false`、`expiredTaskStopVerified=false`。CLS 尚未开启，旧 `GetFunctionLogs` 路径不可用，不能由 Timer 为 `OPEN` 推断它已自然运行成功。

机器人 `MaxIdleTime` 当前默认值为 `60` 秒。历史值 `30` 已在真实 Start 中被参数拒绝；`0.5.5` 第 07 轮以修正后的配置成功启动并完成合成语音短通话。此次没有验证无流等待超时停止，不能作为供应商侧计费上限或定时清理验收结果。

正常清理只处理 `stopping`、45 秒心跳租约到期或10分钟总时长到期的记录。只有显式 `AI_REALTIME_CLEANUP_STOP_ALL=1` 才紧急清理全部未结束任务；缺少开始配置不会误停仍有效的通话。关闭新通话后仍须保留清理控制凭据，尤其不得在旧任务未清完前切换其 AppID。

返回值及 `[ai-realtime-cleanup]` 日志只含扫描/尝试/结束/待确认/跳过/错误/延后计数，`ok=false` 表示未全部核对完。Timer 的异步运行结果仍须取得独立证据，持续 pending/errors/deferred 应告警；还需真实验证无网页访问时租约过期可 Stop、控制台停止状态与失败重试。不把已部署入口、开启的 Timer 或成功的手动扫描等同于已经验证的定时停止保障，也不承诺绝对计费上限。

## 可选受限桥接：接入面与工作量

以下保留 2026-09-23 的设计与工作量记录：若不接受把 CloudBase 管理员 API Key 交给 TRTC，或 TRTC 无法满足 Accept 要求，建议另行实现如下最小桥接；**当次提交没有该路由**。2026-09-24 已选择并部署受限桥接，不再是待实现项；实际链路验收单独记录。

| 接入面 | 具体改动 |
| --- | --- |
| `ai-realtime.js` 持久条目 | 每次手动启动生成独立高熵 Bearer，服务端只存摘要/到期时间，绑定家庭、会话、providerSession、TRTC 房间与机器人；到期不长于本次最多10分钟。仅一次送给 TRTC，禁止下发浏览器。不能复用家庭 token 或 CloudBase 管理员 Key。 |
| `ai-realtime-trtc.js` | 在明确的 bridge 模式下按条目构造 LLM APIKey/APIUrl；固定现有服务同源公开 HTTPS 路径。通用直连配置另保留，不接受浏览器指定供应商。 |
| `server.js` 与新桥接模块 | 独立 SSE POST 路由，不经过现有一次性 JSON `/api`。先校验 Bearer 摘要/TTL/实时条目、登录与家庭权限仍有效；有真实回调证据后校验 TRTC 附带的 task/room/user header，但头部本身不能当认证。 |
| 输入与执行边界 | 固定 `hy3` 和 `cloudbase`；只接有界 user/assistant 纯文本数组，固定或核对服务器 system policy；拒绝未知模型、URL、图片、tools/tool_calls、函数与任意透传参数。每会话原子并发1、轮数/字符/token预算、稳定 requestId 去重。无行动执行器，不调用现有留言/联系路径。 |
| SDK 与 SSE | 内部用原运行身份调用 `app.ai().createModel('cloudbase').streamText()`；转换为 `chat.completion.chunk` + `[DONE]`，有背压、总输出限制和计时。连接断开、条目停止/撤权、超时必须取消上游，不只停止写浏览器；跨实例停止需持久状态复查。 |

本机锁定 SDK 审计：`@cloudbase/node-sdk@3.18.3` / `@cloudbase/ai@2.30.0` 有 `streamText`、`dataStream`、`textStream`。但当前 `ReactModel.streamText` 将输入 `abortSignal` 分离后没有传至 `doStream`，`ReqOptions` 只有 `timeout`；Node 请求适配器在已拿到响应后的流 `cancel()` 会销毁底层流。因此不能声称加一个 `abortSignal` 就完成端到端取消。需测试两条 tee 分支、响应头到达前的取消、任务跨实例失效；必要时用受测的供应商传输适配层或 SDK 修复，凭据仍仅留本服务端。

估算（工程范围，不是完成承诺）：约4个服务端接入点、2–3个独立测试文件，包含短期令牌/并发与重放、真实 Node HTTP SSE/背压、SDK 取消注入、终止/撤权竞态；正常约1–2个工程日，另需一次获准的真实 CloudBase 流与 TRTC 语音联调。SDK 上游取消不满足会增加工作。不要用几十行代理或模型名存在替代这些验证。

## 本次证据与最小剩余项

`0.5.5` 第 07 轮证据目录为 `.tools/realtime-probe-run-07/`：`realtime-call-report.json` 的 `transportPassed=true`，SDK 入房/推流和机器人非零音轨成功，最终 Stop、测试 session 撤销确认；`cloud-evidence.json` 的 `complete=true`，1 轮、15 输入字符、7 输出字符，claim 已释放、记录 `ended`，供应商 Describe 确认 `TaskNotExist`；`semantic-evidence.private.json` 对实收机器人测试音频另行 ASR 转写为“3+4=7。”，`passed=true`。该结果使用合成输入和真实供应商，没有使用实体设备或验证 UI 开始按钮，不能代替真人硬件与插话验收。

定向测试命令：

```powershell
node --test test/ai-realtime.test.js test/ai-realtime-readiness.test.js test/ai-realtime-ui.test.js test/ai-conversation.test.js test/accounts.test.js
```

2026-09-23 上述定向 **74/74 通过**，新增18项测试覆盖预检/Flow02/清理与异常生命周期；测试使用隔离本地数据、云 API/流替身。最后的清理计数日志变动另复验实时服务端22/22。当次没有365项全量回归、浏览器点击、真人录音/扬声器、真实供应商或云端 Timer 运行证据。这些历史测试不覆盖后续部署与真实联调。

2026-09-23 原剩余项（历史）：确认账户 TRTC/AI/Flow 权益与预算；选择直连广域凭据授权或受限桥接；准备私有 TRTC控制/房间权限配置；批准并部署私有 Timer 并验证清理；在已选链路完成真实 LLM流、机器人音频与打断验收。当时在上述完成前保留 `AI_REALTIME_ENABLED=0`。

2026-09-24 已完成专用账户与配置核对、受限桥接部署、实时配置开启、私有 Event/Timer 部署，以及第 07 轮真实供应商合成语音、桥接输出、回答语义和最终停止验证。当前剩余验证为：用户设备上的 UI 开始按钮、实体麦克风/扬声器、真人听说与插话、实体摄像头；Timer 自然执行；无网页访问时真实过期任务 Stop 与失败重试。第 07 轮主动停止成功和手动 Invoke 均不代替独立定时清理结果，各轮实测见 [接手记录](TAKEOVER-20260924.md)。


最终清理同步：2026-09-24T03:14:03Z，Event 已同步 0.5.5 后端源码，25 个源文件摘要一致、角色/环境/Timer 不变；手动 Invoke 的 scanned=1，其余计数为 0，ok=true。固定回执 `.tools/cleanup-live-20260924/update-055-receipt.private.json`；自然 Timer 和过期 Stop 仍未验证。
