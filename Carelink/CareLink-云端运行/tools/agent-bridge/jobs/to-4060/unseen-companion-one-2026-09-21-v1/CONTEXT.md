# 这次需要的全部上下文

## 用户已经确定的内容

- 已购买自由象限 Companion One；设备即将到货。
- 先把它当呈现端，电脑承担计算；树莓派暂时放一边。
- 用户已确认可以用 Windows 电脑测试。
- 本轮明确把现有软件与全部相关资料交给已有 4060 Agent，并授权它继续研发。
- 产品建议沿“桌面空间窗口”展开：先固定小场景产生真实水平视差/遮挡，再接熟悉的真实空间。用户没有要求先做桌宠、换硬件或重建一套后端。

## 已核实的一手资料（2026-09-20）

- C1 是 Companion One 产品线，官方现成软件目前只支持 Windows 10/11；不是 Mac 即插即用保证。
- 官方标称：5.7 英寸，1440×2560 面板，540×960 visual resolution，40 视图，约 40°观看角，约 6 cm 深度范围，建议 50–80 cm 距离。规格不是独立测量。
- 接口 HDMI / Type-C；实际接口形态、接线/供电和固件以到货版本说明为准。不要假定任意 Type-C 单线即可。
- 显示链：3D 内容 → 40 个水平视角 → 8×5 Quilt → 每台设备校准交织 → 光学显示。直接显示普通网页或 Quilt 网格不会自动成为合格的 C1 光场。
- 官方 C1 Blender / Unity SDK 存在，明确 Windows-only。不要混用新的 PLAY 型号 SDK 或 Looking Glass 默认 Quilt/校准。
- 校准核心字段是 lineNumber / obliquity / deviation，来自实际设备配置；禁止用 SDK 示例默认数字冒充本机参数。

直接来源：
- 产品：https://cubevi.com/products/cube-c1
- 软件：https://cubevi.com/pages/download-page
- 沿革：https://cubevi.com/pages/about-us-1
- Blender：https://github.com/CubeVi/CubeVi-Swizzle-Blender ，冻结源码 `2eef4012a792a51d5e3775e228c3acfa278d0306`
- Unity：https://github.com/CubeVi/CubeVi-Swizzle-Unity ，冻结源码 `761b09b74a1b78dd75209324c7a98ada2e0fdfed`

运行包内 `research/quick.md` 是逐项证据表，`research/sources/blender-operators.py` 是核查过的官方原始代码。README 中的连接和许可证说明一起阅读；不要重复广泛搜索，也不要把未到货的设备效果写成已测。

## 已有软件 v0.1

独立 Node.js + Three.js 本地测试台，无云服务依赖。已具备两个几何场景、自包含 GLB 导入、水平视点滑轨、浅景深/平面基线、40 视图预览及完整 PNG 导出、校准解析和受全屏尺寸检查保护的实验交织、人工测试记录导出。素材与校准在内存中，刷新需要重选。

Mac 端 5 项计算测试和 3 项 Chrome 浏览器测试通过；已实际导出 4320×4800 PNG，40 个完整视角哈希互不相同。DPR=2 离屏、合成参数下的 1440×2560 交织、非法校准、GLB 外部引用拒绝、移动布局都测过。模拟原生尺寸不等于设备验证。Windows、真实校准、光学校果全部待测；未包含 3DGS 导入和实际 UNSEEN 场景。

完整细节在包内 `README.md`、`DESIGN.md`、`VALIDATION.md`、`NOTICE.md`。原始包应保持不变，修复标成 v0.1 派生版本。

## 4060 已有 UNSEEN 工作的当前入口（2026-09-21 实查）

- 原工作入口：[Issue #17](https://github.com/maxi-max-dev/max-agent-bridge/issues/17)。该线是已有 3DGS 本机产品，保留其现场。
- [PR #21](https://github.com/maxi-max-dev/max-agent-bridge/pull/21) 当前仍为 Draft/Open，head `49816f3ea7a81d8a88e553bc8ddb1c971d6e771d`，分支 `codex/web-panorama-quality-4060-20260911`。
- #17 最新接收补充记录说明 Mac 功能接收曾通过，但几何/遮罩质量仍部分通过；因此可复用它已有产物做显示实验，不把既有模型包装为画质完全验收。当前本机实际代码与资产由你核对，不用旧文档路径覆盖最新工作。
- Bridge main 查询基线 `d34518b`。H3 #23 的最后消息为完整影片候选冻结/停止新生成；这是历史状态，不是现在 GPU 空闲的证据。不要为本任务恢复或改动 H3。

本轮只交项目相关源码、资料和合同，没有发送 vault、账号凭据、原始个人素材或完整聊天历史。
