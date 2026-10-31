# 短通话之后的只读证据

准备脚本本身不构成线上验收。默认仅打印计划；等短通话结束后，使用当前已登录的 CloudBase CLI 3.8.3 和当前应用的专用 TRTC 控制凭据执行一次：

```sh
node scripts/check-realtime-evidence.mjs --execute /absolute/private-output/realtime-call-recovery.private.json
```

脚本须在已安装 CLI 与 server 依赖、存在私有 `cloudbaserc.local.json` 的应用 checkout 内使用；也可把该应用根目录作为最后一个参数。固定原环境 `memory-frame-demo-d7djiee0702b6c` / 上海，不创建家庭或资源，不调用 Start、Stop、应用登录、心跳或模型，不写数据库。

恢复文件只取 origin 和 requestId，忽略其中可能残留的 token。数据库使用 `tcb db nosql execute --json`，执行固定的 aggregate：按 `kind=ai-realtime` 与本次 requestId 匹配、展开 entries、再次匹配同一 requestId、固定投影、最多返回两行。云端只投影计数、状态和供 Describe 使用的 providerSession；不读取家庭内容、turn 对象、授权 grant 或哈希。requestId 从 stdin 进入 CLI，不进入 shell/OS 参数。必须恰好一行，否则拒绝猜测。

随后复用生产适配器的 `lookup()`，使用本应用 `AI_REALTIME_TRTC_*` 专用控制凭据调用一次 DescribeAIConversation。只有明确 `FailedOperation.TaskNotExist` 才报告 task-not-found；未知/空响应是 unconfirmed。CLI 原始 stdout/stderr 仅在内存中，不保存或打印；最终 JSON 不含 requestId、providerSession、TaskId、家庭信息或凭据。

退出码 0 表示：ended、bridgeBudget.turns > 0、outputChars > 0、claim 已释放、供应商任务明确不存在。退出码 2 表示读取成功但上述证据仍不齐；1 表示无法安全取得/解析证据。可在清理完成后再次执行只读核对。计数只证明 bridge 有调用与输出；ASR→hy3→TTS 的语义验收仍须结合 probe 的合成音频和远端回答录音，不能单凭计数声称通过。

本次只验证了 CLI 的本地帮助/已安装实现，以及离线固定响应回归；未预先读真实数据库或调用 Describe。云端不接受 aggregate 或投影语法时会失败并隐去原始输出，不能退回全库 dump 或扩大读取。
