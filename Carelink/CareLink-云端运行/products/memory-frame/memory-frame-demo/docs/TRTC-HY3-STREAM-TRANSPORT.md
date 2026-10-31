# TRTC 桥接用 hy3 可取消传输层

核对日期：2026-09-24。独立分支 `codex/hy3-stream-transport`，基于 `35c915e`。本次只增加传输模块、独立测试与本文档；没有修改实时会话、TRTC 配置、HTTP 路由或既有文字聊天。没有读取私有配置、调用云模型、开通服务、升级套餐、扩权或部署。

## 接口与职责

```js
const { createHy3Stream } = require('./ai-realtime-hy3-stream');
const hy3 = createHy3Stream({ app: store.app });
for await (const text of hy3.stream({
  messages: [serverSystemMessage, ...validatedConversation],
  signal: controller.signal,
  maxTokens: 256
})) {
  // 调用方负责包装 chat.completion.chunk、SSE 背压和错误终止。
}
```

导入、创建适配器和创建 iterator 均不会发请求，首次 `next()` 才开始。要求显式 `AbortSignal`。断开、停止、撤权或下游错误时必须 `controller.abort()`；只在尚未完成的 `next()` 后调用 iterator 的 `return()`，不能保证立即取消。正常 `for await` 的 `break` 在返回首片后会执行清理。

适配器只输出纯文本片段，不输出工具、推理、usage、供应商错误、URL 或凭据，也没有行动执行器。SSE 转换、固定 system policy、短令牌鉴权、家庭/会话绑定、原子并发、撤权复查与轮数预算属于外层桥接职责。本模块不能单独作为公开代理。

请求固定 `cloudbase/hy3`、`stream:true`、`temperature:0.2`、`enable_thinking:false`；后者与既有 CloudBase probe 一致，显式要求关闭思考，避免短回复预算用于推理。`maxTokens` 为 1–256，默认 256。仅接受 `messages/signal/maxTokens`，最多 16 条消息、单条 8192 字符、合计 16384 字符，只准 `role/content`，首条可为 system，其余只准 user/assistant。不得把客户端原始消息或 system 字段直接传入，也不能覆盖思考开关。锁定 AI SDK 的 DefaultSimpleModel 对额外字段作原样透传；腾讯[兼容协议说明](https://intl.cloud.tencent.com/zh/document/product/1300/82345)列出该简化开关，但具体 CloudBase hy3 的实际效果仍需真实流验证，不能据本地请求体断言供应商必然生效。

总传输期限 45 秒，包含获取凭据与模型流。凭据响应至多 64 KiB、模型流至多 256 KiB、单事件至多 16 Ki 字符、回答至多 16 KiB；超过即销毁连接。无重试、无重定向、无 API Key 参数或任意 URL。收到 `[DONE]` 才正常完成；缺少终止标志的 EOF 报错，即使此前已有回答片段。

## 为何不直接使用 SDK streamText

审计本机锁定 `@cloudbase/node-sdk@3.18.3` / `@cloudbase/ai@2.30.0` 源码：

- AI 包 `dist/cjs/models/model.js` 的 `processInput` 分离 `abortSignal`；`ReactModel.streamText` 未把它交给 `doStream`。流还经过多个 `tee()` 分支，不能仅取消 `textStream` 就假定上游已停止。
- node-sdk `dist/ai/request-adapter.js` 的 `fetch` 只取 URL、stream、timeout、method、headers、body；`AIRequestAdapter` 未传 signal，`tcbopenapicommonrequester.request()` 也没有向调用方交付响应头前的 `ClientRequest`。
- 该 adapter 的 Web 流 `cancel()` 在响应后会调用 `nodeStream.destroy()`，但不能弥补响应头前取消缺口。

因此没有用 Promise.race 包装上述调用，也没有升级、修改或 monkey patch SDK。最小替代是在新模块中复用锁定 SDK 导出的 `TcbOpenApiHttpCommonRequester`、`prepareCredentials` 和网关构造函数，自己持有 Node HTTPS 的实际请求/响应句柄：

1. 通过 SDK 原有 `app.config` 与运行身份签名，向同环境 `/auth/v1/token/clientCredential` 发送 `{grant_type:'client_credentials'}`。这是 SDK `auth().getClientCredential()` 的同一请求，不另建管理员 Key。
2. 只在本进程拿到的 access token 用于同环境 `/v1/ai/cloudbase/chat/completions`。请求头与 Bearer 处理复用同一 SDK builder，显式 `Accept: text/event-stream`。
3. 两段网络请求都由 Node `https.request` 执行；AbortSignal 或期限到达直接 `destroy()` 当前 `ClientRequest` 与 `IncomingMessage`。消费者暂停在 yield 时也会执行销毁。没有后台遗留的凭据请求或 SDK tee 分支。

拒绝自定义 serviceUrl、proxy、accessKey 和跨账户回调；环境必须是当前 CloudStore 的显式 envName，不推导客户端地址。SCF 下沿用 `scf` 来源标签，本地使用 `unknown`，避免 SDK 可选的实例元数据网络探测。签名材料不返回调用者、不记日志，不修改原 app.config。SDK 内部版本必须为审计的 3.18.3，未来升级需重新核实，版本不符即拒绝执行。

追加复核：`tcbapirequester.prepareCredentials` 在跨账户回调被排除后仅调用同步 `getCredentialsOnDemand`；该函数只读取已有 config 或 `CloudBase.getCloudbaseContext()` 的进程环境/上下文，访问实例元数据的旧代码均为注释。本模块没有调用 `request()`、`getCurrRunEnvTag()`、`checkIsInTencentCloud()` 或 SDK 实例构造器。`auth().getClientCredential()` 原样返回 `result.body`，`dist/ai/index.js` 从中取 `credential.access_token`，与本模块解析字段一致。model signer 的 `args.token` 优先于运行身份签名成为 Bearer，因此不会再触发另一轮鉴权请求。上述为锁定源码复核，不涉及读取本机真实凭据。

## 实际验证与剩余边界

执行：

```powershell
node --test test/ai-realtime-hy3-stream.test.js
```

本次 **25/25 通过，零失败、零跳过**。新 worktree 未安装另一份依赖，验证时以进程级 `NODE_PATH` 只读复用了原工作区锁定的 server/node_modules；没有变更依赖文件。`git diff --check` 通过。

测试实际启动 loopback Node HTTP 服务，以仅供测试的函数注入将 SDK 生成的固定 HTTPS 目标导向该服务，使用合成身份。四项取消测试分别覆盖凭据/模型的响应头前与后，头后以客户端已收到 response 回调为准，并确认对端发生未完成响应的 close、ClientRequest 已 destroyed。另覆盖消费者暂停时 abort、读取前/读取中总超时、消费者 break、供应商 `[DONE]` 后仍不关闭连接、并发相互隔离、UTF-8/CRLF 分片、请求/响应上限、协议异常、错误脱敏及监听器移除。

这是**本地实际 HTTP 取消与 SDK 签名形状证据**，不是 CloudBase、TRTC、真人语音或供应商计费证据。上线前仍需在既有运行身份完成一次真实短 hy3 流验证，并确认腾讯侧在连接断开后停止推理；本机 socket 已关闭不等于已证明远端计算或费用立即停止。TRTC 路由/令牌/持久并发/跨实例停止、房间音频和打断由总控另验。适配器完成本身不应打开 `AI_REALTIME_ENABLED`。
