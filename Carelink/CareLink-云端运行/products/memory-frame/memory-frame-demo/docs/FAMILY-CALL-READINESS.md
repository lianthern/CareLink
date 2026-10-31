# 家庭通话入口接线检查（2026-09-24）

本轮从 `35c915e` 检查现有家庭 WebRTC 音频模块，只补模块内部生命周期，不启用 TURN/TRTC，不拨打真实家庭。私有部署文件只读检查：`MEMORY_CALL_ENABLED`、`MEMORY_CALL_ICE_SERVERS_JSON`、`MEMORY_CALL_TURN_SECRET` 均未配置，家庭通话仍关闭。AI 实时语音与家庭通话是两项独立服务。

## 入口应如何接线

- 加载 `family-call.js` 与既有样式；家人/相框点击入口只调用 `MemoryCall.open()`。它读取能力和成员，不自动呼叫，不申请麦克风。不可用原因来自 `callState.capabilities.reason`；`supported()` 只说明浏览器支持，不能代替服务能力检查。
- 已登录的正常轮询调用 `MemoryCall.refresh()`，退出、重新配对或会话失效时调用 `MemoryCall.dispose()`。模块自己处理后台、页面离开、离线、权限拒绝、迟到麦克风和结束重试。初始模块没有被首页加载，本分支的 Chrome 用例是显式加载模块，完整首页接线由前端分支单独验收。
- 普通 AI、AI 实时入口、原声录音（含等待授权）和原声播放入口需检查 `MemoryCall.busy()`。模块在发起、接听、恢复、取得 ICE 和麦克风迟到返回后，反向检查原声录音及 `MemoryRealtime.busy()`；AI 实时挂断尚未确认也视为忙碌。真正进入家庭音频前通过 `MemoryAI.pauseForCall()` 停止 AI 录音/朗读/未决工作，暂停页面音频。
- 保留 `MemoryCall.cancelStart/hasPendingCancellations/canStart`，用于已有 AI 确认动作和原身份的有限结束重试。HTTP 成功仍需匹配通话终态，不能把未确认的挂断称为服务器已结束。
- 来电是页面内按钮，不申请 Notification 权限、不会在系统后台唤醒；双方都需打开页面。显示音频已连接仍要求连接状态、远端音轨和实际播放均就绪。

## 本次修复与证据

模块新增等待原声录音授权、AI 实时占用和离线门禁；ICE/麦克风异步返回后再次核验。离线立即释放本机媒体并保留原绑定结束重试，恢复网络不会自动开麦。状态响应按完整请求耗时保守扣减服务器期限，到达时已过期的 accepted 状态不会启动采集。

媒体修复阶段定向验证共 **71 项通过、零跳过**：`family-call-ui.test.js` 42 项（DOM/音频替身）、`family-call.test.js` 27 项（新临时 LocalStore）、`family-call-readiness-http-browser.test.js` 2 项（实际 Node HTTP、隔离 LocalStore、真实 Chrome）。新增 HTTP 检查默认关闭及 503、接听方限制 403、跨家庭 404、退出失效 401；Chrome 分别检查家人/相框不可用入口，麦克风、RTC、通知权限调用均为零，联系提醒仅打开检查界面不发送请求。合成 TURN 占位配置仅用于本地后端信令鉴权，不给浏览器签发 ICE，不连接中继。

另一个独立提交修复云数据库预算存储：实际 CloudBase SDK 离线序列化证明 `budget.senders: {}` 会被省略，旧发送者计数会残留，之后可能继续错误限流。现在以 `[{id,count}]` 整体替换，过期窗口写入 `[]`。当前窗口的旧对象计数按原值迁移，避免重置后绕过限流；到期时丢弃旧窗口所有计数。迁移在下一次既有通话文档写入时完成，不新增云资源、后台扫描或启用配置。

预算阶段新增 3 项定向回归，后端现为 **30 项**：生产 `CloudStore.mutate` 配合模拟嵌套合并传输，两实例竞争仍只允许剩余的一次预算；新旧格式到期均清空旧发送者；真实 SDK 传输被替换，仅检查序列化，无外部请求。最终后端与上述实际 HTTP/Chrome 两项合计 **32/32、零跳过**；加上此前未变的前端 42 项，本轮相关覆盖 74 项。SDK 用例需要安装既有服务端依赖，或通过 `NODE_PATH` 指向已有依赖目录；缺 SDK 会显式跳过。

运行：`node --test test/family-call-ui.test.js test/family-call.test.js test/family-call-readiness-http-browser.test.js`。Chrome 用例需设置 `AI_UX_PLAYWRIGHT` 为本机 Playwright 包路径、`AI_UX_CHROME` 为 Chrome 可执行文件；缺少时显式跳过，不能计作已验收。

没有部署、真实中继、双设备真人语音或实体相框验收。完整 UI 接线和反向入口互斥以总控整合后的浏览器结果为准。受控 TURN 配置及真实跨网验收要求继续见 [家庭通话协议](FAMILY-CALL.md)。
