# 2026-09-20 归档采集方法

这里保留本次采集所用脚本的文本快照，供审计和后续改造。它们含当时机器的目录、快照日期和状态文件约定，使用 `.txt` 后缀，不作为新的备份入口直接执行。恢复入口在 `scripts/archive/archive.py`。

- `scan.py.txt`：项目目录、Git worktree、普通文件指纹、符号链接和排除项盘点。
- `build_archive_parallel.py.txt`：Git bundle、去重、64 MiB 分块、ZIP / age 加密、上传前解密回验，以及 GitHub 附件大小和 SHA256 回执。
- `capture-additional.py.txt`：按项目命名线索补查得到的文件集合。
- `refresh-cloud.py.txt`、`read-remaining-cloud.py.txt`：iCloud 元数据刷新与实际读取核验。
- Swift 文本快照：使用系统 FileManager 请求下载，未使用未文档化的下载命令。

本次初始采集后又补入 iCloud 旧目录。最终完整私有来源清单位于加密原件 `complete-capture-manifest.json`，文件 ID 为 `complete-capture-20260920`。它记录原路径、指纹、工作目录状态和 Git 来源；恢复私钥不在清单中。

脚本通过 GitHub CLI 的已有登录态上传；脚本中没有 GitHub 访问令牌或归档恢复私钥。未来新快照应明确新日期和数据范围，复用已验证对象时同时保留对应附件来源，不能把旧快照当作持续同步。
