# CareLink P1（本地、独立模块）

入口 `require('./server/carelink')`。未挂到 `server.js`、现有路由、香港存储或任何设备入口。无新增 npm 依赖。

```js
const {createCareLink, MemoryRepository} = require('./server/carelink');
const care = createCareLink({
  repository: new MemoryRepository(), // 测试用；进程退出不保留
  model: async ({text, localTime, contract, signal}) => JSON.stringify(/* contract JSON */)
});
// 仅接受已完成的 ASR 结果，audioRef 是外部私有音频存储引用。
// 实际 ASR、录音、TTS、通知发送、HTTP 鉴权由后续适配器接入。
```

## 数据契约

所有记录含 `familyId/personId/kind/id/createdAt`，按家庭和人物隔离。记录类型：

- `plan`：药名、经核对的剂量文本、时区、每日时段、余量、每次扣减单位、draft/active、核对人、可选原声音频。
- `dose`：计划 ID、日期时段、dueAt、pending/taken/not_taken/unconfirmed/missed、已通知标记、确认原音频。
- `diet`、`discomfort`、`memory`：原文、原音频引用、抽取条目；记忆含时间、地点和人物，不导入原型假病历与人物档案。
- `pending`：照片/提醒/建议，unheard/heard；提醒可含同一时段多个药品的播放项。
- `transfer`：up/down、queued/delivered、紧急优先级、幂等键和负载。
- `utterance`：一次 ASR 事件的幂等结果及原音频，听不清和模型失败保留待确认。

`repository.transaction(scope, fn)` 必须原子、串行化、异常回滚；`fn(tx)` 为同步函数，提供 `get(kind,id) / list(kind) / put(record)`。内存实现用于本地测试，调用方必须显式注入 repository，没有默认磁盘或旧 LocalStore。生产适配器需限定国内区域并实现相同事务语义。输入 scope 必须由未来鉴权层生成，不可直接信任浏览器传来的家庭 ID。

`schedule` 由调度适配器提供当地日期、时段和绝对 dueAt；本模块不启动后台定时器。按一次 occurrence 去重。保存识别草稿不激活计划，active 必须有子女核对。`refill` 同一计划/事件只补一次余量。服药确认、库存扣减、生成记录和 outbox 在同一个事务中提交。

## Agent 与护栏

`process(scope, asrResult, delivery)` 或仅生成记录的 `receive`：

1. 确定性紧急词先判断，命中后跳过模型，包括低 ASR 置信度和模型不可用。模型只能追加紧急判断。
2. 其余输入向注入模型发送原话、服务器计算的当地时间、固定 JSON 契约；不发送整本相册。超时/异常/非法 schema 走待确认，保留音频，不自动记已服药。
3. 可并行生成记忆、饮食和不适记录。服药状态必须有确定性口述依据，模型不能指定剂量记录 ID 或扣库存。
4. 输入和输出都过医疗边界检查；诊断、换药、调剂量改说“请咨询医生”。健康建议只来自注入的 `approvedAdvice`，必须返回 `{reviewed:true,text}`，否则仅确认已记录。原型“火锅照吃”、多喝水抵消盐等说法未移植。
5. 老人只收到 `elder` 投影，完整抽取和护栏原因放 `child`。普通问题/聊天给模型回答，限制两句/90 字，并作为留言保留。提示词和正则不能代替真实模型上线前的语义安全评测。

模型接口是抽象接口，可注入主模型与 `fallbackModel`：主模型调用异常/超时仅回退一次，非法 JSON 直接待确认，不回退掩盖。没有真实 M3/Flash 客户端或真实调用；生产适配器可分别绑定 M3 和 Flash。12 句 UTTER 测试注入人工写定的抽取 JSON，验证分流、数据和护栏；不证明真实模型能正确抽取这 12 句。

## 交付语义与离线

`process` 在显式传入在线传输接口时立即调用 `flush`，紧急项排在普通项之前，且不等分类模型；没有接口时返回 queued。`flush` 只在 `deliver(item,{idempotencyKey})` 明确返回 `{accepted:true}` 后标记 delivered；网络失败/无 ACK 保留队列，重试可用同一个键。传输语义为 at-least-once，接收端须按键幂等，ACK 表示适配器接受，不是人已阅读；这里没有真实短信、订阅消息或送达承诺。

下行发送成功不等于听过，只有 `acknowledgeHeard` 才改 heard。R2/H1 到达只产出红点或灯/轻音效描述，不自动切图或播报。健康数据队列在进程重启后是否保留，取决于后续持久化适配器；本轮内存假实现不提供重启恢复。

## 按键

纯函数 `keys.transition(state,event,config)` 返回状态和 effect 名称，不执行设备操作。事件为 down/up/tick/processed/playbackEnded/settingsClosed。单键长按阈值 800ms，录音上限 30s。短按依据待听内容和当前状态决定听/说/结束；播放中短按先停止再录音。双键可配置听/说键。按住、重复 down、无匹配 down 的 up 不产生重复动作，录音超时清除旧手势。UI、原生事件适配和真机时序均待后续阶段。

## 验证

`node --require ./tools/carelink/local-test-guard.cjs --test test/carelink/*.test.cjs`

完整结果和限制见本轮 `PROGRESS.md`；场景映射见 `SCENARIOS.md`。本轮止于 P1。
