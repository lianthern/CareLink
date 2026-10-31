# 家庭音频通话：管理员配置与验证边界

0.4.9 按用户要求在家人端和相框高级功能中接入通话入口，与站内联系提醒分开。服务仍默认关闭；只有入口可操作，不表示当前已经配置 TURN、可以真实通话或可以拨打电话号码。服务开通和真实跨网验收仍需单独完成。


更新：2026-09-23。与 [站内联系请求](FAMILY-CONTACT.md) 分开，本模块已实现真实 WebRTC 音频通话所需的双方接听、鉴权信令和浏览器媒体流程。**默认关闭**；只有管理员明确配置受控 TURN 及临时凭据密钥后才显示可用。本次未启用真实中继、未部署、未自动呼叫家人，不能据代码、单元测试或模拟媒体测试声称双设备语音已接通。

## 最小启用配置

管理员在相框服务的运行时秘密配置中设置以下三项。它们不应写入 Git、前端、日志、任务消息或共享交付包；无需扩大相框现有 CloudBase 角色权限。

| 环境变量 | 必须值与用途 |
| --- | --- |
| `MEMORY_CALL_ENABLED` | 精确为 `1` 才尝试启用；省略或其他值均关闭 |
| `MEMORY_CALL_ICE_SERVERS_JSON` | JSON 数组，元素只能有 `urls`；必须包含 `turn:` 或 `turns:` 受控中继 |
| `MEMORY_CALL_TURN_SECRET` | 至少 32、至多 512 字符的随机共享密钥；需与受控 coturn 的 TURN REST 密钥一致 |

只含占位域名的格式示例如下，**不是可用服务器，也不会被作为默认值**：

```json
[{"urls":["turns:turn.your-controlled-domain.invalid:5349?transport=tcp"]}]
```

应用不提供公共 STUN/TURN 默认值，不接受用户请求体传入中继地址，不支持 JSON 内的静态 `username`/`credential`。JSON 最多 4 个元素，每元素最多 4 个地址、全配置最多 8 个地址；地址只能使用 STUN/TURN 协议和可选端口/transport 参数。仅配置 STUN、缺密钥、格式错误或开关关闭时，能力检查返回明确不可用原因，发起 API 返回 503。管理员需确认所填域名与中继在自己的控制或明确授权范围内；应用不会自动购买、开通、试用第三方服务或修改 DNS。

前端强制 `iceTransportPolicy: 'relay'`，必须经配置的 TURN 建立音频链路。该选择增加中继流量，也避免把同一局域网直连成功误当作已经有跨网方案。TURN 是用于无法直接建立连接时转发媒体的服务，服务地址与认证信息通过 `RTCPeerConnection` 的 ICE 配置提供。[WebRTC 官方 TURN 说明](https://webrtc.org/getting-started/turn-server)

## 中继端必须匹配的配置

对于管理员已拥有的 coturn，需要启用 `use-auth-secret`，使 `static-auth-secret` 与应用运行时的 `MEMORY_CALL_TURN_SECRET` 相同，并配置自己的 `realm`。应用生成的用户名为“到期秒时间戳:设备范围摘要”，密码为对该用户名执行 HMAC-SHA1 后的 Base64；共享密钥本身不发送到浏览器。[coturn 官方认证文档](https://github.com/coturn/coturn/wiki/turnserver)

使用 `turns:` 时，TLS 证书必须匹配配置的中继主机，服务端需配置证书、私钥和 TLS 监听端口。管理员还需核实公网/NAT 映射、监听端口、`min-port`/`max-port` 指定的中继端口范围及防火墙放行与部署网络一致，并按容量设置配额和带宽限制。这些属于中继自身运行条件，不能靠增加 CloudBase 数据库权限解决。[coturn 官方配置示例](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf)

上述是配置契约，不是已经执行的资源变更。现有服务器、证书、网络和流量费用需要由实际中继管理员确认；本次没有读取或索取真实密钥，没有购买或开通后付费资源。

## 身份、状态与生命周期

家庭成员 ID 来自当前有效家庭会话，账号按账户 ID 去重，旧邀请/相框按会话 ID 区分。真实通话的发起设备绑定当前会话；接听方多设备同时接听时，CAS 只允许一台设备成功绑定。其他同账号设备能看到通话摘要，但不能取得 ICE 凭据、读取对端 SDP/ICE、发送信令或挂断。相框端可以作为双方之一。

| 服务端状态 | 含义 |
| --- | --- |
| `ringing` | 已保存呼叫，等待对方主动接听；页面内提醒，不是系统来电推送 |
| `accepted` | 对方在一台设备上主动接听，尚无媒体连通证明 |
| `connecting` | 正在交换音频描述或网络候选，尚无媒体连通证明 |
| `declined` / `ended` | 对方拒接，或参与设备主动结束/取消 |
| `failed` / `expired` | 权限、设备心跳、配置或连接失败，或服务器时限到期 |

服务端没有 `connected` 状态。浏览器只有在自身 WebRTC 连接和远端音轨满足条件后才能显示媒体已连接；如果音频自动播放被阻止，需给出可操作的播放错误提示。双方都在接听后才申请麦克风，拒接不申请麦克风。关闭、隐藏、取消、退出或会话失效时，前端释放音轨、连接、音频元素、轮询与待完成请求，并尽力发送结束信号。浏览器媒体采集仍需要安全上下文和用户权限。[MDN：getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)

响铃 60 秒后过期；接听后通话最多 15 分钟。活动通话每约 1.5 秒读取指定通话状态，每端心跳最多每 10 秒持久化一次；任何一端超过 45 秒没有心跳，另一端下一次读取时得到失败状态。页面关闭或后台挂起不会得到系统唤醒保证；当前没有 Push API、Service Worker 来电订阅或操作系统电话集成。

每次 API 请求重新验证当前会话和账号；读取或提交信令时仅绑定设备可操作。撤权检查直接读取既有通话的确切设备/账号，再按同一个设备绑定应用 CAS 变更，不会仅凭较早的成员列表中“没有这个会话”永久终止后来创建或接听的通话。

撤权会立即阻止后续受鉴权的 API 与新凭据获取，在线正常客户端从后续状态响应释放媒体。已签发的 TURN 凭据有效至该通话 15 分钟硬截止后 60 秒；应用退出不会让中继已发出的临时凭据瞬间失效。若未来要求中继层即时撤销，还需对受控 TURN 增加分配清理/撤销集成，不能把应用鉴权误称为已完成中继强撤销。

## 后端接口

```js
const { createFamilyCall } = require('./family-call');
const calls = createFamilyCall(store, { allowed: accounts.allowed });
// 现有路由 session(token) 成功后调用；模块内部仍复核会话。
return calls.handle(action, data, s);
```

| action | 输入 | 返回 |
| --- | --- | --- |
| `callCapabilities` | `{}` | `enabled/audioCall/reason/mode`、轮询/时限/候选上限；不含地址、密钥或凭据 |
| `callState` | `{}` 或 `{id}` | `{capabilities,members,calls,serverTime}`；指定 ID 时另有 `call` 并为绑定设备更新心跳 |
| `callStart` | `{targetId,requestId}` | `{callId,call,serverTime}`；稳定请求 ID 避免重复振铃 |
| `callCancelStart` | `{requestId}` | `{cancelled:true,callId,call,serverTime}`；不必拿到 call ID 即可取消未决发起，尚未创建时 callId/call 为 null |
| `callAccept` / `callReject` | `{id}` | 仅目标家人接听/拒接；原接听设备的拒接也可结束已接受的通话，返回同上 |
| `callEnd` | `{id,reason?}` | 绑定设备结束；reason 仅 `hangup/failed/cancelled` |
| `callIce` | `{id}` | 已接听的绑定设备得到 `{iceServers,iceTransportPolicy:'relay',expiresAt}` |
| `callSignal` | `{id,description?,candidates?,iceComplete?}` | 保存本端信令；返回 `{callId,call,serverTime}` |

`call` 元数据含 `id/from/to/direction/status/createdAt/updatedAt/ringExpiresAt/expiresAt/revision/canControl`。`from/to` 仅为 `id/name`；`direction` 为本人视角的 `incoming/outgoing`。通话列表不含信令；指定 `callState{id}` 或写入响应，仅在当前会话是该通话已绑定设备时含 `peer:{description,candidates,iceComplete}`。

`description` 为 `null` 或 `{type:'offer'|'answer',sdp}`；发起方只能提供 offer，接听方等 offer 存在后提供 answer。每端描述一经确定不可更换，相同内容重试幂等。只接受恰好一路 `m=audio` 的 SDP，每份最多 24 KiB。完整 SDP 协议合法性最终由浏览器 `setRemoteDescription` 验证。[W3C WebRTC 标准](https://www.w3.org/TR/webrtc/)

`candidates` 输入为 RTCIceCandidateInit 数组，每次最多 8 条、每端累计最多 48 条，每条 candidate 字符串最多 1,024 字节；按协议字段位置解析类型，只接受 `typ relay`，拒绝 host/srflx 或尾部伪造类型。SDP 内嵌候选使用同一校验、去重和每端 48 条总额：服务端将其移入 trickle 列表并从转发的 SDP 移除候选行，真实 `localDescription` 自带的 relay 候选可以正常提交。输出为 `[{seq,candidate}]`，序号从 1 开始，重复候选不重复追加。先发送全部候选，再发送 `iceComplete:true`；完成后只能重试已有候选，不能追加新候选。浏览器需在远端描述就绪后才调用 `addIceCandidate`。

## 持久化边界与限流

- 每家庭一个 CAS 文档；最多同时 2 通呼叫，每个家庭成员只可参与 1 通活动呼叫，交叉发起不生成两通并存呼叫。
- 每人 10 分钟最多 4 次、每家庭最多 12 次，取消不退额度；重启服务不清除预算。
- 关闭未决发起使用原 `requestId` 调用 `callCancelStart`，在同一 CAS 账本写取消记录。即使原请求已落库但响应丢失，也能结束该通话；取消先于延迟发起写入时，后来相同 ID 的发起会被拒绝。只有原发起设备可取消已存在请求，未知 ID 的取消同样计入持久预算，防止空取消撑大账本。取消失败不能谎报已取消；前端保留有限重试状态，并且关闭后不会自动恢复麦克风采集。
- AI 音频候选的准备结果带 `callRequestId`，与后端实际执行编号同源。前端在确认请求发出前保存编号与原登录令牌；关闭或隐藏时用它取消，不依赖中止后的 fetch 返回。取消先落库会阻止迟到执行创建呼叫。隐藏的已知呼叫只请求结束，不弹窗、不记录新的开麦意图。
- 接听已经落库但响应丢失时，旧 UI 可能仍发 `callReject`；服务器仅允许该次绑定的原接听设备将 accepted/connecting 原子改为 ended。另一台同账号设备不能借此挂断。拒接先落库则后到的接听失败。
- `callCancelStart/callReject/callEnd` 共用当前页面内存中的待确认队列，按原令牌、操作、编号去重，最多 20 项、保留 24 小时。每次已鉴权刷新最多处理 2 项，每项最长等待 4 秒；只在取消明确成功或匹配通话返回终态时清除。网络失败明确显示服务器尚未确认，后续刷新重试；有待确认结束或队列满时禁止再次发起/接听/恢复。页面进程终止后内存队列不保证保留，服务端响铃/心跳/硬时限仍为最终清理边界。
- 另一设备抢先接听时，本机旧拒接可能返回 403/409；仅此路径会在同一 4 秒截止内使用原令牌查询指定通话。只有匹配编号且确认为终态，或 incoming/accepted/connecting 且本机无控制权，才清除本机拒接意图。后一种明确显示由其他设备接听，不结束对方、不声称服务器已挂断；错误、编号不符或权限归属未证实时仍保留重试。
- 最多保留 20 条可见历史、最长 24 小时。有限的请求 ID 摘要账本保持同一天内重试幂等，即使通话已被移出可见历史也拒绝同 ID 重新振铃；房间配额使账本日上限有界。
- SDP/ICE 不写应用日志、不发给家庭其他成员；终态被处理时立即从该记录删除信令。到期为惰性清理：没有后续请求的存储记录不会凭空被定时任务删除，下次读写时执行清理。需要固定时点的物理删除时应另加受审计的清理任务。
- 短期 ICE 凭据只在双方接听后经鉴权接口返回，不保存在通话文档；浏览器为了使用中继会持有短期凭据，但永远不获得服务器共享密钥。
- 返回值和 UI 都不以信令成功声称音频已经互通；能力开关可用也只表示配置齐全，不证明服务器可达、证书有效或中继流量已通过。

## 本轮验证与待验

最新相关 5 份测试（`ai-actions`、`ai-conversation`、`ai-conversation-ui`、`family-call`、`family-call-ui`）共 140 项通过，其中通话后端 27 项、通话前端 VM 35 项。新增真实 `LocalStore/createActions/createFamilyCall` 与前端控制器联动，模拟后台已保存结果但浏览器中止后永远不返回响应，验证关闭/隐藏取消 accepted 通话、取消先于迟到发起、断网后按原令牌与编号重试；媒体对象仍为模拟。独立复审另用真实持久后端复验多设备接听与旧页面拒接，不挂断其他设备且不遗留本机队列。主路由隔离本地 HTTP 测试另验证接线。`d6e81b9` 的完整项目 272 项回归是此前基线，后续按修复运行上述相关测试。这些验证均不等于真人媒体验收。

仍需管理员提供真实受控 TURN 配置后，在明确授权的两台设备上验证：麦克风授权/拒绝、实际双方听到声音、静音、拒接/取消/挂断、断网/恢复、退出/撤权释放、Wi-Fi 与蜂窝跨网中继、TLS 与目标浏览器/微信兼容。应该把浏览器连接统计的 relay candidate pair 与真人双向可闻证据一起记录，不自动呼叫真实家人补证据。
