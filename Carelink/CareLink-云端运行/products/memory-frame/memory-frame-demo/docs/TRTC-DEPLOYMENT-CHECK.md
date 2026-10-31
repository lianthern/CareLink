# 0.5.5 公网配置与资源核对

在整合后的 `memory-frame-demo` 目录执行，源码资源必须与待验证部署一致。仅复用已有两个账号登录、读取状态/配置并退出；固定原公网 origin，不创建家庭、上传内容、调用模型、启动 TRTC 或访问设备。

默认检查实时关闭；也可显式指定 `--realtime-enabled=false`：

```sh
node scripts/check-realtime-deployment.mjs \
  '/Users/max/code/unseen-takeover-20260924/unseen/private-access/online-accounts.json' \
  '.tools/deployment-055-off.json' 0.5.5
```

管理员完成接入并已启用后，仅核对配置可用性：

```sh
node scripts/check-realtime-deployment.mjs \
  '/Users/max/code/unseen-takeover-20260924/unseen/private-access/online-accounts.json' \
  '.tools/deployment-055-on.json' 0.5.5 --realtime-enabled=true
```

版本参数可省略，默认 `0.5.5`。`--realtime-enabled` 只能为 `true` 或 `false`，重复或未知参数会拒绝。结果目录须预先存在。

核对范围：

- `/family` 与 `/frame` 的 HTML 均匹配本地摘要且 `no-store`；家人端 `camera=()`，相框端 `camera=(self)`，麦克风仍限定同源。
- 两个文档的 CSP：实时关闭时仅同源/blob 连接；开启时精确核对当前 TRTC 允许列表，不接受任意 HTTPS 或通配全部站点。检测器允许 `wasm-unsafe-eval`，不放开普通 unsafe-eval/inline；worker 保持同源/blob。
- HTML 引用的脚本、样式，以及手动翻页、摄像头模块、worker、适配器与锁定 TRTC SDK 均逐文件比对。读取本地 `assets/mediapipe-face/1.0.1/manifest.json`，核对 bundle、WASM loader、压缩 WASM、tflite、许可证的文件长度和 SHA-256。
- 两账号同家庭、记忆总数一致，文字/识图能力可用；TRTC 配置开关符合参数，家庭电话仍关闭。测试会话均退出，并再次确认已失效。

结果保留 `realtimeStarts=0`、`modelCalls=0`、`realtimeTransportVerified=false` 和 `microphoneSpeakerCameraVerified=false`。配置开关为 true、资源一致不证明实际语音/摄像头运行成功，真实短通话另见 [工具说明](TRTC-SHORT-CALL-PROBE.md)。

本地回归 `node --test test/realtime-deployment-check.test.js`：7/7、零跳过。使用固定的本地 fetch 替身验证默认关闭、显式开启、错误能力开关、过宽 CSP、相框摄像头权限错误、模型资源不一致及失败后的会话退出；没有真实公网请求。
