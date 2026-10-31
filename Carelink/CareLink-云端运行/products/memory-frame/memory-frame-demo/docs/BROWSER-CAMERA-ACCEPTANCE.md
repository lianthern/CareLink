# 相框浏览器摄像头：2026-09-24

**发布状态**：摄像头增量随 `0.5.0` 上线；当前主服务为 `0.5.5`，功能保持。最新公网检查 `.tools/online-055-on.json`（2026-09-24T03:07:27Z）确认 35 项资源摘要、TRTC 连接域名 CSP、相框允许摄像头/家人端禁止摄像头和两原账号能力均通过；2 个检查 session 已撤销，没有 Start、模型或内容写入。此前关闭/开启检查 `.tools/online-050-off.json`、`.tools/online-050-on.json` 保留为历史。只读资源检查不代替实体相机验证；独立 TRTC 真实供应商合成语音测试结果见 [接手记录](TAKEOVER-20260924.md)。

## 本次增量与使用

相框 `/frame` → **更多 → 摄像头驻足邀请**（设置里也有入口）→ 选择内置或 USB 摄像头 → 点击 **开启摄像头与驻足邀请** → 允许浏览器摄像头权限。面朝相框停留约 3 秒后出现“想聊聊这张照片吗？”；允许语音问候时会尝试朗读。点击“和 AI 聊聊”才读取当前固定照片并提出 AI 首问，麦克风仍要另点语音按钮。

请刷新**原来已配对的相框页面**测试。总控另开的 Chrome `/frame` 不带原设备配对，不能把未配对页面当作功能异常，也不要为此次测试新建配对。腾讯云默认域名首次访问可能出现“确定访问”导航页，按[官方默认域名说明](https://docs.cloudbase.net/service/alias)进入既定相框地址后再测试。

无需更改 Windows Link 2 云端配置。既有 `living-room-link2 → Kevin` 绑定与原令牌不变；相框本机 USB 摄像头是新增接入方式。相框需要已有照片才能邀请围绕照片聊天。

检测由本机 Worker 中的官方 MediaPipe 1.0.1 / BlazeFace 短距模型完成，不能把普通运动当成人，也不声称眼睛注视、身份或活体。建议脸朝向摄像头、距离约 0.5–2 米；背对、遮挡、暗光和太远可能检测不到，静态人脸照片也可能被检测到。模型及运行时从应用同域下载，摄像头画面不上传、不保存。资源来源、许可与 SHA-256 见 `server/public/assets/mediapipe-face/1.0.1/`。

## 生命周期与服务端

- 默认不加载视觉模型、不打开摄像头，刷新不恢复开启状态。退出、后台、夜间和关闭会释放轨道、Worker、临时位图及等待中的启动；返回可见页面需重新点击。
- 开麦、播放原声或聊天时暂停采集；忙碌结束后继续之前明确开启的会话。持续在场只邀请一次，连续检测不到人脸 5 秒才重新准备邀请，至少间隔 60 秒；未知/卡住的视频不当作离开。
- 摄像头拔除、拒绝权限、设备占用和检测失败给出提示；权限弹框关闭后迟到的视频流也会释放。退出操作被发送/录音门禁阻止时保留入口，可再次开启。
- `Permissions-Policy` 只在 `/frame` 允许 `camera=(self)`；`/family` 仍禁用摄像头。CSP 只增加 `wasm-unsafe-eval`，未开放普通 JavaScript `unsafe-eval` 或外部 CDN。
- 原始 WASM 为 10,960,242 字节；无损 gzip 后 3,313,067 字节（base64 上界 4,417,424），单次云网关响应低于 6 MiB。浏览器先解压再加载，支持新版 Chrome / Safari。所有动态模块及 Worker 的请求带独立版本参数。
- 摄像头独立子任务当时未修改 TRTC、导航、传感器绑定、旧 UNSEEN 或家庭内容，也未执行部署。之后由总控与导航/TRTC 增量一起整合并发布 `0.5.0`；这里的原子任务边界不再表示当前版本“未部署”。

## 验证证据

在 macOS / Chrome 153.0.8010.53、真实生产 Node HTTP 与隔离 LocalStore 下完成：

1. 摄像头策略、Worker 生命周期与既有云邀请回归合跑 **85 项通过，零跳过**。审查修复退出被拒绝后的入口生命周期后，最终相框浏览器 **14 项复验通过，零跳过**。
2. 生产 CSP 下真实加载自托管 MediaPipe；空白图返回 `absent`，Google 官方公开 portrait 样本返回 `present / attention:unknown`。实际 canvas 视频 → 浏览器适配器 → 真实本地模型 Worker → 3 秒驻足 → 可见邀请 → 关闭释放通过。无云视觉模型调用。
3. 原生浏览器 `getUserMedia` 使用 Chrome 的 **fake hardware** 确认 `/frame` 权限策略可用、请求只有视频，`/family` 的摄像头策略仍拒绝。
4. 合成摄像头/检测、AI 和语音替身验证了 USB 选择、驻足节流、确认前无 AI/上传/开麦、确认后的固定照片首问、无人取消、后台不自动重启、夜间/撤权/拔线释放、权限拒绝、迟到授权清理和退出被阻止后的可重试入口。
5. 独立只读复审确认模型 manifest 与 gzip 校验一致、异步取消边界和 Kevin 绑定未被触碰；其发现的退出门禁前清除入口问题已修复并增加两项浏览器回归。
6. 总控已在公网 `0.5.0` 核对静态资源和两账号只读流程。它证明发布资源可取得与原账号流程可读，不证明实体相机识别、自动播放声音或 TRTC 音频成功。

定向回归命令：

```sh
AI_UX_PLAYWRIGHT=/opt/homebrew/lib/node_modules/playwright \
AI_UX_CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
node --test --test-concurrency=2 test/camera-presence.test.js test/camera-face-detector.test.js \
  test/frame-camera-browser.test.js test/presence-browser.test.js test/presence-http-browser.test.js
```

模型正样本来源：`https://storage.googleapis.com/mediapipe-assets/portrait.jpg`，176,561 字节，SHA-256 `a6f11efaa834706db23f275b6115058fa87fc7f14362681e6abe14e82749de3e`。仅用作本机临时测试，未放入产品或提交 Git。

**尚未验证**：真实内置/USB/Link 2 硬件、iPad/Safari、真人驻足识别与离开重入、外放语音是否可听见。以上合成与静态样本不替代实机验收。云端代码部署已完成；TRTC 合成音频链路由总控独立验证，实际结果见 [本次交接记录](TAKEOVER-20260924.md)，不以摄像头测试替代。
