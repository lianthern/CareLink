# 演示代码

| 目录 | 内容 | 素材 |
| --- | --- | --- |
| `spaces-gallery/` | 空间展厅、studio、afterglow | SOG 按 `npm run assets -- fetch spaces-gallery` 获取 |
| `routes/` | DAP、3DGS、World Labs 技术路线说明 | 已带 DAP 小样例；部分入口仍指向既有线上服务 |
| `live-events/` | 空间活动 Viewer | 大模型与体素文件按清单由 Max 提供 |
| `film/` | 已发布 V6 影片页 | 视频按 `npm run assets -- fetch film` 获取 |
| `photo-jelly/` | 照片交互实验 | 已带小样例 |
| `huijian/` | 早期回见 Demo | 当前 App 请使用 `apps/huijian/` |
| `modelscope/` | ModelScope 展示入口 | 保留原平台说明 |

这些是独立展示和实验，根目录 `npm run dev` 启动的是当前 App 与核心后端。静态页面可用 Python HTTP server 查看；需要保留页面原来的 URL 路径。较大素材来源、权限与校验方式见 [`docs/team/HANDOFF.md`](../docs/team/HANDOFF.md)。
