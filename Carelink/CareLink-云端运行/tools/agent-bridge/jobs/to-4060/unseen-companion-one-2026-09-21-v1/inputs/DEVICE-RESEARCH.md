# QUICK — Companion One 作为 UNSEEN 电脑驱动的空间显示端

- 核查日期：2026-09-20。
- 范围：已购买的自由象限 Companion One / CubeVi C1 的主机要求、内容格式、开发入口和首个接屏实验。没有进行竞品全面比较或价格调查。
- 停止条件：能选定内容开发与接屏两条路径，并定位到设备校准要求。
- 外部检索/取件：29 次（10 个搜索查询、9 个页面打开/点击、2 个 GitHub 树、8 个原始代码/许可文件，含开发打包时补取 GPL 全文）。搜索结果中的无关同名 DAC 不采信。
- 核查方式：单 agent 二次复核；官网产品页、下载页、README 与实际公开 SDK 代码互核。没有实机。

| ID | 承重事实 | 直接来源 | 核查结果与限定语 |
|---|---|---|---|
| C1 | 产品沿革将 C1 标为 Companion One、PC companion monitor | https://cubevi.com/pages/about-us-1 | 支持；用户订单的实际硬件修订版未见 |
| C2 | 当前官方要求 Windows 10/11，明确不支持 macOS/Linux；HDMI/Type-C 外接屏 | https://cubevi.com/products/cube-c1 | 支持；首次直接打开 403，后续搜索取回同页完整规格/FAQ；不能据此声称已实测 Mac 不出图，也不能承诺 Mac 兼容 |
| C3 | 5.7 英寸，1440×2560 面板；标称 540×960 visual resolution、40 视图、约 6 cm 景深、约 40°、推荐 50–80 cm | https://cubevi.com/products/cube-c1 | 厂商规格；清晰度/串扰/观看范围待实测，面板像素数不等于每个视角的清晰度 |
| C4 | 官方 C1 Blender/Unity 插件仅 Windows | https://cubevi.com/pages/download-page ; https://github.com/CubeVi/CubeVi-Swizzle-Blender | 支持；不把 PLAY 新型号 SDK 的能力套给 C1 |
| C5 | 官方 Blender 输出 40 帧及 Quilt，支持静图、动画和实时预览 | https://github.com/CubeVi/CubeVi-Swizzle-Blender | 支持；官方说明纹理复杂时实时预览会卡顿；平台上传有 70 MB 限制 |
| C6 | 网格为 8 列×5 行，每视图 540×960，完整 Quilt 4320×4800；不是 Looking Glass 通用默认布局 | https://github.com/CubeVi/CubeVi-Swizzle-Unity/blob/761b09b74a1b78dd75209324c7a98ada2e0fdfed/Scripts/BatchCameraManager.cs ; 本地 sources/blender-operators.py:824、1148 | 代码互核支持；相机方向和纹理行列须成套使用 |
| C7 | 校准读取 deviceConfig.json 中 lineNumber/obliquity/deviation，旧 OpenstageAI 和新 Cubestage 路径并存 | https://github.com/CubeVi/CubeVi-Swizzle-Blender/blob/2eef4012a792a51d5e3775e228c3acfa278d0306/addons/CubeVi_Swizzle_Blender/operators/AddonOperators.py#L334 ; 本地 sources/blender-operators.py | 支持；未到货前无法取得这台设备的真实校准；SDK 默认数字不能作为本机校准 |
| C8 | 公开交织算法按 RGB 子像素分别选视图 | 上述 Blender 源码 setup_display_shader；Unity Shader/MultiView.shader | 支持；浏览器移植仍需物理像素映射与实机验证 |
| C9 | SDK 许可证包含 GPL 与商业许可条款 | https://github.com/CubeVi/CubeVi-Swizzle-Unity/blob/761b09b74a1b78dd75209324c7a98ada2e0fdfed/license ; sources/cubevi-unity-license.txt | 保留上游说明；本地实验隔离于 UNSEEN 产品代码，不作商业许可已解决的结论 |

- 反向查询：`"CubeVi" "C1" "macOS"`。结果发现官网明确 Windows-only，收紧最初“电脑都能接”的假设。`"Companion One" "C1" "HDMI"` 用于核对接线描述。未把其他同名产品或 PLAY 支持当成 C1 支持。
- 二次复核：官网 Windows-only 与下载页、Blender README 一致；Unity 与 Blender 代码一致显示 40 视图、8×5、540×960 和设备级校准；Unity/Blender 相机实现存在差异，因此本实验采用 Blender 的平移/离轴投影约定并保留反转视序选项，不宣称已实现官方硬件认证。
- 决策：电脑负责计算，C1 作为空间呈现端成立。首个实验采用小而浅的静态几何场景，先验证左右移动的遮挡，再接真实空间。首个有官方支持的接屏环境是 Windows；Mac 先用于内容预览/导出，直接接屏作为独立待验证实验。
- 状态：完成，有限制。没有硬件、设备校准、订单修订版、Windows 实机性能或肉眼 3D 效果证据。没有联系厂商、安装官方客户端、提交内容、购买服务或改动生产环境。
