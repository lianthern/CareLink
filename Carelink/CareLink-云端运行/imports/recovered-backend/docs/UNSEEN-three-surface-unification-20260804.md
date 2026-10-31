# UNSEEN 三端前端统一与后端收口记录（2026-08-04）

## 本轮发布结果

### 秒哒 H5

- 正式地址：<https://app-dd5e9nnkw4qp.appmiaoda.com>
- App ID：`app-dd5e9nnkw4qp`
- Context ID：`conv-dd5e9nnkw4qo`
- 版本：v26 / `app_version-dhspjq097i0w`
- 发布记录：`app_release_record-dhsq7edlx4w1`
- 修复：AI 演示档案馆的历史原稿不再是不可点击文本；五项均为按钮并进入 `/demo/archive/:id` 静态详情。
- “一场未曾拍摄的婚礼”已从裁切图片方向按钮升级为全屏沉浸页：Four-node Three.js 球面全景、鼠标/触摸拖动、四幕节点切换、首帧前 2D 环视、WebGL 失败或 context lost 时自动回退并释放资源。
- v25 已修复无 WebGL 降级路径的图层与点击缺陷：四幕控件始终在 2D fallback 上方，`n1 → n2 → n3 → n4 → n1` 可完整循环，档案馆主作品卡片可以真实进入体验。
- v26 已修复 2D 环视向右拖动时单张图片平移露出黑边的问题：改为 `background-image + repeat-x` 无缝水平平铺，保留 `data-yaw` 并新增 `data-pan-x` 作为回归断言。
- 2026-08-05 线上浏览器验收：无 WebGL 环境自动进入 fallback；正反方向各累计拖动 624px 均无黑边；四幕循环与返回档案馆通过；随后连续 10 轮执行“四幕循环 + 左右拖动”，10/10 均回到 `n1 / yaw 0 / panX 0`，控制台 error 为 0。

### 独立 Web

- 正式入口：<https://unseen-d3gtp0sxh53bbef61-1316841054.tcloudbaseapp.com/web/index.html?v=20260804a>
- 演示中心：<https://unseen-d3gtp0sxh53bbef61-1316841054.tcloudbaseapp.com/web/index.html?v=20260804a#/demo>
- 档案馆：<https://unseen-d3gtp0sxh53bbef61-1316841054.tcloudbaseapp.com/web/index.html?v=20260804a#/demo-archive>
- 对外演示中心已移除 720° 拍摄与横向扫拍入口；保留理想成品、六幕故事、上传优先流程、AI 档案馆。
- 档案馆共 15 个可进入入口：主作品 1、技术对照 4、交互形态 5、历史原稿 5。
- 生产 `index.html` 与 `unseen.js` 的 SHA-256 已与本地逐字节一致；发布前备份在 `artifacts/cloudbase-backups/20260804-unified-demo-predeploy/`。

### 微信小程序

- AppID：`wx551ef9eb67257f96`
- 新预览码：`UNSEEN-miniapp-unified-demo-v10-20260804.jpg`
- 预览包：1,925,382 bytes
- 二维码 SHA-256：`dedf9e53d34f2af423de165790e9c0bf91897d91730f9b220dbc5d15500131a9`
- 新增 `pages/demo-detail/demo-detail`，五份历史原稿都有独立静态详情和明确返回路径。
- 对外演示中心不再暴露拍摄实验；相关源码仍保留为内部实验，不影响正式上传优先流程。

## 三端统一信息架构

正常入口固定为：

1. 理想的共同记忆空间
2. 六幕产品故事
3. 上传优先流程
4. AI 演示档案馆

档案馆固定为：

- 主作品：一场未曾拍摄的婚礼（4 幕 AI 全景）
- 技术对照：入口大厅、舒适咖啡馆、日间礼堂、古典宴会厅
- 交互形态：婚礼旅程、时光轴、记忆相册、机器回忆、一键成片
- 历史原稿：六幕评委 Demo、路演现场、空间工作台、回到 TA 的视角、产品 Showcase

返回链固定为：详情 → AI 演示档案馆 → 演示中心 → 首页。

## 已知差异与验收边界

- 秒哒的“六幕产品故事”当前仍复用四幕 AI 婚礼体验，独立 Web 与小程序已有独立六幕页面；这是秒哒当前明确的演示差异，下一轮应补齐独立六幕页。v24 的无 WebGL 图层遮挡与随后发现的拖动黑边均已在 v25/v26 修复并上线。
- 小程序静态契约、上传回归和官方开发者工具预览编译通过；Page 自动化受到本机旧自动化端口与首屏 RPC 卡住影响，本轮未通过，因此不能算作真机验收。
- 小程序预览码不是审核发布版本；相机、内存、分享与云函数路径仍以 Max 真机结果为准。

## 当前后端事实

三端前端已经统一，但后端尚未统一：

- 独立 Web：腾讯 CloudBase 环境 `unseen-d3gtp0sxh53bbef61`，通过独立 Web API 与阿里云 OSS 保存共享空间数据。
- 微信小程序：微信云开发环境 `cloudbase-d0gowqdov1065e179`，业务调用云函数 `unseenNative`。
- 秒哒：2026-08-05 最新 `app-detail` 显示平台内置 Supabase 与生产 Supabase 均为 `INACTIVE`；静态演示不依赖该后端，但云端创建、上传与多人分享不能算作端到端可用。

## 推荐的后端统一方向

不要把三个客户端直接改成共享数据库账号；统一成一个版本化 API 契约：

1. 以独立 Web 已有的 CloudBase API + 阿里云 OSS 数据模型作为主数据面。
2. 固定 `space / photo / panorama / share-token / upload-ticket` 五类 API 与统一错误码、幂等键。
3. Web 直接调用 HTTPS API；小程序的 `unseenNative` 暂时作为薄代理调用同一 API；秒哒也调用同一 HTTPS API。
4. 等微信合法域名、CORS、鉴权与 bearer-link 权限模型完成后，再移除小程序旧数据双写，避免一次迁移把现有预览链路打断。
5. 迁移前先做只读清单：现有空间数、照片数、对象存储路径、分享链接格式和重复 ID；没有清单前不做破坏性合并。

这样三端共享的是同一业务事实与对象存储，而不是三套数据库互相同步。
