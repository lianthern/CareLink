# 2026-09-24 部署环境值修复与私有 Timer 工具

基线 `44c5882`，独立分支 `codex/frame-deploy-fix`。CloudBase CLI 3.8.3 的配置读取器使用 JSON reviver，将可解析为对象的字符串再次解析；因此 TTS JSON 字符串到达 SCF 时变成 object。本修复不修改业务配置编码。

**当前实际结果**：主 HTTP 服务已发布 `0.5.5`，官方读回见 `.tools/deploy-2026-09-24T03-05-42-881Z/`，公网资源/权限/两原账号检查见 `.tools/online-055-on.json`。原环境值以 string 保留。第 07 轮真实 TRTC 合成语音通过，机器人音频转写为“3+4=7。”，服务端桥接 1 轮并确认 ended/供应商 TaskNotExist；不能以此替代真人麦克风/扬声器与插话测试，详见 [接手记录](TAKEOVER-20260924.md)。私有清理 Event 已部署、Timer 每分钟 `OPEN`、无公开 HTTP，手动 Invoke 成功；自然触发及真实过期任务停止仍未验证。早期 `0.5.0` 开关关闭/开启的只读检查与历次部署回执保留在 `.tools/`。

`scripts/deploy.mjs --update` 改用官方 `fn code update`（只更新代码，不更新配置），再用 CLI 已登录身份调用 SCF `UpdateFunctionConfiguration`，每个 `Environment.Variables[].Value` 原样保持 string。部署只允许现有上海环境和 `memory-frame-demo`，保留线上全部变量；现有非 `AI_REALTIME_` 变量若和本地冲突则停止。代码更新后再次核对原变量，发现并发变动时停止。角色、内存、超时、网关不由此脚本改动。

```sh
node scripts/deploy.mjs --plan                 # 完全离线，只输出键名/类型
node scripts/deploy.mjs --verify-only          # 官方只读配置比对
node scripts/deploy.mjs --update               # 代码更新、环境更新、官方读回
node scripts/deploy.mjs --config-only          # 仅环境更新、官方读回
```

若 CLI 3.8.3 在 COS 上传阶段报告固定 60 秒超时，可显式选择官方 SCF ZIP 直传；不会自动重试或切换传输方式：

```sh
node scripts/deploy.mjs --update --direct-zip
```

该模式调用 `UpdateFunctionCode` 的 `Code.ZipFile`，`CodeSource=ZipFile`、`InstallDependency=TRUE`、`Publish=FALSE`，只允许既有 HTTP 函数。请求只指定 `Namespace`；首次同时指定 `Namespace` 与 `EnvId` 被 API 明确拒绝，已修正后成功发布。使用官方 [Code 结构的 50 MB 上限](https://cloud.tencent.com/document/api/583/17244)，不用 [旧顶层 ZipFile 字段](https://cloud.tencent.com/document/api/583/18581)；CLI 自身的 `--deployMode zip` 有 1.5 MiB 本地限制，不能用于此服务包。COS 60 秒来自该锁定 CLI 的硬编码计时器，延长外层部署进程超时无效。

本地系统 `zip` 只从当前 `server` 实际目录读取常规文件，不接受外部 ZIP、符号链接，排除 `node_modules`、锁文件、点文件/目录、CloudBase 配置、私有快照和常见密钥文件。打包前要求 `@cloudbase/node-sdk` 精确固定 `3.18.3`；保留启动脚本执行权限。实际 ZIP 清单逐项比较、完整性检测、大小检查全部通过才发请求；私有目录保留 ZIP、SHA-256 清单及原配置。直传不修改原 COS 路径，也不在失败后自动再部署。准备阶段真实主目录打包核对为 126 文件、20,713,210 字节（含摄像头资源及 TRTC 桥接）；该数值是当次本地包证据，成功上线另由部署回执与公网检查证明。

可用 `--config /absolute/path/cloudbaserc.local.json` 指定私有配置。`.tools/deploy-*` 保存原配置、目标配置、代码更新后的配置、最终配置和私有 CLI 日志，目录 700/文件 600。不自动回滚已部署代码；任一步失败都保留快照并退出非零。没有成功读回不报告部署成功，成功也不等于真人实时音频或 Timer 执行通过。

`scripts/cloudbase-scf.mjs` 可供总控读取/更新：`createCloudClient({root,evidenceDir})`、`client.scf('GetFunction',functionParams())`、`environmentOf(detail)`、`environmentUpdate(name,env)`、`writePrivate(path,detail)`。只允许固定环境两个函数和必要的 SCF 操作。请求正文经 stdin 注入 CLI，不出现在 OS 参数；CLI 原始输出只写私有日志。不要 `console.log(detail)`，它含全部服务端环境值。

## 独立清理：已部署结果与维护方式

当前函数 `unseen-ai-realtime-cleanup` 为 `Event / Nodejs20.19 / ai-realtime-cleanup.main`。`2026-09-24T02:18:18Z` 的私有回执确认手动调用 `enabled=true / ok=true`，扫描、候选、尝试、结束、待处理、跳过、错误、延后均为 0；Timer 每分钟开启、没有公开 HTTP 触发器。最终 0.5.5 Event 同步于 03:14:03Z 读回 25 个源文件摘要一致，并手动 Invoke 成功（扫描 1 条，其余计数为 0），固定回执 `.tools/cleanup-live-20260924/update-055-receipt.private.json`；旧回执保留。手动调用只证明该次入口和清理流程可运行，`scheduledInvocationVerified=false`、`expiredTaskStopVerified=false` 仍未改变。

生成配置仍是离线动作；以下供后续维护使用，不能因为执行生成命令就认定重新部署或执行成功：

```sh
node scripts/prepare-realtime-cleanup.mjs --config cloudbaserc.local.json
```

该命令零网络操作。私有 `.tools/realtime-cleanup-plan/` 内产生 Event 函数配置和每分钟 Timer 请求。函数名/触发器名均为 `unseen-ai-realtime-cleanup`，handler 为 `ai-realtime-cleanup.main`，`public:false`，无 HTTP 网关；仅复制原环境和明确的 TRTC 控制配置，不复制开通码、模型密钥、音色配置或 SDK 签名密钥。复用原 `MemoryFrameDemoRuntime`，不创建/修改 IAM。

部署参数由 `cleanupDeployArgs(privateCleanupConfig)` 生成，显式 `--dir` 指向当前 `server`，以 `--deployMode zip` 上传小型 Event 包（**不要加 `--httpFn` 或 `--path`**）。应保留后端共用的 `public/spatial-link.js`：首次粗略排除整个 `public/**` 导致入口依赖缺失，现已改为排除浏览器大资源、`scf_bootstrap` 与 `server.js`。不要把先前启动错误记为 Nodejs20.19 不支持 Event。

当前函数和 Timer 已存在，维护时先用安全 helper `GetFunction`、`ListTriggers` 比较 handler、变量、角色和计划，不盲目重复创建。`CreateTrigger.TriggerDesc` 传原始 cron `0 * * * * * *`，`ListTriggers` 读回则是含 `cron` 的 JSON。`verifyCleanup(detail,triggers)` 仅给脱敏配置检查，不能替代实际运行与过期任务 Stop 回执。

CLI 3.8.3 的 SCF 参数映射明确使用 `Handler: func.handler || 'index.main'`，因此 Event 函数设置 `handler`，不是 HTTP 的 `entry`。受控部署和读回可使用以下模块调用，CLI 输出仍只写私有日志：

```js
const d = client.scf('GetFunction', functionParams(CLEANUP_FUNCTION));
const triggers = client.scf('ListTriggers', functionParams(CLEANUP_FUNCTION));
// 当前已部署：先审阅读回。确需更新代码时才使用生成的参数：
// client.run(cleanupDeployArgs(privateCleanupConfig), { label: 'cleanup-deploy', timeout: 600000 });
// 仅在确认同名 Timer 不存在时创建；现在已有，不能重复执行：
// client.scf('CreateTrigger', trigger);
const invocation = client.scf('Invoke', cleanupInvokeParams());
console.log(summarizeCleanupInvocation(invocation));
```

`cleanupDeployArgs`、`cleanupInvokeParams` 与 `summarizeCleanupInvocation` 由 `prepare-realtime-cleanup.mjs` 导出。主动 Invoke 是真实云函数调用，但不能当作 Timer 自然触发。旧 `GetFunctionLogs` 已不能作为本环境可用查询途径，旧示例中的调用已移除；保留的 `summarizeCleanupLogs` 仅是旧格式摘要工具，不证明当前云日志可查。官方当前日志检索走 CLS，而本轮 `tcb logs search --json` 返回 `LOG_SERVICE_NOT_ENABLED`，**CLS 未开启，本次未开通**。因此不能用 Timer 为 OPEN、等待经过一分钟或手动调用成功来声称定时运行已验证。[官方 Invoke](https://cloud.tencent.com/document/product/583/17243)、[当前日志检索说明](https://cloud.tencent.com/document/product/583/52637)。

后续取得自然执行证据时，需排除手动调用的 request ID，核对新执行时间与清理计数；真正清掉过期任务还需独立 Stop 回执。详细日志/返回正文只保留私有文件。TRTC 合成音频短通话第 07 轮已经通过。前两轮 Start=0，分别定位默认域名导航提醒和 SDK 裸依赖；后续真实 Start 定位 SessionId 过长及 MaxIdleTime=30 被拒，修复后再补齐新版 SDK 的官方连接域名。各轮独立证据见接手记录，不由部署或清理结果推断通话成功。该导航提醒见[官方默认域名说明](https://docs.cloudbase.net/service/alias)。

实际使用源：本地锁定 CLI 3.8.3 的 CodeUpdate、getConfig、ApiCallCommand 和 outputJson；[官方环境更新 API](https://cloud.tencent.com/document/api/583/18580)、[官方变量类型](https://cloud.tencent.com/document/api/583/17244)、[官方 Timer 创建 API](https://cloud.tencent.com/document/api/583/18589)。最初部署工具子任务只开发和本地测试，没有执行登录、云写入、权限变更或真人音频验证；随后总控与受委派的清理子任务已完成上述实际云部署和手动调用，当前状态以本页开头和私有回执为准。

验证命令：`node --test test/deploy-safety.test.js test/deploy-cli-path.test.js test/deploy-direct-zip.test.js`。部署工具开发阶段定向检查已通过，覆盖真实 ZIP 内容/权限/排除、隔离子进程、请求字符串/泄露边界、七项保留、并发变动、失败读回与清理配置；后续 Namespace 和清理包修复另经定向检查与上述云回执确认。本地测试不访问腾讯云；CLI 路径测试需要安装锁定 CLI 或提供 `CLOUDBASE_CLI_BUNDLE`。
