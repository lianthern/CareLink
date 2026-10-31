# 腾讯实时语音方案：TRTC 是否必需

核对日期：2026-09-23。基线 `e5a7e1e`。本次仅核对官方文档并提出接线方案，没有修改业务代码、读取凭据、开通服务、购买、提交工单、部署或调用真实语音/模型。

**TRTC 本身就是腾讯云产品，但不是接入腾讯语音的必选项。** 当前项目已有 TRTC 适配器，实时功能仍默认关闭；现有 CloudBase `hy3` 文字聊天可以继续用。用户要求的是持续听说、自然插话，不应把录音转写加自动朗读当成已完成的替代方案。

## 三条路线怎么选

| 路线 | 已公开的能力 | 本项目需要补的内容 |
| --- | --- | --- |
| 腾讯 TRTC AI 实时对话 | 托管音频传输、ASR/LLM/TTS 编排，官方明确支持智能打断 | 已有适配器；仍须解决账号权限、hy3 流式接入及真实音频验收。当前工程增量最小，不代表费用最低。 |
| 腾讯媒体处理 MPS WebSocket STS | 一条 WebSocket 承载语音输入、模型回复和语音输出，可接自定义 LLM | 新音频传输及播放适配器；公开协议尚不足以确认同会话插话打断，不能直接宣称等价替换。 |
| 腾讯独立实时 ASR + 现有 hy3 + 腾讯流式文本 TTS | 流式识别和增量文本合成都有正式接口 | 自行实现端点检测、轮次调度、打断、旧音频丢弃、回声处理和取消。最能保留现有模型接入，但工程量更大。 |

能力依据：[TRTC 功能介绍](https://cloud.tencent.com/document/product/647/110584)、[MPS STS 协议](https://cloud.tencent.com/document/product/862/135068)、[腾讯实时 ASR](https://cloud.tencent.com/document/product/1093/48982)、[流式文本 TTS](https://cloud.tencent.com/document/api/1073/108595)。表中工程量判断依据本仓库已有实现，不是腾讯承诺。

## MPS STS：完整链路有文档，插话仍需确认

2026-07-27 的 STS 协议给出 `wss://mps.cloud.tencent.com/sts/v1/<appid>`，使用账号 AppID、云 API 签名和音色；SecretKey 必须留在后端代签。默认 `mode=llm` 表示运行 ASR → LLM → TTS，**没有公布默认模型型号，不能认定默认就是 hy3**。默认并发为 2，空闲无上行音频默认 30 秒结束。[协议第 1、7、8 节](https://cloud.tencent.com/document/product/862/135068)

自定义 LLM 要提交工单登记公网 HTTPS `baseURL`、模型与可选提示词/API Key；服务调用 OpenAI 兼容 Chat Completions，明确发送 `Accept: text/event-stream`。`llmApiKey` 支持会话覆盖。[协议第 6 节](https://cloud.tencent.com/document/product/862/135068)

公开控制信令只列 `Finish`，它会处理最后一句后关闭连接；直接关闭 WebSocket 则释放会话。文档未给出取消当前回答、保留会话继续听说的命令或自动打断约定。**这不证明服务不支持打断，只表示现有公开证据不足。** 不能把关闭重连包装为同会话自然插话。[协议第 3、8 节](https://cloud.tencent.com/document/product/862/135068)

开通前还须确认 MPS 产品权限、STS/音色资格和单独费用；MPS 产品开通不等于 STS、模型和用量全部免费。[MPS 账号授权](https://cloud.tencent.com/document/faq/862/117336) 本次没有查到可用于核算这条 STS 完整链路的明确总价，不能套用 TRTC 的分钟价。

建议给腾讯的核实清单：是否支持 AI 输出时持续收音并自动中止旧回答；中止后旧音频如何标识与丢弃；是否保留已实际播放的上下文；所需权限、默认模型、音色、计费及并发；是否支持服务端强制终止已签发的客户端连接。本次未发送这些问题。

## 独立 ASR + hy3 + TTS：能组合，打断由应用负责

独立 ASR 使用 `wss://asr.cloud.tencent.com/asr/v2/<appid>`，需开通语音识别和签名权限，可连续上传音频并获得中间/最终文本。当前中国站 2026-09-20 文档建议按 1:1 实时率、每 200ms 上传相应音频；上行间隔超过 6 秒可能断开。重连必须换 `voice_id`。这些要求不同于旧版或国际站示例，不能混用。[实时 ASR 协议](https://cloud.tencent.com/document/product/1093/48982)

独立 TTS 选 `TextToStreamAudioWSv2`，地址为 `wss://tts.cloud.tencent.com/stream_wsv2`，需另开语音合成并签名；支持持续送入 LLM 文本，音频边生成边返回。单会话上限 10000 字，按标点分句；缺少适当标点可能延迟起播。`ACTION_RESET` **只清尚未合成的文本，不能取消已在合成中的部分**。因此还必须立即清空本机播放队列，并用轮次标识拒收旧音频，必要时关闭旧 TTS 连接。[流式文本 TTS 协议](https://cloud.tencent.com/document/api/1073/108595)

推荐的后续原型接线（设计，未实现）：

```text
用户点击开始
  → 当前家庭身份校验与短时签名
  → 麦克风持续采集 → 腾讯实时 ASR
  → 当前稳态句 → 本应用的 hy3 流式回答
  → 当前回答文本 → 腾讯流式文本 TTS → 有界播放队列

用户再次开口
  → 立即停止旧音频播放、增加轮次序号
  → 取消旧 LLM 与 TTS、忽略所有迟到分片
  → 持续 ASR 接收新话语，进入下一轮
```

“再次开口”需要本地或识别侧的人声检测与回声抑制，不能简单把扬声器回传或任意非空转写当作用户打断。每轮保存哪些回答内容、断网恢复、后台释放、撤权与费用限制都需要专项测试。两套单点 API 的存在不等于上述完整体验已经实现，也不能据此承诺某个端到端延迟。

## hy3 仍可保留，但鉴权路径要区分

CloudBase 官方提供 hy3 的公网 Chat Completions 接口，完整请求地址为：

```text
https://<ENV_ID>.api.tcloudbasegateway.com/v1/ai/cloudbase/chat/completions
```

使用 CloudBase API Key、`model=hy3`、`stream=true` 和 `Accept: text/event-stream`。[cURL 调用](https://docs.cloudbase.net/ai/model/curl-access)、[流式请求约定](https://docs.cloudbase.net/http-api/ai-model/call-llm) 普通 API Key 是开发者/管理员级权限，不能当作仅能执行一次聊天的令牌，也不能放入浏览器或公开签名 URL。[API Key 权限说明](https://docs.cloudbase.net/en/http-api/basic/apikey)

- **选择 MPS STS：** 可以申请把 CloudBase 作为自定义 LLM。其要求的版本前缀与 CloudBase 官方不同示例的路径须确认：CloudBase [AI 工具配置](https://docs.cloudbase.net/en/ai/quickstart/ai-tools)列出末尾带 `/v1` 的 Base URL，而上面的 cURL 是完整路径。不能自行猜截路径就宣称直连成功。直接接入还意味着向 STS 提供 CloudBase 服务端 Key；若不接受其权限范围，则需仅能调用 hy3 的受限 SSE 桥接。不要把长期 CloudBase Key 填入下发浏览器的 `llmApiKey` 参数。
- **选择自行组合：** 让本应用后端调用现有 CloudBase 模型，浏览器仅收到回答流；不必向 ASR/TTS 服务提供 CloudBase Key。当前 `/api` 聊天一次返回 JSON，需另做受控流式输出与上游取消，不能只改模型名。现用 SDK 的取消限制、网关 SSE 和桥接边界已有审计，见 [TRTC 接入准备](TRTC-READINESS.md)。

两条路线均未完成该账户真实流式联调。媒体处理 STS 与腾讯临时安全凭证服务 STS 是不同概念；这里也不需要把账号 AppID 当成 TRTC SDKAppID 使用。

## 对当前项目的建议与接口边界

**如果目标只是使用腾讯服务，继续现有 TRTC 接线最省工程；如果明确希望不使用 TRTC，建议先做“独立 ASR + hy3 + 流式 TTS”的受控原型。** MPS STS 保留为托管候选，先核实同会话打断，再决定是否优于自行组合。没有供应商报价和真实用量之前，不作“哪条一定更便宜”的结论。

本次保留现有 provider 接口和默认关闭状态。当前服务端适配器依赖 `start/lookup/stop/credentials`，前端只接受 `tencent-trtc` 并使用房间凭据；两条 WebSocket 路线都不能通过替换环境变量直接接通。未来实现须单独增加 provider 与传输适配器，共用首页入口、文字草稿、身份隔离和关闭/后台释放规则。

签名直连可以省去音频转发，但签名到期通常不能被当作已建立连接的强制终止保证；当前 TRTC 的任务查询/停止机制不可照搬。若产品要求服务端可靠撤销长连接，必须先核实供应商终止能力，或设计能被服务端关闭的音频转发连接，并核验部署环境是否支持。不得为此默认新建常驻服务、开放任意转发或放宽现有权限。

下一步由总控根据用户选择执行：先确认产品资格与预算，再完成适配器及离线生命周期测试，最后一次受控真人通话验证首字/首音、插话、静音、断网、后台、撤权和实际结束状态。现有录音转写入口继续保留，但不计作实时通话验收。

费用分别核对 [ASR 在线计费](https://cloud.tencent.com/document/product/1093/35686)、[TTS 在线计费](https://cloud.tencent.com/document/product/1073/34112)及当前 CloudBase 资源点。ASR 官方说明后付费默认关闭，开通/额度不足的处理不能沿用 TRTC 新计费规则；本次没有启用后付费或购买套餐。MPS STS 的费用另向腾讯确认。

验证范围：仅官方文档与当前源码审查；文档改动完成静态检查，不重跑业务测试。没有真人声音、麦克风、扬声器、真实 WebSocket、供应商模型或费用验收证据。
