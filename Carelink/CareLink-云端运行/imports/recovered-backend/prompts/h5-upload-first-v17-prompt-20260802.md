这是正式 H5 项目的一次完整可发布增量。请直接检查并修改当前 workspace，完成代码、forward migration 和真实自查；不要写 PRD、不要提问、不要创建新项目、不要 generate-app、不要发布。

项目事实与基线

- 正式项目只有当前 H5 app-dd5e9nnkw4qp；app-d9 系列只是视觉/流程参考，绝对不要修改、调用或发布它们，也不要复制它们的 Expo/React Native 代码。
- 线上基线是 v15 / app_version-ddssyfiqeh34。当前 workspace 可能是未发布 v16 / app_version-depyv57vs16o；v16 是错误方向的 720° 拍摄实验，不能直接发布。本轮必须先把它从正式产品路径完全收口。
- 当前工程是 Vite + React + React Router + Tailwind + Supabase。沿用这个架构，只迁移参考版的信息层级、交互节奏、视觉 token 与上传流程。
- 复用并恢复当前项目已有 Supabase；不得新建、替换、重绑另一个 Supabase，不得破坏旧数据。只新增 forward-only migration，不改历史 migration。
- 本轮产品定位：用户创建记忆空间，分享空间链接，参与者上传普通照片；创建者可在创建空间时上传一张外部工具生成的标准 2:1 等距柱状全景图。正式产品不再提供全景拍摄、自动拍照、陀螺仪引导或拼接。

一、必须先移除错误的拍摄实验

1. 删除 Home 中 v16 新增的“拍摄 720° 全景”入口。
2. Create 中删除“直接在这里拍”“怎么拍/30 秒教程”和从 pano-stitch 回填 panoUrl 的逻辑；全景只能从本地文件选择。
3. 从 routes 和 App 正常公开路径中移除 /pano-capture、/pano-guide、/pano-stitch 及 PanoCaptureProvider。旧大文件可以保留为不可达源码，不要花时间重写数学，但任何深链都必须安全重定向到 /app 或 /create，不能再请求相机或陀螺仪。
4. 正式首页隐藏 Roadshow、Studio、Spatial、固定 s900003 外部上传 iframe；/roadshow-upload、/studio、/spatial 不得出现在主路径，旧深链安全转到 /app。不要把固定 s900003 iframe 改个样式冒充空间上传。
5. 正常入口和文案中不出现 720、拍摄全景、自动拍照、拼接、测试或实验字样。

二、建立真实的普通照片上传闭环（本轮最高优先级）

1. 新增按当前 space.id 绑定的原生 DOM 上传页 /app/spaces/:id/photos。SpaceDetail 最醒目的主 CTA 为“上传照片”，进入该页；分享链接打开同一个空间后也能贡献照片。
2. 上传页使用 input type=file、accept=image/*、multiple，一批最多 9 张。先展示本地预览和待上传数量，用户明确点击“开始上传”后才上传，不能选完即静默上传。
3. 每张照片都有独立且可见的 processing / uploading / saving / success / error 状态和总进度；部分成功时“重试失败项”只能重试失败/未完成项，绝不能重复已经成功的照片。上传过程中禁用重复提交；离开页面前若仍在上传要提示。
4. JPG/PNG/WebP 直接支持；HEIC/HEIF 只有浏览器能够原生解码并成功转换为 WebP/JPEG 时才继续，否则给出明确“请在系统相册中导出为 JPG 后重试”，不得把未知二进制改后缀伪装成功。普通照片单张输入上限 20 MB，最长边压到不超过 2048，输出目标不超过 3 MB，保留正确 EXIF 朝向的视觉结果；压缩失败不上传空文件。
5. 存储路径必须带 spaceId、当前匿名设备 uploaderId 和本地 clientUploadId（crypto.randomUUID，有安全 fallback），文件名唯一、upsert=false。一次页面会话内重试复用同一个 clientUploadId 与已成功 storage path，避免重复对象；数据库记录对 client_upload_id 建唯一约束，重复 insert 视为幂等成功并读取既有记录。
6. 保存照片记录后立即刷新本空间照片时间轴；刷新失败只能提示“已上传，列表刷新失败，可下拉重试”，不能把已成功的文件当失败再传，也不能误删成功数据。
7. SpaceDetail 显示真实照片数量、空态和照片时间轴/网格，按 captured_at（取 file.lastModified，缺失则 created_at）排序。点击照片打开全屏预览，可关闭；不要使用假数据或硬编码 demo space。
8. 增加“分享空间”按钮：优先 navigator.share，失败或不支持时复制当前空间 URL，并明确 toast。它只是“拿到链接即可贡献”的 MVP，不要虚构成员、邀请码或权限角色。

三、Supabase 数据与最低安全边界

1. 新增 forward migration 00003（或下一个未占用编号）创建 public.space_photos：id uuid PK、space_id uuid FK spaces ON DELETE CASCADE、client_upload_id uuid UNIQUE NOT NULL、uploader_id text NOT NULL、uploader_name text NULL、file_url text NOT NULL、storage_path text NOT NULL UNIQUE、original_name text、mime_type text、size_bytes bigint、width int、height int、captured_at timestamptz、created_at timestamptz default now；加 space_id + captured_at/created_at 索引和合理 CHECK（非空、长度、正尺寸、允许的最终 MIME）。
2. 开启 RLS；本轮无真实账户系统，space_photos 只允许 anon/authenticated SELECT 与 INSERT，INSERT 必须关联一个存在的 space，并限制字段长度/MIME/size；不允许客户端 UPDATE/DELETE。
3. 现有架构的 owner_id 只是 localStorage device id，不能当服务端安全身份。因此移除 Create 中“私密空间·仅受邀成员可查看”开关与所有伪私密承诺，新建空间 is_private 固定 false；不要新增仅靠前端判断的 owner/admin 功能。
4. forward migration 撤销现有 anon/authenticated 对 spaces、tasks、imprint_points 的 UPDATE/DELETE 策略；保留当前产品所需 SELECT/INSERT。撤销 memory_media 和 panoramas bucket 对客户端 UPDATE/DELETE 的宽泛策略，保留读取与唯一路径 INSERT；所有上传 upsert=false。不得使用 USING(true) 恢复匿名全写删。
5. 为 memory_media 设置合理的 image MIME 与文件大小边界；不要创建公开可执行脚本或 service-role key。现阶段 public read 是分享空间展示所需，可以保留，但 UI 与报告必须称为“凭链接访问的上传 MVP”，不能称为真正私密成员系统。
6. 如果现有 Supabase 无法恢复、migration 无法实际应用或上传表/策略无法验证，必须明确报阻塞并保持未发布，不能只做 UI 后声称上传可用。

四、外部成品全景上传与查看闭环

1. 全景上传只在 Create 的详情步骤出现，文案为“上传成品全景图（选填）”“请选择由全景相机或外部软件导出的 2:1 等距柱状图”；没有拍摄/教程按钮。创建后本轮不提供修改/删除全景，避免伪 owner 权限。
2. 只接受浏览器实际解码成功的 JPG/PNG/WebP，输入不超过 50 MB，尺寸至少 1600×800，宽高比必须在 1.90–2.10；不符合直接阻止继续并显示具体尺寸/比例。不得再把大于 1 MB 的全景降到最长边 1080，不要破坏原图分辨率；上传时保留原文件。
3. Create 提交时分别显示封面、全景和建空间阶段；任一上传失败不得创建一个看似成功但素材丢失的空间。按钮防重复提交，错误可重试且保留用户已填表单与本地预览。
4. PanoramaView 默认先显示真实 2:1 平面图片（img/object-contain），页面和按钮立即可用。只有用户主动点击“360°查看”才初始化 Three/WebGL；2D 在 3D 首帧成功前保持可见。
5. WebGL 使用低内存配置 antialias:false、powerPreference:low-power、pixelRatio=1。renderer 构造、贴图加载、首帧、动画、resize、webglcontextlost 任一失败都执行同一幂等 cleanup，显示“360°预览不可用，已切回平面图”，并保持 2D 可见。返回/切回平面/卸载必须取消 RAF、移除相同函数引用的监听并 dispose controls/geometry/material/texture/renderer。

五、界面统一到参考版的 H5 视觉与流程

只迁移视觉与 DOM 信息架构，不复制 d9 运行代码。统一 CSS token：

- 背景 #FFF9F7，桌面外侧 #F4EEF0，卡片 #FFFCFB，正文 #59383E，次文 #94787C，粉 #F8C8D6，橙 #FDE0A8，强调 #FF7F9F，边线 rgba(233,210,214,.65)，主渐变 linear-gradient(100deg,#F8C8D6 0%,#FDE0A8 100%)。
- 卡片/按钮主圆角 20px，媒体 16px，pill 999px，内容横 padding 22px，触点至少 44px；卡片阴影 0 8px 24px rgba(248,200,214,.14)。
- 应用内壳 width:100%、max-width:430px、margin:auto，桌面不画 390px 假手机边框。明确覆盖平台可能注入的桌面隐藏规则：min-width 768 时 #root/#app 仍 display:block!important；桌面应显示居中的 430px H5 内壳，不能空白。
- UNSEEN 使用圆体/无衬线 fallback，不再用旧衬线；letter-spacing 6px。适配 375/390/430、100dvh、safe-area 与微信 WebView。

Landing：brand 顶部约 64px；hero 高约 220、圆角 24，不再占满 4:5；场景为两列轻量 tile（emoji + label，不堆长描述）；主 CTA 粉橙渐变、次 CTA 粉边。

Home：顶部 UNSEEN + 通知；第一张 110px 主 CTA“建立一段记忆 / 邀请大家上传照片，共同补全这一天”；场景为 148×200 横向图片卡；删除 Roadshow/Studio；最近记忆显示真实空间卡与照片数量，不要虚构完成度。

Create：固定 top/footer、中间滚动，保留三步“场景/详情/任务”；场景两列照片卡；封面约 220 高；表单和任务卡统一圆角；移除私密开关和所有拍摄入口；全景上传是明确次级选填项。

SpaceDetail：顶部返回、标题、地点和分享；封面/数据卡后立刻放最高优先级“上传照片”渐变浅卡，副文“从相册选择 · 一起补全这一天”；随后显示已上传照片时间轴/网格，再显示任务；有全景时显示“查看全景”次级卡。

照片页：封面 hero 高约 280–320，顶部返回；标题“照片时间轴（n）”；选择照片/开始上传按钮；分阶段 banner；空态；时间轴卡图高约 200、圆角 16。所有 loading/error/empty/success 都有明确状态。

BottomNav：主页/记忆空间/回味/我的四项，fixed 于 430px 内壳底部，高 56 + safe-area，active #FF7F9F；主内容要留出底栏空间。SpaceDetail 与照片上传页可不用全局底栏，但返回路径必须可靠。

六、实现边界与验收

优先修改/新增：App.tsx、routes.tsx、index.css、PhoneFrame/AppLayout/BottomNav、LandingPage、HomePage、CreatePage、SpacesPage、SpaceDetailPage、新照片上传页或组件、PanoramaViewPage、lib/api.ts、types/types.ts、一个 forward migration。不要改 PanoCapture/PanoStitch 数学，不新增大型依赖，不跨架构搬迁。

完成后必须：

1. 运行 npm run lint，并以其真实 exit code 为准（它包含 tsgo、biome、规则检查和真实 testBuild）。package.json 的 npm run build 是 echo/no-op，不能拿它冒充构建验证；若项目有真实测试一并运行。
2. 静态审计 routes/Home/Create：无正常可达 capture/guide/stitch，无 camera/deviceorientation 文案与入口；正式主路径无 s900003 iframe、Roadshow、Studio。
3. 静态审计 migration/RLS：新增表成功，匿名没有 UPDATE/DELETE，旧宽泛 UPDATE/DELETE 已撤销；不要重建旧表或丢数据。
4. 自测 375、390、430 与桌面宽度：Landing→Home→Create（有/无全景）→SpaceDetail→多选 1/3/9 张→部分失败仅重试失败→列表刷新→分享链接打开→贡献照片→2D 全景→主动 360→强制 WebGL 失败回 2D。
5. 最终只报告：实际修改文件、migration 是否实际应用、Supabase 当前状态、上述验收逐项结果、真实 lint/测试日志摘要、未完成项、仍需手机/微信真机验证项。不要发布。
