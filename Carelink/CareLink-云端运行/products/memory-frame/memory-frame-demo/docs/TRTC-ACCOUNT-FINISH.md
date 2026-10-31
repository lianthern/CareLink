# TRTC 账号侧最后配置

2026-09-24。相框专用应用为 unseenframe / SDKAppID 1600164141。应用 ID 与签名密钥已由用户提供，不能把签名密钥当成腾讯云控制 API 的 SecretId/SecretKey。

当前 CloudBase CLI 可部署原云函数，但访问 TRTC 和 CAM 返回 `AuthFailure.UnauthorizedOperation`。浏览器自动化连接返回 `nodeRepl.fetch request failed`。这两条通路均无法代替账号持有人完成账号侧授权。

## 最小控制权限

已有具备下列三项权限的专用服务端子账号时，复用其凭据即可：`trtc:StartAIConversation`、`trtc:DescribeAIConversation`、`trtc:StopAIConversation`。

没有专用凭据时，由账号持有人在 [腾讯云访问管理](https://console.cloud.tencent.com/cam) 创建仅供服务端调用的子账号并绑定 [三项操作策略](TRTC-CONTROL-POLICY.json)，不需要主账号密钥、CAM 管理权限或 TRTC 全量管理策略。正式保存前应确认策略内容只包含这三项操作。

腾讯云目前将 AI 对话 Start/Describe 列为操作级授权，资源字段须用 `*`；不能声称此策略在 CAM 层仅限一个 AppID。应用源码将 AppID 固定为本机服务端配置，浏览器不能指定其他应用。依据：[官方授权粒度](https://cloud.tencent.com/document/product/598/70059)。

把该子账号 SecretId / SecretKey 直接填入本机 Git 忽略文件 `memory-frame-demo/.tools/ai-realtime.free-trial.env` 中的以下两项，真实值不发聊天、不进 Git：

```dotenv
AI_REALTIME_TRTC_SECRET_ID=
AI_REALTIME_TRTC_SECRET_KEY=
```

不要手动把实时开关改成 1。后续由程序做配置检查、部署、短通话和停止验证。

## 核对免费权益与房间权限

在 [TRTC 应用管理](https://console.cloud.tencent.com/trtc/app) 选择上述应用：

1. 查看音视频和 AI 智能语音免费包的实际剩余额度与有效期。7 天体验版仅证明功能体验资格，不证明已领 1,000 分钟 AI 智能语音额度。
2. 在功能配置核实高级房间权限。本应用的客户端只使用服务端签发的指定房间 PrivateMapKey；账号侧确认完成后才设置 `AI_REALTIME_TRTC_ROOM_AUTH=1`。
3. 保持后付费和自动续费关闭；不购买套餐。若控制台只能付费，记录实际提示再决定。

剩余真实验收包括原 hy3 流、TRTC 回调、独立云清理 Timer，以及真人麦克风、扬声器和打断。接入代码或配置就绪不等于这些验收已完成。
