# UNSEEN 协作约定

先读根目录 README 和 `docs/team/HANDOFF.md`，辨认当前 App、后端、演示与历史实现。

- 每项任务使用独立分支和 checkout/worktree。保留他人的未提交修改，不覆盖或重置。
- AI 记忆相框在 `products/memory-frame/`，先读该目录 README。历史交付脚本不能直接当统一仓库发布入口。
- 当前 App 在 `apps/huijian/`；根目录 npm workspace 和 lockfile 管理安装。演示和历史副本不自动加入生产启动。
- 变更记录放 `docs/work/` 的独立任务文件，写清来源版本、结论、验证与下一步；不要求记录每次工具调用。
- 找旧稿、历史实验或素材，先读 `ARCHIVE.md`，用 `scripts/archive/archive.py find` 搜索总档案。归档原件只恢复到新路径，不覆盖当前源码。
- 保留失败实验和被替换草稿的来源。每个任务结束时，把可提交的小文件和大产物的归档地址/文件 ID 写入任务记录；日期快照不等于未来文件已经自动备份。
- 根据改动运行相应检查。App 使用 `npm run app:check`；涉及双进程入口或代理时再跑 `npm run team:check`；整合发布前跑根目录 `npm run check`。
- 先运行 `npm run app:build` 再直接启动整合检查。生成的 App bundle、依赖、缓存和本地状态不提交。
- 不把真实密钥、活动邀请凭证、数据库、原视频或模型权重提交到 Git。大素材用 `provenance/optional-assets.json` 或任务产物清单记录。
- `imports/` 是现有历史副本，不向其中新增内容。`tools/agent-bridge` 的已发布任务与回执是来源快照；新的实际投递仍遵守原通道的协议。
- GitHub 推送、服务器部署、GPU 实机通过和数据备份完成是不同结果；只有拿到对应证据才记为完成。
