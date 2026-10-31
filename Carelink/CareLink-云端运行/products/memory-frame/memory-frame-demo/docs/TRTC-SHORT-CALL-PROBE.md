# 真实 TRTC 短通话的验收准备与实测

2026-09-24。本文最初记录工具准备阶段；该阶段未执行公网 Start、模型调用或实体设备采集。随后总控执行的每轮实际结果统一记录于 [接手与验收记录](TAKEOVER-20260924.md)，不能用准备阶段结论覆盖当前运行结果。

## 当前结果：0.5.5 第 07 轮通过合成语音实测

本轮使用离线合成问题“你好，请用一句话告诉我，三加四等于几。”，经过真实 TRTC、受限 hy3 桥接和机器人语音返回；不是 SDK/API 替身测试，也没有使用实体麦克风、扬声器或摄像头。证据目录为 `.tools/realtime-probe-run-07/`，私有恢复身份和凭据不在本文披露。

| 验证层 | 实际结果与回执 |
| --- | --- |
| 真实传输 | `realtime-call-report.json`：`transportPassed=true`，一次 Start，SDK 入房、发布合成音轨、收到指定机器人音轨且音频非零；最终 `stopConfirmed=true`、`sessionRevoked=true`，新家庭和内容写入均为 0。 |
| 云端桥接与结束 | `cloud-evidence.json`：`complete=true`，1 轮、15 输入字符、7 输出字符；active claim 已释放，记录 `ended`，供应商 Describe 确认 `TaskNotExist`。 |
| 回答语义 | `semantic-evidence.private.json`：对实际收到的机器人测试音频另行执行 1 次 ASR，转写为“3+4=7。”，`expectedMeaningMatched=true`、`passed=true`；语义检查的测试 session 也已撤销，无内容写入。 |
| 未覆盖范围 | `uiButtonVerified=false`，未采集实体设备，机器人录音没有标记为人工听审；真人听说、扬声器外放、插话及实体摄像头待验证。独立 Timer 自然触发和真实过期 Task Stop 也仍待验证。 |

这三份回执合并证明本轮合成输入下的真实供应商语音、桥接输出、回答语义和最终停止。它们不证明无人访问时定时器能停止过期任务，也不代替用户在实际相框上的使用验收。前几轮失败与修复记录继续保留在接手文档。

`scripts/check-realtime-deployment.mjs` 已更新为可校验配置开或关的只读发布检查，默认仍要求关闭；参数与证据边界见 [发布检查](TRTC-DEPLOYMENT-CHECK.md)。它不会启动真实通话。`scripts/check-realtime-call.mjs` 单独执行真实供应商烟测，默认仅输出计划，必须显式提供 `--execute` 与四个文件路径。

## 先完成云端条件

执行者先核对现有应用权益、房间权限、控制凭据、部署版本及 hy3 桥接。工具不会购买、扩权、部署或改配置。

必须先核对私有 `unseen-ai-realtime-cleanup` Timer 已开启、事件入口正确、没有公网 HTTP 触发器，且独立调用返回 `enabled=true, ok=true`。空任务的成功调用只能证明入口可运行；Describe/Stop 权限和真实过期任务回收仍需同本次实际任务关联核对。底层控制台/API配置与调用回执单独保留，不能用下面摘要代替证据。

把**已经检查的事实**填入仓库忽略目录中的私有 JSON；工具要求检查时间距执行不超过一小时：

```json
{
  "origin": "https://memory-frame-demo-d7djiee0702b6c.service.tcloudbase.com",
  "checkedAt": "填写实际UTC检查时间",
  "timerEnabled": false,
  "cleanupInvocationSucceeded": false,
  "noPublicHttpTrigger": false
}
```

只在相应事实已通过时将字段改为 `true`。这是操作者提供的回执门禁，脚本不会把它伪装成自身完成了云侧验证。

## 离线合成测试问题

Mac 已有系统中文声线 Tingting。准备 1–15 秒、不含私人内容的 WAV，工具直接把 WebAudio 音轨传给 SDK；实体麦克风和屏幕采集 API 被拒绝，浏览器输出静音。不要传入家庭原声。

```sh
mkdir -p .tools/realtime-probe-private
chmod 700 .tools/realtime-probe-private
say -v Tingting -r 175 -o .tools/realtime-probe-private/prompt.aiff '你好，请用一句话告诉我，三加四等于几。'
afconvert -f WAVE -d LEI16@16000 .tools/realtime-probe-private/prompt.aiff .tools/realtime-probe-private/prompt.wav
```

不带执行参数先查看计划，零网络：

```sh
node scripts/check-realtime-call.mjs
```

准备好后由总控明确执行一次；`AI_UX_*` 复用现有测试 harness 的独立 Chrome 路径，不连接用户浏览器或既有 profile：

```sh
AI_UX_PLAYWRIGHT='/Users/max/Documents/ChatGPT/HUIJIAN/companion-one-lab/node_modules/playwright' \
AI_UX_CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
node scripts/check-realtime-call.mjs --execute \
  '/Users/max/code/unseen-takeover-20260924/unseen/private-access/online-accounts.json' \
  '.tools/realtime-probe-private/prompt.wav' \
  '.tools/realtime-probe-run-01' \
  '.tools/cloud-cleanup-receipt.private.json'
```

工具只登录现有第二个账号；不创建家庭、邀请或内容。不自动重试 Start，通话工具本身不运行额外 ASR 或 TTS 请求。第 07 轮的回答语义在通话结束后由独立步骤执行 1 次 ASR，单独保存回执。不要在同一输出目录重复执行；上一条结束未确认时，不得换目录绕开并发保护再发起新通话。

## 停止与失败处理

- 浏览器和主 Node 进程各有 45 秒结束计时；同一时刻关闭合成音轨并调用原客户端 Stop。
- 启动前将同一 `requestId`、测试会话和截止时间写入权限为 `0600` 的恢复文件，并启动独立 Node watchdog；没有 watchdog 就绪标记不会 Start。watchdog 在第 55 秒重复同一个 Stop；主进程已退出时，确认 ended 后还会退出测试账号。
- 只收到 `status=ended` 才记 `stopConfirmed=true`。网络失败/进程异常不等于已停止；工具保留恢复文件与 `operatorActionRequired=true`，避免丢失清理身份。不要在结束确认前撤销这份恢复身份。
- 必须同时检查服务端持久记录及供应商任务的停止证据，特别是 Start 响应超时。不能手工删除持久条目来释放并发。
- 本地录音停止、API Stop 已发出、服务端 ended、供应商计费结束是不同证据。45/55 秒是请求目标，**不是断网或腾讯服务异常下的绝对云计费上限**。现有服务的 45 秒租约加每分钟 Timer 可能晚于 60 秒；若要求任何故障下都严格不超过 60 秒，当前服务配置无法保证，本工具不能绕过这个限制。

恢复文件仅本地保存，确认 Stop 和退出成功后会去除 token；不要提交、发送或打印原文件。不要把 `--watchdog` 当作新的 Start：该模式只会 Stop 原 requestId 与处理孤立测试会话。

## 判定证据

`realtime-call-report.json` 只保存固定字段、哈希和计数。`transportPassed=true` 需要一次 Start、SDK 进房、合成音频发布、指定机器人的远端音轨和非零音频、Stop 确认，以及家庭消息数量未变化。

若有音轨，`bot-reply.private.webm` 保存本次机器人返回的测试音频，供总控听取是否正确回答“七”。SDK 的 `TRACK` 事件给出实际 MediaStreamTrack，见 [腾讯 Web SDK 事件说明](https://web.sdk.qcloud.com/trtc/webrtc/v5/doc/zh-cn/module-EVENT.html)。工具监听真实远端音轨，不把“收到远端音频可用事件”直接当成已听到回复。

每轮仍须分别核对；第 07 轮已完成的证据见上表：

1. 确认本次实收机器人录音不是空声/报错且正确回答合成问题。第 07 轮已通过独立 ASR 转写核对，未标记人工听审。
2. 按本次 requestId 的私有恢复记录关联服务端实时条目，只读核对 `bridgeBudget.turns`、`outputChars` 与已释放的 active claim；核对配置和云端调用记录确实是 hy3。第 07 轮云端证据已通过；只有音轨仍不足以证明用了哪个模型。
3. 核对服务端和供应商停止。第 07 轮最终 Stop、`ended` 与 `TaskNotExist` 已确认；无网页访问时 Timer 后续独立运行、停止真实过期任务的证据仍未取得，不能由本轮主动结束推断。
4. 本工具复用客户端和真实 SDK，但不通过 UI 开始按钮；`uiButtonVerified=false`。设备扬声器、实体麦克风、真人语音、真实打断及实体相框由随后用户测试，不能写成已完成。

通话工具原始报告保留 `asrHy3TtsSemanticsVerified=false`，因为该工具只判定传输，不自行判定回答语义。第 07 轮已另行取得云端 `complete=true` 和语义 `passed=true` 回执，本文据三份独立证据记录合成语音测试通过；不回写或覆盖原始报告，也不把自动转写说成人工听审。仅收到音轨、文字模型可用或静态预检通过仍不足以做出这个结论。

本地准备验证：`test/realtime-probe.test.js` 与 `test/ai-realtime-ui.test.js` 共 **20/20，零跳过**。包括真实隔离 Chrome/WebAudio/MediaRecorder、本地 SDK/API 替身、默认零网络、重复 Start 保护、watchdog 同身份 Stop 及孤立会话退出。以上仅为工具准备阶段的本地验证，不是供应商或云端验收；后续实际结果见接手记录。
