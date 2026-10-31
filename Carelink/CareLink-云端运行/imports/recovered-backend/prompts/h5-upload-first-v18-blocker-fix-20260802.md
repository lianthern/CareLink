继续修改当前正式 H5 应用的未发布开发版。目标必须且只能是 app-dd5e9nnkw4qp，当前 conversation/context 必须是 conv-dd5e9nnkw4qo。当前开发版 app_version-dff0i2rq9ssg（界面显示 v18）已经加入 upload-first 基础，不要回滚到 v15/v16，不要恢复任何拍摄/拼接功能，不要修改其他 app，不要发布。本轮只修发布阻断项，并在结束前自行读取实际源码和实际数据库策略验证，不能仅凭上一轮总结。

产品边界再次固定：这是“上传优先”的正式 MVP。参与者上传手机里已有的普通照片；创建者可上传外部相机或第三方软件已生成的 2:1 等距柱状全景图。正式产品不提供拍全景、自动拍照、视频扫拍、拼接、陀螺仪采集。不要声称有登录、成员制或真正私密空间；当前是“拿到空间链接即可查看和贡献”的 bearer-link MVP。

请完整完成以下 P0/P1 修复，尽量集中修改，避免无关重构：

1. 路由与入口彻底收口
- 正常主路径保留 `/`、`/create`、`/app`、空间列表/详情、`/app/spaces/:id/photos`、查看成品全景所需路由。
- `/pano-guide`、`/pano-capture`、`/pano-stitch`、`/roadshow`、`/roadshow-upload`、`/spatial`、`/upload`、`/studio` 及其旧深链全部用 `<Navigate replace to="/app" />` 收口；不要只隐藏卡片而保留可用深链。
- Home 删除 Roadshow、Studio、拍摄和拼接入口；核心只保留创建空间、进入真实空间、上传照片。旧组件源码可以保留但必须不可达，避免大范围删除导致风险。

2. 真正对齐参考视觉但不要假手机框
- 以 430px 内容壳为桌面最大宽度；手机宽度 100%。外层桌面背景 `#F4EEF0`，内容背景 `#FFF9F7`，卡片 `#FFFCFB`，正文 `#59383E`，次级文字 `#94787C`，粉色 `#F8C8D6`，橙色 `#FDE0A8`，激活色 `#FF7F9F`，主要渐变约 `linear-gradient(100deg,#F8C8D6,#FDE0A8)`。
- `PhoneFrame` 不得再有桌面圆角、边框、阴影、932px 假设备高度；它只是居中的 430px 内容壳，最小高度 `100dvh`。
- 秒哒生产页可能注入 `@media(min-width:768px){#root,#app{display:none;}}`，在 index.css 明确加入同媒体条件下 `#root,#app{display:block !important;}`，保证桌面浏览器可见。
- Landing/Home/Create/SpaceDetail 统一上述 token 和大圆角风格；避免再保留旧金棕色视觉。不要为了像素模仿破坏可访问性或主要流程。

3. 普通照片上传必须可幂等重试且不重复
- 每个待上传文件在“用户选择时”只生成一次稳定的 `clientUploadId`；重试复用同一个 ID。不要在 `uploadSpacePhoto()` 内每次重新生成 ID。
- 提供兼容 ID 工具：优先 `crypto.randomUUID()`，不可用时用 `crypto.getRandomValues`，再有明确非加密 fallback；所有调用不得假设 randomUUID 一定存在。
- `uploadSpacePhoto` 明确接收 `clientUploadId` 和 `uploaderId`。对象路径固定为 `${spaceId}/${uploaderId}/${clientUploadId}.${ext}`，不重复扩展名，不包含未清理的原文件名。
- Storage 保持 `upsert:false`。调用前先按 `client_upload_id` 查询：已存在则直接返回已存在记录。若第一次 Storage 成功但 DB 写入失败，重试遇到“对象已存在/409”时不能永久失败：继续取得同一路径 public URL 并重试数据库插入；数据库唯一键冲突时重新查询并按成功处理。不要删除已成功文件。
- 上传队列只重试 error 项；done 项绝不重复上传。修正所有使用旧 state 计算成功/失败数量的问题，最终结果以本次 Promise 返回值或函数式 state 为准。
- 上传阶段至少清楚显示“处理中/上传中/保存中/完成/失败”；离页拦截仅在仍有处理中请求时启用并正确移除。
- 普通照片客户端做移动端友好的压缩：原图较小时保留；大图最大边约 2560、JPEG/WebP 质量约 0.82，释放 object URL/canvas/bitmap 内存；压缩失败可回原图，但最终仍必须满足单张 ≤20MB。HEIC/HEIF 用扩展名、MIME 和文件头共同识别并清楚提示先导出 JPEG。不要把普通照片误判成 2:1 全景。
- EXIF 时间提取只能作为可选增强，解析失败不能阻止上传。详情列表优先按 `captured_at` 倒序、为空时按 `created_at` 倒序；分页不能重复项目。

4. 成品全景上传保持原图并严格阻断无效文件
- 只接受 JPEG/PNG/WebP、≤50MB、最小 1600×800、宽高比 1.90–2.10；验证失败必须阻断创建/上传并显示原因，不只是警告。
- 不得再把全景压到 1080 或 1MB；上传原文件。每次替换文件都正确 revoke 旧 preview URL。
- 创建页移除“私密空间”开关或任何“仅受邀可见”的虚假承诺，写入 `is_private:false`；移除所有从 pano stitch URL 回填逻辑。

5. 360 查看绝不能因 WebGL 黑屏
- 默认始终呈现可见的 2D 等距柱状 `<img>`，360° 是用户主动点击的增强模式。
- Three.js 只在用户主动开启时动态加载。Renderer 使用 `antialias:false`、`powerPreference:'low-power'`、`setPixelRatio(1)`。
- WebGL renderer/纹理/场景/监听器/resize/render 任一步都要置于可恢复的 try/catch 清理流程。360 画布至少首帧成功后才覆盖或隐藏 2D 图；加载期间保留 2D。
- 监听 `webglcontextlost`，调用 preventDefault，立即停止动画并完整 dispose，然后自动回到 2D，显示“360° 模式不可用，已回到平面图”；初始化失败同样自动回到 2D，不能用整页错误或黑底替代已有图片。
- 关闭增强模式、路由卸载和竞态都必须幂等清理 requestAnimationFrame、renderer、geometry、material、texture、DOM canvas 和监听器。图片本身加载失败要显示明确错误状态而不是黑屏。

6. 分享回退与数据库权限
- `navigator.share()` 被拒绝或失败时：若不是用户主动 Abort，则继续尝试 Clipboard；Clipboard 不可用时提供真实可复制的当前 URL/选中文本，只有真实成功才提示“已复制”。
- 查询 `pg_policies` 和 `storage.objects` 的当前实际策略，不要凭策略名猜测。`spaces/tasks/imprint_points/space_photos` 和现有业务表不得给 anon/authenticated 宽泛 UPDATE/DELETE；`memory_media/panoramas/photo_uploads` 三个桶也不得有客户端 UPDATE/DELETE，仅保留产品当前需要的 SELECT/INSERT。不要删除已有数据或桶。
- 把本轮实际 forward-only、可重复执行的 SQL 保存到新的 migration 文件（若 00003 已存在就用 00004，不覆盖已应用历史），并实际 apply。migration 要根据真实策略查询结果精确清理，不能只写不存在的 policy 名。
- 不增加伪 Auth，不在 UI 声称 owner/admin/member 权限。

7. 最终硬验收
- 逐个重新读取 routes、Home、Create、SpacePhotos、SpaceDetail、api、PhoneFrame、index.css、PanoramaView 和 migration，确认上述要求真正存在于代码。
- 运行真实 `npm run lint`，必须 exit 0；若 package 的 build 是 echo/no-op，要明确说明，不能把它当构建通过证据。
- 最终报告：实际修改文件、lint 原始末行、数据库 policy 查询的最终表格摘要、仍然存在的限制。不要发布，等待外部单独 `publish --wait`。
