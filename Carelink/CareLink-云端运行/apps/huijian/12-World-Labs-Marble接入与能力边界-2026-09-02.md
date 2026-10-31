# World Labs Marble 接入与能力边界

> 日期：2026-09-02
> 更新：2026-09-03
> 结论：首个实验采用「2–8 张同一场景照片 → 一个可探索 3D 世界」；单图作为次模式保留。多图、单图、真实 SPZ 站内渲染和 UNSEEN 旧模型方向回定位均已实测；照片精确 3D 锚点仍不成立。

## 先把产品线分清

World Labs 现在有两条不同的能力线：

- **Marble World API** 是现在可以自助接入的公开 API。它支持文本、单图、全景图、多图和视频生成世界，输出包括 SPZ Gaussian splat、碰撞体 GLB、全景图和缩略图。
- **Atlas** 是 World Labs 在 2026-09-01 公布的更强显式 3D 生成/重建模型，但当前仅向 select partners 提供 early access，没有面向普通开发者的自助 API。

## 四种能力的实际状态

| 想要的能力 | 当前真实能力 | 建议 |
|---|---|---|
| 单图 → 3D 空间 | Marble 已支持；系统会创意补全画面外区域，不是测量级复刻 | 保留为次模式 |
| 一段视频 → 3D 空间 | Marble 已支持；最长 30 秒、最大 100 MB，适合稳定地覆盖一个静态空间 | 等单图真实效果后开 |
| 长视频走动 → 完整空间 | 不是公开 Marble 的当前宽泛能力；Atlas 的 spatial reconstruction 更接近这个目标 | 等 Atlas 公开或申请伙伴访问 |
| 多图 → bullet time | Marble 多图是最多 4 张方向图或 8 张同场景重叠图；Atlas 才明确支持 3–5 机位素材的 bullet time | 先开同场景多图世界，不叫 bullet time |

## 回见中的已完成实现

- 新页面：`/world`，默认暴露同场景多图模式，单图创意补全作为次模式。
- 新 API：`GET /api/worldlabs/config`、`POST /api/worldlabs/generate`、`GET /api/worldlabs/operations/:id`。
- World Labs key 只由 Node 服务端读取，不进 HTML/JS，不回传到浏览器。
- 多图模式接受 2–8 张照片，浏览器逐张压缩至长边 1400 px；服务端再次检查单张 6 MB、合计 24 MB 与数量边界后，向 Marble 发送 `type: multi-image`、`reconstruct_images: true`。单图仍压缩至长边 1600 px。
- 页面明示要求用户确认照片权利、公开世界访问以及 World Labs 可能按条款使用输入改进模型。上线前应再在付费账户中启用可用的训练 opt-out。
- 默认使用 `marble-1.0-draft`，全站每日 5 次、每访客每日 1 次，额度状态由 systemd 持久目录保留。
- operation 轮询可跨刷新恢复；预估等待时间约 5 分钟。参与生成的压缩后原图只写入该浏览器的 IndexedDB，用于刷新后继续显示“照片入口”，不由回见服务器持久保存。
- Marble 站点有 `frame-ancestors 'none'` / `X-Frame-Options: DENY`，所以没有用 iframe。生成完成后，页面用 SparkJS + Three.js 直接渲染 500k SPZ，加载失败时再跳到 Marble 原页。
- World Labs 未配置时是失败关闭：`/world` 可查看，生成按钮不可点，主站的回见对话功能不受影响。

## “照片回到场景”的当前边界

Marble 的公开 World/operation 响应文档列出了 SPZ、碰撞体、全景、缩略图与世界 prompt，但没有文档化返回每张输入图的相机外参或恢复位姿。因此当前版本能保证的是：

- 每张原照片都真实参与同一个世界的 Auto Layout 重建；
- 生成后，它们作为世界边缘的“照片入口”保留，点击看原图，再一键回到 3D；
- 不把这些入口画成照片的精确拍摄位置。以后若 Atlas/Marble 提供逐图位姿，现有入口可直接升级为空间锚点。

## 2026-09-03 真实 canary

输入采用 openMVG 官方 `ImageDataset_SceauxCastle` 的 11 张同场景连续视角：8 张参与 World Labs 多图生成，7101、7107、7109 三张留出，仅用于定位验证。

| 模式 | 结果 | 耗时 | credits | 世界 |
|---|---|---:|---:|---|
| 8 图 Auto Layout 重建 | 成功；全景、collider、100k/500k/full SPZ | 约 93 秒 | 250 | [Marble 多图世界](https://marble.worldlabs.ai/world/585ed6bd-7c49-4460-aac0-104f878af2f1) |
| 单图创意补全 | 成功；同类资产 | 约 93 秒 | 230 | [Marble 单图世界](https://marble.worldlabs.ai/world/a6755a78-656b-4e3e-b78b-7eca5b903864) |

这个城堡样例里，多图比单图更好地保留了正立面、道路与树木关系；但照片未覆盖的方向仍会出现重复或补生建筑。它证明的是“可探索的共同生成世界”，不是测量级完整复刻。

API 还暴露了一个实际兼容性问题：完成 operation 的首次响应里，`pano_url` 可能仍为空、collider 也未齐；随后 `GET /worlds/{world_id}` 才返回完整资产。客户端已改为在完成后用 canonical World 再 hydrate 一次，并增加回归测试。

UNSEEN 定位实验直接复用现有 `clip-ViT-B-32`、12 个 30° yaw crop、FOV 70、800×600，不训练、不微调：

- 多图世界：11/11（含 3/3 留出图）top-1 都落在 yaw 150°，confidence 0.870831–0.900941，margin 0.053858–0.076422；
- 单图世界：10/11 落在 yaw 180°，1/11 落在 yaw 120°；
- 这足以做“照片 → 候选方向”，但不能做精确位置。11 个不同水平机位在多图世界全部坍缩到同一 yaw，且模型没有平移输出；结合既有跨场景 release gate 未通过，产品仍采用候选方向 + 人工确认。

## 成本和运营默认值

官方当前定价是 1 美元购买 1250 API credits，最低购买 5 美元。图像 draft 为 230 credits，约 0.184 美元/次；standard 为 1580 credits，约 1.264 美元/次。API credits 与 Marble 应用内额度分开。

因此第一版用 draft + 每日 5 次的理论生成成本约 0.92 美元/日，在还没有真实使用数据时是合理的试验闸门。

## 验收记录

- 项目全量测试 `150/150` 通过，包括 World Labs 单图/多图请求、完成后 World hydration、输出脱敏、额度持久化和分享链接合同。
- World Labs 真实多图、单图 operation 均成功，共扣 480 credits；全景、collider 和 SPZ 均已下载并校验哈希。
- 真实浏览器打开官方 Marble 多图世界；公网 [huijian.maxxam.xyz/world](https://huijian.maxxam.xyz/world) 也已启用服务端 key，并通过 `/world?operation=...&mode=multi` 恢复同一真实结果、加载 500k SPZ 与拖动环看。
- UNSEEN 原模型已对 8 张输入图与 3 张留出图完成两套世界的方向匹配，原始逐图结果保存在审计包。
- 尚未覆盖：多个室内/室外场景的总体成功率与移动端真机 GPU 失败率。

## 下一步

1. 先以多图为默认入口、单图为次入口，小额度公开；收集不同真实场景的成功率。
2. 将 UNSEEN 结果只显示为 3 个候选方向，让用户确认；不要自动写入精确锚点。
3. 若 World Labs 后续返回逐图相机位姿，或我们训练出带平移监督的 6DoF 模型，再重新开精确照片入口的 release gate。
4. 用 iPhone Safari 与 Android Chrome 各跑至少一次真实 500k SPZ，记录加载时间、崩溃和降级到 100k 的比例。

## 官方资料

- [World Labs API Quickstart](https://docs.worldlabs.ai/api)
- [Image prompt guide](https://docs.worldlabs.ai/marble/create/prompt-guides/image-prompt)
- [Multi-image prompt guide](https://docs.worldlabs.ai/marble/create/prompt-guides/multi-image-prompt)
- [Video prompt guide](https://docs.worldlabs.ai/marble/create/prompt-guides/video-prompt)
- [API pricing](https://docs.worldlabs.ai/api/pricing)
- [API rate limits](https://docs.worldlabs.ai/api/rate-limits)
- [Introducing Atlas](https://www.worldlabs.ai/blog/atlas)
- [World Labs API examples](https://github.com/worldlabsai/worldlabs-api-examples)
- [Rendering SPZ files](https://docs.worldlabs.ai/api/rendering-spz)
- [SparkJS documentation](https://sparkjs.dev/docs/)
- [World Labs Terms of Service](https://www.worldlabs.ai/terms-of-service)

能力调研审计包：`/Users/max/Library/Mobile Documents/iCloud~md~obsidian/Documents/MaxNotes/🔍 调研 Hub/_runs/DR-20260902-225517-world-labs-marble-能力与回见接入可行性快探`（validator PASS）。

真实实验审计包：`/Users/max/Library/Mobile Documents/iCloud~md~obsidian/Documents/MaxNotes/🔍 调研 Hub/_runs/DR-20260903-002440-world-labs同场景多图重建与unseen定位真实实验`（validator PASS，0 errors / 0 warnings）。
