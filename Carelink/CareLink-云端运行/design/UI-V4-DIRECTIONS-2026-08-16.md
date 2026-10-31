# UNSEEN UI v4 · 三个设计方向（2026-08-16 · 待 Max 拍板）

前提（不重开的决定）：
- IA 不动：首页三入口（逛逛空间/创建我的空间/传照片）+ 轻量邀请入口，见 vault UNSEEN-UI规划v3。
- 色板不动：全部取自冻结 DESIGN-TOKENS.json（共光）。三个方向是**同一套 token 的三种执行强度**，不是三套新视觉。
- 铁律不动：每页至多一个主 CTA；手机/电脑同 action 同文案；无障碍（focus 可见、对比 3:1、reduced-motion）。
- 移动优先：Max 用 iPhone PWA，触感/动效/安全区/暗色 viewer 都按 APP 标准验收。

所有方向都包含 **§4 通用工艺修复包**（无论选哪个都做）。

---

## 方向 A 「共光·信笺」— 合同原教旨，最快最稳

**一句话**：把 Codex 合同本来设想的克制编辑风做到位，不加新手法。

- 字体：全站 Inter/PingFang，杀掉衬线；标题靠字重与字号分层。
- 图标：一套 1.5px 描边 SVG（burgundy 单色），替换全部 emoji。
- 卡片：白底 + hairline 边 + radius-lg(20)，仅可交互卡给 shadow-card。
- CTA：保持现 token 规格（渐变底、burgundy 字与 1px 边），圆角 md，不做胶囊。
- 光晕：每页至多一处（主 CTA 区背后），弱。
- APP 感来源：间距节奏、press 态（scale .98 + 120ms）、骨架屏、safe-area、粘底操作条。
- 风险最低；但和六图的「灵光感」距离最远，Max 可能仍觉得素。

## 方向 B 「共光·灵光」— 六图质感还原（推荐）

**一句话**：把产品做成 ref-4/ref-5 手机样机里那个 APP。

- CTA：渐变**胶囊**（radius pill、高 52），带柔粉光晕投影（`0 8px 24px rgba(255,150,178,.35)`）；次按钮白胶囊。
- 卡片：白底大圆角 xl(28)，柔光影；关键卡（空间卡/邀请卡）背后铺 halo 光晕。
- 图标：SVG 置于粉金渐变软圆片（ref-4 任务卡手法），全站一套。
- **签名元素：回现场进度环**——渐变描边圆环（ref-4 的 64% 环），用在空间卡与空间头部：「已回到现场 6/6」。这是 UNSEEN 独有机制（照片回到现场）的可视化，别家没有。
- 首页：三卡改「图标圆片 + 标题 + 副文案 + chevron」，卡间距收紧；hero 段与三卡合并成一屏叙事（hero 缩为顶部氛围带，不再重复标题）。
- 相册：圆角瀑布流，白缝 8px；状态改**小徽标**（渐变圆点+悬停/长按出全文），不再盖大胶囊；分组头「已回到现场 n · 待定位 m」。
- 现场 360：全屏沉浸（edge-to-edge 暗色 viewer），玻璃 chip 控件统一到底部一条操作带 + 已定位照片胶片条（filmstrip），罗盘方向做成单个圆形罗盘钮，不再四个单字键。
- 动效：120/180/320 全用起来——页面进场 180ms 淡升、卡片 press、进度环描边动画（reduced-motion 全关）。
- 风险中等：新增手法都在 token 色值内，但 radius/阴影用法超出合同§5 的「克制」表述，需要在合同上记一条 v4 修订。

## 方向 C 「共光·舞台」— 照片即界面，最大胆

**一句话**：chrome 退后，摄影全屏，界面浮在照片上。

- 首页：顶部 60vh 全出血封面（模板空间照片轮换），三入口为玻璃卡浮在照片下沿。
- 相册：edge-to-edge 密铺网格（2px 缝、无圆角框），点开即沉浸详情（暗场、双指缩放）。
- 空间页整体进「暗色舞台」：darkViewer token 从 360 页扩展到整个空间上下文；首页保持浅色。
- 现场 360：与 B 相同的沉浸方案。
- 风险最高：偏离合同「普通页面不得大面积变黑」最远，文字压图的对比与 scrim 工作量大；工期约为 B 的 1.5 倍。

---

## §4 通用工艺修复包（任一方向都做，对应审计编号）

1. 测试横幅 → 头部一枚小「测试」徽标点，点开弹说明（A1）。
2. Emoji → SVG 图标系统（A2）。
3. 杀衬线，恢复 token 字体（A3）。
4. 全站骨架屏加载态；空态给插画+行动指引（A4/A6）。
5. press/hover/焦点/过渡按 motion token 全铺（A5）。
6. 文案清洗：杀「本机可操作样本」「人工已确定」「https://.../open/...」等系统词（B7/B8/B18）；照片名用「时间 + 上传者」生成（B10）。
7. /open 页装饰点与文字分层（B6）；邀请落地页封面加 scrim（B4）；CTA 渐变回 token 色值（B5）。
8. 相册滚动位置保持（B11）；「查看」按钮改明确语义或并入照片点击（B9）。
9. 举报入口收进「⋯」菜单（对话框确认不变）（B19）。
10. 照片详情：标题改真实信息层（空间名+序号+上传者+时间），图占屏优先（B17/B20）。

## 推荐与施工计划

**推荐 B**：它就是六张参考图的质感（Max 最早认可的方向），工期可控，且签名元素（回现场进度环）长在 UNSEEN 自己的机制上。
A 是保底（若要 3 天内上线），C 可作为 B 之后的 v4.1 实验（先做 B 的沉浸 360，验证暗场手法再扩）。

拍板后施工拆分（全部 Sonnet 子代理、全在 cc/ui-v4、每步保 64 pass 1 skip）。
页面全量（src/ui/templates.js）：home/discover/start-upload/book-preview/open×2/login/spaces/spaces-new/album/scene/photo/upload/batch-result/batch-item/placement-editor/manage(tabs)/scene-management/account/account-uploads/support/media-notice/legal/status/404/dialogs ≈24 页。

1. 基建（先行，其余块的公共依赖）：SVG 图标系统替换 emoji + 按钮/卡片/chip/骨架屏组件层 + motion 工具类 + 杀衬线。
2. 首页 + discover + start-upload + open×2 + login + spaces/spaces-new。
3. 空间相册 + 照片详情 + book-preview。
4. 现场 360 沉浸改造 + placement-editor（最重，单独一块）。
5. 上传与回执流：upload/batch-result/batch-item。
6. 管理与账号：manage tabs/scene-management/account/account-uploads/support/legal/status/404（密度页，重排版轻视觉）。
7. 文案清洗 + 无障碍复检（focus/对比/reduced-motion/200% zoom）+ 移动视口截图验收。
