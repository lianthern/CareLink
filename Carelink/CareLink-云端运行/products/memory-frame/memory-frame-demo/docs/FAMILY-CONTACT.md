# 家庭联系：实现、接入与验证边界

更新：2026-09-23。本次用户明确“呼叫”指联系家庭成员；本文件描述的模块是**站内联系请求与确认收到**，不是语音通话、视频通话或系统电话。真实音频通话已另增独立模块，配置与验收边界见 [FAMILY-CALL.md](FAMILY-CALL.md)。没有后台常听、外部消息、短信、推送或真人拨号，也没有创建新的云资源。

## 只读参考审计

审计参考为交付包 `reference-product/unseen-full`（完整旧 UNSEEN 跟踪快照）与 `D:/CodexData-20260923/Projects/UNSEEN2.0/unseen-github`。对代码及文档检索 `RTCPeerConnection`、`WebRTC`、`webrtc`、`tel:`、`makePhoneCall`、`视频通话`、`语音通话`、`呼叫`、`联系家人`、`拨打`，未找到可复用的家庭通话或拨号实现。没有读取旧私有配置、环境文件或凭据，没有修改旧源码、服务或 DNS。

本模块复用相框当前的 `accounts.allowed`、`session`、`LocalStore/CloudStore.mutate` 和前端鉴权 `api`；无需重建账号、家庭或存储权限。

## 当前可用闭环

1. 已登录成员在“联系家人”中选择本家庭有效成员，主动点“发送联系请求”。可以选择有效家人账号（包含正常退出后暂时离线的账号）或有效配对会话的相框。
2. 服务端保存请求。对方页面的主状态轮询调用 `MemoryContact.refresh()` 后显示站内提醒；没有投递到操作系统或外部应用。页面关闭、后台挂起、断网时不能保证收到提醒。“最近打开过页面”只表示既有会话 `lastSeen`，不是已送达、正在收听或可拨通。
3. 收件人可点“确认收到”或“暂不方便”。确认只代表读到了联系请求，双方可以用已有联系方式继续联系；界面与接口不称为“已接通”。发件人能读到回应。
4. 待回应请求可由发件人取消；确认后双方均可结束。待回应 5 分钟过期，确认后 30 分钟过期。所有判断以服务器时钟为准。

当前没有媒体流，不申请麦克风或摄像头，也没有音频资源需要释放。关闭面板、退出会话、会话失效、切换账号或离开页面会中止模块的网络请求，忽略过时响应并清除展示的私有状态。已保存请求不会因浏览器关闭而伪装为“已取消”，而是根据成员有效性和服务器到期时间结束。

## 接入契约

服务端创建：

```js
const { createFamilyContact } = require('./family-contact');
const familyContact = createFamilyContact(store, { allowed: accounts.allowed });
// 在现有 session(token) 成功之后分派；模块内部仍重读会话与账号权限。
return familyContact.handle(action, data, s);
```

| action | 输入 | 结果 |
| --- | --- | --- |
| `contactState` | `{}` | 本人可见的成员与联系状态 |
| `contactRequest` | `{ targetId, requestId }` | 保存后状态；`requestId` 为每次用户发起稳定的 8–100 位字母、数字、下划线或短横线 ID，网络重试沿用 |
| `contactRespond` | `{ id, response: 'acknowledge' \| 'decline' }` | 仅收件人可回应 |
| `contactEnd` | `{ id }` | 发件人取消待回应请求，或任一方结束已确认请求 |

所有成功结果均含 `members: [{id,name,role,recentlySeen}]`、`requests`、`incomingCount`、`mode:'request-only'`、`audioCall:false`、`backgroundPush:false`、`serverTime`。`members` 排除本人；账号以账户文档 ID 去重，旧邀请与相框以会话文档 ID 区分。目标 ID 只能从当前家庭实时有效成员中解析，不接收电话号码、外部地址或任意目标账号。API 返回值不包含会话 token、账号凭据、请求幂等内部摘要或其他人的联系记录。

`requests` 元素含 `id/from/to/status/createdAt/updatedAt/expiresAt/direction`；`from/to` 仅含 `id/name`，`direction` 为本人视角的 `incoming/outgoing`。状态为 `pending`、`acknowledged`、`declined`、`cancelled`、`ended`、`expired`、`unavailable`。

前端加载 `family-contact.css` 与 `family-contact.js`，入口点击调用 `window.MemoryContact.open()`；现有主状态轮询成功后调用 `MemoryContact.refresh()`（内部至少间隔 5 秒），退出与会话失效调用 `MemoryContact.dispose()`。模块独立 `<dialog>`，样式仅作用于自己的 ID，并继承全局字体。主导航的首页、中央加号、我的顺序不变。

AI 行动模块如生成联系建议，需先向用户展示成员和“站内联系请求”的实际行为，再经显式确认调用 `contactRequest`；候选对象不构成发送授权，确认时必须重新读取成员。对于 `ai-actions`，`roster(s)` 可包装 `handle('contactState', {}, s).members`，`contactRequest(data,s)` 可直接包装相应 action。

## 权限、有界状态和真实错误

- 每请求重读会话记录及账号有效性，校验家庭、角色、过期、撤销；拒绝跨家庭和伪造 caller。注册账号的家庭成员资格与会话在线状态分开，正常退出不会丢掉未过期提醒。目标真正失效后不能新发请求，活动请求在当前响应中呈现 `unavailable`，不会仅凭一份较早的成员快照将并发新请求永久覆写为失效。
- 只允许请求的两个参与者读取该请求；只有收件人能确认收到或婉拒。
- 每家庭一个 CAS 文档，最多 40 条、保留最长 24 小时；过期变更读时持久化，成员不可用是动态权限投影，普通轮询无变更不写库。正常退出后的有效账号可重新登录后看到和回应原请求；已撤销或离开家庭的账号不能读取或回应。
- 10 分钟内每发件人最多 6 次、全家庭最多 30 次；取消不退还额度；每发件人最多 3 条活动请求，每收件人最多 5 条。双方间已有活动请求时拒绝新建反向/同向重复请求。
- 同 `requestId` 重试只产生一条记录、一次额度计数；尝试用同一 ID 更换目标返回 409。新请求达到上限返回 429，移除/不存在目标返回 404，错误回应状态返回 409。
- 请求超时有真实错误文案，可使用原 ID 重试；超时不会谎报服务器未保存。旧的状态读取不能覆盖新确认结果。服务端已接受的请求与浏览器取消等待是不同事件。

## 真实通话仍需的工作

截至本次官方文档核查，WebRTC 的媒体连接通常需要 ICE/STUN/TURN 配置并通过应用信令交换协商信息。这个站内提醒模块不交换 SDP/ICE，也不建立 `RTCPeerConnection`；独立音频通话模块的信令、媒体权限、连接状态和释放实现见 [FAMILY-CALL.md](FAMILY-CALL.md)，真实中继与双设备验证仍需完成。[WebRTC 官方入门](https://webrtc.org/getting-started/peer-connections)

跨不同网络要准备受控且可审计的 TURN 中继及临时凭据、网络端口、带宽容量与流量预算；是否需要付费及价格取决于自建或供应商。不能据现有 CloudBase 数据库/HTTP 函数已授权推定新的中继购买、后付费或云角色授权已经获准。STUN 单独存在不保证所有网络连通。[WebRTC 官方连接说明](https://webrtc.org/getting-started/peer-connections)

浏览器采集语音需安全上下文与用户麦克风权限，设备、iframe 权限策略或浏览器限制可能阻止获取媒体；需要两台真实设备在 Wi-Fi、蜂窝、微信内置浏览器等目标环境验证。必须在取消、拒绝、挂断、退出和页面离开时释放所有媒体轨道及连接。[MDN：getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)

页面关闭时的提醒属于另一层能力，需要受支持的 Push API、Service Worker、用户订阅/权限与服务端推送；当前未注册这些能力，不能承诺锁屏或后台来电。应单独核验 iOS、Android 与微信的实际支持条件，再选择方案。[MDN：Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)

## 验证记录

- `node --test test/family-contact.test.js`：12 项本地单元测试通过。覆盖有效成员去重、完整双方状态机、跨家庭/参与者权限、移除与过期、正常退出后的账号重新登录、旧成员快照并发加入回归、12 路同时重试幂等、限流持久化、服务器过期和历史上限。
- 前端验证命令为 `node --test test/family-contact-ui.test.js`。测试使用 Node VM 执行真实模块，验证请求取消、重试、过时状态、会话隔离和站内提醒；不是浏览器点击证据，后续前端修复应以最新回归结果为准。
- 未创建云家庭、未向任何真人发联系请求、未发送外部消息、未部署。
- 未完成双真实浏览器点击/提醒、真机、后台/锁屏推送或 WebRTC 音频连通验收；当前实现本身不提供这些媒体/后台能力。
