# 项目地图

更新：2026-09-24。团队日常开发入口为本仓库的 `main`。

## 当前产品

### UNSEEN App 与回见

`apps/huijian/` 保存当前整合的 App，延续回见的照片与原话流程，并包含空间、照片场景和 App 内家庭相框页面。来源为 `huijian` 的 `codex/family-frame-integration-20260921`，在统一仓库中保留本地双服务启动及凭据隔离适配。

核心 API、存储、任务和成书代码分别在 `services/`、`packages/` 及其他 `apps/` 子目录。运行方式见 [上手说明](HANDOFF.md)。

### AI 记忆相框

`products/memory-frame/` 保存独立 AI 记忆相框 0.5.6 的应用、测试、设备文本源码及技术记录。产品由手机家人端和老人相框端组成，已包含照片、原声、AI 对话、驻足邀请和扫码上传。

[产品概述](../products/memory-frame/OVERVIEW.md) · [使用说明](../products/memory-frame/GUIDE.md) · [版本记录](../products/memory-frame/CHANGELOG.md)

### 设备与空间处理

`tools/agent-bridge/` 保存 UNSEEN 相关设备处理源码和任务快照。C1 / Companion One 的任务位于 `jobs/to-4060/unseen-companion-one-2026-09-21-v1/`。已有回执是对应时间的记录，不表示设备当前运行状态。自动投递仍使用原 Bridge 通道。

## 演示与历史

| 内容 | 统一仓库位置 | 原仓库用途 |
| --- | --- | --- |
| 早期回见照片对话 | `demos/huijian/` | `huijian-demo`：公开独立演示 |
| 亲亲家人相框 | `demos/qinqin-family-frame/` | `qinqin-family-frame-demo`：静态交互演示 |
| 空间展厅 | `demos/spaces-gallery/` | `unseen-ui-preview`：展示与界面实验 |
| 照片交互 | `demos/photo-jelly/` | `unseen-photo-jelly`：照片交互演示 |
| 影片入口 | `demos/film/` | `unseen-film`：已发布影片页 |
| 早期 UNSEEN | `archive/unseen-demo/` | `unseen-demo`：早期原型 |
| 旧版实现 | `archive/unseen-classic/` | `unseen-classic`：历史实现 |
| 空间活动与路线说明 | `demos/live-events/`、`demos/routes/` | 本地历史快照 |
| 研究、原稿、旧分支及大素材 | [总档案](../../ARCHIVE.md) | 日期归档，不自动包含后续变更 |

`unseen-memory-frame` 是相框的公开比赛源码，当前保留的公开版本为 0.4.9；本仓库包含 0.5.6。公开展示仓库不作为团队最新代码的判断依据。

## 原仓库与历史的关系

本次将可运行源码和产品文档整合到一个工作树，不删除原仓库，也不把不同产品的 Git 历史强行改写成同一条记录。来源提交、导入文件指纹和必要适配保存在 `provenance/`；历史 Git 包和大型原件仍从总档案读取。`unseen-chatgpt-archive` 等历史资料源继续按原权限保存。

9 月 20 日之后尚未收集的其他机器文件、服务器数据库与上传媒体，不因本次整合而成为已归档内容。
