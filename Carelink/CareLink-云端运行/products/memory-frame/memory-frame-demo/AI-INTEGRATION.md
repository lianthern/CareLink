# AI 接入与验证（2026-09-23）

导出契约不变：`transcribe(wav)` 返回原始转写字符串；`summarize(text, app)` 返回待确认 AI 记忆卡（`source: ai, confirmed: false`）。调用方必须分别保存 transcription 与 card，人工修改不得覆盖原始转写。摘要与标题是 AI 生成内容，不是逐字引语；人物、时间、地点必须是原文的字面片段。不确定字段为空。结构校验不能保证摘要语义绝对正确，仍需用户确认。

## 推荐配置

- Node 18+（部署建议 Node 20/22）；已有依赖 @cloudbase/node-sdk 和 tencentcloud-sdk-nodejs-asr，无新增依赖。
- CloudBase：环境支持 AI 且模型已启用、有可用资源点/额度，设置 `AI_MODEL=hy3`。代码调用 `app.ai().createModel('cloudbase').generateText(...)`，读取 `text` 并先检查 `error`。模型以控制台可用列表为准。app 初始化建议 `timeout: 60000`；ASR 和模型分别55秒上限，HTTP处理预算需大于110秒。
- ASR：腾讯云单独开通语音识别，核实额度和计费；给函数执行角色 `asr:SentenceRecognition`、资源 `*` 的最小权限。SCF 自动注入 `TENCENTCLOUD_SECRETID`、`TENCENTCLOUD_SECRETKEY`、`TENCENTCLOUD_SESSIONTOKEN`；代码按次读取，不能把 SCF 令牌混入其他凭据。独立服务可由安全环境注入 `TENCENT_SECRET_ID`、`TENCENT_SECRET_KEY`，临时凭据另需 `TENCENT_SESSION_TOKEN`。不要发送密钥到聊天、前端或仓库。
- ASR 输入：16kHz、单声道、PCM16 RIFF WAV，0–60秒（非空），最多3MB；请求 SentenceRecognition 使用 `SourceType:1, VoiceFormat:wav, EngSerViceType:16k_zh, SubServiceType:2`，`DataLen` 为文件字节数，`Data` 为整个WAV的base64，返回 `Result`。

## 费用与服务开通

总控核对的新购个人版包含4万资源点，但模型实际开关、可用列表和余额仍需控制台验证。CloudBase [2026-06-18更新说明](https://docs.cloudbase.net/ai/CHANGELOG)说明资源点套餐可抵扣模型Token、旧Token资源包停售，**不要购买旧Token包**。旧接入页仍可能写Token包，其费用说明不应用于新环境。ASR是独立服务，不能假定数据库/资源点套餐含ASR调用；以[ASR计费说明](https://cloud.tencent.com/document/product/1093/35686)和账号控制台为准。适配代码不会购买服务或更改IAM权限。

## OpenAI兼容备用服务

服务器环境设置 `ASR_BASE_URL=https://供应商/v1`、`ASR_API_KEY`，可选 `ASR_MODEL`（默认whisper-1）；使用 multipart `/audio/transcriptions`，要求 JSON `{text:string}`。LLM设置 `AI_BASE_URL=https://供应商/v1`、`AI_API_KEY`、`AI_MODEL`，使用 `/chat/completions` 并读取 `choices[0].message.content`。两组可独立选择；配置部分缺失时明确失败，不静默切换供应商。调用外部供应商会向其发送录音/原文，部署者应选择已授权的服务。生产使用HTTPS。

## 错误与验证

错误带稳定code：AI_CONFIG、AI_AUDIO_FORMAT、AI_INPUT、AI_PERMISSION、AI_QUOTA、AI_SERVICE、AI_TIMEOUT、AI_RESPONSE、AI_UNGROUNDED、AI_NO_SPEECH、AI_UPSTREAM。对外提示不包含上游原始报文或密钥。不自动重试，避免重复计费；CloudBase传入abortSignal并设置调用上限，SDK底层是否停止网络请求取决于SDK版本。

`node --test test/ai-adapter.test.js` 是模拟外部网络/SDK的适配测试，不是真实接口测试。覆盖WAV边界、SCF令牌、协议、JSON与事实字段校验、错误映射。真实验收需在已授权环境上传一句真实录音，核对原声和转写，再生成卡片并人工核对；记录请求成功及实际模型，不能只凭模拟测试宣布已联通。

已核验官方当前[Node SDK调用文档](https://docs.cloudbase.net/ai/model/nodejs-access)、[AI返回结构](https://docs.cloudbase.net/api-reference/server/node-sdk/ai)、[混元升级指南](https://docs.cloudbase.net/ai/ai-inspire-plan-upgrade)、[一句话识别](https://cloud.tencent.com/document/api/1093/35646)、[SCF环境变量](https://intl.cloud.tencent.com/zh/document/product/583/32748)、[ASR权限](https://intl.cloud.tencent.com/zh/document/product/598/57065?lang=zh)。还读取公开npm包：node-sdk 3.18.3声明依赖 @cloudbase/ai ^2.23.0；ai 2.30.0实现确认 generateText 返回 text/error/rawResponses，并接受abortSignal。未读取本机密钥，未调用真实收费服务。
