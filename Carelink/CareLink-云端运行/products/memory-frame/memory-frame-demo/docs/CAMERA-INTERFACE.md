# 相框摄像头：本地驻足邀请

2026-09-24：相框“更多 → 摄像头驻足邀请”已挂载内置/USB 摄像头入口。用户点击开启后，本机 Worker 用固定 MediaPipe 1.0.1 + BlazeFace 模型检测人脸在场；连续约 3 秒提出可朗读的邀请，确认后打开固定照片的 AI 首问，不自动开麦。Windows Link 2 云端上报与 Kevin 绑定保持独立。用法及本轮验证见 [浏览器摄像头验收](BROWSER-CAMERA-ACCEPTANCE.md)。实机摄像头、iPad和真人声音仍待用户验收；下面保留通用适配器协议和示例。

官方 [Link SDK](https://github.com/Insta360Develop/Link-SDK) 和 [UVC 开发指南](https://raw.githubusercontent.com/Insta360Develop/Insta360-Developer_Docs/main/docs/en/sdk/link/uvc/guide.md) 列出 Link 2 及 Windows、macOS、Ubuntu 22.04；`GetTrackObjLists` 返回至多 10 个人脸框，`GetPrivacyMode` 读取隐私状态。具体 API 仍须检查型号、固件及返回值。人脸框只能作为有人在镜头范围内的证据，不能证明眼睛正在看相框。未核实到眼球/视线方向 API；`GetNewTrackObjLists` 也不是视线 API。固定官方版本、头文件与后续硬件核验项见 [Link 2 调研](CAMERA-LINK2-RESEARCH.md)。

## 已提供的文件

| 文件 | 职责 |
| --- | --- |
| `server/public/camera-presence.mjs` | 观察协议版本、停留/冷却/离开重置策略、权限和忙碌状态门禁 |
| `server/public/camera-adapters.mjs` | 原生 Link SDK 轮询接缝、浏览器本地视频检测接缝 |
| `server/public/frame-camera.js` | 用户开启、摄像头选择、忙碌/后台/退出清理及错误提示 |
| `server/public/camera-face-detector.mjs`、`camera-face-worker.js` | 本地人脸检测与 Worker 生命周期，固定自托管模型资源 |
| `test/camera-presence.test.js`、`camera-face-detector.test.js`、`frame-camera-browser.test.js` | 策略、释放、真实本地模型与生产 HTTP/CSP 下的合成摄像头验收 |

策略与适配器没有网络请求；检测 Worker 只从本应用下载公开模型/运行时，不发送图像。没有录像、摄像头上传、人脸身份识别、联系人操作或自动开麦代码。原生 SDK 的人脸坐标留在 adapter 内，策略层只接收枚举值。自定义桥/检测器也必须遵守不上传、不留存原始帧的约束；通用接口不能约束外部代码自行发网。

## 观察协议 v1

```js
{
  version: 1,
  observedAt: 1234567890, // 与 controller.now 同一时钟的毫秒值
  presence: 'present',   // present | absent | unknown
  attention: 'unknown',  // looking | away | unknown
  privacy: 'off',        // off | on | unknown
}
```

- `observedAt` 是实际采样/开始读取时刻，不能在推理或传输迟到后改成“现在”。未知、过期、重复、倒序和未来时间全部中断停留积累。
- SDK 桥没有设备侧推理时间戳时，这个字段只能表示主机读取开始时间，不能证明固件检测缓存是新的；上线前须实测持续更新和拔线状态。
- `present` 不携带身份或人数；`absent` 只能用于成功完成且确实没有检测对象的观察。错误、尚未初始化、设备断开、权限失败均为 `unknown`，不能拿它重新武装下一次问候。
- SDK 的 `privacy:'off'` 需查询成功且明确不在隐私状态。浏览器 adapter 的 `off` 只表示获得视频授权、轨道可用且未静音，不能保证 Link 2 硬件隐私开关状态。应用自己的隐私开关另由 `privacyAllowed` 控制。
- `capabilities.gaze` 必须准确申报；只有能力为真且 `attention:'looking'` 才能通过视线模式。不能把人脸框、云台朝向或检测到眼睛直接映射为正在注视。

adapter 接口：

```js
{
  capabilities: { presence: true, gaze: false },
  async start({ signal, onObservation, onError }) { /* 显式启动 */ },
  async stop() { /* 幂等释放 */ },
}
```

`start` 完成表示初始化完成，第一条观察可以稍后到达。`signal` 取消后必须立即停止定时器和已经获得的视频轨道；权限弹框/原生调用迟到返回时也必须释放、丢弃结果。自定义 adapter 的 `stop` 必须释放资源，不得后台继续拍摄。

`onError({ code:'observation-unavailable', fatal:false })` 表示某次读取失败，策略清除观察证据，adapter 可继续轮询；`onError({ code:'adapter-stopped', fatal:true })` 表示设备拔除等导致 adapter 停止，策略立即禁用并取消本次启动/观察、排队清理。用户重插后只需再次明确启用，不必先额外关闭一次。控制器错误回调不返回排队清理的 Promise，避免 adapter 在启动中等待回调与控制器等待启动形成死锁；旧会话迟到的错误无权停止新会话。

## 两种接入方式

**原生 Link SDK 优先验证。** `createLinkSdkPresenceAdapter({ readPrivacy, readFaces })` 只接收本地宿主注入的函数，浏览器不能直接调用 C++ DLL。`readPrivacy({ signal })` 返回 `off/on/unknown`，`readFaces({ signal })` 返回本次成功查询的人脸框数组；SDK 返回 false、设备不支持或无效输出应抛错/返回未知，禁止转换为空数组。实现先检查隐私，再读框，再复查隐私；仅输出 present/absent，gaze 永远为 false。默认每次读取完成后 250 ms 再读，禁止并发轮询；不自动修改相机模式、关闭硬件隐私或操纵云台。

后续宿主按同一 SDK 发行版的头文件映射 `GetPrivacyMode(int&, bool&)` 的有效状态和执行结果，不能凭 bool 参数名猜语义；遇到不认识的模式一律 unknown。必要时用桌面壳的受限 IPC 注入桥，只传这些只读方法，不开放通用执行接口。当前交付未创建本地 HTTP 端口，也不把设备控制接口暴露到公网。

**浏览器本地检测备选。** `createBrowserCameraAdapter({ detector, deviceId? })` 要求显式传入 `detector.capabilities` 和 `detector.detect(video, { signal })`，后者返回 `{ presence, attention }`。`frame-camera.js` 已接本机 MediaPipe 人脸检测器；`getUserMedia` 自身不提供识人或视线检测。只有显式启动后请求 `audio:false` 的视频，期望 640×480、5 fps、上限 10 fps；设备 ID 来自用户选择。检测完成后再查轨道状态，避免静音/拔线期间采用迟到结果。检测器模型的加载、内存/worker 释放由其拥有方负责。

## 邀请策略与应用接线

通用 controller 默认连续有效有人 2 秒，相框应用显式设为 3 秒后可邀请一次；观察最长有效 1.5 秒，相邻有效样本间隔最多 1 秒；再次邀请必须先连续确认无人 5 秒，而且距上次邀请至少 60 秒。短暂丢失/未知不算离开。禁用再启用也保留本 controller 的本次访问与冷却状态，避免反复问候。失败的回调也消耗本次访问，需要重新离开再来；策略只驻留内存，刷新页面会重置。

创建时 `enabled=false`、`visible=false`、`privacyAllowed=false`。调用 `enable({ consent:true })` 只代表用户明确选择该功能，应用还需提供可见和隐私许可状态；默认无观察。`busy:true`、`visible:false`、`privacyAllowed:false` 都立即取消邀请并停摄像头。页面隐藏或撤销隐私许可还会禁用功能，恢复可见/许可不会自动唤醒镜头，必须用户再次点击启用；仅忙碌结束可恢复先前明确启用的观察，重新积累停留。邀请持续期间若观测挂起超过有效期，定时器会取消邀请，而不是继续采用最后一次检测。忙碌状态应涵盖已有 AI 会话、录音、通话和当前不宜打断的页面；退出账号应调用 `dispose()`，不能沿用旧家庭的实例。

以下为通用宿主接入示例；浏览器实际挂载见 `frame-camera.js`。`localDetector` 与 `showInvitation` 是自定义宿主需实现的接缝；邀请按钮确认后再调用现有 `window.MemoryAI.open()`，语音按钮仍须用户单独点击。不要在 `onGreet` 内直接开麦。

```js
import { createCameraPresenceController } from '/camera-presence.mjs';
import { createBrowserCameraAdapter } from '/camera-adapters.mjs';

function prepareCameraFeature({ localDetector, showInvitation, isBusy }) {
  const adapter = createBrowserCameraAdapter({ detector: localDetector });
  const presence = createCameraPresenceController({
    adapter,
    requireGaze: false,
    onGreet({ signal }) {
      if (signal.aborted) return;
      // Invitation implementation must remove its prompt on signal.abort.
      return showInvitation({
        text: '想聊一会儿吗？', signal,
        onAccept: () => {
          if (!signal.aborted) window.MemoryAI?.open();
        },
      });
    },
  });
  const onVisibility = () => presence.setContext({ visible: !document.hidden });
  document.addEventListener('visibilitychange', onVisibility);
  return {
    async enableFromUserClick() {
      await presence.setContext({ visible: !document.hidden, busy: isBusy(), privacyAllowed: true });
      await presence.enable({ consent: true });
    },
    setBusy: (busy) => presence.setContext({ busy }),
    disableFromUserClick: () => presence.disable(),
    async dispose() {
      document.removeEventListener('visibilitychange', onVisibility);
      await presence.dispose();
    },
  };
}
```

回调只收到 `{ reason, observedAt, signal }`，没有人脸框、设备序列号、图片或身份。应用要在 `signal` 取消时收起邀请/停止尚未开始的播报；已开始的实时会话由对话模块自己的用户操作和生命周期管理。浏览器可能要求先有用户手势才能播音，此接口不绕过自动播放限制。

## 验证与剩余工作

本次运行 `node --test test/camera-presence.test.js`：35 项通过；证据为 Node 中实际模块的策略/适配器替身测试，包括拒绝权限、挂起启动取消、SDK 隐私竞态、断流、迟到观察、挂起观察导致邀请过期、隐藏后手动恢复、摄像头拔除与重新启用、启动中的终止错误无死锁及资源释放。没有创建云家庭、调用云视觉、访问摄像头或录音；不是实机检测准确率、眼动或主动对话验收。

下一步依次接入指定机器的 Link 2 与只读 SDK 桥，验证型号/固件/隐私状态/检测更新；选择有人或本地真实视线模式；增加默认关闭的设置和常驻可见隐私指示；绑定页面忙碌、隐藏、退出清理与邀请 UI；最后验证停留距离、遮挡、多人、误触发、离开重来、主动邀请与低延迟对话的联动。未完成这些步骤前，不把接口预留描述为已实现硬件自动问候。
