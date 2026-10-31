# UNSEEN 独立 Web 与微信小程序交付记录（2026-08-02）

## 本轮边界

- 本轮只完善独立 Web、独立微信小程序与各自的数据链路。Web 保留原 CloudBase/OSS 后端；小程序已迁移到同一 AppID 自带的微信原生云开发。
- 秒哒应用未修改、未发布。
- `/Users/max/code/spatial-memory` 主仓未修改。
- 正式产品采用“上传优先”：用户上传普通照片；创建者可选上传外部制作完成的 2:1 全景图。正式入口不提供拍摄、扫拍或本地拼接。

## 已部署服务

- Web 门户：<https://unseen-d3gtp0sxh53bbef61-1316841054.tcloudbaseapp.com/portal.html>
- Web 应用：<https://unseen-d3gtp0sxh53bbef61-1316841054.tcloudbaseapp.com/web/index.html>
- API：<https://unseen-d3gtp0sxh53bbef61-1316841054.ap-shanghai.app.tcloudbase.com/unseen-api>
- CloudBase 环境：`unseen-d3gtp0sxh53bbef61`
- 云函数：`unseenBackend`，Node.js 20.19，512 MB，60 秒
- 每小时维护触发器：`unseenMaintenanceHourly`
- 微信小程序 AppID：`wx551ef9eb67257f96`
- 微信原生云环境：`cloudbase-d0gowqdov1065e179`
- 小程序原生云函数：`unseenNative`，状态 `Active`

Web 与小程序都默认创建共享云空间；“仅保存在本机”是明确的次入口。Web 继续走原 HTTP/OSS 链路；小程序走 `wx.cloud.callFunction`、`wx.cloud.uploadFile` 与微信云数据库。小程序共享链接只包含 `sid`，创建者身份由微信 `OPENID` 校验，不再保存或传输 `hostKey`。

## Web 后端上传模型

1. 客户端用稳定随机 ID 调用 `createSpace`。
2. 后端只签发精确到单个私有 OSS object key、15 分钟有效的 POST policy。
3. 创建者上传可选封面/全景后调用 `finalizeSpace`。
4. 参与者每张普通照片先取 `photoTicket`，上传后用不可伪造的 `commitToken` 调用 `commitPhoto`。
5. 后端按 magic bytes、尺寸与大小校验真实对象，发布不可变照片与公开 manifest。
6. 所有创建、取票和提交路径均可安全重试；单空间最多 90 张普通照片。

## 小程序原生云上传模型

1. `app.js` 固定初始化环境 `cloudbase-d0gowqdov1065e179`；业务动作统一调用云函数 `unseenNative`，不经过合法域名列表。
2. 创建空间后，云函数返回受 `sid` 约束的全景 `cloudPath`；客户端直接用 `wx.cloud.uploadFile` 上传到私有云存储。
3. 发布时云函数重新下载图片，按 magic bytes、真实尺寸、2:1 比例和大小校验，再把私有 `fileID` 写入空间。
4. 参与者普通照片采用 `preparePhoto → wx.cloud.uploadFile → commitPhoto`；90 个固定 slot 防止并发超卖，24 小时后清理失效预留。
5. `createSpace`、`preparePhoto` 与 `commitPhoto` 都使用稳定客户端 ID 保证幂等；云数据库事务保证照片、上传任务和容量 slot 同步提交。
6. 对外 manifest 只返回临时访问地址、作品数据和容量，不泄露 `OPENID`；旧 HTTP/OSS 空间仅保留读取兼容。

## 已完成验收

- 后端语法与单元/集成测试：10/10 通过。
- 真实生产 API + OSS：14 项断言通过，覆盖创建、全景上传、发布、普通照片取票/上传/提交、幂等重试、公开 manifest 与资源读取。
- 独立 Web 本地与已部署页面：320、375、390、430、768、1024、1440 七档响应式自动回归 9/9 通过。
- 真实浏览器云端闭环：有全景、无全景各一轮，均可创建、上传普通照片、生成 sid-only 分享链接并在全新浏览器上下文查看。
- 微信小程序页面代码测试：7/7 通过；原生云后端纯函数测试 1/1 通过。
- 微信原生云真实 E2E：健康检查、自动建表、创建空间、上传 2048×1024 全景、发布、准备普通照片、上传、事务提交、重复提交幂等、manifest/容量读取和精确清理全部通过。
- 微信开发者工具真实 Page 自动化：连续 10 轮通过，异常 0；覆盖首页、创建、本机照片、时间线、2D 全景与删除，确认本机模式不会调用生产网络。
- 微信开发者工具 iPhone 12/13 Pro 模拟器（390×844、3×像素比）首页几何验收通过：共用 20px 内容边距，四张场景卡严格 2×2；“打开”按钮右边为 362px、外卡右边为 370px，无裁切和横向越界；底部导航 390px 铺满；捕获异常 0。
- 旧 `UNSEEN-miniapp-shared-cloud-final-v2-20260802.jpg`、`UNSEEN-miniapp-native-cloud-v4-20260802.jpg`、`UNSEEN-miniapp-unified-home-v5-20260802.jpg`、`UNSEEN-miniapp-demo-center-v6-20260802.jpg` 均不能继续使用；真实演示版本见下方 2026-08-03 记录。
- 自动验收产生的临时空间与对象已精确删除。

## 小程序与 Web 首页统一（2026-08-02）

- 用户真机截图确认小程序首页存在三个独立问题：旧三点品牌标识仍在、调试用 vConsole 覆盖内容、“打开已有空间”的按钮被输入框挤出屏幕。
- 小程序首页现与稳定 Web 首页共用同一视觉层级：U 标识、粉橙渐变主视觉、相同标题/说明、四个场景卡、整行主次按钮和底部三导航；秒哒本轮仅作为视觉基线，未消耗秒点、未修改或发布。
- 小程序仍保留云端默认、本机次入口、按空间编号打开和本机历史，不为统一外观删减功能；这些次级功能位于统一首屏之后。
- 输入行改为可收缩 flex 布局，输入框明确 `min-width: 0`，按钮宽度固定 128rpx，外卡强制隐藏横向溢出；主、次按钮明确 `width: 100%`，消除微信原生 `button` 未自动拉满造成的居中窄按钮。
- `app.js` 启动时显式关闭持久化调试开关，开发者工具截图已不再出现绿色 vConsole；真机需要用新预览码冷启动复核一次。

## 统一演示中心（2026-08-02）

- 独立 Web 与小程序首页都增加顶栏“◇ 演示”胶囊和独立演示中心卡；不向底部导航硬塞第五项。
- 演示中心统一为三组五项：产品与体验（六幕产品故事、上传优先流程）、全景技术实验（720° 球形全景、横向扫拍）、研究说明（回到 TA 的视角）。每项明确类型、能力边界和动作。
- Web 新增 `#/demo`；旧 `demo.html`、`pov.html`、`pano-capture.html`、`pano-sweep.html` 统一返回 `index.html#/demo`。线上入口、JS、CSS 与四个旧演示页共 8 个文件已先备份到 `artifacts/cloudbase-backups/20260802-demo-center-predeploy/`，再精确覆盖；线上与本地 SHA-256 逐文件一致。
- Web 正式入口：<https://unseen-d3gtp0sxh53bbef61-1316841054.tcloudbaseapp.com/web/index.html?v=20260802c#/demo>。
- 小程序重新注册 `pages/demo/demo`，并把现有球形拍摄/横向扫拍放进隔离演示路由；创建、上传、空间详情正式页面仍不直接跳实验。开发者工具 390×844 几何验收：五张卡共用 20px 边距、产品故事可展开、两个实验路由可达、异常 0。
- 小程序新增演示后，正式本机创建→普通照片→2D 全景→删除流程再次连续 10/10 通过，异常 0、生产网络调用 0；页面/算法/云函数八组代码测试全部通过。
- 秒哒正式 app 当前线上为 v19、无待发布修改。本轮集中演示中心 chat 在执行前返回“秒点不足”，因此秒哒未改、未发布；秒点恢复后再执行一次集中修改和独立 `publish --wait`。

## 可真正进入的演示作品集（2026-08-03）

- 2026-08-02 的第一版只是目录页：小程序“六幕产品故事”在原卡片下面展开三小段文字，“回到 TA 的视角”只弹出说明框；这两个动作不构成可用 Demo，现已删除。
- Web 与小程序演示中心统一为六个真实入口：理想的共同记忆空间、六幕产品故事、上传优先流程、720° 球形全景、横向扫拍、回到 TA 的视角。坏的无参数 `show.html` 不再出现在入口或六幕故事终点。
- Web 新增 `#/demo-story`，可逐幕进入 1–6；新增 `#/demo-vision`，在同一成品中切换“空间 / 时间线 / 全景 / TA 视角”。全景方向和四位拍摄者都可操作；跨页面和六幕翻页自动回顶，成品内部换标签保留当前位置。
- 小程序新增原生页 `pages/demo-story/demo-story` 与 `pages/demo-vision/demo-vision`，不使用 WebView、弹窗或假展开。六幕支持左右滑动、页码、上/下一幕和最终 CTA；成品页支持四个标签、横向 2:1 全景和四个 TA 方向。
- 产品 Demo 已从算法测试用彩色经纬网切换为仓库内真实宴会厅全景与六张宾客照片；经纬网只留给隐藏算法测试。
- Web 在 320×700、390×844、1280×900 三档浏览器完成入口、六幕翻页、四标签、全景方向和 TA 人物切换；无横向越界，控制台 error 为 0。线上 4 个覆盖文件已先备份到 `artifacts/cloudbase-backups/20260803-real-demo-predeploy/`，发布后逐文件 SHA-256 与本地一致。
- Web 正式演示入口：<https://unseen-d3gtp0sxh53bbef61-1316841054.tcloudbaseapp.com/web/index.html?v=20260802e#/demo>。
- 小程序在微信开发者工具 iPhone 12/13 比例下逐页点击完成：演示中心 → 六幕 1–6 → 最终 CTA → 理想成品 → 时间线/全景/TA 视角 → 小红视角；编译问题 0。验收截图为 `artifacts/miniapp-demo-story-real-20260803.png` 与 `artifacts/miniapp-demo-vision-real-20260803.png`。
- 新预览码固定为 `UNSEEN-miniapp-real-demo-v7-20260803.jpg`，AppID `wx551ef9eb67257f96`，预览包 1,705,311 bytes，二维码 SHA-256 `65ffffbfa396dcc51f701e0e1ccaf761e9097acaf4f41086b83d505495da1465`。此前所有二维码作废。
- 新增演示后再次执行正式本机闭环 10/10：创建空间、上传普通照片、加入成品全景、打开 2D、删除；异常 0、生产网络调用 0。
- 秒哒正式应用本轮仍未修改或发布；不要把 Web/小程序完成状态误报为秒哒已同步。

## Web 响应式排版升级（2026-08-02）

- 线上 Web 已由固定 430px 手机壳升级为三段响应式布局：手机全宽、平板最大 760px、桌面最大 1120px。
- 首页首屏取消 220px 固定高度，标题、说明和状态标签按内容自然排布，修复窄屏文字与标签重叠。
- 统一中文系统字体、响应式字阶、行高、标题平衡换行、说明文字行长和按钮高度；主按钮由 77px 收敛到 58px。
- 320px 使用单列场景卡，375–430px 使用双列，平板使用四列，桌面首页使用主视觉 + 操作区双栏。
- 创建、加入、空间列表等内容页在桌面限制为 720px 阅读宽度，避免表单和长说明横向拉散。
- 发布前已备份旧线上 `index.html`、`unseen.js`、`unseen.css` 到 `artifacts/cloudbase-backups/20260802-responsive-predeploy/`；发布后 JS/CSS 的 SHA-256 与线上文件逐字节一致。
- 第二次真机反馈后确认入口和静态资源存在 5 分钟浏览器/CDN 缓存窗口；现已把入口、门户跳转、CSS、JS 统一锁定为 `v=20260802b`。版本化入口与生产文件哈希一致，重新执行生产浏览器回归 9/9 通过。

## AI 演示档案馆（2026-08-03）

- 旧演示没有删除，而是曾散落在 `demo.html`、`show.html`、四个 `viewer/walk.html` 场景、`roadshow.html`、`workspace.html`、`pov.html`、`portal.html` 以及多份旧概念页中；因此从新版演示中心看起来像“消失了”。本轮把它们整理为一个长期入口。
- 档案馆按 `4 个 AI 空间 + 5 种观看形态 + 6 份叙事/路演/研究原稿 = 15 个可进入版本` 展示。当前“理想成品”和“新版六幕”单列为产品方向，不混入历史数量。
- Web 新增 `#/demo-archive`、`#/demo-player?id=…` 和 `#/demo-mode?mode=…`。仍在线的历史原稿用统一返回栏和安全白名单播放器承载；已不再独立存在的“婚礼旅程、时光轴、记忆相册、机器回忆、一键成片”恢复为新的可操作页面。
- Web 线上档案馆：<https://unseen-d3gtp0sxh53bbef61-1316841054.tcloudbaseapp.com/web/index.html?v=20260803a#/demo-archive>。生产浏览器确认 15 张入口卡完整、页面无横向溢出；旧版六幕 iframe 实际加载，恢复后的相册显示 12 张照片并可打开灯箱。
- 小程序新增原生页 `pages/demo-archive/demo-archive`，不使用 WebView 和业务域名；同样显示 4 个空间、5 种观看形态和 6 份历史原稿。四方向全景、时间线、相册、机器视角与六镜故事板都有原生可操作预览。
- 微信开发者工具 iPhone 12/13 模拟器完成首页 → 演示中心 → 档案馆实际点击；确认 15 个版本全部渲染、四方向按钮保持横排、方向切换更新预览、0 个 DevTools error、0 个 Problems。标准基础库提示与 SharedArrayBuffer 弃用提示不属于业务异常。
- 新预览码为 `UNSEEN-miniapp-ai-demo-archive-v8-20260803.jpg`，AppID `wx551ef9eb67257f96`，预览包 1,727,303 bytes，二维码 SHA-256 `138e774947195d66227661e9e573e6e7cee6134c97a30a3a545ef1c2bba368fb`。此前 v7 及更早二维码作废。
- Web 发布前的线上三文件备份位于 `artifacts/cloudbase-backups/20260803-ai-demo-archive-predeploy/`；本轮只精确覆盖 `web/index.html`、`web/unseen.css`、`web/unseen.js`，没有触碰后端或秒哒。

## 纯 AI 婚礼全景找回与重新归档（2026-08-03）

- 历史记录中用户所说的“纯 AI 抽出来的全景图”已精确定位为固定空间 `s900001`。`space.json` 明确记录 `aiGenerated: true`、fixture `wedding-spatial-v1`、4 个 1774×887 的 2:1 AI 全景节点和 8 张 AI 照片；四幕依次为“初见 / 迎宾庭院、誓言 / 林间仪式、共宴 / 烛光长桌、尽兴 / 星夜派对”。
- 同时纠正上一版分类错误：`entrance_hall`、`comfy_cafe`、`chapel_day`、`ballroom` 来自 Poly Haven 的真实 CC0 全景，只是渲染和照片钉点技术样片，不是 AI 生成内容。
- 档案馆不再平铺 15 张同级卡片。网页端和小程序端统一改为“1 件主作品 + 3 类折叠归档”：纯 AI 婚礼全景置顶；4 个真实技术样片、5 种观看形态、5 份历史原稿分别收起。当前理想成品与新版六幕仍作为产品方向单列。
- Web 主作品可进入旧 `show.html?s=s900001` 完整展览，实际展示 4 个全景节点和 8 张 AI 照片；首页四张预览使用 640×320 的轻量本地缩略图，避免首屏下载约 11 MB 原始 PNG。生产链接：<https://unseen-d3gtp0sxh53bbef61-1316841054.tcloudbaseapp.com/web/index.html?v=20260803d#/demo-archive>。
- 小程序新增原生页 `pages/demo-ai-pano/demo-ai-pano`，不依赖 WebView：可切换四幕、横向拖动 2:1 全景、按四方向定位，并持续显示 AI 生成内容说明。开发者工具实际点击“演示中心 → 档案馆 → 纯 AI 婚礼全景 → 第四幕”通过，编译错误 0；截图为 `artifacts/miniapp-ai-archive-curated-20260803.jpeg` 与 `artifacts/miniapp-ai-wedding-pano-20260803.jpeg`。
- 新预览码固定为 `UNSEEN-miniapp-ai-panorama-curated-v9-20260803.jpg`，AppID `wx551ef9eb67257f96`，预览包 1,920,857 bytes，二维码 SHA-256 `bc4f878ec1e1bff7586829b729b51670b40991250838afcb59387d9d5280b15a`。此前 v8 及更早二维码作废。
- Web 发布前备份位于 `artifacts/cloudbase-backups/20260803-ai-panorama-curation-predeploy/`。入口、CSS、JS 的线上哈希与本地一致；生产浏览器确认 15 个总入口、3 个折叠组、4 张 AI 缩略图完整加载且无横向溢出。主仓 `/Users/max/code/spatial-memory` 全程只读，秒哒未修改。

## 微信原生云状态与清晰操作路径

此前“AppID 未开通原生云、只能补合法域名”的判断已经失效。2026-08-02 从微信开发者工具重新查询确认，同一 AppID 已直接开通并绑定环境 `cloudbase-d0gowqdov1065e179`；`wx.cloud` 数据库与存储访问均成功，云函数 `unseenNative` 已部署。因此小程序正式路径固定为：

`App 启动 → wx.cloud.init → unseenNative → 微信云数据库/云存储`

不再要求 Max 配置阿里云 OSS，也不再要求为小程序补旧 API/OSS 的 `request`、`uploadFile`、`downloadFile` 合法域名。Web 仍独立使用旧 HTTP/OSS 后端，两端在产品交互和数据契约上保持一致，但后端调用方式不强行做成同一套。

当前唯一建议的控制台增强不是功能阻塞：`unseenNative` 仍是平台默认 3 秒超时，200 KB 真实全景 E2E 已通过；为覆盖接近 50 MB 上限的图片，建议管理员在“云开发 → 云函数 → unseenNative → 函数配置/高级设置”把超时时间调到 20 秒。官方配置说明：<https://docs.cloudbase.net/cloud-function/function-configuration/config>。

## 真机验收清单

1. 无全景创建共享空间，退出并从“我的空间”重新打开。
2. 上传合格的 JPEG/PNG/WebP 2:1 全景创建空间；不合格比例、HEIC 与超限文件应在上传前阻断。
3. 分别上传 1、3、9 张普通照片；弱网失败后只重试失败项，不能重复入库。
4. 分享给另一微信账号；新账号仅凭 `sid` 打开并看到全景、照片与时间线。
5. 切后台后返回、拒绝相册权限后从设置恢复、连续点击按钮，均不能卡死或发起重复提交。
6. 从本机历史移除远端空间不应删除云端数据；重新用分享链接仍能打开。

## 后续非阻塞增强

- 把云函数使用的 OSS 凭据切换为专用、最小权限 RAM 身份。
- 将 OSS V1 Header/PostObject 签名整体迁移到 V4。
- 数据规模增长后增加服务端缩略图、manifest 分页和可观测告警。

## 2026-08-04｜三端同步与秒哒 v22

三端当前统一为同一个“上传优先 MVP”，不再把端上拍摄/拼接放进正常产品路径：

- 秒哒 H5：<https://app-dd5e9nnkw4qp.appmiaoda.com>，线上 `v22 / app_version-dgr5ak4kixvk`，发布记录 `app_release_record-dgr5h4w9zrpd`。
- 独立 Web：<https://unseen-d3gtp0sxh53bbef61-1316841054.tcloudbaseapp.com/web/index.html?v=20260803d>。
- 微信小程序：AppID `wx551ef9eb67257f96`，开发预览 `/Users/max/Documents/ADVX/work/unseen-panorama-rebuild/UNSEEN-miniapp-ai-panorama-curated-v9-20260803.jpg`。

统一项包括 U + UNSEEN 顶栏、粉橙奶油视觉、婚礼/旅行/聚会/日常 2×2、首页/空间/创建三导航、普通照片与成品 2:1 全景上传、演示中心与纯 AI 四幕婚礼 `s900001`。秒哒生产浏览器已验证首页、`/app`、本机创建、演示档案、第四幕、方向切换和旧拍摄深链重定向；364 px iframe 无横向溢出。

2026-08-04 的 v22 额外修复秒哒桌面生产宿主的“双页叠加”：平台同时保留原始 `#root` 并注入手机 iframe，原始内容从 iframe 下方漏出。当前仅在桌面检测到 `#md-h5-iframe` 时隐藏宿主 root，手机直开和 iframe 内应用保持显示。自动回归通过 1280×720 桌面以及 320/375/390/430 四档手机宽度；`/`、`/app`、`/create`、`/demo` 均无重复页面和横向溢出。

后端仍应分别按各端真实状态描述：微信小程序走微信云开发 `cloudbase-d0gowqdov1065e179`；独立 Web 沿用现有 Web 后端；秒哒 Supabase 当前 `INACTIVE`，所以秒哒仅确认本机模式和静态演示可用，不能把云端分享/多人上传标成已通过。下一次秒哒编辑页激活后，应立即验证“云端创建 → 上传普通照片/2:1 全景 → 分享链接 → 第二设备打开”。
