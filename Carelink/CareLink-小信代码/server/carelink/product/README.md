# 小信 CareLink · Frame 698 本地交付

本轮按 Max 最新要求实现相框和手机，替代上一轮“默认关闭、只到 P3”的交付范围。没有部署、签名、发布、SSH、push 或新增远程。

## 最快启动（免费、假 AI）

```sh
cd <项目根目录>
node tools/carelink/product/serve.cjs
```

打开 http://127.0.0.1:8787/carelink-demo ，从入口进入手机、相框或原型演示台。入口自动加入**同一个本地测试家庭**；再次启动复用该家庭。数据保存在 `evidence/product698/local-data/`，本地测试会话在 `local-session.json`，均已忽略，不应提交。服务只监听回环地址，并由 local-test-guard 禁止外部请求及读取密钥文件。

- 手机：`/r15/carelink/product.html?view=phone`
- 相框网页：`/r15/carelink/product.html?view=frame`
- 演示台：`/r15/carelink/product.html?view=demo`。保留原型的 19 个剧本、模拟时间及示例。假 ASR 默认返回第一条 UTTER；测试相框 URL 的 `fixture=2` 使用原型第三条混合讲述。真服务忽略这个字段。
- 正常相框入口仍是 `/r15/os/index.html`，先经过原来的配对和底座。698 默认进入新界面。设备 localStorage 的 `unseen-carelink-device` 显式设置 `{"enabled":false}` 并重载，可回到旧界面。
- 单键短按：有待听内容时听，否则开始说；说话时再按结束；播放时可按键回话。长按进入原设备设置。屏幕右上切换单键/听说两按钮。

## 实现与数据

`prototype.js` 从队友原型导入，保留原交互与规则。原图 22 张已本地化，前端转成 ES2017；CSS inset 已展开，flex gap 用 margin 兼容。导入器是 `tools/carelink/product/import-prototype.py`，当前 esbuild 路径是本机已有工具，移机需调整工具位置。

同一份规则代码由 `engine.js` 在隔离的无网络 DOM 替身中运行。`service.js` 通过现有 `/api` 的登录会话隔离家庭，状态持久化到既有 store；旧照片/配对/更新/通话代码仍保留。新界面的 legacy iframe 继续加载原通话模块，回传家庭通知与设备诊断对象；新入口不会假装已经拨通。

状态修改采用 base/patch 合并，避免跨端新增照片互相覆盖。相框录音先存 IndexedDB PCM/WAV（16 kHz），稳定操作 ID 重试、服务确认后才标记已送达。照片、提醒、原声及未提交状态在本地缓存，失败仍可重试。真实 ASR 失败保存原声并给手机“待家人听取”；模型失败保留原型确定性分流；TTS 失败回退原设备/浏览器语音，播放失败保留待听内容。没有新增系统外推送渠道，手机页面关闭后不能声称紧急通知已送达。

本地演示的时间按原型加速；正常服务使用分钟节拍。节拍在 API 请求时追赶经过的分钟，因此两端都未运行时不会产生外部通知；恢复请求后补算提醒。不是独立的生产定时/通知服务。

报告解读、药盒/整袋识别、健康周报中的初始资料使用原型示例，**不是真实 OCR 或已验证医疗结果**。药盒上传继续显示原型“按示例填入、逐项核对”提示。相框没有指标、告警表单或文字输入。

## 真实 AI 接口（本轮未调用）

普通 `node server/server.js` 使用真实提供者适配器，不启用 fake。由运维在进程环境中提供配置，不把密钥写进源码：

- ASR：复用 `server/ai.js` 的 `ASR_BASE_URL`、`ASR_API_KEY`、`ASR_MODEL` 或既有 ASR relay 配置。
- 模型：复用 `AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL`；兼容 Chat Completions，含既有 MiniMax M3 工具返回适配。只抽取原话事实，原型急症/用药护栏不被模型覆盖。
- TTS：`CARELINK_TTS_BASE_URL`、`CARELINK_TTS_API_KEY`，可选 `CARELINK_TTS_MODEL`、`CARELINK_TTS_VOICE`。此适配器要求 OpenAI-compatible `/audio/speech` 返回音频；不把 MiniMax 原生 speech API 当成相同协议。

ASR/模型/TTS 均有本地超时/降级；测试通过不等于真实服务配置、额度、音色或国内速度已验证。部署的数据地域、真实 COS 和通知渠道仍需后续配置，本轮未开资源。

## 验证与构建

```sh
node --require ./tools/carelink/local-test-guard.cjs --test test/carelink/*.test.cjs
node --require ./tools/carelink/local-test-guard.cjs --test tools/carelink/product/service.test.cjs
node --require ./tools/carelink/local-test-guard.cjs --test test/photo-upload-shrink-browser.test.cjs
node tools/carelink/product/flows.cjs
node tools/carelink/product/legacy-check.cjs
node tools/carelink/compare-mirrors.cjs
```

浏览器脚本需要上述本地服务和本机 Chrome/Playwright。`flows.cjs` 使用真实浏览器录音 API 的假麦克风设备，而不是人为跳过录音上传。模型适配器测试用注入的 HTTP 假响应。

Android 验证脚本 `tools/carelink/product/emulator.cjs` 需要已启动的指定 AVD、9550 调试转发及本地服务。它使用现有 **696 测试壳 + 当前 698 网页**、本地 HTTP 拦截，并执行 `adb -s emulator-5580 shell input keyevent 231`。记录不是 698 APK 的安装验收。模拟器最终关闭；实体手机未操作。

最终未签名包：`UnseenFrame-v698-unsigned.apk`；构建回执与 SHA 在同目录。版本698，Console48未改。旧中间包保留在 `unseen-carelink-build-698/`，发布时使用 final 包对应源码重新走 Max 的签名/更新流程。

证据见 `evidence/product698/`；完整结果和限制见 `（内部记录，未公开）` 最新节。
