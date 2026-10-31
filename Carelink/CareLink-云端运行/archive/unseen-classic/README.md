> 此目录是 2026-09-20 导入的来源快照。统一安装、当前用途、素材与部署边界请先读仓库根目录 README 和 `docs/team/HANDOFF.md`；下文保留原项目说明。

# UNSEEN Classic — AdventureX 2026 黑客松原版(抢救归档)

> 2026-08-25 从腾讯云 CloudBase 环境 `unseen-d3gtp0sxh53bbef61`(预付费,创建于
> 2026-07-25 AdventureX 现场,2026-08-25 到期不续)整体抢救下来的 UNSEEN 原始版本。
> 这是黑客松时期的概念演示站,与现行生产仓 `maxi-max-dev/unseen`(unseen.maxxam.xyz)
> 是两套独立代码;此仓只做原版保存与展示,不再开发。

## 内容

| 目录 | 来源 | 说明 |
|---|---|---|
| `site/` | COS 桶 `2c9f-static-…` 静态托管全量 309 文件 | 产品主页 portal、空间体验(Spatial/Pico/World)、深度图 demo、赞助商赛道实验室等 |
| `cloud/unseenBackend/` | 云函数 `unseenBackend`(Node 20,2026-08-02 版) | OSS 直传后端:PostObject policy、magic-bytes 校验、槽位原子预留 |
| `oss-data/` | 阿里云 OSS 桶 `psm-advx-2026`(杭州)全量 134 对象 | 演示空间数据 `spaces/`(全景与照片)+ `unseen-backend/` 提交记录 |

## 原始部署拓扑(已停)

- 静态站: `unseen-d3gtp0sxh53bbef61-1316841054.tcloudbaseapp.com`(TCB 静态托管)
- API: TCB 云函数 HTTP 访问服务 `/unseen-api`
- 媒体: 阿里云 OSS `psm-advx-2026`(公共读经 `OSS_PUBLIC_BASE`)
- TCB 云存储桶为空、TCB 数据库未被代码使用(后端纯 OSS 记账),均无需迁移

## 镜像展示

原版静态站逐字节镜像部署在 https://unseen-classic.maxxam.xyz
(香港机 `/var/www/unseen-classic`,Caddy 静态 vhost)。
注意:站内调用 TCB API 的动态功能(创建空间/上传)在源环境到期后即失效,镜像不修改、不接新后端——原版原样保存。

## 密钥

云函数环境变量(含 OSS AccessKey 与各签名 secret)保存在本机
`cloud/unseenBackend.env.json`(chmod 600,已 gitignore),不入仓、不入任何远端。
