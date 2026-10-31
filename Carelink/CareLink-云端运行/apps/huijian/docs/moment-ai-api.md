# 回忆时刻：连续对话与语音适配

实现：2026-09-05。新 App 使用以下新接口；原 `/api/question`、`/api/memory-dialogue`、`/api/tts`、空间接口及 canonical proxy 行为保持原样。接口不建立第二套账号或回忆数据库。

## 客户端契约

所有新接口需要已有 canonical session cookie（或原服务接受的 Authorization），以及 `X-Unseen-Expected-Account-Id`。服务端每次先用相同凭据只读请求 canonical `/v1/me`；与预期账号不一致返回 `409 account_changed`。浏览器需使用 `credentials: 'same-origin'`，并在切换账号时取消旧请求。传入的 cookie 不会发给模型供应商。

`GET /api/moment-config` 返回：

```js
{
  chat: { enabled, provider, model, capabilities: { image, audioInput, audioOutput } },
  transcription: { enabled, provider, model, maxAudioBytes, maxDurationMs, mimeTypes,
    requestTimeoutMs?, recommendedSegmentMs? },
  context: { version, maxMessages, maxHistoryCharacters, maxMessageCharacters,
    recentMessages, recentCharacters, memoryCharacters, questionCharacters,
    maxPromptCharacters, maxImageBytes }
}
```

`POST /api/moment-chat`，`Content-Type: application/json`：

```js
{
  momentId: 'stable-moment-id',
  requestId: 'stable-send-id',
  photo: { id: 'stable-photo-id', dataUrl: 'data:image/jpeg;base64,...' },
  messages: [
    { id: 'message-id', role: 'user', text: '原话或经确认的转写', photoId: 'stable-photo-id',
      createdAt: '2026-09-05T00:00:00.000Z' }
  ],
  context: {} // 可传之前的结果；不作为事实或指令来源
}
```

ID 使用 1–128 个 ASCII 字母、数字、下划线或横线。`messages` 允许空数组（开启对话），之后发送完整、按顺序的原始文字历史，包含已成功生成的 assistant 消息；不用塞录音 Blob、失败占位或系统角色。`photoId` 与 `createdAt` 可省略。当前照片始终传清晰副本，格式为 JPEG/PNG/WebP data URL；供应商不代取任意远程 URL。

成功：

```js
{
  message: { id, role: 'assistant', text, photoId, createdAt },
  context: {
    version: 1, sourceHash, sourceMessageCount, activePhotoId,
    strategy: 'source-quotes-and-recent-window',
    memory: { userQuotes, previousQuestions, omittedOlderMessages },
    recentMessages, promptCharacters
  },
  provider, model
}
```

`message` 加进账号中已有的完整记录，再保存。`context` 是**本次生成前**的可重建视图，不替代完整历史，也不能代替服务端保存回执。后续请求会把上一条新回复纳入重建。

`POST /api/moment-transcribe`：

```js
{ requestId: 'stable-voice-id',
  audio: { dataUrl: 'data:audio/webm;codecs=opus;base64,...', durationMs: 3200 },
  language: 'zh' } // language 和 durationMs 可省略
```

返回 `{ text, provider, model }`。兼容模式使用实际录音文件 multipart → `/audio/transcriptions`；本地模式通过 FFmpeg 与 whisper.cpp 处理，不发送外部 ASR 请求。原声保存及播放由账号内容层负责。支持 WebM、MP4/M4A、MP3、WAV；最大 8 MiB / 声明时长 180 秒。本地模式另外验证解码后的实际样本数，超过 180 秒拒绝。兼容模式的声明时长不是音频探测结果。无 ASR 配置返回 `503 transcription_not_configured`，空识别返回 `422 speech_not_recognized`，不生成假转写。浏览器识别只可作为明示 fallback，并保留原声。

现有朗读：`POST /api/tts { text }` 返回音频字节，可通过 Blob/object URL 播放；不是 `/api/voice`。新 AI 的朗读接口可继续复用这个实现。

## 上下文如何重建

全历史允许最多 10,000 条 / 2,000,000 个文字字符，单条最多 12,000 字符；这些是输入资源边界，不是规定聊多少轮。模型看到的输入另行约束：最近最多 16 条完整消息 / 16,000 字符、较早用户原话摘录最多 11,000 字符、较早问题最多 2,200 字符；总 context JSON 最多 34,000 字符。字符预算不是精确 tokenizer 计数，图像与系统提示占额外 tokens；切换模型需确认其窗口容量。

每次从源记录重新计算 SHA-256，按原记录顺序归因。旧用户摘录优先保留明确更正，再选择与最新内容重合、属于当前照片和较早建立背景的信息。长原话保留首尾并标注省略。用户原话与助手问题分别保存；旧助手猜测不会升级为用户事实。最新完整消息保持原文顺序；图片归属独立保留，避免将一张照片的故事套到另一张。

不把客户端摘要当权威，不让模型反复总结自己的总结。编辑、删除、换序、切图、切供应商后重算，旧摘要不会回流。选择器是可测试的文字匹配与原话检索，**不是**完整语义记忆或无限无损上下文；省略的信息仍在账号全历史中。未来可以替换检索器，或增加带原话来源校验的摘要，保持此接口不变。

提示明确将用户消息、照片文字和记忆都视为待处理内容，禁止它们改写系统边界。模型只谈已观察细节和用户提供的信息，不能根据餐具推断晚饭等事件，也不能声称已替用户保存或删除。初始常见越界前提有额外拒绝检查；这不是视觉真实性的完美自动证明。真实 canary 曾暴露晚饭猜测和 JSON 复述，修正及原始结果记录在 `moment-provider-canary.json`。

## 换供应商

应用只依赖 `complete({ instructions, context, photo, initial, signal }) → { text, provider, model }` 与 capability flags，不依赖供应商消息 schema。当前两个聊天配置都使用 **Chat Completions 协议**。MiniMax 适配处理专属 `thinking` / `reasoning_split`，独立清理 `<think>` 和 text envelope；OpenAI-compatible 配置不向其他供应商发送这些参数。

默认复用现有 MiniMax key（环境变量或现有 secret store）及 `MINIMAX_BASE_URL`、`MINIMAX_VISION_MODEL`。可覆盖：

```dotenv
MOMENT_CHAT_ADAPTER=minimax
MOMENT_CHAT_MODEL=MiniMax-M3
# MOMENT_CHAT_BASE_URL=https://api.minimaxi.com/v1
# MOMENT_CHAT_API_KEY=由秘密配置提供
MOMENT_CHAT_MAX_OUTPUT_TOKENS=900
MOMENT_TIMEOUT_MS=70000
```

明确兼容 Chat Completions、支持 image_url 的其他服务：

```dotenv
MOMENT_CHAT_ADAPTER=openai-compatible
MOMENT_CHAT_BASE_URL=https://your-provider.example/v1
MOMENT_CHAT_MODEL=部署方确认的视觉模型
MOMENT_CHAT_API_KEY=由秘密配置提供
MOMENT_CHAT_TOKEN_PARAMETER=max_completion_tokens
# 供应商只支持旧字段时可用 max_tokens；不会自动猜测并重试付费请求。
```

可选语音转写独立配置：

```dotenv
MOMENT_ASR_ADAPTER=openai-compatible
MOMENT_ASR_BASE_URL=https://your-asr-provider.example/v1
MOMENT_ASR_MODEL=部署方确认的转写模型
MOMENT_ASR_API_KEY=由秘密配置提供
```

不自动使用聊天 key 充当 ASR key，不假定 MiniMax 存在相同转写接口。服务商需明确支持 JSON 转写输出和目标音频格式。生产外部 endpoint 必须 HTTPS；HTTP 仅放行 localhost 测试。redirect 禁止，避免凭据跟随任意重定向。配置错误只关闭新能力并由 config 反映，不拖垮旧服务。

Responses、Anthropic Messages、Gemini、原生音频或 Realtime 等是**新的适配器实现**，不能只改 URL 就宣称支持。对应适配器负责自己的角色、媒体、token、输出、流式和错误转换；原声输入能力需显式设 `audioInput: true`。当前统一形状与前台语音消息可保留。

## 失败、配额和重试

新接口只在成功获得有效回复时返回 200，不用预写套话伪装模型成功。网络/供应商错误 502，超时 504，账号失效 401，账号变化 409，输入不合法 400/413/415，配额 429。公开错误只包含稳定代码，不暴露密钥、供应商错误 body 或原话日志。

聊天与 ASR 共享原有 `photoAiGate`：每个真实上游调用先持久扣减，失败/取消不退还不确定费用，用户断开会取消供应商请求。新 HTTP 请求包含读取 body 的总期限，过大/停滞的上传关闭连接。上游 JSON 按流限制到 256 KiB。

按账号、回忆、requestId 去重。进程内最多 100 个请求记录、5 分钟 TTL：同一成功请求重试返回原 message ID，相同 ID 变更内容返回 `409 request_id_conflict`，正在处理返回 `409 request_in_progress`（Retry-After: 2）。该缓存不提供跨进程 exactly-once 保证；重启/过期后客户端必须先核对已持久保存的 message。没有服务器会话数据库，缓存只含摘要指纹和有界回复视图，不含图片/音频字节。

默认既有门槛是每访客每分钟 6 次、全局 20 次、每日 200 次；语音每轮可能消耗 ASR + chat 两次，部署需按实际获授权额度设置 `PHOTO_AI_*`，不将原有预览配额擅自移除。现有 TTS 另有 `TTS_*` 配额。

## 验证与官方依据

- `node --test test/moment-context.test.mjs test/moment-provider.test.mjs test/moment-http.test.mjs`：长历史、旧信息检索、更正、编辑重算、角色边界、clear image、供应商切换、转写 multipart、真实 HTTP 会话隔离、去重、限流、截止和断开取消。
- 原 `test/server-reliability.test.mjs` 与 `test/canonical-proxy.test.mjs` 一并回归，保证旧端点与原 cookie/media proxy 行为。
- 使用现有公开照片 fixture 与现有 MiniMax secret 的小规模真实 canary，结果单列，不把 mock 通过等同于模型质量通过。
- [OpenAI 图像输入](https://developers.openai.com/api/docs/guides/images-vision)：Chat Completions 支持视觉输入，图像可以 data URL 提供。
- [OpenAI 语音转写](https://developers.openai.com/api/docs/guides/speech-to-text)：文件转写接口与 multipart file/model 参数、输出格式和音频要求。
- [MiniMax Chat Completions](https://platform.minimax.io/docs/api-reference/text-chat-openai)：M3 image_url、max_completion_tokens、thinking.type=disabled 与 reasoning_split 的独立语义，已读取 2026-09-05 官方 markdown schema。

## 已有 Groq 的本机启用与实际 canary（2026-09-05）

后续生产核验：香港服务器访问 Groq models 路径时，无认证与有认证均为 403；此前 Mac 成功不能证明生产可用。停止该服务器的 Groq 探测，不使用代理。腾讯已有账号的 ASR 探测返回 `FailedOperation.UserNotRegistered`，未开通新付费服务。下节本地适配器处理这一部署差异。

已确认本机现有 secret store 包含 Groq profile，并通过同一个 `createTranscriptionAdapter` 完成 **1 次**实际转写请求。输入为本机 `say -v Tingting` 合成的中文，转换成 16 kHz、mono、PCM WAV，约 206 KB；未使用用户音频。结果：

- 合成原句：`这是一次语音测试。照片里的那盆花，是二零一一年在杭州拍下的。`
- 实际输出：`这是一次语音测试,照片里的那盆花,是2011年在杭州拍下的。`
- 本次请求耗时：297 ms（不含本机合成）。这不是普遍延迟或真实麦克风识别率保证。
- 模型：`whisper-large-v3-turbo`；语言：`zh`；结果档案：`docs/moment-asr-canary.json`。
- 未读取账号剩余额度、计费档位或消耗明细；一次成功只证明当前凭据与这条接口实际可用。

[Groq 官方语音契约](https://console.groq.com/docs/speech-to-text)确认其 transcription 路径、multipart file/model、JSON 输出、ISO-639-1 语言参数与 WebM/MP4/M4A/WAV 等格式，与已有 compatible adapter 相符。因此无需新注册服务，也无需写另一个供应商协议实现。

安全开发启动脚本：

```bash
node tools/run-moment-dev.mjs
```

默认启动当前仓库的 `server.mjs`。原有 `PORT`、`CANONICAL_UPSTREAM`、`CANONICAL_PUBLIC_ORIGIN`、MiniMax 设置和配额变量保持继承。例如已有账号后台正在运行时：

```bash
PORT=4610 CANONICAL_UPSTREAM=http://127.0.0.1:你的账号后台端口 node tools/run-moment-dev.mjs
```

需要自定义 devserver 命令，用 `--` 分隔，参数通过 `spawn` 直接传递，不经 shell 解释：

```bash
node tools/run-moment-dev.mjs -- node --watch server.mjs
```

脚本仅在子进程环境中设置：

```dotenv
MOMENT_ASR_ADAPTER=openai-compatible
MOMENT_ASR_BASE_URL=https://api.groq.com/openai/v1
MOMENT_ASR_MODEL=whisper-large-v3-turbo
# MOMENT_ASR_API_KEY 由现有 authProfiles.groq.apiKey 在内存中读取。
```

不会创建 `.env`、改写 secret store、打印密钥或把密钥作为进程参数。已有显式 `MOMENT_ASR_API_KEY` 优先；自定义非 Groq endpoint 必须显式提供它自己的 key 与 model，脚本不会把 Groq key 自动转发给其他地址。缺少已有凭据时以固定错误码退出。SIGINT/SIGTERM 会转发给 devserver 子进程。

已额外验证默认 launcher → 实际服务启动 → 登录保护的 `/api/moment-config` 报告 `transcription.enabled=true` 和该模型。此启动检查仅使用本机临时模拟账号服务，没有再调用模型或使用真实账号会话。

部署端仍须按原来的秘密配置机制提供同样四个环境变量；这个 launcher 是本机开发用，不自动 SSH、复制密钥或改变生产账号服务。

## 服务器本地 Whisper（2026-09-05）

`lib/moment-local-whisper.mjs` 使用已安装的 whisper.cpp **b4938** CLI 和 `small-q5_1` 多语言模型。没有新账号、API key、代理或外部 ASR 请求。管理员固定绝对路径；启动时检查二进制可执行、模型为可读非空普通文件。配置错误时 `transcription.enabled=false`，不会假装可用；这些检查不等于真实推理已验证，仍需管理员合成音频 smoke。

```dotenv
MOMENT_ASR_ADAPTER=local-whisper
MOMENT_ASR_WHISPER_BIN=/opt/huijian-asr/b4938/whisper-bin-ubuntu-x64/whisper-cli
MOMENT_ASR_WHISPER_MODEL=/opt/huijian-asr/b4938/ggml-small-q5_1.bin
MOMENT_ASR_FFMPEG_BIN=/usr/bin/ffmpeg
MOMENT_ASR_MODEL=whisper-small-q5_1
MOMENT_ASR_TIMEOUT_MS=110000
MOMENT_TIMEOUT_MS=120000
# 可选 MOMENT_ASR_TMPDIR：服务用户可写的固定临时目录，默认系统 tmpdir()
```

`MOMENT_ASR_MODEL` 只是公开标签，不是文件路径。路径、模型、prompt、线程数、demuxer 和 CLI 参数都不能由客户端指定。`tools/run-moment-dev.mjs` 在明确选择本地适配器时保留该配置，不再读取 Groq secret store；正式服务器可直接运行 `node server.mjs`。`MOMENT_ASR_TIMEOUT_MS` 最大 110000，覆盖写入、转换和推理；HTTP 应设置为 120000。本地 config 额外返回 `requestTimeoutMs=130000`，让浏览器在服务端返回明确超时前保留连接；新的录音建议读取 `recommendedSegmentMs=30000`，自动发出短段并按连续模式继续会话。这些字段不要求在产品界面显示模型实现。

固定推理参数为 `-m MODEL -f PRIVATE.wav -l LANGUAGE -t 2 -p 1 -ng -nt -np -bs 1 -bo 1`。仅 `language=zh` 增加固定 `--prompt '以下是普通话的简体中文转写。'`；其他语言不加。输入 language 仍限定两个小写字母，默认 zh。CLI stdout 只读转写文本，UTF-8 与控制字符校验后返回；空文本、静音标记或全零 PCM 返回未识别，超过 12000 字符拒绝。64 KiB stdout/stderr 上限会结束进程。stderr、进程错误及内部路径不会返回或记录为用户错误。

FFmpeg 通过 `execFile`、无 shell 调用，输入 MIME 固定映射 `webm→matroska`、`mp4/m4a→mov`、`mpeg/mp3→mp3`、`wav/x-wav→wav`；不会自动探测任意 playlist。输入只允许 file 协议，MOV 显式禁止外部 data references 和绝对 alias 路径。仅第一条音轨，禁视频/字幕/数据，转换到 mono、16 kHz、16-bit PCM WAV。解码/编码/过滤器单线程，单次分配上限 64 MiB，输出 pipe 有约 5.9 MB 硬限。先最多解码 **181 秒**，再按实际 PCM 字节数校验 **180 秒**，超过即 `413 audio_duration_invalid`，不会把前半段当成成功结果；客户端 durationMs 无法绕过。输入原声字节保持原样，WAV 是独立衍生文件。

整个 Node 进程只运行一份本地转换/识别，跨 adapter 实例也共享同一并发槽；繁忙返回 `429 provider_rate_limited` / `Retry-After: 2`，没有无限排队。取消、请求断开、110 秒 deadline 或输出超限都直接 SIGKILL 子进程，并等待实际 `close` 才释放并发槽及清理文件。每次随机私有目录 0700、原声/WAV 文件 0600，finally 删除；本服务应保持单 Node 实例，否则需在进程层统一资源限制。本地子进程仅继承固定 PATH/locale/线程环境，不继承服务器 key 或 CLI override 变量。

账号层保存的原声不会被此临时文件清理删除。既有 180 秒长录音若推理超时，返回 `504 provider_timeout`，让 App 保留原声并提供重试/补充文字；不得把失败当识别成功，也不因一次超时删除原声。30 秒是录音分段建议，180 秒仍是已有录音可尝试的硬输入上限；CPU 转写质量和耗时并非固定比例。

主流程提供的实际服务器证据（此适配器作者未 SSH）：5.43 秒合成普通话，加简体 prompt 后转写正确，推理 15.21 秒，峰值 RSS 360924 KiB。45 秒重复语句测试耗时 24.78 秒、峰值 RSS 375888 KiB，但模型合并了重复句，**不计为长录音内容完整性通过**。单模型峰值不包含 Node 主进程，服务内存预算需覆盖两者。安装校验记录：二进制 SHA-256 `f4cfc1f969a13805908fb72043ce7cc896eb42e0b8afbe841dc8e7298923b061`；模型 SHA-256 `ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb`，Hugging Face revision `5359861c739e955e79d9a303bcbc70fb988958b1`。这是安装与合成样本证据，不是所有原声识别率保证。

验证：`node --test test/moment-local-whisper.test.mjs test/moment-provider.test.mjs test/moment-http.test.mjs test/moment-dev.test.mjs`。测试包含真实本机 FFmpeg 转换 WebM/M4A/MP3/WAV、实际超长音频拒绝、错误格式拒绝，及真实受控子进程的并发、取消、超时、输出上限、权限、清理、HTTP 去重和配置契约；受控 CLI 测试不冒充模型质量测试。无 FFmpeg 的 CI 会明确跳过真实解码一项，其余仍运行。

官方依据：[whisper.cpp b4938 CLI 源码](https://github.com/ggml-org/whisper.cpp/blob/b4938/examples/cli/cli.cpp)、[FFmpeg 参数与 option 作用域](https://ffmpeg.org/ffmpeg.html)、[FFmpeg 协议白名单](https://ffmpeg.org/ffmpeg-protocols.html)。CLI 格式来自固定版本，不把其他程序名称当作相同接口。
