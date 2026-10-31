// UNSEEN 官方案例馆 v1 的唯一内容源。
//
// 这里的对象只描述可观看的官方案例。渲染层不得把 post.media 写入
// `state.photo`、个人记忆 IndexedDB 或 World Labs 的 source-set/handoff。

export const OFFICIAL_GALLERY_SCHEMA_VERSION = "1.0.0";

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

export const OFFICIAL_GALLERY_AUTHOR = deepFreeze({
  id: "unseen-official",
  name: "UNSEEN 官方",
  displayName: "UNSEEN 官方",
  kind: "official"
});

export const OFFICIAL_POSTS = deepFreeze([
  {
    schemaVersion: OFFICIAL_GALLERY_SCHEMA_VERSION,
    id: "photo-question-memory-page",
    slug: "photo-question-memory-page",
    authorId: OFFICIAL_GALLERY_AUTHOR.id,
    publishedAt: "2026-09-05T00:00:00+10:00",
    updatedAt: "2026-09-05T00:00:00+10:00",
    source: {
      label: "UNSEEN 照片追问真实主链",
      provenance: "能力来自当前 /unseen-demo；配图派生自 git:8580998 收录的仓内 AI 模板图",
      license: "配图限 UNSEEN 项目内官方演示使用"
    },
    title: "照片先开口，原话最后留下",
    dek: "看图服务只问一次；用户确认的文字或语音转写，原样形成一页只存在本机的回忆。",
    body: [
      "这条案例对应当前已经接通的照片主链。用户先拍摄或选择自己的照片；只有明确进入“聊聊这张”后，预览副本才会发送给看图服务。",
      "模型从本机照片生成的清晰预览副本中读取可见内容，再提出一个问题。若服务无法可靠看图，界面会明确改用备用开放问题，不会把失败包装成已经看懂。",
      "用户可以打字，也可以主动开始和停止语音转写。确认后的原话不会被润色；生成的一页回忆只有在用户再次确认保存后才进入当前浏览器的 IndexedDB。"
    ],
    capability: {
      id: "photo-question-memory-page",
      label: "照片追问 → 一页回忆",
      status: "available",
      statusLabel: "已接通",
      summary: "单图看图一问、文字或可编辑语音转写、一页回忆与本机保存。"
    },
    media: [
      {
        id: "memory-page-cover",
        kind: "image",
        src: "/official-gallery/v1/media/memory-page-cover.webp",
        thumbnailSrc: "/official-gallery/v1/media/memory-page-thumb.webp",
        width: 1200,
        height: 750,
        thumbnailWidth: 640,
        thumbnailHeight: 400,
        alt: "暖色餐桌上的花器、杯子和餐具，用作照片追问与一页回忆能力示意",
        credit: "UNSEEN AI 模板素材；由仓库内置例图 photo4_table_detail.jpg 派生",
        license: "UNSEEN 项目内官方演示素材",
        sourceLabel: "git:8580998 · 内置 AI 模板图 · 非真人照片"
      }
    ],
    limitations: [
      "案例图片只是官方能力说明，不会进入用户的照片、回忆或生成记录。",
      "一页回忆只保留用户确认的原话，不自动补写人物关系、地点或故事。",
      "保存仅发生在当前浏览器；没有账号、云同步或公开发布。"
    ],
    facts: [
      { label: "输入", value: "用户自己拍摄或选择的 1 张照片" },
      { label: "追问", value: "MiniMax 读取清晰预览副本后只问一次；失败时明确降级" },
      { label: "回答", value: "文字，或用户主动开始/停止的可编辑语音转写" },
      { label: "结果", value: "一页回忆；用户确认后保存到本机 IndexedDB" }
    ],
    viewer: null
  },
  {
    schemaVersion: OFFICIAL_GALLERY_SCHEMA_VERSION,
    id: "dap-ballroom-limited-panorama",
    slug: "dap-ballroom-limited-panorama",
    authorId: OFFICIAL_GALLERY_AUTHOR.id,
    publishedAt: "2026-09-05T00:00:00+10:00",
    updatedAt: "2026-09-05T00:00:00+10:00",
    source: {
      label: "仓内 ballroom DAP 已验收范例",
      provenance: "全景：Sergej Majboroda / Poly Haven；深度：DAP © Insta360 Research",
      license: "全景 CC0；DAP 深度模型 CC BY-NC 4.0，正式商用可能需要授权或替换"
    },
    title: "宴会厅，只允许轻轻探身",
    dek: "4K 全景叠加 DAP 单目深度，可 360° 环视，也只在约 0.42 米内给出有限视差。",
    body: [
      "这不是一间可以自由行走的完整 3D 房间。查看器把 4096×2048 宴会厅全景与 1024×512 DAP 深度叠在一起，让桌面端用鼠标和 WASD、移动端用拖动和摇杆观察有限视差。",
      "移动半径被明确限制在约 0.42 米，以避免把单目深度边缘拉成错误的空间结构。画面里的照片入口也只表示大致观看方向，不声称是精确相机位姿。",
      "全景来自 Sergej Majboroda 在 Poly Haven 发布的 CC0 素材；深度模型演示基于 Insta360 Research 的 DAP，按 CC BY-NC 4.0 使用。"
    ],
    capability: {
      id: "dap-limited-panorama",
      label: "DAP 受限全景",
      status: "available",
      statusLabel: "真实范例已开放",
      summary: "360° 环视、有限深度视差、桌面和移动端控制。"
    },
    media: [
      {
        id: "dap-ballroom-cover",
        kind: "image",
        src: "/official-gallery/v1/media/dap-ballroom-cover.webp",
        thumbnailSrc: "/official-gallery/v1/media/dap-ballroom-thumb.webp",
        width: 1200,
        height: 750,
        thumbnailWidth: 640,
        thumbnailHeight: 400,
        alt: "UNSEEN 宴会厅 DAP 查看器，画面中可见白色钢琴、展厅和受限移动控制",
        credit: "全景：Sergej Majboroda / Poly Haven；深度：DAP © Insta360 Research",
        license: "全景 CC0；DAP 深度模型 CC BY-NC 4.0",
        sourceLabel: "仓内已验收的 ballroom DAP 本地范例"
      }
    ],
    limitations: [
      "这是有限视差全景，不是可自由穿行的完整 3D 或自有 3DGS。",
      "移动半径约 0.42 米；单目深度在遮挡边缘仍可能出现误差。",
      "DAP 深度模型为 CC BY-NC 4.0；正式商用可能需要另行授权或替换模型。"
    ],
    facts: [
      { label: "全景", value: "4096 × 2048 · Poly Haven CC0" },
      { label: "深度", value: "1024 × 512 · DAP 单目深度" },
      { label: "交互", value: "360° 环视 + 约 0.42 米受限视差" },
      { label: "状态", value: "本地静态资源与查看器已接通" }
    ],
    viewer: {
      kind: "read-only",
      href: "/unseen-dap?scene=ballroom&back=unseen-demo%3Fcase%3Ddap-ballroom-limited-panorama",
      label: "进入只读 DAP 范例"
    }
  },
  {
    schemaVersion: OFFICIAL_GALLERY_SCHEMA_VERSION,
    id: "world-labs-single-and-multi",
    slug: "world-labs-single-and-multi",
    authorId: OFFICIAL_GALLERY_AUTHOR.id,
    publishedAt: "2026-09-05T00:00:00+10:00",
    updatedAt: "2026-09-05T00:00:00+10:00",
    source: {
      label: "World Labs Marble 已接通能力与仓库 canary 记录",
      provenance: "README 记录单图/多图 canary；本帖配图仅使用 git:8580998 仓内 AI 模板图说明输入方式",
      license: "配图限 UNSEEN 项目内官方演示使用；未复制外部 canary 原图或输出"
    },
    title: "一张，或多张：世界怎样展开",
    dek: "World Labs Marble 同时承接单图创意补全与 2–8 张同场景重建；两者都保留清楚的第三方处理边界。",
    body: [
      "单图模式从一张有空间感的照片出发，补全画面之外的世界。结果含模型想象，不等同于真实现场复原。",
      "多图模式接收 2–8 张同一场景、彼此有重叠的照片，经 Auto Layout 对齐后生成一个可探索的共同空间。仓库已经分别跑通单图与多图 canary；本帖图片仅说明输入方式，不冒充某次 canary 的输出。",
      "真正生成前，World Labs 页面仍会要求用户确认照片使用权、第三方处理、公开链接和可能用于模型改进的条款；任务状态与源图入口只保存在本机，生成会消耗公共体验额度。"
    ],
    capability: {
      id: "world-labs-marble",
      label: "World Labs 单图 / 多图世界",
      status: "available",
      statusLabel: "第三方能力已接通",
      summary: "单图创意补全，或 2–8 张同场景照片经 Auto Layout 重建。"
    },
    media: [
      {
        id: "world-single-input",
        kind: "image",
        src: "/official-gallery/v1/media/world-single-cover.webp",
        thumbnailSrc: "/official-gallery/v1/media/world-single-thumb.webp",
        width: 1200,
        height: 750,
        thumbnailWidth: 640,
        thumbnailHeight: 400,
        alt: "一张暖色碰杯画面，用作 World Labs 单图输入方式示意",
        credit: "UNSEEN AI 模板素材；由仓库内置例图 photo1_cheers.jpg 派生",
        license: "UNSEEN 项目内官方演示素材",
        sourceLabel: "git:8580998 · 内置 AI 模板图 · 非真人照片"
      },
      {
        id: "world-multi-input",
        kind: "image",
        src: "/official-gallery/v1/media/world-multi-cover.webp",
        thumbnailSrc: "/official-gallery/v1/media/world-multi-thumb.webp",
        width: 1200,
        height: 750,
        thumbnailWidth: 640,
        thumbnailHeight: 400,
        alt: "蛋糕、餐桌和聚会环境的三联画，用作 World Labs 多图输入方式示意",
        credit: "UNSEEN AI 模板素材；由仓库内置例图 photo2、photo4、photo3 派生",
        license: "UNSEEN 项目内官方演示素材",
        sourceLabel: "git:8580998 · 内置 AI 模板图 · 非真人照片"
      }
    ],
    limitations: [
      "生成由 World Labs Marble 完成；UNSEEN 负责入口、额度控制和站内查看。",
      "生成世界可通过公开链接访问；输入可能按 World Labs 服务条款用于改进模型。",
      "Marble 当前不返回每张输入照片的精确相机位姿；照片入口不是精确空间锚点，只是非精确的原图回看入口。",
      "公共体验有每日与单设备额度，生成通常需要约 5 分钟。",
      "自有 3DGS 训练链路仍在进行中，本案例不把它标成已开放能力。"
    ],
    facts: [
      { label: "单图", value: "1 张照片 → 含模型想象的画外世界" },
      { label: "多图", value: "2–8 张同场景重叠照片 → Auto Layout 共同空间" },
      { label: "提供方", value: "World Labs Marble" },
      { label: "提交前", value: "必须明确确认公开生成与第三方数据处理" }
    ],
    viewer: null
  }
]);

export function getOfficialPost(idOrSlug) {
  const key = String(idOrSlug ?? "");
  return OFFICIAL_POSTS.find((post) => post.id === key || post.slug === key) ?? null;
}
