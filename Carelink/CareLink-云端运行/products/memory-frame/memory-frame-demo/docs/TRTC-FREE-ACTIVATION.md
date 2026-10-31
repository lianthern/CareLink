# TRTC 免费试用接入：当前落地与剩余步骤

核对日期：2026-09-24。用户已要求按免费方案继续接入；本轮不购买套餐、不开自动续费。本文区分本地实现与账号侧实际开通。

**09:10 最新交接**：用户确认无控制凭据，要求打包交由具有浏览器权限的 AI 继续。已整合线上 0.4.9 与桥接，578/578 零跳过；部署尝试因 CLI 将 `AI_REALTIME_TTS_JSON` 环境值处理为非字符串而失败。官方 SCF 读回证实原 7 项云环境配置与代码 hash 未变，实时仍关闭。应用 ID/签名密钥目前只在本机私有部署草稿，不能写成已上线。账号侧最小权限与填写步骤见 [最后配置](TRTC-ACCOUNT-FINISH.md)。

**08:48 实际软件复查**：用户截图已证实 `unseenframe` 应用体验版正常、到期日 2026-10-01、后付费未开通；AppID 与 SDK 签名密钥已写入本地忽略配置。仍缺控制 API 的 SecretId/SecretKey，房间权限与 AI 语音额度未核实。复用既有账号查询实际公网，健康版本为 **0.4.9**，`aiRealtimeCapabilities.enabled=false`，文字/识图能力启用；测试会话已退出，无模型调用或 TRTC Start。当前分支和 main 文档仍记录先前 0.4.8，不能用旧配置覆盖现有部署。见 [实际查询证据](TRTC-LIVE-STATUS.json)。

## 免费权益先核对

中国站提供一次性 10,000 分钟音视频免费包，以及 AI 智能语音 1,000 分钟免费包。前者用于 RTC 时长；后者按 ASR、TTS、AI 对话各自比例抵扣，不能理解成 1,000 分钟全包通话。7 天体验只解锁功能；抵扣包不足仍可能后付费。hy3 消耗现有 CloudBase 模型额度，另核对该环境余量。

- [TRTC 免费试用与有效期](https://cloud.tencent.com/document/product/647/44360)
- [AI 智能语音免费包及抵扣规则，2026-09-20 更新](https://cloud.tencent.com/document/product/647/137853)
- [应用与 AI 对话开通入口](https://cloud.tencent.com/document/product/647/116792)

官方存在赠送活动不等于当前账号已经领取。本轮仍无法确认账号剩余额度：浏览器连接枚举返回 `nodeRepl.fetch request failed`；重新执行只读应用查询返回 `AuthFailure.UnauthorizedOperation`。没有据此断言账号没有 TRTC。

## 账号侧尚需完成

1. 打开 [TRTC 应用管理](https://console.cloud.tencent.com/trtc/app)。核对现有应用；若没有适合相框的独立应用，使用“自由集成（无 UI）”准备 unseen 应用。
2. 核对可领的 7 天体验、10,000 分钟音视频和 1,000 分钟 AI 智能语音权益，以及适用范围、有效期和实际余额。免费试用符合本轮指令；若只剩付费入口，先记录具体条件，不自动购买。
3. 准备 SDKAppID、应用签名密钥、调用 Start/Describe/StopAIConversation 的服务端控制凭据。现有 CloudBase CLI 授权不具备这项查询权限，不能把它硬套为 TRTC 权限。不要为了接入交付云账号主密钥或扩大原运行角色。
4. 为相框专用应用核实高级房间权限；当前代码必须提供指定房间的 PrivateMapKey。不要对已有其他线上业务的共享应用盲目切换开关。
5. 将上述值直接填写本机忽略文件 `.tools/ai-realtime.free-trial.env`。该草稿已选择原环境、`cloudbase-bridge` 模式、Flow 02 的官方中文“温柔姐姐”音色；缺失凭据留空，实时和清理开关仍为 0。密钥不发聊天、不提交 Git。官方音色见 [文字转语音配置](https://cloud.tencent.com/document/product/647/115414)。

## 代码新增的连接

链路为：浏览器麦克风 → TRTC/ASR → 本服务受限 SSE 路由 → 原 CloudBase hy3 → TRTC/Flow TTS → 浏览器播放。

- 新模式 `AI_REALTIME_LLM_MODE=cloudbase-bridge`，公开路径固定为同一 CloudBase 环境的 `/internal/ai-realtime/chat/completions`；没有浏览器指定 URL 或模型的通道。
- 每次手动开始生成独立 256 位随机凭据，绑定家庭和实时条目；服务端只持久化摘要，原值仅交给该次 TRTC Start，不下发浏览器，不交付 CloudBase 管理员 API Key。
- 只接受固定 hy3 的有界纯文本对话，固定系统规则，拒绝工具、图片、任意模型/URL；没有留言、联系或删除执行器。
- 持久 CAS 保证同会话一个模型生成，重复回调 ID 不再次生成。每通话最多 40 次模型请求、64,000 输入字符、24,000 输出字符；单回复最多 256 tokens、2,400 字符、45 秒。遗留的未释放生成占位不会被新请求抢占，需挂断该通话后重新开始。
- SSE 有背压，断开直接取消上游；每秒重查会话、租约和撤权，停止/退出后取消生成。数据库故障会拒绝继续生成。跨实例取消受数据库响应速度与轮询间隔影响，不能宣称瞬时或绝对计费上限。
- 正式 provider 回调使用官方记录的 `X-Rquest-Id`（原文拼写），兼容 `X-Request-Id`；缺失或冲突会拒绝。真实 TRTC 回调头与格式仍需联调，不能靠替身确认兼容。

上游传输与证据见 [hy3 流式传输](TRTC-HY3-STREAM-TRANSPORT.md)。原 direct 模式保持兼容，但本次推荐受限桥接。

## 开放按钮前的真实验收

1. 用现有私有配置做脱敏离线预检，不创建新家庭。
2. 原环境部署桥接后，验证真实 hy3 首段到达、完整结束以及中途取消；没有真实流之前保持实时入口关闭。
3. 部署私有的 `unseen-ai-realtime-cleanup` 每分钟清理任务，沿用既有清理入口，验证无网页请求时也会停止过期任务。不要设置公开 HTTP 清理接口。
4. 在免费权益与配置都已确认后，仅对复用的测试家庭进行一段短通话：进房、机器人音频、说话、插话打断、静音、挂断、切后台、断网及 Describe/Stop 结束核对。
5. 检查实际用量抵扣和剩余额度。全部通过后再对用户开放；领取试用或 `configurationReady=true` 都不等于已接通。

目前本地代码与替身/HTTP 测试已推进；账号权益、真实 CloudBase 流、TRTC 回调与真人声音、独立云 Timer 均尚未验证。原线上 0.4.8 未因本轮准备而被启用实时语音。
