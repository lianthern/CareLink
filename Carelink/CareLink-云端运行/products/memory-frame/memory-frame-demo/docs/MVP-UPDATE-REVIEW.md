# 新到 MVP 项目包审查（2026-09-24）

## 结论

**不整包合并，不替换线上前后端。保留 Windows Link 2 采集/上报器作为独立设备端，与当前 0.4.7 对接。** 新包没有发现当前业务必须摘取的修复。唯一额外产品行为是老人确认后 AI 自动读图并提出第一问，需按产品选择独立实现；本次审查未改变确认行为、未调用模型或重新部署。

用户所指 `.rar.qkdownloading` 已不存在，下载完成后的文件为 `C:/Users/15pro/Downloads/unseen insta360/前后端项目包-MVP.rar`，185,719,916字节。SHA-256：`c2d2bd4ca73fd130212fffcf4f389543d4f9ebb6e52a20e6fe3aa0edd2818602`。

审查基线为本仓 `ee0bbbc`，运行版本仍为0.4.7 / `5772f48`。使用独立 `codex/mvp-update-review` worktree，源码选择性解包在忽略的 `memory-frame-demo/.tools/incoming-mvp`。包内文档仅作为交付说明，没有执行其中部署、设置云环境变量或自动启动摄像头的指令。

## 哪些内容有用

| 内容 | 处理 | 原因 |
| --- | --- | --- |
| `link2_dwell_demo/presence_uploader.cjs`、云端启动脚本 | 保留为独立设备端，用现有签发令牌连接 | 与当前协议通过实际本地HTTP联调，不需要替换服务器 |
| C++采集源码、已编译Demo及SDK DLL | 保留原私有交付，现场验收 | 本次未执行摄像头程序、未编译或验证硬件 |
| `presence-events.js`与包内server路由 | 不合并 | 较旧的共享令牌/映射方案，会替换当前独立令牌、管理和隔离边界 |
| `presence-dwell.js`、包内app与样式 | 不合并 | 当前邀请已经覆盖，混用同名全局接口会报错，整包覆盖还会退回旧界面与语音逻辑 |
| `MemoryAI.openFromPresence()` | 记录为可选产品增量，本次不摘入 | 会在确认后自动读图/请求AI；异步生命周期检查也需按当前版本重写 |
| 便携预览、家庭快照、private-access、旧Git历史 | 不入源码和公开包 | 属于旧私有交付资料，非本次功能补丁 |

## 版本与差异证据

包内 `server/server.js:299` 自报 `0.4.5-presence-mvp`。preview与development的前端87文件归一换行后相同；`ai-realtime.js`、`family-experience.js`、`family-call.js` 与历史 `561c6ec`（0.4.5）文本一致，`style.css` 也是旧版全文后追加邀请样式。两份 `store.js` 与当前版本字节相同，没有额外存储修复。

后端复核（行号指包内 `unseen/development/project/memory-frame-demo/server`）：

- `presence-events.js:59–82`：先通过全局令牌，再按请求deviceId映射家庭。一枚共享令牌能改deviceId转投另一映射家庭；用临时LocalStore复现。
- `presence-events.js:85–109`：frameId可缺省；缺省时同家庭两frame都能获得事件，已复现。不满足每设备必须绑定指定相框。
- `presence-events.js:90–98`：只保留最近32个ID，同ID改变内容仍成功；挤出第一个ID后重试从seq1变为seq34，已复现。
- 同模块只在读取时隐藏过期事件，未清理原始驻足时长/头部数量与ID；模拟一小时后仍在库。更换环境令牌后旧事件仍可下发。
- `server.js:86,129,301`：接管现有presenceReport/state，没有当前四个owner管理接口及专用2KiB请求上限，不能与当前实现并列挂载。

前端复核（行号指包内 `unseen/preview/server/public`）：

- `presence-dwell.js:64`导出consume/dispose/pending，当前MemoryPresence使用receive/close/guard，混入会破坏现有调用。
- `presence-dwell.js:58`接受邀请时不复查期限/忙碌/身份，邀请也未接线随到期、撤销或后台关闭。
- `app.js:44`只检查DOM audio，但同文件256行通过离DOM的new Audio播放原声，因此会漏判播放状态。
- 缺少当前慢state响应的RTT保守估时、存储失败不邀请、夜间时钟和迟到麦克风流清理等边界。
- `ai-conversation.js:150`的自动开场是唯一额外体验；不能为此覆盖当前完整AI模块。

## 验证范围

1. **原上报器6项测试全部通过。** 解析、字段契约、HTTPS限制、同ID重试、参数等；本机Node运行已经审阅的测试文件。
2. **原上报器与当前生产源码的6组实际HTTP场景通过。** 显式全新LocalStore、临时本地家庭、随机loopback端口：有效上报与目标隔离；同ID重试保持seq/到期；两台传感器分别投递；跨设备令牌与旧MVP共享令牌拒绝；真实Node CLI stdin/once完成captured→uploaded200且不输出令牌；轮换与撤销兼容。
3. **独立后端模块复现**使用新临时LocalStore证明上述MVP边界问题；没有使用包内快照、真实账号或云端。
4. 前端是源码/历史审查。本轮没有重新运行此前454项回归，也没有声称本轮浏览器点击、真人AI、摄像头、实体iPad或GPU验收。

HTTP脚本和脱敏结果保存在审查worktree的 `.tools/check-incoming-uploader.cjs`、`.tools/incoming-uploader-verification.json`。依赖当前主目录已安装模块；临时数据已清理。所有真实Kevin令牌继续只在原私有连接包。

## Windows接线注意点

Kevin仍使用已签发的 `living-room-link2` 与对应私有令牌，目标绑定不变。将原私有包的 `LOAD-PRESENCE-ENV.ps1` 在同一个PowerShell窗口点加载，再进入本包 `link2_dwell_demo`，使用 `start-cloud-uploader.ps1` 连接现有HTTPS服务。包内 `start-local-mvp-uploader.ps1` 连接的是本地旧MVP，不用于Kevin公网链路；包内 `.presence-mvp-token` 也不适用于当前服务。

包里有一个编译好的Demo和SDK DLL，但没有CMake要求的 `UVCCamera_win.zip` 源SDK压缩包，构建脚本还有原作者机器路径。不能宣称在任意新机器直接运行build.ps1即可重新编译。需要重编译时补齐官方SDK并调整构建路径，现有二进制仍需现场验收。

`main.cc:264–270,419`自动选择首个名字匹配的Link 2，没有摄像头序列号/设备路径命令行选择。每台Windows接一台Link 2与云端多绑定相容；同一Windows接多台摄像头仍需采集端明确选择设备，不能只启动多个相同进程。

归档目录包含private-access文件、家庭媒体/数据快照、本地传感器令牌及旧历史。**原RAR不能作为公开比赛源码上传。** 现有GitHub脱敏包保持不变；本次未把包内旧前后端或私有资料合入。
