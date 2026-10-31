# Link 2 云驻足邀请：前端交付与本地验收

日期：2026-09-23。对应 `CLOUD-UPLOAD-HANDOFF.md` 与 `FRONTEND-BACKEND-REQUESTS.md`。本文件记录本地实现和证据，不表示已部署、已连接 Link 2 或已完成实体 iPad 联调。

本文件保留 0.4.7 初版行为及其验收记录；2026-09-24 新增的“明确确认后读固定照片并先问一句”已在[首问功能说明](PRESENCE-PROACTIVE-AI.md)单独记录，替代下文“确认只打开普通聊天、不读取照片”的历史行为。事件协议、持久去重、门禁和 RTT 期限策略保持不变。

## 使用与事件策略

家庭 owner 在家人端“设置 → 管理相框驻足邀请”选择当前家庭的目标相框，填写 `living-room-link2` 等设备标识并签发。相框下拉显示名称、稳定 ID 尾码和在线状态，可区分同名相框。已有设备可轮换令牌或停用；换目标需先停用再签发。使用后端 `presenceSensorList`、`presenceSensorIssue`、`presenceSensorRotate` 和 `presenceSensorRevoke`，所有写入仍由后端检查 owner 权限。

令牌仅在签发/轮换响应后一次性显示，默认遮挡。可显式显示或复制，不写 localStorage、文档或诊断日志；一分钟、关窗、切后台或登录失效时清除 DOM。切后台/失效后的迟到响应不能重新显示。请求超时会明确结果尚未确认，应重新查看或轮换，不能假定未执行。

相框沿用现有 `state` 轮询读取 `presenceEvent`，采用以下策略：

- 验证事件类型、UUID、正整数序号和不超过 15 秒的服务端期限。时间使用 `state.serverTime + 本次 state 请求完整往返耗时 + 接收后的 performance.now() 增量` 的保守上界，不依赖平板墙钟正确。慢响应不能延长事件有效期。
- 每个家庭持久保存最后一个 `seq/eventId` 水位，**先去重并持久记录，再检查门禁**。被忽略的事件不排队、不延迟；刷新也不会重新邀请。无法持久保存时不弹邀请。
- 仅 `/frame`、frame 角色、有效会话、页面可见且非夜间时钟、有真实照片 `image/imageURL` 时可邀请；纯文字家书不会被称为照片。
- 录音及麦克风授权等待、原声播放、AI 文字/实时对话、家人通话、其他弹窗、已有邀请时均忽略。
- 显示“**想聊聊这张照片吗？**”“可以和 AI 慢慢聊。由您决定是否开始。”按钮为“和 AI 聊聊 / 暂时不用”，Escape 可拒绝。默认焦点在拒绝按钮，无注视或身份推断。
- 保存触发时的照片 ID。确认前重新检查门禁和到期；确认只调用 `MemoryAI.open(id)`，不自动读取照片、不生成第一句、不申请麦克风、不开始实时语音。原有 AI 内部照片选择与授权继续生效。
- 邀请显示后，后台、忙碌、期限到达、照片删除、会话失效和退出均关闭；服务端撤销后下一次 state 省略事件，邀请即关闭。

浏览器控制台 `[presence]` 只输出 `eventId / seq / outcome / reason`。可区分 received、duplicate、expired、ignored、shown、closed（declined/accepted 等原因）、accepted、ai-opened、ai-not-opened、ai-open-failed；不含照片 ID、相片地址、聊天正文、令牌或人脸信息。

## 本轮实际检查

Chrome `153.0.8010.49`，全新浏览器 context，无既有浏览器资料。以下定向检查总计 **130 项通过、0 失败、0 跳过**，不是项目全量回归。

| 检查 | 结果与边界 |
| --- | --- |
| `presence-browser.test.js`、`ai-conversation-ui.test.js`、`family-call-ui.test.js`、`elder-frame-browser.test.js`、`family-ui-lifecycle.test.js`、`account-ui.test.js` | 129/129。真实 Chrome/生产前端，API、音频/图片和部分页面状态为替身。覆盖慢 state 在途过期、固定照片与同事件刷新、拒绝/已有邀请不排队、录音/原声/文字 AI/实时 AI/家人 call/后台/夜钟门禁、显示后清理、存储失败、owner 绑定/轮换/停用与迟到 token，以及原 AI/通话/相框/账号回归。还覆盖录音授权等待中退出/过期/后台与 AudioContext.resume 等待、录音构造失败的流与 context 释放，旧异步回包不会清除新请求的忙碌门禁。 |
| `presence-http-browser.test.js` | 1/1。实际 Node HTTP + 显式隔离 LocalStore + Chrome，无 API 替换。与后端 `ef388f7` 内容联合运行；owner 在实际 UI 签发目标 frame 令牌，实际上传合成 PNG，sensor 实际 POST，下一次轮询显示；重复回相同 seq、刷新不弹；owner 和另一 frame 的 state 无事件；邀请期间新照片到达后，确认仍在真实 AI 面板选择原照片；revoke 后下一次 state 关闭。 |

HTTP 用例的家庭、两台相框、媒体与事件均为本地临时数据，结束后删除；没有占用云家庭配额、真实供应商调用或线上写入。`conversation.capabilities` 是本地能力替身，仅为打开 AI 界面，不调用模型。

横屏 1180×820、竖屏 820×1180 的截图均来自上述真实 HTTP 用例。逐张视觉检查：文案完整、按钮大于 150×70、按钮和邀请在屏内、无横向溢出；背景为脚本生成并实际上传的风景几何图，无私人照片。截图保存在本 worktree 忽略目录：

| 文件 | SHA-256 |
| --- | --- |
| `.tools/presence-browser/presence-invitation-1180.png` | `266ac15d772ea13eda6444a5d3d1f211e348d80ba50b2d298f3f11013a2da8c7` |
| `.tools/presence-browser/presence-invitation-820.png` | `b12ee458bd5039272337d80514a3b01a5e846e87a0e975cb38658f082db7bfe0` |

复跑时按本机路径设置 `AI_UX_PLAYWRIGHT`、`AI_UX_CHROME`；可设置 `AI_UX_SCREENSHOTS` 保存新截图。截图含本机时钟，重新生成后摘要会改变。

```powershell
node --test test/presence-browser.test.js test/presence-http-browser.test.js test/ai-conversation-ui.test.js test/family-call-ui.test.js test/elder-frame-browser.test.js test/family-ui-lifecycle.test.js test/account-ui.test.js
```

尚待总控部署和 Windows 上报器/Link 2/实体平板全链路验收。此处不将模拟 visibility、HTTP POST、Headless Chrome 或能力替身称为真人录音、供应商语音、实体相机或 GPU 验收。
