# 本次验证 · 2026-09-20

环境：macOS arm64、Node.js 22.23.1。本次只进行本地检查及 GitHub 素材读取。

| 检查 | 结果 |
| --- | --- |
| 根目录 `npm ci` | 通过，使用统一 lockfile 安装 |
| 根目录 `npm run check` | 完整执行通过，退出码 0 |
| 其中 App 构建与测试 | 639 项通过 |
| 其中 canonical API | 447 项通过 |
| 其中既有后端基线 / 运维 | 10 / 59 项通过 |
| 其中 Web / Book Lab Web | 243 / 46 项通过 |
| 成书与 Worker 相关组合测试 | 101 项通过；专用渲染验证 45 项通过 |
| 本地 App + core 整合检查 | 页面和 bundle 可读；后端健康检查通过；代理请求到达账号鉴权；父进程中的提供商密钥未被使用；SIGTERM 后两进程退出且后端记录干净退出 |
| 新模块凭证扫描、根目录格式及 contracts | 通过 |
| Agent Bridge JSON 与边界校验 | 16 份 UNSEEN 任务合同通过 |
| Bridge 发布器单元测试 | 15 项通过 |
| v15 处理工具测试 | 87 项通过，使用测试替身，不启动真实 GPU 训练 |
| 按需素材下载 | 实际下载 `unseen-demo` 的 6 个文件，大小与 SHA256 全部匹配 |
| 全新 checkout 验证 | 使用 `git clone --no-local --single-branch` 拉取 `dc1a9edf1f07b7bda0ebd5705f57a7df240de0ea` 到独立目录；重新 `npm ci`、`npm run app:check`、`npm run team:check` 全部通过，App 再次 639 项通过 |

测试数字按各命令报告记录，其中部分测试可能由不同检查入口重复运行，不表示互不重复的独立测试总数。

原始本地日志指纹记录在 [`validation.json`](../../provenance/team-monorepo-20260920/validation.json)，原始日志保存在执行机器的临时检查目录，不作为长期备份。

没有重跑 Windows / WSL / RTX 4060 实机任务，没有验证所有旧演示的完整交互，没有切换生产部署，也没有完成生产数据与其他设备草稿的备份。
