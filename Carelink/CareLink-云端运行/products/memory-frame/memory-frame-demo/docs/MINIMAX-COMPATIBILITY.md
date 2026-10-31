# MiniMax M3 兼容性核验

2026-09-23。仅核验官方文档、修改相框 Demo 的兼容请求与运行本地替身测试；本任务未读取凭据、调用模型、改配置、部署或修改旧 UNSEEN。旧源码中的 MiniMax 接口实现不等于旧账号已通过真实视觉调用。

## 必要适配

[官方 OpenAI SDK 文档](https://platform.minimax.cn/docs/api-reference/text-openai-api)说明 M3 默认开启 thinking，内容可能放入 `message.content` 的 `<think>` 标签；`thinking: {type: 'disabled'}` 才会关闭思考，`reasoning_split: true` 只负责分离输出。相框仅解析严格 `{answer, action}`，因此在精确匹配以下配置时加入这两项参数，并将输出限制字段换成 `max_completion_tokens: 1200`：

- `AI_VISION_MODEL=MiniMax-M3`。
- `AI_VISION_BASE_URL=https://api.minimax.cn/v1`，或官方国际端点 `https://api.minimax.io/v1`；可有末尾单斜杠。
- `AI_VISION_API_KEY` 由总控在现有私有配置中设置；不写入本文或 Git。

同一适配也适用于显式指定对应 `AI_MODEL/AI_BASE_URL/AI_API_KEY` 的文字通道，但本轮保留普通聊天 hy3 的既有配置。不会自动选模型、迁移旧域名或跟随重定向。第三方代理、旧 `api.minimaxi.com`、其他路径/端口及 M2.x 等模型保持原兼容请求，不能据此认定已适配。

[官方 Chat Completions 参数表](https://platform.minimax.cn/docs/api-reference/text-chat-openai)推荐使用 `max_completion_tokens`，仍列有旧 `max_tokens`。[官方 Provider-Verifier 的 M3 用例](https://github.com/MiniMax-AI/MiniMax-Provider-Verifier/blob/main/m3_format_check/docs/m3_text_cases.md)明确将 `response_format=json_object` 用例跳过，原因是 M3 暂不支持；因此没有为 MiniMax 添加该参数。

总控反馈实际单图遵守 JSON、双图却返回 Markdown 正文；关闭 thinking 本身不能保证 JSON 输出。后续总控一次有界双图协议探针验证了命名工具选择：`tools` 只声明 `unseen_reply`，`tool_choice={type:'function',function:{name:'unseen_reply'}}`；耗时 2444 ms，返回单一同名工具调用、空正文、完整正确的回答参数。这是总控提供的探针证据，本任务未调用云模型；最终适配的单/双图复验由总控另行记录。

[官方工具调用文档](https://platform.minimax.io/docs/guides/text-m3-function-call)定义 `function.arguments` 为 JSON 字符串。适配仅在上述精确端点和模型范围启用同一 schema 与命名工具选择，在已有系统提示后追加输出通道说明，不改产品政策。`unseen_reply` 只携带 `answer/action` 数据，没有执行器；不进行第二次 completion 或回灌工具结果，历史仍仅保留回答文本的 JSON 封装、历史行动为 null。

服务端要求唯一 choice、唯一 `type=function` 且同名的工具调用，完成原因只能是 `tool_calls/stop`，正文只能缺省、null 或空白。完整 arguments 须为 JSON 字符串并通过原有 answer/action 字段、类型及长度校验；参数内代码围栏、前后正文、未知工具、多调用、缺字段、截断及无效行动均失败。没有自然语言回退、片段提取或自动包装 `action:null`。HTTP 成功但 `base_resp` 声明错误时返回通用上游错误，不输出供应商原始说明。

## 兼容范围与待验边界

当前 `image_url` 内容块与 Base64 data URL 可沿用；多张图片顺序放在同一个用户消息的 `content` 数组。已有家庭鉴权、文件摘要验证、PNG/JPEG 白名单、单张 3 MB、最多 4 张合计 8 MB 保留。官方单图 10 MB/请求体 64 MB 的限制高于当前应用预算，但不代表实测吞吐或准确度。

保持 55 秒服务端截止、1200 输出 token、128 KB 响应读取上限、`redirect: 'error'` 和请求取消；不自动重试、扩容、申请 priority 服务或降级到纯文字。关闭思考有助于减少回复延迟，但不保证真实调用能在截止前完成，也不能保证模型一定遵守 JSON 协议。

本地 `node --test test/ai-conversation.test.js` 共 **27/27 通过**。fetch 替身覆盖官方两端点的单图/四图字节、JSON 历史、思考字段隔离、非官方接口不带特殊参数、单一工具封装、歧义或无效参数拒绝、截断/供应商错误、取消只中止一次请求；实际 `createConversation` + `LocalStore` 接线验证双图留言候选只返回数据、不发布记忆。前次 23 项是工具输出适配前的结果；本地测试不证明真实模型总会遵守协议，也不替代最终适配的云端/浏览器验收。

后续总控反馈最终适配单/双图结构正确，但普通双图描述返回了全空 `message` 候选。对此仅加强 `action.description` 与追加输出规则：当前用户明确要求留言/联系才提出候选，普通聊天/看图/比较必须为 null，不能以全空对象代替；保留明确行动但缺信息时的补问与缺失字段。原 POLICY、工具协议、解析和确认权限未变，也不把错误候选静默改写为 null。此小修定向 **28/28 通过**，新增替身覆盖上述错误输出不被隐瞒、null 保留及缺内容的明确留言仍可补问；提示语的真实效果待总控限定次数复验，本地测试不作模型语义遵循的证明。
