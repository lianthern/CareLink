# GitHub Bridge 协议 v1

## 角色与真源

- **Mac publisher**：发布任务合同、Release 资产与初始 Issue。
- **4060 receiver**：拉取任务，验证资产，追加状态回执和最小结果报告。
- **GitHub private repository**：Agent 间的控制面、状态账本与人类查看入口。
- **GitHub private Release**：经过 SHA256 固定的交接包运输层。
- **香港服务器**：未来生产任务真源；本 Bridge 不替代它，也不声称已接入它。

## 不等于“两边上传所有东西”

两端只上传合同允许的最小信息：

- 可以：`TASK.json`、状态 receipt、报告、benchmark 摘要、必要的脱敏日志。
- 大包：只放 private Release，并在任务中固定 asset 名、字节数和 SHA256。
- 禁止：原视频、frames、隐私素材、`.env`、token、SOG/PLY、checkpoint、训练 work 目录。

## 生命周期

Bridge 交接状态采用追加式回执：

`PUBLISHED -> RECEIVED_VERIFIED -> RUNNING -> UPLOADING -> COMPLETED`

异常终态是 `BLOCKED` 或 `FAILED`。一次执行可以在问题修复后追加新的 `RUNNING` 回执；不得改写历史回执。任务合同中的 SceneWorker 内部生产 scaffold 仍使用其自己的 `queued -> leased -> running -> uploading -> ready/failed` 契约，两者不要混为一谈。

## 冲突与离线

- Job ID 幂等且不可复用；修订时创建 `-v2`，不覆盖 `-v1`。
- 回执文件名包含 UTC 时间和随机后缀，永不覆盖。
- 4060 离线时任务和 Release 会持续存在；上线后再拉取，不丢单。
- 提交回执前脚本执行 `pull --rebase`，push 冲突时自动再同步一次。
- GitHub Issue 给人看；仓库中的 receipt 是机器可审计真源。

## 成功定义

- `PUBLISHED` 只表示 Mac 已发布，不代表 4060 收到。
- `RECEIVED_VERIFIED` 表示 4060 已实际下载并验证 SHA256。
- `COMPLETED` 必须附最小报告路径；没有 4060 实机数据的指标保持 `null`/`PENDING`。
- 没有 receipt 就明确是“尚无送达证据”，不从 iCloud 图标或口头状态推断。
